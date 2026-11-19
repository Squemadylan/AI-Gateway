package dev.aigw.server

import fi.iki.elonen.NanoHTTPD
import java.io.File
import java.time.Duration
import java.time.LocalTime
import java.time.ZonedDateTime
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import kotlin.system.exitProcess

/**
 * WebView2 版 AI Gateway 的进程入口。
 *
 * 和旧 Swing 版的关系：**同一个 :core 引擎、同一份数据目录**，只是界面层从
 * Swing 自绘换成 WebView2 里的 HTML。启动时先拉起本模块的本地管理 API，
 * 再由外壳 C# 进程（AI Gateway.exe）创建窗口指向它。
 *
 * 单实例与端口见 [InstanceScope]：锁是**数据目录下的文件锁**（不再是固定端口 8791），
 * UI 端口默认 8792、派生目录按哈希换到 18xxx，并写进数据目录的 `.instance.json`
 * 供外壳读取。因此不同数据目录的两个实例可以同时运行，互不抢端口。
 *
 * 参数（外壳与开发态都用这一套）：
 * ```
 *   --data <dir>   数据目录（默认 %APPDATA%\AIGateway\data，与旧版一致，账号直接沿用）
 *   --port <n>     UI API 端口（默认按数据目录派生；显式指定时优先）
 *   --no-browser   只起服务不开浏览器（外壳自己开 WebView2 时用）
 * ```
 */
private const val DEFAULT_UI_PORT = 8792

/** 自动签到的触发时刻（本地时间）。 */
private const val CHECKIN_HOUR = 10

fun main(args: Array<String>) {
    val dataDir = resolveDataDir(args)

    // 把数据目录暴露给 core：Antigravity 的 OAuth 客户端凭据不写死在源码里
    // （GitHub push protection 会把 installed-app 的 client_secret 判为泄漏），
    // 改为从 <dataDir>/antigravity-oauth.json 或环境变量读取。
    System.setProperty(dev.aigw.core.provider.antigravity.AntigravityProvider.DATA_DIR_PROPERTY, dataDir.absolutePath)

    // 数据目录级单实例锁：同一份加密存储只能被一个进程写。
    // 旧版用的是全局固定端口 8791，导致换目录跑第二个实例必被挡——那是隔离残留的根因。
    val scope = try {
        InstanceScope.acquire(dataDir)
    } catch (e: InstanceScope.AlreadyRunning) {
        println("[aigw-server] 已在运行：${e.message}")
        exitProcess(EXIT_ALREADY_RUNNING)
    } catch (e: Exception) {
        println("[aigw-server] 实例初始化失败：${e.message}")
        exitProcess(EXIT_ALREADY_RUNNING)
    }

    val uiPort = resolvePort(args) ?: scope.uiPort

    // 待恢复的备份**必须在打开加密存储之前落地**。
    //
    // 两个理由：① 上一个进程退出时才会放开 `secure/` 下的文件句柄，能到这一行
    // 说明实例锁已经拿到、旧进程确实不在了；② EngineHost 构造时会立即
    // createDesktopStore()（读 master.key + 打开 secure/），之后再替换文件，
    // 内存里留下的就是旧账号池，表现成「恢复了但界面还是老数据」。
    // 这里的实例只是文件操作，不持有任何 core 状态，与 host.backup 各用各的。
    val restoreNote = BackupManager(dataDir).applyPending()
    if (restoreNote != null) println("[aigw-server] $restoreNote")

    val host = EngineHost(dataDir).also {
        it.derived = scope.derived
        it.uiPort = uiPort
        it.engine.migrateAccounts()
    }

    // 账号池变化后只清理 Auto 链里失效的候选，不打乱用户手动排好的顺序
    host.engine.onAccountsChanged = {
        if (host.autoRoute.enabled()) {
            Thread { runCatching { host.autoRoute.pruneInvalid() } }.apply {
                isDaemon = true
                name = "aigw-prune"
            }.start()
        }
    }

    val webRoot = resolveWebRoot()
    if (!File(webRoot, "index.html").isFile) {
        println("[aigw-server] 前端资源缺失：$webRoot/index.html")
        println("[aigw-server] 请先执行 web 目录下的构建（或在打包时把 web/dist 放到同级 web/）")
        exitProcess(EXIT_NO_WEB)
    }

    val server = UiApiServer(host, webRoot, uiPort)
    silenceNanoHttpdNoise()
    try {
        server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
    } catch (e: Exception) {
        println("[aigw-server] UI 端口 $uiPort 启动失败：${e.message}")
        exitProcess(EXIT_NO_WEB)
    }
    println("[aigw-server] UI  http://127.0.0.1:$uiPort/")
    println("[aigw-server] 数据 $dataDir")
    println("[aigw-server] 资源 $webRoot")
    if (scope.derived) println("[aigw-server] 派生实例：UI 端口 $uiPort（默认目录用 $DEFAULT_UI_PORT）")

    startGateway(host, scope)
    println("[aigw-server] 网关 ${host.engine.localUrl()}")

    // 网关起来之后再刷一次模型数：构造时那次往往太早（账号池/供应商还在加载），
    // 不补这一下，概览「模型数」要等下一个周期才出数字。
    host.invalidateModelMeta()

    // 端口文件要等网关端口最终落定再写：外壳读的是同一份内容。
    scope.writePortFile(host.engine.settings().port, uiPort)

    // 每日 10:00 自动批量签到（单发调度，触发后重排次日；两次之间零唤醒）
    val checkinTimer = scheduleDailyCheckin(host)

    // 启动后延迟 40 秒跑一次更新检查：太早会和「拉模型目录 / 首次登录探测」
    // 抢网络，而且用户此刻多半还在看首屏概览的骨架。40 秒后界面已稳定。
    // 之后每 6 小时一次——GitHub 那边的缓存是 30 分钟，但更新是低频事件，
    // 一天查四次足够，不打扰。
    val updateTimer = scheduleUpdateCheck(host)

    Runtime.getRuntime().addShutdownHook(Thread {
        runCatching { checkinTimer.shutdownNow() }
        runCatching { updateTimer.shutdownNow() }
        runCatching { server.stop() }
        runCatching { host.shutdown() }
        runCatching { host.engine.stop() }
        runCatching { scope.release() }
    })

    if (!args.contains("--no-browser")) openBrowser("http://127.0.0.1:$uiPort/")

    // 前台常驻：等待进程被终止（外壳用 Process 管理生命周期）
    Thread.currentThread().join()
}

private const val EXIT_ALREADY_RUNNING = 1
private const val EXIT_NO_WEB = 2

/**
 * 关掉 NanoHTTPD 自带的 `java.util.logging` 输出。
 *
 * 它把「客户端在响应写完前断开」也记成 SEVERE 并打印完整栈——
 * 而那是**完全正常**的事：WebView2 刷新页面、关窗口、用户点取消，
 * 都会让连接在服务端写回包前消失。日志里一堆 `SocketException:
 * 你的主机中的软件中止了一个已建立的连接` 只会淹没真正的故障。
 *
 * 真正需要看见的异常由 [UiApiServer.serve] 自己捕获并落 `[aigw-ui]` 日志，
 * 所以关掉这层只会丢掉噪音，不会丢掉信息。
 */
private fun silenceNanoHttpdNoise() {
    runCatching {
        java.util.logging.Logger.getLogger("fi.iki.elonen.NanoHTTPD").level =
            java.util.logging.Level.OFF
    }
}

// ---------------------------------------------------------------- 网关启动

/**
 * 网关本体：端口优先级 = 派生实例的协商端口 > settings/gateway.json（默认目录）。
 *
 * 默认目录完全沿用配置值（老用户升级后行为不变）；派生目录拿到的是自己的号，
 * 这样两个实例能同时开着——否则第二个实例的 8790 必然被第一个占住，隔离就是空话。
 */
private fun startGateway(host: EngineHost, scope: InstanceScope.Scope) {
    // 闸门已落（强制更新）就**根本不起服务**。
    // 这是「禁止更新时服务不能被使用」的最终落点：不是起来再停，而是压根不监听 8790，
    // 客户端连连接都建立不了——比起动停，这才没有中间窗口期。
    if (host.gateClosed) {
        println("[aigw-server] 强制更新闸门已落，网关不启动：${host.updateChecker.gateReason}")
        return
    }
    if (scope.derived && scope.gatewayPort != null) {
        host.mutate {
            host.engine.updateSettings(host.engine.settings().copy(port = scope.gatewayPort))
        }
    }
    host.mutate {
        runCatching { host.engine.start() }
            .onFailure { println("[aigw-server] 网关启动失败：${it.message}") }
    }
    if (scope.derived) startGatewayFallback(host, skip = setOf(host.uiPort, 8791))
}

/**
 * 派生实例的网关兜底：首选端口仍绑不上时依次换下一个空位，最多 [ATTEMPTS] 次。
 *
 * 只在**派生目录**走这条（默认目录仍是一句 `start()`，行为零变化）。
 * 换端口用 `updateSettings` 写盘——派生目录本来就是临时验证目录，记下端口
 * 反而让它重启后能落回同一号；默认目录的配置绝不被这里改写。
 */
private fun startGatewayFallback(host: EngineHost, skip: Set<Int>) {
    var tried = skip
    repeat(GATEWAY_PORT_ATTEMPTS) {
        if (host.engine.isRunning()) return
        val next = InstanceScope.nextFreePort(host.engine.settings().port, tried) ?: run {
            println("[aigw-server] 没有可用网关端口，放弃启动网关（管理面仍可用）")
            return
        }
        tried = tried + next
        host.mutate {
            host.engine.updateSettings(host.engine.settings().copy(port = next))
            runCatching { host.engine.start() }
                .onFailure { println("[aigw-server] 网关端口 $next 不可用：${it.message}") }
        }
        if (host.engine.isRunning()) {
            println("[aigw-server] 网关端口换到 $next")
            return
        }
    }
    println("[aigw-server] 连续 $GATEWAY_PORT_ATTEMPTS 次都起不来，放弃启动网关（管理面仍可用）")
}

private const val GATEWAY_PORT_ATTEMPTS = 12

// ---------------------------------------------------------------- 每日签到

/**
 * 每日 [CHECKIN_HOUR]:00 的自动签到。
 *
 * 用 `ScheduledExecutorService` 的单发延时任务（触发后自行重排），不是 Swing Timer：
 * 后者需要一个 Swing 事件循环，服务端进程里根本没有——原来那版是靠
 * `javax.swing.Timer` 的守护线程勉强跑起来的，打包时还得额外保留 java.desktop 模块。
 * 纯 Java 定时器没有这个依赖，也不必依赖 EDT 是否活着。
 *
 * 启动补签：已经过了 10 点且今天还没签成功，立刻补一次（进程可能在 10 点后才有机会启动）。
 */
private fun scheduleDailyCheckin(host: EngineHost): ScheduledExecutorService {
    val exec = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "aigw-checkin").apply { isDaemon = true }
    }

    fun armNext() {
        val now = ZonedDateTime.now()
        val next = now.toLocalDate()
            .atTime(LocalTime.of(CHECKIN_HOUR, 0))
            .atZone(now.zone)
            .let { candidate -> if (candidate.isAfter(now)) candidate else candidate.plusDays(1) }
        val delayMs = Duration.between(now, next).toMillis().coerceAtLeast(1_000L)
        exec.schedule({
            runCatching { host.engine.autoCheckin.tick(force = false) }
                .onFailure { println("[aigw-server] 自动签到异常：${it.message}") }
            armNext()
        }, delayMs, TimeUnit.MILLISECONDS)
    }

    armNext()

    val now = ZonedDateTime.now()
    val passedToday = now.hour >= CHECKIN_HOUR
    if (passedToday && !runCatching { host.engine.autoCheckin.doneToday() }.getOrDefault(true)) {
        exec.execute {
            runCatching { host.engine.autoCheckin.tick(force = false) }
                .onFailure { println("[aigw-server] 启动补签异常：${it.message}") }
        }
    }
    return exec
}

// ---------------------------------------------------------------- 更新检查

/** 启动后第一次检查的延迟（毫秒）。程序打开即查，但避开首屏与供应商探测那几秒。 */
private const val UPDATE_FIRST_DELAY_MS = 6_000L

/** 之后的检查间隔：6 小时。 */
private const val UPDATE_INTERVAL_MS = 6L * 60 * 60 * 1000

/**
 * 后台更新检查。
 *
 * **为什么不在心跳里做**：`/ui/state` 是 2 秒一拍，而这里要发一次外网请求
 * （GitHub，最长 8 秒）。放在心跳里等于每两秒卡一次界面。所以拆成后台定时：
 * 后台把结果写进 [UpdateChecker] 的缓存，心跳只读 `peek()`（微秒级）。
 *
 * **触发时机**：程序打开后 6 秒一次（"程序打开时检查是否有更新"），之后每 6 小时。
 * 首查延迟从 40 秒压到 6 秒——之前那个值是为了避开「拉模型目录 / 首次登录探测」，
 * 但用户明确要求开机就查，实际测下来 6 秒时首屏已经画完，两者不冲突。
 *
 * **强制态出现后整个定时器停掉**：既然已经判定「必须更新才能用」，
 * 继续每 6 小时打一次 GitHub 既没意义又白耗网络。闸门靠闸门文件持久化，
 * 不依赖这个线程继续跑。定时器只在没命中强制更新时才自我重排。
 *
 * 失败**不重试、不弹窗**：更新检查失败不该打扰用户，下一次周期自然重来。
 */
private fun scheduleUpdateCheck(host: EngineHost): ScheduledExecutorService {
    val exec = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "aigw-update").apply { isDaemon = true }
    }

    fun tick() {
        runCatching { host.updateChecker.check(refresh = true) }
            .onSuccess { r ->
                val latest = r.get("latest")?.takeIf { !it.isJsonNull }?.asString ?: ""
                if (r.get("hasUpdate")?.asBoolean == true) {
                    println("[aigw-server] 发现新版本 $latest（当前 $APP_VERSION）" +
                        if (r.get("mandatory")?.asBoolean == true) "，强制更新" else "")
                }
                // 判定出强制更新就**立刻**停网关，不等下一次心跳（心跳 2 秒一拍，
                // 但用户可能刚从客户端发起一长串请求，能早停一秒是一秒）。
                runCatching { host.enforceGate() }
                    .onSuccess { stopped ->
                        if (stopped) println("[aigw-server] 网关已因强制更新停止")
                    }
                // 已进强制态：不再重排。状态由闸门文件承载，重启照样拦。
                if (host.gateClosed) {
                    println("[aigw-server] 已进入强制更新态，停止周期检查（装到新版后自动恢复）")
                    return@onSuccess
                }
                // 没进强制态：按 6 小时重排。用 schedule（单发）而不是
                // scheduleWithFixedDelay，才能在强制态出现时干净地停掉。
                runCatching { exec.schedule({ tick() }, UPDATE_INTERVAL_MS, TimeUnit.MILLISECONDS) }
            }
            .onFailure { e ->
                println("[aigw-server] 更新检查异常：${e.message}")
                // 失败也要排下一次，否则断网一次就再也不查了
                runCatching { exec.schedule({ tick() }, UPDATE_INTERVAL_MS, TimeUnit.MILLISECONDS) }
            }
    }

    // 已从闸门文件恢复出强制态（装了旧版重启）→ 一次都不查，直接停
    if (host.gateClosed) {
        println("[aigw-server] 强制更新闸门已在开机时恢复，跳过更新检查")
        return exec
    }

    exec.schedule({ tick() }, UPDATE_FIRST_DELAY_MS, TimeUnit.MILLISECONDS)
    return exec
}

// ---------------------------------------------------------------- 路径与端口解析

/**
 * 前端资源目录。
 *
 * 发布版布局（见 build-web.ps1）：
 * ```
 *   <root>\AI Gateway.exe
 *   <root>\app\*.jar          ← jar 在这里
 *   <root>\web\index.html     ← 资源在这里（与 jar 隔一层，所以要向上两级）
 * ```
 * 开发态则是 `web/dist` 相对当前工作目录。
 *
 * 不能只向上找一级：`app\` 的父目录是 `<root>`，再取 `parentFile.resolve("web")`
 * 才命中；只取一级会落在 `app\web`（不存在），于是报「前端资源缺失」。
 */
private fun resolveWebRoot(): File {
    System.getProperty("aigw.web")?.let { return File(it) }

    // 顶层函数没有隐式 javaClass，必须显式取 MainKt 的类对象
    val codeSource: File? = runCatching {
        File(Class.forName("dev.aigw.server.MainKt").protectionDomain.codeSource.location.toURI())
    }.getOrNull()

    // jar 形态时 location 就是 jar 文件本身；目录形态（gradle run）时是 classes 目录。
    // 关键：**先判断是不是文件**，不能只看 isDirectory——
    // 有些 FileSystem 实现对 jar 的 isDirectory 返回值不可靠，会导致 parentFile 算错一层。
    val jarDir: File? = codeSource?.let {
        if (it.name.endsWith(".jar")) it.absoluteFile.parentFile else it.absoluteFile
    }

    val candidates = listOfNotNull(
        jarDir?.parentFile?.resolve("web"),          // 发布布局
        jarDir?.parentFile?.parentFile?.resolve("web"), // 多一层嵌套
        jarDir?.resolve("web"),                      // 部分打包形态
        File("web/dist"),                            // 开发态（gradlew :server:run）
        File("web"),
    )

    if (System.getenv("AIGW_DEBUG_WEBROOT") != null) {
        println("[aigw-server] codeSource=$codeSource")
        println("[aigw-server] jarDir=$jarDir")
        candidates.forEach { println("[aigw-server]   candidate: $it  index=${File(it, "index.html").isFile}") }
    }

    return candidates.firstOrNull { File(it, "index.html").isFile } ?: File("web/dist")
}

private fun resolveDataDir(args: Array<String>): File {
    val i = args.indexOf("--data")
    if (i >= 0 && i + 1 < args.size) return File(args[i + 1])
    System.getProperty("aigw.data")?.let { return File(it) }
    System.getenv("AIGW_DATA")?.let { return File(it) }
    val base = System.getenv("APPDATA") ?: System.getProperty("user.home")
    return File(base, "AIGateway/data")
}

private fun resolvePort(args: Array<String>): Int? {
    val i = args.indexOf("--port")
    if (i >= 0 && i + 1 < args.size) return args[i + 1].toIntOrNull()?.takeIf { it in 1..65535 }
    System.getProperty("aigw.uiPort")?.toIntOrNull()?.takeIf { it in 1..65535 }?.let { return it }
    return null // 未显式指定就交给 InstanceScope 按数据目录派生
}

/** 打开系统浏览器。失败不算错误（无 GUI 的机器上必然失败），只提示一条。 */
private fun openBrowser(url: String) {
    val ok = runCatching { java.awt.Desktop.getDesktop().browse(java.net.URI(url)) }.isSuccess
    if (!ok) println("[aigw-server] 未能自动打开浏览器，请手动访问 $url")
}
