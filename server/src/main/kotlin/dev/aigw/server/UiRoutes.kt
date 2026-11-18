package dev.aigw.server

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import dev.aigw.core.gateway.CustomProviderConfig
import dev.aigw.core.gateway.GroupMember
import dev.aigw.core.gateway.RoutingGroup
import dev.aigw.core.gateway.RoutingGroupSettings
import dev.aigw.core.provider.ACTION_CHECKIN
import dev.aigw.core.provider.DeviceAuthPoll
import dev.aigw.core.provider.ProviderCapability
import dev.aigw.core.provider.custom.CustomProvider
import dev.aigw.core.failover.AccountStrategy
import dev.aigw.core.failover.ConcurrencyConfig
import dev.aigw.core.gateway.ProviderInfo
import java.io.File

/**
 * 管理面全部业务端点。
 *
 * 这一层不认识 HTTP：入参是 [UiRequest]，出参是 [UiOut]/[UiException]。
 * 好处是「读一个端点要动哪些 core 方法」集中在一个文件里，看路由表就知道全貌；
 * 而 HTTP 骨架（连接、keep-alive、静态资源、错误码）在 [UiApiServer] 里各归各位。
 *
 * 三条硬约定：
 * 1. **所有写操作强制 POST**（[ensurePost]）。原来 GET 也能改数据，
 *    浏览器里任意页面都能构造 `GET /ui/account/delete?...` 把账号删掉。
 * 2. **写操作串行**（[EngineHost.mutate]）。HTTP 是并发的，core 的账号池/路由组
 *    变更不是为并发设计的。读操作不加锁——它们全是快照。
 * 3. **参数错误 → 400**，业务失败 → `{ok:false,message}` 且 200。
 *    前者是调用方的错，后者是"操作没成功但链路正常"，前端只需看 ok 字段。
 */
internal class UiRoutes(private val host: EngineHost) {

    private val engine get() = host.engine

    /**
     * 路由表。key 是 URI（不含 query），value 是处理函数。
     *
     * 用 map 而不是 `when`：新增端点只需插一行，不用改分派逻辑；
     * 也方便直接按 key 遍历做自检（见 [names]）。
     */
    private val table: Map<String, (UiRequest) -> UiOut> = mapOf(
        // ---- 读
        "/ui/state" to { req -> UiOut.Json(host.snapshot(includeModels = req.query.containsKey("models"))) },
        "/ui/models" to {
            // 拉到全量之后顺手刷一次「模型数」缓存：否则概览卡要等最多 60 秒才变
            host.invalidateModelMeta()
            UiOut.Json(modelsJson())
        },
        "/ui/logs" to { req -> UiOut.Json(logsJson(req)) },
        "/ui/calls" to { req -> UiOut.Json(callsJson(req)) },
        "/ui/strategy" to { UiOut.Json(strategySnapshot()) },
        "/ui/ping" to { UiOut.Json(pingJson()) },

        // ---- 网关开关
        // 强制更新闸门落下时**禁止启动**：这两个端点原来是唯一能把网关重新拉起来的地方，
        // 不拦住的话用户点一下「启动」就绕过了整道闸。
        "/ui/gateway/start" to { req ->
            ensurePost(req)
            if (host.gateClosed) {
                UiOut.Json(resultJson(false,
                    "必须更新才能启动网关（当前 ${APP_VERSION}，${host.updateChecker.peek().str("latest")} 已发布）"))
            } else {
                mutate { engine.start() }
            }
        },
        "/ui/gateway/stop" to { req -> ensurePost(req); mutate { engine.stop() } },

        // ---- 账号
        "/ui/credits/refresh" to { req -> ensurePost(req); refreshCredits(req) },
        "/ui/account/enable" to { req -> ensurePost(req); setAccountEnabled(req) },
        "/ui/account/priority" to { req -> ensurePost(req); moveAccount(req) },
        "/ui/account/delete" to { req -> ensurePost(req); deleteAccount(req) },
        "/ui/account/import" to { req -> ensurePost(req); importAccount(req) },
        "/ui/account/export" to { req -> ensurePost(req); exportAccounts() },

        // ---- 登录
        "/ui/login/browser" to { req -> ensurePost(req); browserLogin(req) },
        "/ui/login/poll" to { req -> ensurePost(req); pollDevice(req) },
        "/ui/login/sms/send" to { req -> ensurePost(req); smsSend(req) },
        "/ui/login/sms/complete" to { req -> ensurePost(req); smsComplete(req) },

        // ---- 签到
        "/ui/checkin/all" to { req -> ensurePost(req); checkinAll() },

        // ---- Auto 路由
        "/ui/auto/toggle" to { req -> ensurePost(req); toggleAuto(req) },
        "/ui/auto/chain" to { req -> ensurePost(req); saveChain(req) },
        "/ui/auto/prune" to { req -> ensurePost(req); pruneAuto() },

        // ---- 配置
        "/ui/settings" to { req -> ensurePost(req); saveSettings(req) },
        // 同一个 URI 两用：GET 读全部组（含成员可用性判定），POST 整表覆盖。
        // 路由表按 URI 建 key，方法判定放在处理函数里——读端点没有副作用，
        // 不需要为它单独占一个路径。
        "/ui/groups" to { req -> if (req.isPost) saveGroups(req) else UiOut.Json(groupsJson()) },
        // 单组读写：页面只提交自己正在编辑的那一个组，不用把别的组一起回写。
        // 否则「路由组页」保存时会把 auto 组（由智能路由页维护）覆盖成旧值。
        "/ui/groups/save" to { req -> ensurePost(req); saveGroup(req) },
        "/ui/groups/delete" to { req -> ensurePost(req); deleteGroup(req) },
        // 自定义供应商：界面缺环的一处（settings/custom.json 原先只能手改）。
        // 读端点带「注册状态 + 可解析端点 + 账号数」，写端点**单条**读写，
        // 与路由组同一套理由：整表回写会把另一个窗口正在编辑的条目覆盖成旧值。
        "/ui/custom" to { req -> if (req.isPost) saveCustomConfig(req) else UiOut.Json(customJson()) },
        "/ui/custom/save" to { req -> ensurePost(req); saveCustomConfig(req) },
        "/ui/custom/delete" to { req -> ensurePost(req); deleteCustomConfig(req) },
        "/ui/custom/models" to { req -> ensurePost(req); fetchCustomModels(req) },
        // 「重新登记」：配置在盘上但没进 registry 时（手改过 custom.json，或从
        // 别的实例拷过来）用它补一次登记。不做成 GET 是因为它会改运行时状态。
        "/ui/custom/reload" to { req -> ensurePost(req); reloadCustom() },
        "/ui/keys" to { req -> ensurePost(req); saveKeys(req) },
        "/ui/theme" to { req -> ensurePost(req); saveTheme(req) },
        "/ui/strategy/save" to { req -> ensurePost(req); saveStrategy(req) },
        "/ui/affinity/clear" to { req ->
            ensurePost(req)
            mutate { engine.sessionAffinity.clear() }
            UiOut.Json(resultJson(true, "亲和表已清空"))
        },
        "/ui/cooling/clear" to { req -> ensurePost(req); clearCooling() },

        // ---- 媒体实测
        "/ui/media/image" to { req -> ensurePost(req); MediaProbe(engine).image(req.json) },
        "/ui/media/transcribe" to { req -> ensurePost(req); MediaProbe(engine).transcribe(req.json) },

        // ---- 更新
        // 强制更新的「检查」端点。零服务器：清单是 GitHub 仓库里的一个 update.json，
        // 发布新版只改文件 + commit，客户端 raw 拉取即生效。
        // 带 `refresh=1` 时绕过 30 分钟缓存（概览页「检查更新」按钮走这条）。
        // **刻意做成 POST**：它会发一次外网请求，GET 端点会被浏览器里任意页面
        // 构造请求打出去；而且这是写语义（刷新缓存）。
        "/ui/update/check" to { req -> ensurePost(req); UiOut.Json(host.updateChecker.check(req.query.containsKey("refresh")) ) },
    )

    /** 端点清单（自检与文档用）。 */
    fun names(): Set<String> = table.keys

    /**
     * 分派。未命中的路径抛 404（由 `UiApiServer` 翻成对应状态码）。
     */
    fun handle(req: UiRequest): UiOut {
        val fn = table[req.uri] ?: throw UiException.notFound("未知接口：${req.uri}")
        return fn(req)
    }

    fun has(uri: String): Boolean = table.containsKey(uri)

    // ---------------------------------------------------------------- 基础设施

    /**
     * 写操作统一收口：串行 + 结果归一。
     *
     * 返回值约定：`null` → `{ok:true}`，JsonObject → 原样，String → 当作成功消息。
     */
    private fun mutate(block: () -> Any?): UiOut {
        val out = host.mutate {
            when (val r = block()) {
                null -> okJson()
                is JsonObject -> r
                is String -> resultJson(true, r)
                else -> okJson()
            }
        }
        return UiOut.Json(out)
    }

    // ---------------------------------------------------------------- 读端点

    private fun pingJson(): JsonObject = JsonObject().apply {
        addProperty("ok", true)
        addProperty("version", APP_VERSION)
        addProperty("uiPort", host.uiPort)
        addProperty("dataDir", host.dataDir.absolutePath)
        addProperty("derived", host.derived)
        addProperty("uptimeMs", System.currentTimeMillis() - host.startedAtMillis)
    }

    private fun modelsJson(): JsonObject {
        val exposed = runCatching { engine.exposedModels() }.getOrDefault(emptyList())
        val arr = JsonArray()
        exposed.forEach { m ->
            arr.add(JsonObject().apply {
                addProperty("id", m.fullId)
                addProperty("name", m.model.name)
                addProperty("providerId", m.providerId)
                addProperty("cached", m.cached)
            })
        }
        return JsonObject().apply {
            addProperty("ok", true)
            addProperty("count", arr.size())
            add("models", arr)
        }
    }

    private fun logsJson(req: UiRequest): JsonObject {
        // 增量水位由**前端**保存并通过 since 传上来：服务端持有水位时，
        // 页面刷新或多标签页会把水位顶高，新会话就再也拿不到历史（日志页永久空白）。
        val since = req.query["since"]?.toLongOrNull() ?: -1L
        val limit = req.query["limit"]?.toIntOrNull()?.coerceIn(1, 1000) ?: 300
        val lines = host.logsSince(since, limit)
        val arr = JsonArray()
        lines.forEach {
            arr.add(JsonObject().apply {
                addProperty("seq", it.seq)
                addProperty("at", it.atMillis)
                addProperty("level", it.level)
                addProperty("text", it.text)
            })
        }
        return JsonObject().apply {
            addProperty("ok", true)
            // 空增量时回显 since，避免前端把它写成 -1 之后反复全量拉取
            addProperty("nextSince", lines.lastOrNull()?.seq ?: since)
            add("lines", arr)
        }
    }

    private fun callsJson(req: UiRequest): JsonObject {
        val limit = req.query["limit"]?.toIntOrNull()?.coerceIn(1, 500) ?: 100
        val records = runCatching { engine.callLogStore.list().take(limit) }.getOrDefault(emptyList())
        val arr = JsonArray()
        records.forEach { r ->
            arr.add(JsonObject().apply {
                addProperty("id", r.id)
                addProperty("at", r.startedAtMillis)
                addProperty("providerId", r.providerId)
                addProperty("model", r.model)
                // 实际发给上游的模型（auto/组名展开后的具体模型）；旧记录为空
                addProperty("upstreamModel", r.upstreamModel)
                addProperty("account", r.accountNickname.ifEmpty { r.accountUid })
                addProperty("streaming", r.streaming)
                addProperty("status", r.status.name)
                addProperty("httpStatus", r.httpStatus)
                addProperty("promptTokens", r.promptTokens)
                addProperty("completionTokens", r.completionTokens)
                addProperty("totalTokens", r.totalTokens)
                addProperty("firstByteMillis", r.firstByteMillis)
                addProperty("durationMillis", r.durationMillis)
                addProperty("tries", r.tries)
                addProperty("error", r.error)
                addProperty("requestBody", r.requestBody.take(2000))
                addProperty("responseBody", r.responseBody.take(2000))
                addProperty("rawResponse", r.rawResponse.take(2000))
            })
        }
        return JsonObject().apply { addProperty("ok", true); add("records", arr) }
    }

    /**
     * 高级策略快照。
     *
     * 平铺返回：前端把 failover / affinity / breakers / cooling 直接当顶层字段读，
     * 多包一层 `{strategy:{…}}` 会让每个取值点都要多点一次。
     * `routes`（模型级映射）不下发：可能几百条，且 2 秒一拍白传。
     */
    private fun strategySnapshot(): JsonObject {
        val fo = engine.failoverSettings()
        val affinitySize = runCatching { engine.sessionAffinity.size }.getOrDefault(0)
        val out = JsonObject().apply {
            addProperty("ok", true)
            add("failover", JsonObject().apply {
                addProperty("enabled", fo.enabled)
                addProperty("accountStrategy", fo.accountStrategy.name)
                addProperty("accountCooldownMs", fo.accountCooldownMs)
                add("retry", JsonObject().apply {
                    addProperty("maxAttempts", fo.retry.maxAttempts)
                    addProperty("initialBackoffMs", fo.retry.initialBackoffMs)
                    addProperty("maxBackoffMs", fo.retry.maxBackoffMs)
                    addProperty("backoffMultiplier", fo.retry.backoffMultiplier)
                    addProperty("jitterRatio", fo.retry.jitterRatio)
                })
                add("circuitBreaker", JsonObject().apply {
                    addProperty("failureThreshold", fo.circuitBreaker.failureThreshold)
                    addProperty("openDurationMs", fo.circuitBreaker.openDurationMs)
                    addProperty("halfOpenSuccessCount", fo.circuitBreaker.halfOpenSuccessCount)
                })
                add("concurrency", JsonObject().apply {
                    addProperty("maxPerAccount", fo.concurrency.maxPerAccount)
                    addProperty("maxGlobal", fo.concurrency.maxGlobal)
                    addProperty("queueTimeoutMs", fo.concurrency.queueTimeoutMs)
                })
                add("modelCooldown", JsonObject().apply {
                    addProperty("cooldownMs", fo.modelCooldown.cooldownMs)
                    addProperty("maxCooldownMs", fo.modelCooldown.maxCooldownMs)
                })
                addProperty("routeCount", fo.routes.size)
            })
            add("affinity", JsonObject().apply { addProperty("size", affinitySize) })
            // 只报「非 CLOSED」的供应商，避免 11 家全列一遍占版面
            add("breakers", JsonArray().apply {
                engine.providers().forEach { p ->
                    val st = runCatching { engine.circuitBreakerOf(p.id).currentState().name }
                        .getOrDefault("CLOSED")
                    if (st != "CLOSED") {
                        add(JsonObject().apply {
                            addProperty("providerId", p.id)
                            addProperty("name", p.displayName.ifEmpty { p.id.uppercase() })
                            addProperty("state", st)
                        })
                    }
                }
            })
            add("cooling", JsonArray().apply {
                runCatching { engine.modelCooldownOf().snapshot() }.getOrDefault(emptyMap())
                    .forEach { (key, remaining) ->
                        add(JsonObject().apply {
                            addProperty("key", key)
                            addProperty("remainingMs", remaining)
                        })
                    }
            })
            // 安全防护：core 早就有这一整套（脱敏 / 限速 / 隐私占位符），但界面从来没有入口，
            // 只能改 settings/security.json。隐私脱敏是上游 v2.37.2 新增的能力，默认关闭。
            val sec = engine.securitySettings()
            add("security", JsonObject().apply {
                addProperty("sanitizeEnabled", sec.sanitizeEnabled)
                addProperty("minIntervalMillis", sec.minIntervalMillis)
                addProperty("jitterMillis", sec.jitterMillis)
                addProperty("extraWordsCount", sec.extraWords.size)
                addProperty("privacyRedactionEnabled", sec.privacyRedactionEnabled)
            })
        }
        // 媒体实测页据此提示「有没有可用供应商」，避免用户点了才看到 400。
        // 注意能力不是在 ProviderCapability 里声明的——图像/音频是 Provider 的
        // supports* 属性，从 registry 现取，别去解析 capabilities 字符串。
        out.addProperty("imageProviders", countProvidersBy { p ->
            engine.registry.get(p.id)?.supportsImageGeneration == true
        })
        out.addProperty("audioProviders", countProvidersBy { p ->
            engine.registry.get(p.id)?.supportsAudioTranscription == true
        })
        return out
    }

    private fun countProvidersBy(predicate: (dev.aigw.core.gateway.ProviderInfo) -> Boolean): Int =
        engine.providers().count { p -> p.accountCount > 0 && predicate(p) }

    // ---------------------------------------------------------------- 账号

    /**
     * 额度刷新：并发 2，返回逐账号结果，前端自己汇总。
     *
     * 并发压到 2 而不是更高：上游按账号限流，刷太快反而全体失败；
     * 每个账号的失败原因都单独回传，界面能按账号显示「为什么没刷到」。
     */
    private fun refreshCredits(req: UiRequest): UiOut {
        val providerId = req.str("providerId").ifBlank { null }
        val results = engine.refreshAllCredits(providerId = providerId, parallelism = 2)
        val arr = JsonArray()
        results.forEach { r ->
            arr.add(JsonObject().apply {
                addProperty("providerId", r.providerId)
                addProperty("uid", r.uid)
                addProperty("nickname", r.nickname)
                addProperty("balance", r.balance)
                addProperty("known", r.known)
                addProperty("error", r.error)
                addProperty("unit", r.unit)
            })
        }
        val known = results.count { it.known }
        val out = JsonObject().apply {
            addProperty("ok", true)
            addProperty("summary",
                "已刷新 $known 个账号" + if (results.size > known) "，${results.size - known} 个失败" else "")
            addProperty("known", known)
            addProperty("total", results.size)
            add("results", arr)
        }
        return UiOut.Json(out)
    }

    private fun setAccountEnabled(req: UiRequest): UiOut {
        val p = req.requireStr("providerId")
        val uid = req.requireStr("uid")
        val enabled = req.json.boolOr("enabled", true)
        engine.setAccountEnabled(p, uid, enabled)
        return UiOut.Json(okJson())
    }

    private fun moveAccount(req: UiRequest): UiOut {
        val moved = engine.moveAccountPriority(
            req.requireStr("providerId"), req.requireStr("uid"), req.json.boolOr("up", true),
        )
        return UiOut.Json(resultJson(moved, if (moved) "" else "已在边界，无法再移动"))
    }

    private fun deleteAccount(req: UiRequest): UiOut {
        val removed = engine.removeAccount(req.requireStr("providerId"), req.requireStr("uid"))
        return UiOut.Json(resultJson(removed, if (removed) "" else "账号不存在"))
    }

    private fun importAccount(req: UiRequest): UiOut {
        val r = engine.importAccountJson(req.requireStr("providerId"), req.requireStr("raw"))
        return UiOut.Json(resultJson(r.ok, r.error))
    }

    private fun exportAccounts(): UiOut {
        val text = engine.exportAccounts()
        // 用 JsonObject 包一层而不是把整份 JSON 塞进 message：message 是给人看的短句，
        // 塞 20KB 进去会让前端 toast 弹一个满屏的框。
        return UiOut.Json(JsonObject().apply {
            addProperty("ok", true)
            addProperty("message", "已导出 ${engine.accounts().size} 个账号")
            addProperty("payload", text)
        })
    }

    // ---------------------------------------------------------------- 登录

    private fun browserLogin(req: UiRequest): UiOut {
        val id = req.requireStr("providerId")
        // 未知供应商是「参数错了」而不是「服务端崩了」：core 这边抛的是
        // IllegalArgumentException，如果不在这里翻译，外壳会返回 500，
        // 浏览器控制台里一条红字，排查时容易误判成后端故障。
        val ticket = runCatching { engine.beginBrowserLogin(id, req.str("region")) }
            .getOrElse { e ->
                throw UiException.badRequest(e.message ?: "无法创建授权：$id")
            }
        return UiOut.Json(JsonObject().apply {
            addProperty("ok", true)
            addProperty("loginUrl", ticket.loginUrl)
            addProperty("pollState", ticket.pollState)
            addProperty("region", ticket.region)
        })
    }

    private fun pollDevice(req: UiRequest): UiOut {
        val r = engine.pollDeviceAuth(
            req.requireStr("providerId"), req.requireStr("state"), req.str("region"),
        )
        val out = when (r) {
            is DeviceAuthPoll.Success -> JsonObject().apply {
                addProperty("state", "success"); addProperty("ok", true)
            }
            is DeviceAuthPoll.Failed -> JsonObject().apply {
                addProperty("state", "failed"); addProperty("ok", false); addProperty("error", r.error)
            }
            DeviceAuthPoll.Pending -> JsonObject().apply { addProperty("state", "pending") }
        }
        return UiOut.Json(out)
    }

    private fun smsSend(req: UiRequest): UiOut {
        val msgid = engine.sendSmsCode(req.requireStr("providerId"), req.requireStr("phone"))
        return UiOut.Json(JsonObject().apply { addProperty("ok", true); addProperty("msgid", msgid) })
    }

    private fun smsComplete(req: UiRequest): UiOut {
        val r = engine.completeSmsLogin(
            req.requireStr("providerId"), req.requireStr("phone"),
            req.requireStr("code"), req.str("msgid"),
        )
        return UiOut.Json(resultJson(r.ok, r.error,
            JsonObject().apply { addProperty("nickname", r.nickname) }))
    }

    // ---------------------------------------------------------------- 签到

    /**
     * 一键签到：**全量批量**（不是选中谁签谁），走 core 的闸门 force 模式。
     */
    private fun checkinAll(): UiOut {
        val targets = engine.batchTargetsFor(ACTION_CHECKIN, ProviderCapability.CHECKIN)
        if (targets.isEmpty()) {
            return UiOut.Json(resultJson(false, "没有支持签到的账号（Trae / WorkBuddy / 小浣熊）"))
        }
        val results = engine.performActionAll(targets, ACTION_CHECKIN)
        val okCount = results.count { it.ok }
        val arr = JsonArray()
        results.forEach {
            arr.add(JsonObject().apply {
                addProperty("providerId", it.providerId)
                addProperty("nickname", it.nickname.ifEmpty { it.uid })
                addProperty("ok", it.ok)
                addProperty("message", it.message)
            })
        }
        return UiOut.Json(JsonObject().apply {
            addProperty("ok", true)
            addProperty("summary", "执行 ${results.size} 个，成功 $okCount，失败 ${results.size - okCount}")
            add("results", arr)
        })
    }

    // ---------------------------------------------------------------- Auto 路由

    private fun toggleAuto(req: UiRequest): UiOut {
        val on = req.json.bool("enabled")
        host.autoRoute.setEnabled(on)
        // 首次打开且链为空时生成初始链（纯手动排序版只在启用的这一刻兜一次底）
        if (on && host.autoRoute.chainCount() == 0) {
            runCatching { host.autoRoute.rebuild(forceRefresh = false) }
        }
        return UiOut.Json(okJson())
    }

    /** 保存候选链顺序（前端排完序整链回传，一次写入）。 */
    private fun saveChain(req: UiRequest): UiOut {
        val arr = req.json.array("members") ?: return UiOut.Json(resultJson(false, "缺少 members"))
        val members = arr.mapNotNull { el ->
            runCatching {
                val o = el.asJsonObject
                GroupMember(
                    providerId = o.str("providerId"),
                    model = o.str("model"),
                    priority = o.int("priority", 100),
                )
            }.getOrNull()
        }.filter { it.providerId.isNotBlank() && it.model.isNotBlank() }
        if (members.isEmpty()) return UiOut.Json(resultJson(false, "members 里没有有效候选"))

        val existing = engine.routingGroupSettings()
        // 用 groups 直查而不是 find("auto")：find 会过滤 enabled=false，
        // 停用中的 auto 组会被当成「不存在」而新建一个 enabled=true 的组，
        // 等于偷偷把 Auto 打开了。
        // 忽略大小写（同上）：组名大小写不该决定「保存顺序」能不能生效
        val group = existing.groups.firstOrNull { it.id.equals("auto", ignoreCase = true) }
            ?: RoutingGroup(id = "auto", name = "Auto 智能路由")
        val updated = existing.copy(
            groups = existing.groups
                .filterNot { it.id.equals("auto", ignoreCase = true) } + group.copy(members = members),
        )
        engine.updateRoutingGroups(updated)
        return UiOut.Json(okJson())
    }

    private fun pruneAuto(): UiOut {
        val removed = runCatching { host.autoRoute.pruneInvalid() }.getOrDefault(0)
        return UiOut.Json(JsonObject().apply { addProperty("ok", true); addProperty("removed", removed) })
    }

    // ---------------------------------------------------------------- 配置

    private fun saveSettings(req: UiRequest): UiOut {
        val cur = engine.settings()
        // 只接受显式给出的字段，避免前端漏传把服务端配置清零
        val updated = cur.copy(
            port = req.json.int("port", cur.port).coerceIn(1, 65535),
            apiKey = req.json.strOr("apiKey", cur.apiKey),
            allowNoKey = req.json.boolOr("allowNoKey", cur.allowNoKey),
            exposeLan = req.json.boolOr("exposeLan", cur.exposeLan),
            onlyUsableModels = req.json.boolOr("onlyUsableModels", cur.onlyUsableModels),
            maxRotate = req.json.int("maxRotate", cur.maxRotate).coerceIn(0, 20),
            verboseLogging = req.json.boolOr("verboseLogging", cur.verboseLogging),
            logRetentionDays = req.json.int("logRetentionDays", cur.logRetentionDays).coerceIn(1, 3650),
            callLoggingEnabled = req.json.boolOr("callLoggingEnabled", cur.callLoggingEnabled),
            requestLogCapacity = req.json.int("requestLogCapacity", cur.requestLogCapacity)
                .coerceIn(50, 5000),
            defaultProvider = req.json.strOr("defaultProvider", cur.defaultProvider),
        )
        engine.updateSettings(updated)
        return UiOut.Json(okJson())
    }

    private fun saveGroups(req: UiRequest): UiOut {
        val arr = req.json.array("groups") ?: return UiOut.Json(resultJson(false, "缺少 groups"))
        val groups = arr.mapNotNull { el ->
            runCatching { RoutingGroup.fromJson(el.asJsonObject) }.getOrNull()
        }
        engine.updateRoutingGroups(RoutingGroupSettings(groups))
        return UiOut.Json(okJson())
    }

    // ---------------------------------------------------------------- 路由组

    /**
     * 全部路由组 + 每组成员可解析性。
     *
     * `usable` 是**界面**要的判断：成员指向的供应商还在、且还有可用账号。
     * 网关自己不管这个——组里挂了失效成员时它会自动跳到下一个候选，
     * 但界面上必须能看出「这条候选现在其实选不到号」，否则用户会以为
     * 分流规则没生效，实际是成员早就空了。
     */
    private fun groupsJson(): JsonObject {
        val settings = engine.routingGroupSettings()
        val providers = engine.providers().associateBy { it.id }
        val groups = JsonArray()
        settings.groups.forEach { g ->
            groups.add(groupJson(g, providers))
        }
        return JsonObject().apply {
            addProperty("ok", true)
            addProperty("count", settings.groups.size)
            add("groups", groups)
        }
    }

    private fun groupJson(
        g: RoutingGroup,
        providers: Map<String, ProviderInfo>,
    ): JsonObject = JsonObject().apply {
        val obj = g.toJson()
        obj.entrySet().forEach { (k, v) -> add(k, v) }
        addProperty("displayName", g.displayName)
        addProperty("routeId", RoutingGroupSettings.PREFIX + g.id)
        addProperty("memberCount", g.members.size)
        addProperty("ruleCount", g.rules.size)
        addProperty("isAuto", g.id == "auto")
        // 组内能真正选到号的成员数：供应商已注册 + 未被禁用 + 有可用账号
        val usableMembers = g.members.count { m ->
            providers[m.providerId]?.let { it.enabled && it.usableCount > 0 } == true
        }
        addProperty("usableMembers", usableMembers)
    }

    /**
     * 保存单个组（新增或覆盖同 id）。
     *
     * 与 [saveGroups] 的区别是**不碰别的组**：路由组页和智能路由页都在改
     * `settings/routing_groups.json` 的同一份数据，整表回写会让另一页
     * 未刷新时的旧值把对方的改动画回去。
     */
    private fun saveGroup(req: UiRequest): UiOut {
        val node = req.json.child("group")
            ?: return UiOut.Json(resultJson(false, "缺少 group"))
        val group = runCatching { RoutingGroup.fromJson(node) }.getOrNull()
            ?: return UiOut.Json(resultJson(false, "组配置无效：id 不能为空"))
        if (group.id.contains('/')) {
            return UiOut.Json(resultJson(false, "组名不能含斜杠（对外 id 是 ${RoutingGroupSettings.PREFIX}<组名>）"))
        }
        return mutate {
            val updated = engine.routingGroupSettings().upsert(group)
            engine.updateRoutingGroups(updated)
            JsonObject().apply {
                addProperty("ok", true)
                addProperty("message", "已保存路由组「${group.displayName}」")
                addProperty("count", updated.groups.size)
            }
        }
    }

    private fun deleteGroup(req: UiRequest): UiOut {
        val id = req.requireStr("id", "id")
        return mutate {
            val current = engine.routingGroupSettings()
            if (current.groups.none { it.id == id }) {
                return@mutate JsonObject().apply {
                    addProperty("ok", false)
                    addProperty("message", "路由组不存在：$id")
                }
            }
            val updated = current.remove(id)
            engine.updateRoutingGroups(updated)
            JsonObject().apply {
                addProperty("ok", true)
                addProperty("message", "已删除路由组「$id」")
                addProperty("count", updated.groups.size)
            }
        }
    }

    // ---------------------------------------------------------------- 自定义供应商

    /**
     * 自定义供应商列表。
     *
     * core 的 `CustomProviderConfig` 只存 key/name/baseUrl/apiKeys/protocol/models，
     * 界面还需要三样东西才能用：
     * 1. **注册状态**：配置写进 `settings/custom.json` 不等于已登记进 registry，
     *    中间差一次 `reloadCustomProviders()`。没登记时供应商页看不到它、
     *    账号也导不进来，而用户从配置列表上看不出任何异常。
     * 2. **真实请求端点**：`normalizeBaseUrl` 会补 `/v1`、会剥掉
     *    `/chat/completions` 这类尾巴。用户填 `https://api.x.com` 时界面上
     *    必须能预览最终会打哪个地址，否则 404 只能靠抓包才知道差在哪。
     * 3. **账号数**：apiKeys 是「配置里的初始 key」，实际可用账号在账号池里，
     *    两者可能不一致（用户可能在账号页删过号）。
     */
    private fun customJson(): JsonObject {
        val configs = runCatching { engine.settingsRepository.loadCustomProviders() }
            .getOrDefault(emptyList())
        val poolCounts = runCatching { engine.accounts().groupBy { it.providerId } }
            .getOrDefault(emptyMap())
            .mapValues { it.value.size }
        val arr = JsonArray()
        configs.forEach { cfg ->
            arr.add(JsonObject().apply {
                addProperty("key", cfg.key)
                addProperty("providerId", cfg.providerId)
                addProperty("name", cfg.name)
                addProperty("baseUrl", cfg.baseUrl)
                addProperty("protocol", cfg.protocol)
                addProperty("registered", engine.registry.get(cfg.providerId) != null)
                addProperty("chatEndpoint", CustomProvider.chatEndpointOf(cfg.baseUrl))
                addProperty("modelsEndpoint", CustomProvider.modelsEndpointOf(cfg.baseUrl))
                addProperty("keyCount", cfg.apiKeys.size)
                addProperty("accountCount", poolCounts[cfg.providerId] ?: 0)
                addProperty("modelCount", cfg.models.size)
                add("models", JsonArray().apply { cfg.models.forEach { add(it) } })
                // 出图能力：列表页要能看出「这家能不能出图」，否则媒体实测页写着
                // 「图像供应商：无」而供应商页看起来一堆供应商，两边对不上。
                addProperty("supportsImage", cfg.supportsImage)
                addProperty("imageCount", cfg.imageModels.size)
                add("imageModels", JsonArray().apply { cfg.imageModels.forEach { add(it) } })
                addProperty("imageEndpoint", CustomProvider.imageEndpointOf(cfg.baseUrl))
            })
        }
        return JsonObject().apply {
            addProperty("ok", true)
            addProperty("count", arr.size())
            add("items", arr)
        }
    }

    /**
     * 保存一条自定义供应商（新增或按 key 覆盖）。
     *
     * 三条必须在这里做的判断，缺一条就会留下「看着保存成功、实际不能用」的配置：
     * 1. **key 规范化**：`normalizeKey` 把空格/斜杠/大写压成 `a-z0-9_-`。
     *    key 是 provider id 的组成（`custom:<key>`），带斜杠会让路由解析错乱，
     *    而 core 的 `fromJson` 下次启动时会把它当无效项静默丢掉——
     *    用户只会看到「重启后供应商没了」。
     * 2. **baseUrl 规范化**：core 在请求时才补 `/v1`；这里存规范化后的值，
     *    让界面预览的地址与实际请求地址永远一致。
     * 3. **改名搬账号**：key 变了等于换了一家供应商（providerId 变了），
     *    旧账号必须一起搬过去，否则新 id 账号数为 0、旧账号永远选不中。
     */
    private fun saveCustomConfig(req: UiRequest): UiOut {
        val name = req.str("name").ifBlank { req.str("key") }
        val keyRaw = req.str("key").ifBlank { CustomProviderConfig.deriveKey(name) }
        val key = CustomProviderConfig.normalizeKey(keyRaw)
        if (key.isEmpty()) {
            // 纯中文显示名派生不出短名（`[^a-z0-9_-]` 全部被压成 `-`，trim 后为空）。
            // 不在这里兜底的话，用户填了名字点保存只会看到「短名不能为空」，
            // 而他并没有看到「短名」这个字段有任何问题。
            return UiOut.Json(resultJson(false,
                "短名不能为空：显示名「$name」里没有可用的英文字母/数字，请手动填一个短名（如 relay1）"))
        }
        val baseUrl = CustomProvider.normalizeBaseUrl(req.str("baseUrl"))
        if (baseUrl.isEmpty()) return UiOut.Json(resultJson(false, "接口地址不能为空"))
        val apiKeys = (req.json.array("apiKeys") ?: JsonArray())
            .mapNotNull { runCatching { it.asString }.getOrNull() }
            .map { it.trim() }
            .filter { it.isNotEmpty() }
        val models = (req.json.array("models") ?: JsonArray())
            .mapNotNull { runCatching { it.asString }.getOrNull() }
            .map { it.trim() }
            .filter { it.isNotEmpty() }

        val existing = runCatching { engine.settingsRepository.loadCustomProviders() }
            .getOrDefault(emptyList())
        // 编辑态下用户可能改了短名：originalKey 用于定位要替换的那一条。
        val originalKey = CustomProviderConfig.normalizeKey(req.str("originalKey"))
        // 图像模型：**请求里没带这个字段时保留原值**。
        // 旧版前端（或第三方脚本）只传 models，直接当空数组会把已配好的出图能力清掉，
        // 表现为「编辑一次供应商，媒体实测页的出图就坏了」。
        val hasImageField = req.json.get("imageModels") != null
        val previousImages = existing.firstOrNull { it.key == key || it.key == originalKey }?.imageModels
            ?: emptyList()
        val imageModels = if (hasImageField) {
            (req.json.array("imageModels") ?: JsonArray())
                .mapNotNull { runCatching { it.asString }.getOrNull() }
                .map { it.trim() }
                .filter { it.isNotEmpty() }
        } else {
            previousImages
        }

        val config = CustomProviderConfig(
            key = key,
            name = name,
            baseUrl = baseUrl,
            apiKeys = apiKeys,
            protocol = req.str("protocol").ifBlank { CustomProviderConfig.PROTOCOL_OPENAI },
            models = models,
            imageModels = imageModels,
        )

        return mutate {
            val keep = existing.filterNot {
                it.key == key || (originalKey.isNotEmpty() && it.key == originalKey)
            }
            engine.settingsRepository.saveCustomProviders(keep + config)
            // 配置写盘 != 登记进 registry：不 reload 时供应商页看不见它，
            // 账号也导不进来（importAccountJson 第一步就是 registry.get 判空）。
            engine.reloadCustomProviders()
            engine.syncCustomAccounts(config)
            if (originalKey.isNotEmpty() && originalKey != key) {
                renameCustomAccounts(originalKey, key)
            }
            JsonObject().apply {
                addProperty("ok", true)
                addProperty("message", "已保存自定义供应商「$name」（${config.providerId}）")
                addProperty("providerId", config.providerId)
                addProperty("baseUrl", config.baseUrl)
                addProperty("chatEndpoint", CustomProvider.chatEndpointOf(config.baseUrl))
            }
        }
    }

    /**
     * 短名改名后把账号搬到新 id 下。
     *
     * 账号池按 providerId 分区，旧 id 下的账号在新供应商里完全不可见。
     * 先 upsert 新 id 再删旧 id：顺序反了会有一瞬「账号全没了」，
     * 如果用户恰好在这中间点了「刷新额度」，会拿到一份空列表。
     */
    private fun renameCustomAccounts(fromKey: String, toKey: String) {
        val fromId = "custom:" + fromKey
        val toId = "custom:" + toKey
        if (fromId == toId) return
        engine.accounts(fromId).forEach { st ->
            val account = engine.account(fromId, st.uid) ?: return@forEach
            engine.pool.upsert(account.copy(providerId = toId))
            engine.removeAccount(fromId, st.uid)
        }
    }

    /**
     * 删除一条自定义供应商。
     *
     * 必须连带删账号：`reloadCustomProviders` 会把它从 registry 摘掉，
     * 但账号池里的账号还在（键是 providerId）。孤儿账号会让「账号总数」
     * 大于「供应商能覆盖的账号数」，而且永远不会被任何路由选中——
     * 界面上只表现为「有个不存在的供应商还占着 3 个账号」。
     */
    private fun deleteCustomConfig(req: UiRequest): UiOut {
        val key = CustomProviderConfig.normalizeKey(req.requireStr("key", "key"))
        return mutate {
            val existing = runCatching { engine.settingsRepository.loadCustomProviders() }
                .getOrDefault(emptyList())
            if (existing.none { it.key == key }) {
                return@mutate JsonObject().apply {
                    addProperty("ok", false)
                    addProperty("message", "自定义供应商不存在：$key")
                }
            }
            val providerId = "custom:$key"
            val removedAccounts = runCatching { engine.accounts(providerId).size }.getOrDefault(0)
            runCatching {
                engine.accounts(providerId).forEach { st -> engine.removeAccount(providerId, st.uid) }
            }
            engine.settingsRepository.saveCustomProviders(existing.filterNot { it.key == key })
            engine.reloadCustomProviders()
            JsonObject().apply {
                addProperty("ok", true)
                addProperty("message", "已删除自定义供应商「$key」，连带 $removedAccounts 个账号")
                addProperty("removedAccounts", removedAccounts)
            }
        }
    }

    /**
     * 用「尚未保存」的地址与 Key 拉一次模型目录。
     *
     * 不读已保存配置：新建时用户还没保存，也要能先看看这个中转站到底有哪些模型。
     * 失败原因由 core 的 `ModelFetchResult` 原样带回（401 / 404 / 网络不通三种
     * 说法完全不同），这里只负责透传——压成一句「拉取失败」等于让用户去猜。
     */
    private fun fetchCustomModels(req: UiRequest): UiOut {
        val baseUrl = CustomProvider.normalizeBaseUrl(req.str("baseUrl"))
        if (baseUrl.isEmpty()) return UiOut.Json(resultJson(false, "先填写接口地址"))
        val providerId = "custom:" + CustomProviderConfig.normalizeKey(req.str("key"))
        // 界面在编辑已保存条目时只带 key 不带密钥：从账号池取第一个能解析的凭证。
        val poolKey = runCatching {
            engine.accounts(providerId).firstNotNullOfOrNull { st ->
                engine.account(providerId, st.uid)?.secret?.let { parseApiKey(it) }
            }
        }.getOrNull().orEmpty()
        val key = req.str("apiKey").ifBlank { poolKey }
        val result = CustomProvider.fetchModels(baseUrl, key)
        return UiOut.Json(JsonObject().apply {
            addProperty("ok", result.error.isEmpty())
            addProperty("message", result.error)
            addProperty("baseUrl", baseUrl)
            addProperty("modelsEndpoint", CustomProvider.modelsEndpointOf(baseUrl))
            add("models", JsonArray().apply { result.models.forEach { add(it) } })
        })
    }

    /** 账号 secret 是 `{\"apiKey\":\"…\"}`，取不出来就当空串（无 Key 的本地中转也能拉目录）。 */
    /**
     * 把 `settings/custom.json` 重新登记进 registry。
     *
     * 给「配置文件被外部改过」的场景用：手改（或拿别的实例的副本覆盖）
     * custom.json 之后，进程里的 registry 还是旧的——供应商页看不到新条目、
     * 账号导不进来，而界面没有任何提示能说明「配置在盘上、只是没生效」。
     *
     * 顺手把每个配置里的 apiKeys 同步成账号（与保存路径同一套语义），
     * 否则「重新登记」出来的供应商会是 0 账号，看起来像坏的。
     */
    private fun reloadCustom(): UiOut {
        return mutate {
            val before = runCatching { engine.providers().count { it.custom } }.getOrDefault(0)
            engine.reloadCustomProviders()
            val configs = runCatching { engine.settingsRepository.loadCustomProviders() }
                .getOrDefault(emptyList())
            configs.forEach { cfg -> runCatching { engine.syncCustomAccounts(cfg) } }
            val after = runCatching { engine.providers().count { it.custom } }.getOrDefault(0)
            JsonObject().apply {
                addProperty("ok", true)
                addProperty("message", "已重新登记 ${configs.size} 个自定义供应商（注册数 $before → $after）")
                addProperty("count", configs.size)
                addProperty("registered", after)
            }
        }
    }

    private fun parseApiKey(secret: String): String =
        runCatching {
            com.google.gson.JsonParser.parseString(secret).asJsonObject.get("apiKey")?.asString.orEmpty()
        }.getOrDefault("")

    private fun saveKeys(req: UiRequest): UiOut {
        when (req.str("op")) {
            "add" -> engine.clientKeyStore.add(req.requireStr("name"))
            "remove" -> engine.clientKeyStore.remove(req.requireStr("id"))
            else -> return UiOut.Json(resultJson(false, "未知操作：${req.str("op")}"))
        }
        return UiOut.Json(okJson())
    }

    private fun saveTheme(req: UiRequest): UiOut {
        val theme = req.str("theme").ifBlank { "dark" }
        // 未知值一律按 dark 处理：前端只有一个切换按钮，不需要报错打断用户
        val normalized = if (theme == "light") "light" else "dark"
        runCatching { File(host.dataDir, "ui-theme.txt").writeText(normalized) }
        return UiOut.Json(JsonObject().apply {
            addProperty("ok", true)
            addProperty("theme", normalized)
        })
    }

    /**
     * 保存高级策略。
     *
     * 只覆盖前端显式给出的字段：`routes`（模型级故障转移映射）不出现在界面上，
     * 从现有配置原样带过去，否则一保存就把用户手写的映射表清空。
     */
    private fun saveStrategy(req: UiRequest): UiOut {
        val cur = engine.failoverSettings()
        val strategyName = req.json.strOr("accountStrategy", cur.accountStrategy.name)
        val strategy = runCatching { AccountStrategy.valueOf(strategyName) }
            .getOrElse { return UiOut.Json(resultJson(false, "未知账号策略：$strategyName")) }

        fun retryInt(k: String, d: Int, lo: Int, hi: Int) =
            req.json.child("retry")?.int(k, d)?.coerceIn(lo, hi) ?: d
        fun retryLong(k: String, d: Long, lo: Long, hi: Long) =
            req.json.child("retry")?.long(k, d)?.coerceIn(lo, hi) ?: d
        fun retryDouble(k: String, d: Double, lo: Double, hi: Double) =
            req.json.child("retry")?.double(k, d)?.coerceIn(lo, hi) ?: d

        val updated = cur.copy(
            enabled = req.json.boolOr("enabled", cur.enabled),
            accountStrategy = strategy,
            accountCooldownMs = req.json.long("accountCooldownMs", cur.accountCooldownMs)
                .coerceIn(0L, 600_000L),
            retry = cur.retry.copy(
                maxAttempts = retryInt("maxAttempts", cur.retry.maxAttempts, 1, 10),
                initialBackoffMs = retryLong("initialBackoffMs", cur.retry.initialBackoffMs, 0L, 10_000L),
                maxBackoffMs = retryLong("maxBackoffMs", cur.retry.maxBackoffMs, 0L, 60_000L),
                backoffMultiplier = retryDouble("backoffMultiplier", cur.retry.backoffMultiplier, 1.0, 5.0),
                jitterRatio = retryDouble("jitterRatio", cur.retry.jitterRatio, 0.0, 1.0),
            ),
            circuitBreaker = cur.circuitBreaker.copy(
                failureThreshold = req.json.child("circuitBreaker")
                    ?.int("failureThreshold", cur.circuitBreaker.failureThreshold)?.coerceIn(1, 100)
                    ?: cur.circuitBreaker.failureThreshold,
                openDurationMs = req.json.child("circuitBreaker")
                    ?.long("openDurationMs", cur.circuitBreaker.openDurationMs)
                    ?.coerceIn(1_000L, 3_600_000L) ?: cur.circuitBreaker.openDurationMs,
                halfOpenSuccessCount = req.json.child("circuitBreaker")
                    ?.int("halfOpenSuccessCount", cur.circuitBreaker.halfOpenSuccessCount)
                    ?.coerceIn(1, 10) ?: cur.circuitBreaker.halfOpenSuccessCount,
            ),
            concurrency = cur.concurrency.copy(
                maxPerAccount = req.json.child("concurrency")
                    ?.int("maxPerAccount", cur.concurrency.maxPerAccount)
                    ?.let { ConcurrencyConfig.clampMaxPerAccount(it) }
                    ?: cur.concurrency.maxPerAccount,
                maxGlobal = req.json.child("concurrency")
                    ?.int("maxGlobal", cur.concurrency.maxGlobal)
                    ?.let { ConcurrencyConfig.clampMaxGlobal(it) }
                    ?: cur.concurrency.maxGlobal,
                queueTimeoutMs = req.json.child("concurrency")
                    ?.long("queueTimeoutMs", cur.concurrency.queueTimeoutMs)
                    ?.let { ConcurrencyConfig.clampQueueTimeoutMs(it) }
                    ?: cur.concurrency.queueTimeoutMs,
            ),
            modelCooldown = cur.modelCooldown.copy(
                cooldownMs = req.json.child("modelCooldown")
                    ?.long("cooldownMs", cur.modelCooldown.cooldownMs)
                    ?.coerceIn(1_000L, 7_200_000L) ?: cur.modelCooldown.cooldownMs,
                maxCooldownMs = req.json.child("modelCooldown")
                    ?.long("maxCooldownMs", cur.modelCooldown.maxCooldownMs)
                    ?.coerceIn(1_000L, 7_200_000L) ?: cur.modelCooldown.maxCooldownMs,
            ),
            routes = cur.routes,
        )
        engine.updateFailoverSettings(updated)
        // 安全防护与故障转移同一页：只覆盖请求体里显式给出的字段，
        // 漏传（老前端）时保留当前值，别把用户手改过的 security.json 洗掉。
        val secReq = req.json.child("security")
        if (secReq != null) {
            val curSec = engine.securitySettings()
            engine.updateSecuritySettings(
                curSec.copy(
                    sanitizeEnabled = secReq.boolOr("sanitizeEnabled", curSec.sanitizeEnabled),
                    minIntervalMillis = secReq.long("minIntervalMillis", curSec.minIntervalMillis)
                        .coerceIn(0L, 60_000L),
                    jitterMillis = secReq.long("jitterMillis", curSec.jitterMillis)
                        .coerceIn(0L, 10_000L),
                    privacyRedactionEnabled = secReq.boolOr(
                        "privacyRedactionEnabled", curSec.privacyRedactionEnabled,
                    ),
                ),
            )
        }
        return UiOut.Json(JsonObject().apply {
            addProperty("ok", true)
            addProperty("message", "策略已保存")
            add("strategy", strategySnapshot())
        })
    }

    /** 清空全部模型级冷却（某模型被判超限后想立刻重试时用）。 */
    private fun clearCooling(): UiOut {
        val tracker = engine.modelCooldownOf()
        val keys = runCatching { tracker.snapshot().keys }.getOrDefault(emptySet())
        keys.forEach { k ->
            val sep = k.lastIndexOf('|')
            if (sep > 0) tracker.clear(k.substring(0, sep), k.substring(sep + 1))
        }
        return UiOut.Json(resultJson(true, "已清空 ${keys.size} 条模型冷却",
            JsonObject().apply { addProperty("cleared", keys.size) }))
    }
}
