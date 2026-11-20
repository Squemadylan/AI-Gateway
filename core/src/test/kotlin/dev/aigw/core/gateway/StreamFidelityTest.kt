package dev.aigw.core.gateway

import com.google.gson.JsonParser
import dev.aigw.core.InMemoryKeyValueStore
import dev.aigw.core.provider.AggregatedChatCall
import dev.aigw.core.provider.AuthKind
import dev.aigw.core.provider.ChatCall
import dev.aigw.core.provider.ErrorKind
import dev.aigw.core.provider.Provider
import dev.aigw.core.provider.ProviderAccount
import dev.aigw.core.provider.ProviderModelCatalogView
import dev.aigw.core.provider.StreamingChatCall
import dev.aigw.core.provider.UpstreamError
import dev.aigw.core.security.SecuritySettings
import java.io.ByteArrayInputStream
import java.net.Socket
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 流式保真度（stream fidelity）：用**差分对照组**给「网关不改变语义」立判据。
 *
 * 判据不来自我对实现的判断，而来自两条独立代码路径产出同一份字节：
 *
 *   路径 A：隐私脱敏**关闭** → 上游看到原文 → 客户端收到原文
 *   路径 B：隐私脱敏**开启** → 上游看到占位符 → 网关还原 → 客户端收到原文
 *
 * A/B 客户端重组内容必须 **sha256 完全相同**。占位符泄漏一个字符、少还原一个字符、
 * 尾巴被丢弃，哈希立刻不同——不需要人去看日志判断「看起来对不对」。
 *
 * 另有两条独立断言：客户端内容里不得出现占位符前缀（不依赖期望值，只依赖
 * 「这东西不该出现在出口」）；上游收到的内容里不得出现原始密钥（证明脱敏真生效）。
 *
 * 第二组测试**穷举切点**：占位符被切成任意两段都必须还原。这类 bug 只在特定边界出现，
 * 手工挑三个切点验不出来。
 */
class StreamFidelityTest {

    /** 原文里放三类高置信度敏感串，覆盖 key / 邮箱 / GitHub token 三种模式。 */
    private val secrets = listOf(
        "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
        "someone@example.com",
        "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
    )

    /** 待回显的文本：普通正文 + 三个敏感串，长度足够被切成多帧。 */
    private val echoText: String = buildString {
        append("第一段：这里是普通正文，不含任何密钥。")
        append("第二段：key=").append(secrets[0]).append("，请勿外传。")
        append("第三段：邮箱=").append(secrets[1]).append("，工作用。")
        append("第四段：token=").append(secrets[2]).append("，仓库读权限。")
        append("第五段：结尾普通文字，用来把切点推到后面。")
        // 故意以占位符前缀结尾：还原器会把它当作「可能未完成的占位符」先扣住，
        // 只有在流结束时 flush 才交得出来。少这一处，flush 丢失就永远测不到。
        append("第六段：代码里的宏前缀写作 __AIGW")
    }

    // ------------------------------------------------------------------ 上游桩

    /**
     * 回显型上游：把收到的 user 内容原样吐回。
     *
     * 「收到什么就回什么」是关键——脱敏开启时它收到的就是占位符，于是它会像真实上游一样
     * 把占位符发回来，网关必须还原。还原失败则 A/B 哈希不等。
     *
     * [cuts] 按回显文本长度的比例切帧；[receivedContent] 记录上游实际收到的内容，
     * 供测试断言「占位符确实出网了」。
     */
    private inner class EchoProvider(
        private val nonStream: Boolean,
        var cuts: List<Double> = emptyList(),
    ) : Provider {
        var receivedContent: String = ""
            private set

        override val id = "echo"
        override val displayName = "回显上游"
        override val authKind = AuthKind.NONE
        override fun listModels(account: ProviderAccount?) = ProviderModelCatalogView(emptyList(), true, "")
        override fun resolveModel(requested: String) = requested
        override fun classify(status: Int, body: String) = UpstreamError(ErrorKind.CLIENT, body)

        override fun openChat(account: ProviderAccount, openAiBody: String): ChatCall {
            val obj = JsonParser.parseString(openAiBody).asJsonObject
            val content = obj.getAsJsonArray("messages")
                .filter { it.asJsonObject.get("role")?.asString == "user" }
                .last()
                .asJsonObject.get("content").asString
            receivedContent = content

            if (nonStream) {
                return AggregatedChatCall(
                    200,
                    """{"id":"c1","object":"chat.completion","created":1,"model":"echo",""" +
                        """"choices":[{"index":0,"message":{"role":"assistant","content":"""" +
                        jsonEscape(content) +
                        """"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}""",
                )
            }
            return StreamingChatCall(
                200,
                ByteArrayInputStream(sseFor(content, cuts).toByteArray(Charsets.UTF_8)),
            )
        }

        override fun toString(): String = "EchoProvider(nonStream=$nonStream,cuts=$cuts)"
    }

    private fun jsonEscape(s: String): String = s
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")
        .replace("\n", "\\n")

    private fun sseFor(content: String, cuts: List<Double>): String {
        val pieces = splitByCuts(content, cuts)
        val sb = StringBuilder()
        for (p in pieces) {
            sb.append("""data: {"id":"c1","object":"chat.completion.chunk","model":"echo",""")
            sb.append(""""choices":[{"index":0,"delta":{"content":"""").append(jsonEscape(p))
            sb.append(""""}}],"usage":null}""").append("\n\n")
        }
        sb.append("""data: {"id":"c1","object":"chat.completion.chunk","model":"echo",""")
        sb.append(""""choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}""").append("\n\n")
        sb.append("data: [DONE]\n\n")
        return sb.toString()
    }

    private fun splitByCuts(content: String, cuts: List<Double>): List<String> {
        if (cuts.isEmpty() || content.isEmpty()) return listOf(content)
        val points = cuts.map { (it * content.length).toInt() }.sorted().distinct()
        val out = mutableListOf<String>()
        var last = 0
        for (p in points) {
            if (p <= last || p >= content.length) continue
            out.add(content.substring(last, p))
            last = p
        }
        out.add(content.substring(last))
        return out
    }

    // ------------------------------------------------------------------ 客户端

    private fun withGateway(
        redaction: Boolean,
        provider: Provider,
        block: (port: Int) -> Unit,
    ) {
        val engine = GatewayEngine(InMemoryKeyValueStore())
        engine.registry.register(provider)
        engine.pool.upsert(ProviderAccount(provider.id, "u1", "账号", "{}"))
        engine.updateSecuritySettings(
            SecuritySettings.fromJson(null).copy(privacyRedactionEnabled = redaction),
        )
        val server = GatewayHttpServer(engine, "127.0.0.1", 0)
        server.start(0, true)
        try {
            block(server.listeningPort)
        } finally {
            server.stop()
        }
    }

    private fun post(port: Int, body: String): String =
        Socket("127.0.0.1", port).use { socket ->
            socket.soTimeout = 20_000
            val bytes = (
                "POST /v1/chat/completions HTTP/1.1\r\n" +
                    "Host: 127.0.0.1\r\n" +
                    "Content-Type: application/json\r\n" +
                    "Content-Length: ${body.toByteArray(Charsets.UTF_8).size}\r\n" +
                    "Connection: close\r\n\r\n" + body
                ).toByteArray(Charsets.UTF_8)
            socket.getOutputStream().write(bytes)
            socket.getOutputStream().flush()
            socket.getInputStream().readBytes().toString(Charsets.UTF_8)
        }

    /** 客户端视角：把响应里所有 `delta.content` 拼起来——这才是客户端真正看到的东西。 */
    private fun clientContent(raw: String): String {
        val body = bodyOf(raw)
        val sb = StringBuilder()
        for (line in body.lineSequence()) {
            if (!line.startsWith("data:")) continue
            val payload = line.removePrefix("data:").trim()
            if (payload.isEmpty() || payload == "[DONE]") continue
            val obj = runCatching { JsonParser.parseString(payload).asJsonObject }.getOrNull() ?: continue
            val choices = obj.getAsJsonArray("choices") ?: continue
            for (el in choices) {
                val delta = el.asJsonObject.getAsJsonObject("delta") ?: continue
                delta.get("content")?.takeIf { it.isJsonPrimitive }?.asString?.let { sb.append(it) }
            }
        }
        return sb.toString()
    }

    private fun nonStreamContent(raw: String): String {
        val obj = runCatching { JsonParser.parseString(bodyOf(raw)).asJsonObject }.getOrNull() ?: return ""
        return runCatching {
            obj.getAsJsonArray("choices")[0].asJsonObject
                .getAsJsonObject("message").get("content").asString
        }.getOrDefault("")
    }

    private fun bodyOf(raw: String): String {
        val start = raw.indexOf("\r\n\r\n")
        return if (start >= 0) raw.substring(start + 4) else raw
    }

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    private fun body(model: String, stream: Boolean): String =
        """{"model":"$model","stream":$stream,"messages":[{"role":"user","content":"${jsonEscape(echoText)}"}]}"""

    // ------------------------------------------------------------------ 对照组

    @Test
    fun `流式：脱敏关与脱敏开还原后，客户端内容 sha256 必须相同`() {
        val offProvider = EchoProvider(nonStream = false)
        val off = StringBuilder()
        withGateway(redaction = false, provider = offProvider) { port ->
            off.append(clientContent(post(port, body("echo/e", true))))
        }

        val onProvider = EchoProvider(nonStream = false)
        val on = StringBuilder()
        withGateway(redaction = true, provider = onProvider) { port ->
            on.append(clientContent(post(port, body("echo/e", true))))
        }

        // 对照组基准先成立，否则「两条路径一致」毫无意义
        assertEquals(
            sha256(echoText), sha256(off.toString()),
            "脱敏关闭时必须原样回显，否则对照组基准就是错的",
        )
        assertEquals(
            sha256(off.toString()), sha256(on.toString()),
            "脱敏开启并还原后必须与关闭时逐字节一致",
        )

        // 两条独立断言：出网内容与出站内容各自受限
        assertFalse(offProvider.receivedContent.contains("__AIGW_"), "脱敏关时上游不该看到占位符")
        assertFalse(onProvider.receivedContent.contains(secrets[0]), "脱敏开时上游不能看到原始密钥")
        assertTrue(onProvider.receivedContent.contains("__AIGW_"), "脱敏开时上游必须看到占位符，否则等于没脱敏")
        assertFalse(on.toString().contains("__AIGW_"), "占位符泄漏给客户端：" + on.toString().take(200))
    }

    @Test
    fun `非流式：脱敏关与脱敏开还原后 sha256 必须相同`() {
        val offProvider = EchoProvider(nonStream = true)
        val off = StringBuilder()
        withGateway(redaction = false, provider = offProvider) { port ->
            off.append(nonStreamContent(post(port, body("echo/e", false))))
        }

        val onProvider = EchoProvider(nonStream = true)
        val on = StringBuilder()
        withGateway(redaction = true, provider = onProvider) { port ->
            on.append(nonStreamContent(post(port, body("echo/e", false))))
        }

        assertEquals(sha256(echoText), sha256(off.toString()), "脱敏关闭时必须原样回显")
        assertEquals(sha256(off.toString()), sha256(on.toString()), "非流式还原后必须逐字节一致")
        assertFalse(on.toString().contains("__AIGW_"), "非流式也不许泄漏占位符")
    }

    // ------------------------------------------------------------------ 边界穷举

    @Test
    fun `穷举切点：占位符被切成任意两段都必须完整还原`() {
        // 先请上游把「它真正收到的文本」交出来，切点按它的长度枚举，
        // 保证每个切点都实际落在某个占位符内部，而不是随机撞运气。
        val probe = EchoProvider(nonStream = false)
        var redacted = ""
        withGateway(redaction = true, provider = probe) { port ->
            post(port, body("echo/e", true))
            redacted = probe.receivedContent
        }
        assertTrue(redacted.contains("__AIGW_"), "上游收到的文本里没有占位符——脱敏没生效，无从谈切点")

        val provider = EchoProvider(nonStream = false)
        withGateway(redaction = true, provider = provider) { port ->
            // 单个长会话复用一台网关：每轮只改切点，避免反复起服务
            val ranges = placeholdersIn(redacted)
            var checked = 0
            for ((start, end) in ranges) {
                for (cut in start..minOf(end + 1, redacted.length)) {
                    checked++
                    provider.cuts = listOf(cut.toDouble() / redacted.length)
                    val client = clientContent(post(port, body("echo/e", true)))
                    assertEquals(
                        sha256(echoText), sha256(client),
                        "切点 $cut 还原失败（占位符被切开未拼回）：" + client.take(160),
                    )
                    assertFalse(client.contains("__AIGW_"), "切点 $cut 处占位符泄漏")
                }
            }
            assertTrue(checked > 0, "切点枚举为空")
        }
    }

    /** 找出文本里所有形如 `__AIGW_<n>__` 的占位符区间（闭区间）。 */
    private fun placeholdersIn(text: String): List<Pair<Int, Int>> =
        Regex("__AIGW_\\d+__").findAll(text).map { it.range.first to it.range.last }.toList()
}
