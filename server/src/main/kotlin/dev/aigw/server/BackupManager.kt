package dev.aigw.server

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/**
 * 数据目录的备份与恢复。
 *
 * 这一层是纯文件操作，不认识 HTTP，也不碰 core —— 它只保证一件事：
 * **任何一次替换都可回滚**。凭证全在 `secure/` 下，被 `master.key` 加密；
 * 备份包里同时带走密钥，否则恢复出来的密文在新机器上一条都解不开。
 *
 * 四条硬约定：
 * 1. **备份目录在数据目录之外**（`<dataDir>/../backups`）。放在里面的话，
 *    恢复时"先清空再解压"会把备份自己删掉，用户就失去了唯一的回滚点。
 * 2. **不备份 `webview2/`**。它占 80 MB（Chromium 缓存，与本项目数据无关），
 *    混进去会让一次备份从 2 MB 变成 80 MB，用户不会再用第二次。
 * 3. **恢复不立即替换**：只登记一个 `.restore-pending.json`，由下次进程启动
 *    在拿到实例锁之后、打开加密存储之前执行。正在跑的进程持有 `secure/` 下的
 *    文件句柄，边跑边替换会得到半个账号池。
 * 4. **解压必须防 zip-slip**：条目名里出现 `..` 或绝对路径一律整包拒绝。
 *    本服务只监听 127.0.0.1，但浏览器里任意页面都能发请求过来。
 */
internal class BackupManager(private val dataDir: File) {

    /** 备份存放目录：数据目录的兄弟目录，绝不在数据目录内部。 */
    val backupDir: File = File(dataDir.absoluteFile.parentFile, "backups")

    private val pendingFile: File = File(dataDir, PENDING_NAME)

    /** 上次启动实际恢复的记录（供界面显示"昨天那次恢复做了什么"）。 */
    private val lastRestoreFile: File = File(dataDir, LAST_RESTORE_NAME)

    // ---------------------------------------------------------------- 快照范围

    /**
     * 打包/替换的条目白名单。
     *
     * 用白名单而不是"全部"：`webview2/`、`.instance.*`、`shell-launcher.log`、
     * `.update-cache.json` 都是可再生的进程状态，带进备份只会让包变大、
     * 让恢复后的实例身份变得可疑（`.instance.json` 里写死了旧端口）。
     */
    private fun snapshotTopLevel(): List<String> = buildList {
        add("secure")           // 账号、凭证、设置、调用记录、用量（全在这里，加密）
        add("master.key")       // 没有它，secure/ 就是一堆无法解密的字节
        add("antigravity-oauth.json")
        add("ui-theme.txt")
        add("auto-route.txt")
        // 明文遗留目录：正常情况为空（迁移后已清），但旧版本可能还在用
        add("account"); add("pool"); add("logs"); add("usage"); add("login")
    }.filter { File(dataDir, it).exists() }

    // ---------------------------------------------------------------- 创建

    /**
     * 创建一份备份。
     *
     * @param includeCallLogs 是否带上 `secure/logs/`（调用记录全文）。关掉后包小一半，
     *                        但恢复后「调用记录」页会是空的——所以这是个显式开关，
     *                        不是默默裁剪。
     */
    fun create(includeCallLogs: Boolean): JsonObject {
        backupDir.mkdirs()
        if (!backupDir.isDirectory) {
            return resultJson(false, "备份目录无法创建：${backupDir.absolutePath}")
        }
        val stamp = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")
            .withZone(ZoneId.systemDefault()).format(Instant.now())
        // 同一秒内连点两次会撞名，而 renameTo 在这条路径上**不覆盖**（Windows 上返回 false，
        // 代码随后 copyTo(overwrite=true) 就把上一份删了）——实测连点两次只剩一份。
        // 名字里带序号，保证每次创建都是新文件。
        val name = uniqueName("aigw-backup-$stamp")
        val target = File(backupDir, name)
        val tmp = File(backupDir, "$name.tmp")

        var entries = 0
        try {
            ZipOutputStream(FileOutputStream(tmp)).use { zos ->
                zos.setLevel(6)
                for (top in snapshotTopLevel()) {
                    val root = File(dataDir, top)
                    if (root.isFile) {
                        entries += addFile(zos, root, top, includeCallLogs)
                    } else if (root.isDirectory) {
                        root.walkTopDown().filter { it.isFile }.forEach { f ->
                            val rel = f.relativeTo(dataDir).invariantSeparatorsPath
                            entries += addFile(zos, f, rel, includeCallLogs)
                        }
                    }
                }
                // 清单条目：让恢复端能在解压前判断"这包是什么、什么时候、哪个版本"
                val manifest = JsonObject().apply {
                    addProperty("createdAtMillis", System.currentTimeMillis())
                    addProperty("appVersion", APP_VERSION)
                    addProperty("includeCallLogs", includeCallLogs)
                    addProperty("entryCount", entries)
                    addProperty("dataDirName", dataDir.absoluteFile.name)
                }
                zos.putNextEntry(ZipEntry(MANIFEST_NAME))
                zos.write(manifest.toString().toByteArray(Charsets.UTF_8))
                zos.closeEntry()
            }
            if (!tmp.renameTo(target)) {
                tmp.copyTo(target, overwrite = true)
                tmp.delete()
            }
        } catch (e: Exception) {
            runCatching { tmp.delete() }
            return resultJson(false, "备份失败：${e.javaClass.simpleName}: ${e.message}")
        }

        return JsonObject().apply {
            addProperty("ok", true)
            addProperty("message", "已备份 $entries 个条目（${sizeText(target.length())}）")
            addProperty("name", name)
            addProperty("path", target.absolutePath)
            addProperty("bytes", target.length())
        }
    }

    /** 同名时追加 `-2`、`-3`…，返回一个当下不存在的文件名（含 .zip）。 */
    private fun uniqueName(base: String): String {
        var candidate = "$base.zip"
        var i = 2
        while (File(backupDir, candidate).exists()) {
            candidate = "$base-$i.zip"
            i++
        }
        return candidate
    }

    /** 单个条目入包；调用记录可按前缀跳过。返回实际写入的条目数。 */
    private fun addFile(zos: ZipOutputStream, file: File, rel: String, includeCallLogs: Boolean): Int {
        if (!includeCallLogs && rel.startsWith("secure/logs/")) return 0
        // .tmp 残片是原子写的中转文件，带进备份没有意义
        if (rel.endsWith(".tmp")) return 0
        try {
            zos.putNextEntry(ZipEntry(rel))
            FileInputStream(file).use { it.copyTo(zos) }
            zos.closeEntry()
            return 1
        } catch (e: Exception) {
            // 单个文件读不出（被占用）→ 跳过而不是整包失败：
            // 少一个日志文件好过用户拿不到任何备份
            runCatching { zos.closeEntry() }
            return 0
        }
    }

    // ---------------------------------------------------------------- 列举 / 删除

    fun list(): JsonObject {
        val arr = JsonArray()
        scanBackups().forEach { f ->
            val info = readManifest(f)
            arr.add(JsonObject().apply {
                addProperty("name", f.name)
                addProperty("path", f.absolutePath)
                addProperty("bytes", f.length())
                addProperty("sizeText", sizeText(f.length()))
                addProperty("atMillis", info?.first ?: f.lastModified())
                addProperty("appVersion", info?.second?.get("appVersion")?.takeIf { !it.isJsonNull }?.asString ?: "")
                addProperty("entryCount", info?.second?.get("entryCount")?.takeIf { !it.isJsonNull }?.asInt ?: 0)
                addProperty("includeCallLogs", info?.second?.get("includeCallLogs")?.takeIf { !it.isJsonNull }?.asBoolean ?: false)
            })
        }
        val top = snapshotTopLevel()
        return JsonObject().apply {
            addProperty("ok", true)
            addProperty("dir", backupDir.absolutePath)
            addProperty("count", arr.size())
            add("items", arr)
            add("scope", JsonArray().apply { top.forEach { add(it) } })
            add("pending", pendingInfo())
            add("lastRestore", lastRestoreInfo())
        }
    }

    /**
     * 备份文件按创建时间倒序（最新的在最上面）。
     *
     * 不能按文件名字典序：同秒创建的 `…-1549.zip` 与 `…-1549-2.zip` 里，
     * `-`(45) 排在 `.`(46) 前面，字典序会把后创建的那份排到前面去——
     * 列表顺序会和"最新"直觉相反。
     */
    private fun scanBackups(): List<File> =
        (backupDir.listFiles { f -> f.isFile && f.name.startsWith("aigw-backup-") && f.name.endsWith(".zip") })
            ?.sortedByDescending { readManifest(it)?.first ?: it.lastModified() } ?: emptyList()

    fun delete(name: String): JsonObject {
        if (name.contains('/') || name.contains('\\') || name.contains("..")) {
            return resultJson(false, "非法的备份名：$name")
        }
        val f = File(backupDir, name)
        if (!f.isFile) return resultJson(false, "备份不存在：$name")
        return if (f.delete()) {
            resultJson(true, "已删除备份 $name")
        } else {
            resultJson(false, "删除失败（文件可能被占用）：$name")
        }
    }

    // ---------------------------------------------------------------- 恢复

    /**
     * 登记一次恢复请求。**不动任何现有文件**。
     *
     * 真正的替换发生在下次进程启动（[applyPending]）：那时旧进程已经退出、
     * 实例锁在手里、加密存储还没打开——三个条件同时成立才不会读到半个账号池。
     */
    fun requestRestore(name: String): JsonObject {
        if (name.contains('/') || name.contains('\\') || name.contains("..")) {
            return resultJson(false, "非法的备份名：$name")
        }
        val f = File(backupDir, name)
        if (!f.isFile) return resultJson(false, "备份不存在：$name")
        if (!validateZip(f).ok) {
            return resultJson(false, "备份包不可用：${validateZip(f).error}")
        }
        val json = JsonObject().apply {
            addProperty("zip", f.absolutePath)
            addProperty("name", name)
            addProperty("requestedAtMillis", System.currentTimeMillis())
            addProperty("requestedByVersion", APP_VERSION)
        }
        return runCatching {
            pendingFile.writeText(json.toString())
            JsonObject().apply {
                addProperty("ok", true)
                addProperty("message", "已登记恢复：$name。重启应用后生效（重启前会自动快照当前数据）")
                addProperty("name", name)
            }
        }.getOrElse { resultJson(false, "写入恢复标记失败：${it.message}") }
    }

    /** 取消已登记的恢复（用户改主意了）。 */
    fun cancelRestore(): JsonObject =
        if (!pendingFile.isFile) resultJson(true, "当前没有待恢复的请求")
        else if (pendingFile.delete()) resultJson(true, "已取消待恢复请求")
        else resultJson(false, "无法删除恢复标记：${pendingFile.absolutePath}")

    private fun pendingInfo(): JsonObject? {
        if (!pendingFile.isFile) return null
        val o = runCatching { JsonParser.parseString(pendingFile.readText()).asJsonObject }.getOrNull()
            ?: return null
        return JsonObject().apply {
            addProperty("name", o.str("name"))
            addProperty("path", o.str("zip"))
            addProperty("requestedAtMillis", o.long("requestedAtMillis", 0L))
            // 包还在不在：用户可能已经把 zip 挪走/删了，那种情况下重启会静默跳过，
            // 界面必须提前说"文件已不存在"，而不是等重启后什么都没发生
            addProperty("available", File(o.str("zip")).isFile)
        }
    }

    private fun lastRestoreInfo(): JsonObject? {
        if (!lastRestoreFile.isFile) return null
        return runCatching { JsonParser.parseString(lastRestoreFile.readText()).asJsonObject }.getOrNull()
    }

    // ---------------------------------------------------------------- 启动期执行

    /**
     * 启动时应用待恢复请求。**必须在本进程打开加密存储之前调用**。
     *
     * 步骤：
     * 1. 校验 zip（存在 + 结构合法 + 防穿越）；
     * 2. 把当前数据目录快照成 `pre-restore-<stamp>.zip`（回滚点，失败则整体放弃）；
     * 3. 先**解压到暂存目录** `dataDir/.restore-staging/`（不在白名单内，不会被清理误伤）；
     * 4. 暂存解压全部成功后，才清掉白名单内的现有条目并把暂存整体搬进数据目录；
     * 5. 写 `last-restore.json` 并把 pending 删掉。
     *
     * **顺序是"先解压、后清空"，不是"先清空、后解压"**：早先是先删后解，
     * 一旦包读到一半失败，数据目录已经是空的，只能靠回滚包手工救——
     * 用户看到的是"恢复失败，账号全没了"。暂存目录让"删"变成最后一步，
     * 那时所有字节都已落盘，只剩下同盘移动这种近乎不会失败的操作。
     *
     * 任一步失败都保留 pending（下次启动还能重试）并把原因写进 last-restore.json，
     * 界面在"上次恢复"一栏里能看见它——静默失败是最坏的结果。
     *
     * @return 一句话结果，null 表示没有待恢复请求。
     */
    fun applyPending(): String? {
        if (!pendingFile.isFile) return null
        val req = runCatching { JsonParser.parseString(pendingFile.readText()).asJsonObject }.getOrNull()
        val reqName = req?.str("name").orEmpty()
        val zipPath = req?.str("zip").orEmpty()
        val zip = File(zipPath)
        fun fail(msg: String): String {
            writeLast(true, msg, reqName)
            return msg
        }
        if (zipPath.isEmpty() || !zip.isFile) return fail("待恢复的备份文件已不存在：$zipPath")
        val v = validateZip(zip)
        if (!v.ok) return fail("备份包校验失败：${v.error}")

        // 1) 回滚点：先把现状整体备份一次。失败就不继续——没有回滚点的替换不接受。
        val rollback = create(includeCallLogs = true)
        if (rollback.get("ok")?.asBoolean != true) {
            return fail("恢复前的自动快照失败，已放弃恢复：${rollback.str("message")}")
        }
        val rollbackName = rollback.str("name")

        // 2) 解压到暂存目录（现有数据此时一个字节都没动）
        val staging = File(dataDir, STAGING_DIR)
        runCatching { staging.deleteRecursively() }
        staging.mkdirs()
        var restored = 0
        try {
            ZipFile(zip).use { zf ->
                val entries = zf.entries()
                while (entries.hasMoreElements()) {
                    val e = entries.nextElement()
                    if (e.isDirectory) continue
                    if (e.name == MANIFEST_NAME) continue
                    if (!safeEntry(e.name)) continue
                    val out = File(staging, e.name)
                    out.parentFile?.mkdirs()
                    zf.getInputStream(e).use { ins -> FileOutputStream(out).use { ins.copyTo(it) } }
                    restored++
                }
            }
        } catch (e: Exception) {
            runCatching { staging.deleteRecursively() }
            return fail("解压失败（现有数据未改动，可重试）：${e.message}")
        }
        if (restored == 0) {
            runCatching { staging.deleteRecursively() }
            return fail("备份包里没有任何可恢复条目（现有数据未改动）")
        }

        // 3) 到这里才清空 —— 所有字节已落盘，剩下的只是同盘移动
        for (top in snapshotTopLevel()) {
            val f = File(dataDir, top)
            if (f.exists()) runCatching { f.deleteRecursively() }
        }
        // 4) 暂存整体搬进数据目录
        try {
            staging.listFiles()?.forEach { src ->
                val dst = File(dataDir, src.name)
                if (dst.exists()) dst.deleteRecursively()
                if (!src.renameTo(dst)) src.copyRecursively(dst, overwrite = true)
            }
        } catch (e: Exception) {
            return fail("移入失败（回滚包 $rollbackName 可完整还原）：${e.message}")
        }
        runCatching { staging.deleteRecursively() }

        pendingFile.delete()
        val msg = "已从 $reqName 恢复 $restored 个条目；恢复前快照为 $rollbackName"
        writeLast(false, msg, reqName, rollbackName)
        return msg
    }

    private fun writeLast(
        failed: Boolean,
        message: String,
        source: String,
        rollback: String = "",
    ) {
        runCatching {
            lastRestoreFile.writeText(JsonObject().apply {
                addProperty("atMillis", System.currentTimeMillis())
                addProperty("failed", failed)
                addProperty("message", message)
                addProperty("source", source)
                addProperty("rollback", rollback)
                addProperty("appVersion", APP_VERSION)
            }.toString())
        }
    }

    // ---------------------------------------------------------------- 校验

    private data class Check(val ok: Boolean, val error: String = "")

    /**
     * 结构校验：能打开、有清单、所有条目路径安全。
     *
     * 不做"必须有 secure/ 或 master.key"这种强校验——空数据目录的备份是合法的
     * （用户可能就是想清空重来），拒绝它只会让"恢复出厂"没法走。
     */
    private fun validateZip(f: File): Check {
        return runCatching {
            ZipFile(f).use { zf ->
                var manifest = false
                var unsafe = ""
                val entries = zf.entries()
                while (entries.hasMoreElements()) {
                    val e = entries.nextElement()
                    if (e.name == MANIFEST_NAME) manifest = true
                    if (!e.isDirectory && !safeEntry(e.name) && unsafe.isEmpty()) unsafe = e.name
                }
                when {
                    unsafe.isNotEmpty() -> Check(false, "包含非法路径：$unsafe")
                    !manifest -> Check(false, "不是本程序生成的备份（缺少 $MANIFEST_NAME）")
                    else -> Check(true)
                }
            }
        }.getOrElse { Check(false, "${it.javaClass.simpleName}: ${it.message}") }
    }

    /**
     * 条目路径安全：拒绝绝对路径、盘符、`..` 段。
     *
     * 只判断"是否落在数据目录内"不够——Windows 上 `C:\x` 与 `\x` 都是绝对路径，
     * 而 `File(dataDir, "C:\\x")` 在 JVM 上会**忽略父目录**直接指向 C 盘。
     */
    private fun safeEntry(name: String): Boolean {
        if (name.isEmpty()) return false
        if (name.contains('\u0000')) return false
        val norm = name.replace('\\', '/')
        if (norm.startsWith("/")) return false
        if (norm.length > 2 && norm[1] == ':') return false
        return norm.split('/').none { it == ".." || it == "." }
            && norm.split('/').firstOrNull() != ""
    }

    /** 读清单：返回 (创建时间, 清单对象)。读不出来就回落到文件 mtime。 */
    private fun readManifest(f: File): Pair<Long, JsonObject>? = runCatching {
        ZipFile(f).use { zf ->
            val e = zf.getEntry(MANIFEST_NAME) ?: return@use null
            val text = zf.getInputStream(e).use { it.readBytes().toString(Charsets.UTF_8) }
            val o = JsonParser.parseString(text).asJsonObject
            (o.long("createdAtMillis", f.lastModified())) to o
        }
    }.getOrNull()

    companion object {
        /** 清单条目名。带 `aigw-` 前缀避免与数据目录里任何真实文件名冲突。 */
        const val MANIFEST_NAME = "aigw-backup-manifest.json"

        /** 待恢复标记（放在数据目录里，启动时读）。 */
        const val PENDING_NAME = ".restore-pending.json"

        /** 上次恢复结果（界面展示用）。 */
        const val LAST_RESTORE_NAME = ".last-restore.json"

        /** 恢复解压的暂存目录：**必须在白名单之外**，否则"清空白名单"会把暂存一起删掉。 */
        const val STAGING_DIR = ".restore-staging"

        /** 人对人可读的体积。 */
        fun sizeText(bytes: Long): String = when {
            bytes < 1024 -> "$bytes B"
            bytes < 1024 * 1024 -> "%.1f KB".format(bytes / 1024.0)
            else -> "%.1f MB".format(bytes / 1024.0 / 1024.0)
        }
    }
}
