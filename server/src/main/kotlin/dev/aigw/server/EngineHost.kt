package dev.aigw.server

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import dev.aigw.core.gateway.GatewayEngine
import dev.aigw.core.gateway.ProviderInfo
import dev.aigw.core.provider.CreditUnit
import dev.aigw.core.usage.LogLine
import dev.aigw.desktop.AutoRouteManager
import dev.aigw.desktop.createDesktopStore
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 面向 WebView2 前端的应用服务层。
 *
 * 与旧 Swing 壳的关系：**同一个 GatewayEngine + 同一份加密存储**，只是把「怎么显示」
 * 从 Swing 自绘换成了浏览器渲染。账号、额度、路由组、调用记录全部原样复用，
 * 迁移后不需要重新登录任何供应商。
 *
 * 三条设计约束：
 * 1. **写操作串行**（[mutate]）：HTTP 是并发的，core 的账号池/路由组变更不是为并发
 *    设计的。读操作不加锁——它们读的全是内存快照。
 * 2. **快照与日志分开**：state 2 秒一拍（小），logs 按 seq 增量（大且高频）。
 *    早先把日志塞进 state，一次心跳几十 KB，界面直接卡。
 * 3. **展示口径与旧界面一致**：所有数字在这里算好，前端不做任何"猜"。
 *    换壳不该让「今日请求数」变一个值——那种偏差最难排查。
 */
class EngineHost(val dataDir: File) {

    /** 实例身份（由 Main 在拿到 [InstanceScope] 后填）。默认按「主实例」处理。 */
    @Volatile var derived: Boolean = false
    @Volatile var uiPort: Int = 8792

    /** 进程启动时刻（供 /ui/ping 报运行时长）。 */
    val startedAtMillis: Long = System.currentTimeMillis()

    /**
     * 与旧 desktop 完全相同的装配方式：加密存储 + 不预载历史调用日志（冷启动更快）。
     *
     * `onLog` 只负责转发到 stdout：core 内部 `log()` 已经先写进 `requestLog`
     * （界面日志页的数据源）再回调这里，在这里再写一遍就会每条日志重复两次。
     */
    val engine: GatewayEngine = GatewayEngine(
        createDesktopStore(dataDir),
        preloadCallLogs = false,
        spillDir = null,
        onLog = { line -> println("[aigw] $line") },
    )

    val autoRoute = AutoRouteManager(engine, dataDir)

    /** 写操作串行锁。 */
    private val writeLock = Any()

    fun <T> mutate(block: () -> T): T = synchronized(writeLock, block)

    // ---------------------------------------------------------------- 模型数缓存

    /**
     * 模型计数缓存。
     *
     * **为什么必须有这一层**：core 的 `cachedExposedModels()` 名字像纯读缓存，
     * 实际内部会走 `groupModels()` → `models()` → `modelsStreaming{}`，
     * 也就是「每个供应商提交一次拉取任务」再聚合。实测单次 300–350ms，
     * 冷启动第一次 2.4 秒。界面心跳 2 秒一拍，等于每两秒就让服务端做一次
     * 全供应商聚合——这就是「主界面很卡」的真正来源（不是渲染，是心跳在打上游）。
     *
     * 所以这里在管理面自己维护一份快照：后台线程按「目录空时勤刷、有内容后 5 分钟一次」
     * 的节奏更新，心跳只读字段（微秒级）。core 一行不改——它每天与上游同步，
     * 改它会在下次 sync-core 时冲突。
     */
    @Volatile
    private var modelMeta: ModelMeta = ModelMeta.EMPTY

    /**
     * 模型计数快照。
     *
     * [providers] 只统计真实供应商目录，**排除 `group/xxx` 路由组投影**：
     * 它们不是上游模型，混进「模型数」会让「一个模型都没拉」显示成「1 个」——
     * 用户按这个数字去模型页找一个不存在的模型，是最典型的误导。
     *
     * @param count      真实上游模型数
     * @param groupCount 路由组投影数（单独展示，不与上游目录相加）
     */
    private data class ModelMeta(
        val count: Int,
        val groupCount: Int,
        val byProvider: Map<String, Int>,
    ) {
        val hasAny: Boolean get() = count > 0
        companion object {
            val EMPTY = ModelMeta(0, 0, emptyMap())
        }
    }

    private val metaExecutor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "aigw-model-meta").apply { isDaemon = true }
    }

    /** 目录还没内容的连续尝试次数（上限后降到低频，避免一直打上游）。 */
    @Volatile
    private var metaMissCount = 0

    init {
        // 立刻在后台跑一次（不阻塞启动），之后按 refreshDelaySeconds() 自行排下一轮
        metaExecutor.execute { refreshModelMeta() }
    }

    /**
     * 下一轮刷新的延迟：目录还空着时 30 秒（刚装/刚登录，等它出来），
     * 有内容后 5 分钟（够新，又不至于每分钟都去聚合 11 家供应商）。
     */
    private fun nextMetaDelaySeconds(): Long {
        if (modelMeta.hasAny) return 300L           // 有内容：5 分钟一次足矣
        if (metaMissCount < 5) return 10L           // 刚启动，账号/目录还在加载：10 秒重试
        if (metaMissCount < 12) return 60L          // 仍然空：退回一分钟，最多再试 7 次
        return 1_200L                               // 确实没有目录：20 分钟一次，别再打上游
    }

    private fun scheduleNextMetaRefresh(delaySeconds: Long) {
        if (metaExecutor.isShutdown) return
        metaExecutor.schedule({ refreshModelMeta() }, delaySeconds, TimeUnit.SECONDS)
    }

    /** 重新计算模型数快照。失败保留上一份（宁可显示旧数字，也不要把界面置空）。 */
    fun refreshModelMeta() {
        runCatching {
            // 这里用 `exposedModels()` 而不是 `cachedExposedModels()`：本条跑在
            // [metaExecutor] 后台线程上，允许它按 core 的 5 秒预算去聚合一次上游
            // （快照失效时先返回旧值、后台再刷）。心跳路径永远只读 [modelMeta] 字段，
            // 所以「聚合一次」只会发生在这个线程，不会拖住界面。
            val all = engine.exposedModels()
            // 路由组（`group/auto` 之类）不是上游模型：把它们算进「模型数」会让
            // 「一个模型都没拉」显示成「1 个」，用户按这个数字去模型页找一个不存在的模型。
            val groups = all.count { it.providerId.startsWith(GROUP_PREFIX) }
            val real = all.filterNot { it.providerId.startsWith(GROUP_PREFIX) }
            ModelMeta(
                count = real.size,
                groupCount = groups,
                byProvider = real.groupBy { it.providerId }.mapValues { it.value.size },
            )
        }.onSuccess { meta ->
            modelMeta = meta
            metaMissCount = if (meta.hasAny) 0 else metaMissCount + 1
        }
        scheduleNextMetaRefresh(nextMetaDelaySeconds())
    }

    /**
     * 让调用方（如「拉取模型目录」之后）立刻刷新，不必等下一个周期。
     * 同时把连续落空计数清零——用户刚点过拉取，值得再试一次。
     */
    fun invalidateModelMeta() {
        metaMissCount = 0
        metaExecutor.execute { refreshModelMeta() }
    }

    private companion object {
        /** 与 `RoutingGroupSettings.PREFIX` 同值；这里只用它区分「上游模型」与「路由组投影」。 */
        const val GROUP_PREFIX = "group/"
    }

    /**
     * 记一条**界面侧**日志（网关自身的事件不经过这里）。
     *
     * 只用于 shell/管理面自己的事件，比如「这个 UI 请求花了 3 秒」——
     * 那些不属于网关调用链，但排查「点一下卡住」必须看得见。
     */
    fun log(text: String) {
        println("[aigw-ui] $text")
        runCatching { engine.requestLog.warn(text) }
    }

    /** 关停后台线程（进程退出时调用；不调用也能靠 daemon 线程自然结束）。 */
    fun shutdown() {
        metaExecutor.shutdownNow()
    }

    /**
     * 取日志行。
     *
     * 水位由**调用方**传（`since`），不在服务端保存状态：
     * 服务端持有水位的话，页面刷新（F5 / 关窗重开）后就永远拿不到历史，
     * 而且多个标签页会互相把水位顶高——排查「日志页一直空白」就是这个原因。
     *
     * @param since 上次拿到的最大 seq；-1 表示要全量（首次进入日志页）
     */
    fun logsSince(since: Long, limit: Int = 300): List<LogLine> {
        val newestFirst = engine.requestLog.lines()
        if (since < 0) return newestFirst.take(limit).reversed()
        return newestFirst.takeWhile { it.seq > since }.take(limit).reversed()
    }

    // ---------------------------------------------------------------- 概览快照

    /**
     * 更新检查器。
     *
     * 放在 host 上而不是新建一个全局单例：它需要读 [APP_VERSION]，
     * 也要跟着实例生命周期走（派生实例各查各的，缓存落盘各在数据目录）。
     */
    internal val updateChecker = UpdateChecker(dataDir)

    /**
     * 强制更新闸门是否落下。
     *
     * 判定口径全部在 [UpdateChecker]（版本更高 + force/minVersion + 有下载入口），
     * 这里只负责**执行**：闸门落下时网关必须保持停止。
     *
     * 为什么由服务端执行而不是只靠前端弹窗：弹窗是最容易绕过的一层——
     * 用户完全不用看界面，客户端直接请求 `127.0.0.1:8790/v1` 就照常能用。
     * 「禁止更新」必须等于「禁止服务」，否则那两个字没有意义。
     */
    val gateClosed: Boolean get() = updateChecker.gateClosed

    /**
     * 确保强制更新闸门落到实际状态。
     *
     * 闸门已落但网关还在跑时**主动停掉**它。设计成幂等且随时可调：
     * 后台更新检查完成、界面心跳、网关启动入口都会调它。
     *
     * @return true 表示本次调用实际停掉了网关（调用方据此记日志）
     */
    fun enforceGate(): Boolean {
        if (!gateClosed) return false
        if (!runCatching { engine.isRunning() }.getOrDefault(false)) return false
        log("强制更新闸门已落，停止网关：${updateChecker.gateReason}")
        runCatching { engine.stop() }
        return true
    }

    /**
     * 概览快照：一次 HTTP 往返把整页需要的数字全部带回来。
     *
     * 拆成几个小函数而不是一个大方法：这份快照有 12 个区块，原先全塞在
     * 一个 200 行的 `snapshot()` 里，任何一处字段改名都要滚屏才能确认前后一致。
     *
     * @param includeModels true 时额外拉一次上游模型目录（得等几秒，只在模型页用）
     */
    fun snapshot(includeModels: Boolean = false): JsonObject {
        val s = engine.status()
        val obj = JsonObject()
        obj.addProperty("version", APP_VERSION)
        obj.addProperty("running", s.running)
        obj.addProperty("port", s.port)
        obj.addProperty("localUrl", s.localUrl)
        obj.addProperty("missingApiKey", s.missingApiKey)
        obj.addProperty("dataDir", dataDir.absolutePath)
        // 实例身份：同一个窗口模板可能同时开多份（每份一个数据目录），
        // 界面靠这两个字段区分「这是派生实例还是主实例」，外壳靠 dataDir 判断
        // 当前端口上的后端是不是自己那份（见 shell 的 IsUiAliveFor）。
        obj.addProperty("derived", derived)
        obj.addProperty("uiPort", uiPort)
        obj.add("pool", poolJson())
        obj.add("today", todayJson())
        obj.addProperty("yesterdayRequests", yesterdayRequests())
        obj.add("trend", trendJson())
        obj.add("providers", providersJson())
        obj.add("accounts", accountsJson())
        obj.add("modelsMeta", modelsMetaJson())
        obj.add("auto", autoJson())
        obj.add("settings", settingsJson())
        obj.add("clientKeys", clientKeysJson())
        obj.add("recentCalls", recentCallsJson())
        obj.add("providerStats", providerStatsJson())
        obj.add("checkin", JsonObject().apply {
            addProperty("doneToday", runCatching { engine.autoCheckin.doneToday() }.getOrDefault(false))
        })
        // 更新状态只读**已缓存**的结果（peek 不发网络请求）：
        // 心跳 2 秒一拍，这里若直接调 check()，每拍都会卡 8 秒在 GitHub 上。
        // 真正的联网检查由 Main 的后台线程与 /ui/update/check 触发。
        obj.add("update", updateChecker.peek())
        // 顺手执行一次闸门：后台检查刚判定出强制更新、而网关还活着时，
        // 2 秒内就会在这里被停掉——不依赖用户回概览页看那个弹窗。
        // 放最后是因为它可能改 running 状态，上面那些字段要读被它改之前的值。
        enforceGate()
        if (includeModels) obj.add("models", fullModelsJson())
        return obj
    }

    private fun poolJson(): JsonObject {
        val p = engine.status().pool
        return JsonObject().apply {
            addProperty("total", p.total)
            addProperty("usable", p.usable)
            addProperty("disabled", p.disabled)
            addProperty("disabledByUser", p.disabledByUser)
            addProperty("totalCredits", p.totalCredits)
            addProperty("creditsKnown", p.creditsKnown)
            addProperty("percentKnown", p.percentKnown)
        }
    }

    private fun todayJson(): JsonObject {
        val t = engine.status().today
        return JsonObject().apply {
            addProperty("requests", t.requests)
            addProperty("success", t.success)
            addProperty("failed", t.failed)
            addProperty("aborted", t.aborted)
            addProperty("promptTokens", t.promptTokens)
            addProperty("completionTokens", t.completionTokens)
            addProperty("totalTokens", t.totalTokens)
        }
    }

    /** 昨日请求数：前端算涨跌百分比用。取不到就当 0（界面显示「无昨日数据可对比」）。 */
    private fun yesterdayRequests(): Long = runCatching {
        engine.callLogStore.dailyStats(System.currentTimeMillis(), 2).firstOrNull()?.requests ?: 0L
    }.getOrDefault(0L)

    private fun trendJson(): JsonObject {
        val stats = runCatching {
            engine.callLogStore.dailyStats(System.currentTimeMillis(), 14)
        }.getOrDefault(emptyList())
        return JsonObject().apply {
            add("prompt", JsonArray().apply { stats.forEach { add(it.promptTokens) } })
            add("completion", JsonArray().apply { stats.forEach { add(it.completionTokens) } })
        }
    }

    /**
     * 供应商（拓扑与容量分布的数据源）。
     *
     * 权重口径：有调用按调用占比，无调用按可用账号占比，下限 0.08
     * （完全没调用过的供应商线也要看得出「连着」，否则拓扑看起来像断了）。
     */
    private fun providersJson(): JsonArray {
        val providers = engine.providers()
        val callCounts = engine.callLogStore.list().take(20)
            .groupBy { it.providerId.lowercase() }.mapValues { it.value.size }
        val activeCounts = runCatching { engine.activeRequests.snapshot() }.getOrDefault(emptyList())
            .groupBy { it.providerId.lowercase() }.mapValues { it.value.size }
        val totalOfCalls = callCounts.values.sum()
        val totalUsable = providers.filter { it.accountCount > 0 }
            .sumOf { it.usableCount }.coerceAtLeast(1)

        return JsonArray().apply {
            providers.forEach { p: ProviderInfo ->
                val calls = callCounts[p.id.lowercase()] ?: 0
                add(JsonObject().apply {
                    addProperty("id", p.id)
                    addProperty("name", p.displayName.ifEmpty { p.id.uppercase() })
                    addProperty("authKind", p.authKind.name)
                    addProperty("enabled", p.enabled)
                    addProperty("accountCount", p.accountCount)
                    addProperty("usableCount", p.usableCount)
                    addProperty("custom", p.custom)
                    addProperty("capabilities", p.capabilities.joinToString(",") { it.name })
                    // 媒体能力单列：前端「媒体实测」页要据此提示「当前有没有可用的
                    // 图像/转写供应商」。从 capabilities 字符串里现解析一遍容易漏掉
                    // 枚举改名，直接从 registry 问。
                    addProperty("image", engine.registry.get(p.id)?.supportsImageGeneration == true)
                    addProperty("audio", engine.registry.get(p.id)?.supportsAudioTranscription == true)
                    addProperty("callCount", calls)
                    addProperty("activeCount", activeCounts[p.id.lowercase()] ?: 0)
                    addProperty("weight",
                        if (totalOfCalls > 0) {
                            (calls.toFloat() / totalOfCalls).coerceIn(0.08f, 1f)
                        } else {
                            (p.usableCount.toFloat() / totalUsable).coerceIn(0.08f, 1f)
                        })
                })
            }
        }
    }

    private fun accountsJson(): JsonArray = JsonArray().apply {
        engine.accounts().forEach { a ->
            add(JsonObject().apply {
                addProperty("providerId", a.providerId)
                addProperty("uid", a.uid)
                addProperty("nickname", a.nickname)
                addProperty("credits", a.credits)
                addProperty("creditsKnown", a.creditsKnown)
                addProperty("creditUnit", a.creditUnit)
                addProperty("detail", a.detail)
                addProperty("reason", a.reason)
                addProperty("disabled", a.disabled)
                addProperty("enabled", a.enabled)
                addProperty("raised", a.raised)
            })
        }
    }

    /**
     * 模型计数（**只读后台快照，绝不打上游**）。
     *
     * 早先这里直接调 `engine.cachedExposedModels()`，它内部会聚合全部供应商
     * （单次 300–350ms，冷启动 2.4s）。心跳 2 秒一拍 = 每两秒一次全量聚合，
     * 这就是「主界面卡」的真正原因。现在由 [metaExecutor] 每分钟刷一次，
     * 心跳只读字段（微秒级）。
     */
    private fun modelsMetaJson(): JsonObject {
        val meta = modelMeta
        return JsonObject().apply {
            addProperty("count", meta.count)
            addProperty("groups", meta.groupCount)
            addProperty("snapshot", true)
            add("byProvider", JsonObject().apply {
                meta.byProvider.forEach { (k, v) -> addProperty(k, v) }
            })
        }
    }

    private fun fullModelsJson(): JsonArray {
        val all = runCatching { engine.exposedModels() }.getOrDefault(emptyList())
        return JsonArray().apply {
            all.forEach { m ->
                add(JsonObject().apply {
                    addProperty("id", m.fullId)
                    addProperty("name", m.model.name)
                    addProperty("providerId", m.providerId)
                    addProperty("cached", m.cached)
                })
            }
        }
    }

    private fun autoJson(): JsonObject {
        // 忽略大小写取 auto 组：组名是用户可改的，"Auto" 与 "auto" 应当视作同一个组，
        // 否则对方把组名写成 Auto 时，智能路由页会显示"候选链 0 个"（读不到成员）。
        val group = engine.routingGroupSettings().groups.firstOrNull { it.id.equals("auto", ignoreCase = true) }
        val (names, total) = autoRoute.chainSummary()
        return JsonObject().apply {
            addProperty("enabled", autoRoute.enabled())
            addProperty("groupEnabled", autoRoute.groupEnabled())
            addProperty("chainCount", autoRoute.chainCount())
            addProperty("summary", names.joinToString(" → "))
            addProperty("candidates", total)
            // 完整候选链：前端「智能路由」页要能编辑顺序，必须拿到全部成员
            add("chain", JsonArray().apply {
                group?.members?.sortedByDescending { it.priority }?.forEach { m ->
                    add(JsonObject().apply {
                        addProperty("providerId", m.providerId)
                        addProperty("model", m.model)
                        addProperty("priority", m.priority)
                    })
                }
            })
        }
    }

    private fun settingsJson(): JsonObject {
        val cfg = engine.settings()
        return JsonObject().apply {
            addProperty("port", cfg.port)
            addProperty("apiKey", cfg.apiKey)
            addProperty("allowNoKey", cfg.allowNoKey)
            addProperty("exposeLan", cfg.exposeLan)
            addProperty("onlyUsableModels", cfg.onlyUsableModels)
            addProperty("verboseLogging", cfg.verboseLogging)
            addProperty("logRetentionDays", cfg.logRetentionDays)
            addProperty("callLoggingEnabled", cfg.callLoggingEnabled)
            addProperty("requestLogCapacity", cfg.requestLogCapacity)
            addProperty("maxRotate", cfg.maxRotate)
            addProperty("defaultProvider", cfg.defaultProvider)
        }
    }

    private fun clientKeysJson(): JsonArray = JsonArray().apply {
        runCatching { engine.clientKeyStore.list() }.getOrDefault(emptyList()).forEach { k ->
            add(JsonObject().apply {
                addProperty("id", k.id)
                addProperty("name", k.name)
                addProperty("secret", k.secret)
                addProperty("enabled", k.enabled)
                addProperty("createdAtMillis", k.createdAtMillis)
            })
        }
    }

    private fun recentCallsJson(): JsonArray = JsonArray().apply {
        runCatching { engine.callLogStore.list().take(4) }.getOrDefault(emptyList()).forEach { r ->
            add(JsonObject().apply {
                addProperty("id", r.id)
                // 悬浮提示要展示的明细：时间 / 供应商 / 流式 / 首字延迟 / 输入输出拆分
                addProperty("at", r.startedAtMillis)
                addProperty("providerId", r.providerId)
                addProperty("model", r.model)
                addProperty("upstreamModel", r.upstreamModel)
                addProperty("streaming", r.streaming)
                addProperty("status", r.status.name)
                addProperty("totalTokens", r.totalTokens)
                addProperty("promptTokens", r.promptTokens)
                addProperty("completionTokens", r.completionTokens)
                addProperty("firstByteMillis", r.firstByteMillis)
                addProperty("durationMillis", r.durationMillis)
            })
        }
    }

    /**
     * 按供应商聚合的调用统计（最近 200 条）：请求数 / 成功 / 失败 / 中断 / 成功率。
     *
     * 数据源就是调用记录本身——`ModelHealthWindow` 只有内存最近 50 次且不落盘，
     * 重启就清零；调用记录跨重启保留，统计口径与「调用记录」页完全一致，
     * 用户对得上数。模型维度合并进供应商（排障看「这家最近稳不稳」足够）。
     */
    private fun providerStatsJson(): JsonArray {
        val records = runCatching { engine.callLogStore.list().take(200) }.getOrDefault(emptyList())
        val providers = engine.providers()
        data class Agg(var req: Long = 0, var ok: Long = 0, var fail: Long = 0, var abort: Long = 0,
                       var tokens: Long = 0, var durTotal: Long = 0, var lastAt: Long = 0)
        val agg = LinkedHashMap<String, Agg>()
        for (r in records) {
            val a = agg.getOrPut(r.providerId) { Agg() }
            a.req++
            when (r.status) {
                dev.aigw.core.usage.CallStatus.SUCCESS -> a.ok++
                dev.aigw.core.usage.CallStatus.FAILED -> a.fail++
                dev.aigw.core.usage.CallStatus.ABORTED -> a.abort++
            }
            a.tokens += r.totalTokens
            a.durTotal += r.durationMillis
            if (r.startedAtMillis > a.lastAt) a.lastAt = r.startedAtMillis
        }
        return JsonArray().apply {
            // 没有调用记录的供应商也列出（0 次调用），与供应商页顺序一致
            val order = providers.map { it.id } + agg.keys.filter { k -> providers.none { it.id == k } }
            order.distinct().forEach { pid ->
                val a = agg[pid] ?: Agg()
                add(JsonObject().apply {
                    addProperty("providerId", pid)
                    addProperty("name", providers.find { it.id == pid }?.let { it.displayName } ?: pid)
                    addProperty("requests", a.req)
                    addProperty("success", a.ok)
                    addProperty("failed", a.fail)
                    addProperty("aborted", a.abort)
                    addProperty("successRate", if (a.req > 0) "%.1f".format(a.ok * 100.0 / a.req) else "")
                    addProperty("totalTokens", a.tokens)
                    addProperty("avgMillis", if (a.req > 0) a.durTotal / a.req else 0L)
                    addProperty("lastAt", a.lastAt)
                })
            }
        }
    }
}

/** 版本号：界面左上角与「关于」共用。改版本时只改这一处。
 *
 * **改这里必须同步改更新源仓库的 update.json**：
 * 本值即客户端判定「是否有新版」的基准（见 [UpdateChecker]）。
 * 只升这里不升清单 → 所有已装实例立刻看到"有新版本"；只升清单不升这里 → 永远不提示。 */
const val APP_VERSION = "0.9.9"

/** 额度单位转成前端显示用的后缀。 */
fun unitSuffix(unit: String): String = when (unit) {
    CreditUnit.PERCENT -> "%"
    CreditUnit.CREDITS, "" -> ""
    else -> unit
}
