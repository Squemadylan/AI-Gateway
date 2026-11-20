#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""故障注入矩阵：验证网关在 7 类上游异常下的**对外可见行为**。

为什么要有这一支：`stress.py` 打的是「网关自己不会被畸形请求搞崩」，
这一支打的是「上游坏掉时，客户端看到的东西是否符合承诺」。两者断言对象不同。

每条模式的期望行为是**事先写死的**，不是跑完看结果再补文档：

| 模式        | 上游动作                                   | 客户端必须看到                     |
|-------------|--------------------------------------------|------------------------------------|
| ok          | 正常 2 帧 + [DONE]                          | 内容逐字节等于原文、无占位符        |
| rate429     | 首响应 429                                  | 429 + rate_limit_exceeded          |
| server500   | 首响应 500                                  | 502 + upstream_error               |
| half        | 发半截 content 后直接断 socket               | 收到的半截 + 终止帧（不是裸断流）    |
| drip        | 每字节间隔 50ms                             | 首字延迟 < 5s（证明没被攒包）        |
| bigchunk    | 单个 delta 塞 96KB                          | 内容完整、长度一致                  |
| splitph     | 正好把占位符劈在两帧之间                    | 占位符被拼回原文、不泄漏            |

后半段是**对照组哈希**：同一条原文，脱敏关 vs 脱敏开（上游看到占位符），
客户端重组结果的 sha256 必须相同。判据来自哈希，不来自我的判断。

用法：
    python tools/uitest/chaos_stream.py                 # 全跑
    python tools/uitest/chaos_stream.py ok splitph     # 只跑指定模式
    python tools/uitest/chaos_stream.py --keep          # 不清理临时目录

退出码：0 = 全部符合期望；1 = 有模式偏离期望。
"""

import hashlib
import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHAOS_PORT = 18999
DATA_DIR = os.path.join(ROOT, ".tmp", "chaos", "data")
CHAOS_HOME = os.path.join(ROOT, ".tmp", "chaos")

SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"
MAIL = "someone@example.com"
ECHO_TEXT = (
    "第一段：普通正文。"
    "第二段：key=" + SECRET + "，勿外传。"
    "第三段：邮箱=" + MAIL + "，工作用。"
    "第四段：结尾普通文字。"
    "第五段：宏前缀写作 __AIGW"
)

FAILS = []


def note(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("  " + detail if detail else ""), flush=True)
    if not ok:
        FAILS.append(label + " " + detail)


def sha256(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ 故障上游

class ChaosState:
    mode = "ok"
    received = []          # 上游收到的 user content（证明脱敏是否真出网）
    lock = threading.Lock()


class ChaosHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # ---- 控制面
    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/__mode":
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8") if length else "{}"
            ChaosState.mode = json.loads(body).get("mode", "ok")
            self._json(200, {"ok": True, "mode": ChaosState.mode})
            return
        if path == "/__received":
            self._json(200, {"received": ChaosState.received[-3:]})
            return
        if path == "/__reset":
            ChaosState.received.clear()
            self._json(200, {"ok": True})
            return
        if path.endswith("/chat/completions"):
            self._chat()
            return
        self._json(404, {"error": {"message": "not found"}})

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/__received":
            self._json(200, {"received": ChaosState.received[-3:]})
            return
        if path == "/__reset":
            ChaosState.received.clear()
            self._json(200, {"ok": True})
            return
        if path.rstrip("/").endswith("/models"):
            self._json(200, {"object": "list", "data": [{"id": "echo", "object": "model"}]})
            return
        self._json(404, {"error": {"message": "not found"}})

    # ---- 业务面
    def _chat(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            obj = json.loads(raw)
        except Exception:
            self._json(400, {"error": {"message": "bad json"}})
            return
        content = ""
        for m in obj.get("messages", []):
            if m.get("role") == "user":
                content = m.get("content") or ""
        with ChaosState.lock:
            ChaosState.received.append(content)

        mode = ChaosState.mode
        if mode == "rate429":
            self._json(429, {"error": {"message": "rate limited", "type": "rate_limit"}})
            return
        if mode == "server500":
            self._json(500, {"error": {"message": "boom"}})
            return
        if mode == "half":
            self._half(content)
            return
        if mode == "drip":
            self._stream(content, drip=True)
            return
        if mode == "bigchunk":
            self._stream(content, big=True)
            return
        if mode == "splitph":
            self._stream(content, split_placeholder=True)
            return
        self._stream(content)

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _begin_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

    def _frame(self, text):
        payload = json.dumps(
            {
                "id": "c1",
                "object": "chat.completion.chunk",
                "model": "echo",
                "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
                "usage": None,
            },
            ensure_ascii=False,
        )
        return ("data: " + payload + "\n\n").encode("utf-8")

    def _end(self):
        stop = json.dumps(
            {
                "id": "c1",
                "object": "chat.completion.chunk",
                "model": "echo",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": None,
            },
            ensure_ascii=False,
        )
        self.wfile.write(("data: " + stop + "\n\n").encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _stream(self, content, drip=False, big=False, split_placeholder=False):
        self._begin_sse()
        if big:
            # 单帧塞 96KB：验证网关不会因单帧过大截断
            chunk = (content + " 填充" * 30000)
            self.wfile.write(self._frame(chunk))
            self.wfile.flush()
        elif split_placeholder:
            # 正好把占位符劈成两段：先找到第一个占位符，从它中间切开
            m = re.search(r"__AIGW_\d+__", content)
            if m:
                cut = m.start() + len(m.group()) // 2
                self.wfile.write(self._frame(content[:cut]))
                self.wfile.flush()
                time.sleep(0.05)
                self.wfile.write(self._frame(content[cut:]))
                self.wfile.flush()
            else:
                self.wfile.write(self._frame(content))
                self.wfile.flush()
        elif drip:
            # 每字符一帧，帧间 50ms：验证网关没有攒包（首字必须早出来）
            for ch in content:
                self.wfile.write(self._frame(ch))
                self.wfile.flush()
                time.sleep(0.05)
        else:
            half = max(1, len(content) // 2)
            self.wfile.write(self._frame(content[:half]))
            self.wfile.flush()
            time.sleep(0.05)
            self.wfile.write(self._frame(content[half:]))
            self.wfile.flush()
        self._end()

    def _half(self, content):
        """发半截就断：这是最容易被网关误判成「正常结束」的场景。"""
        self._begin_sse()
        half = max(1, len(content) // 2)
        self.wfile.write(self._frame(content[:half]))
        self.wfile.flush()
        try:
            self.wfile.flush()
            self.connection.close()
        except Exception:
            pass
        self.close_connection = True


# ------------------------------------------------------------------ 客户端工具

def http_post(url, payload, timeout=30):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8", "replace")


def http_get(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8", "replace")


def stream_chat(gw_port, model="custom-chaos/echo", api_key="", timeout=60):
    """流式请求，返回 (status 行, 已解 chunked 的 body, 首字耗时秒)。

    用标准库 `http.client` 而不是手写 socket：
    网关的流式响应是 `Transfer-Encoding: chunked`，手写解帧第一版把 chunk 边界算错，
    把 `content` 切成了 `connt`——于是哈希对照变成「碰巧不等」，判据失效。
    标准库的 HTTPResponse 内部实现 chunk 解析，readline 逐行读仍能测到首字时序。
    """
    body = json.dumps(
        {
            "model": model,
            "stream": True,
            "messages": [{"role": "user", "content": ECHO_TEXT}],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    started = time.time()
    first = None
    lines = []
    conn = http.client.HTTPConnection("127.0.0.1", gw_port, timeout=timeout)
    try:
        conn.request(
            "POST",
            "/v1/chat/completions",
            body=body,
            headers={"Content-Type": "application/json", "Connection": "close"},
        )
        resp = conn.getresponse()
        status_line = "HTTP/1.1 %d %s" % (resp.status, resp.reason)
        while True:
            try:
                line = resp.readline()
            except (socket.timeout, TimeoutError):
                break
            if not line:
                break
            text = line.decode("utf-8", "replace")
            if first is None and text.startswith("data:"):
                first = time.time() - started
            lines.append(text)
    finally:
        conn.close()
    return status_line, "".join(lines), (first or 999.0)


def client_content(body):
    """客户端视角：拼所有 delta.content，并回报解析失败的帧数。

    第二个返回值是「有多少 data 行不是合法 JSON」。真客户端（openai SDK）遇到坏帧会
    直接抛异常，所以这个计数不能只看内容长度——内容拼对了、但中间夹着一条残缺帧，
    客户端依然会崩。断流场景尤其要看这条。
    """
    sb = []
    bad = 0
    for line in body.split("\n"):
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            obj = json.loads(payload)
        except Exception:
            bad += 1
            continue
        for ch in obj.get("choices", []):
            delta = ch.get("delta") or {}
            if isinstance(delta.get("content"), str):
                sb.append(delta["content"])
    return "".join(sb), bad


def find_port(logfile, pattern, deadline=45):
    """从服务端日志里读端口（派生实例端口不固定，不能写死）。"""
    end = time.time() + deadline
    while time.time() < end:
        if os.path.isfile(logfile):
            with open(logfile, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            m = re.search(pattern, text, re.MULTILINE)
            if m:
                return int(m.group(1))
        time.sleep(0.3)
    return None


# ------------------------------------------------------------------ 主流程

MODES = ["ok", "rate429", "server500", "half", "drip", "bigchunk", "splitph"]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    keep = "--keep" in sys.argv
    modes = args or MODES

    if not keep and os.path.isdir(CHAOS_HOME):
        shutil.rmtree(CHAOS_HOME, ignore_errors=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    # 1) 起故障上游
    chaos = ThreadingHTTPServer(("127.0.0.1", CHAOS_PORT), ChaosHandler)
    threading.Thread(target=chaos.serve_forever, daemon=True).start()
    print("== 故障上游 127.0.0.1:%d ==" % CHAOS_PORT)

    # 2) 起被测网关（真实进程）
    java_home = os.path.expanduser("~/.workbuddy/binaries/jdk-21/jdk-21.0.3+9")
    env = dict(os.environ)
    env["JAVA_HOME"] = java_home
    log = os.path.join(CHAOS_HOME, "server.log")
    os.makedirs(CHAOS_HOME, exist_ok=True)
    lf = open(log, "w", encoding="utf-8")
    proc = subprocess.Popen(
        [
            os.path.join(java_home, "bin", "java.exe"),
            "-Dfile.encoding=UTF-8",
            "-Dsun.stdout.encoding=UTF-8",
            "-cp", os.path.join(ROOT, "server", "build", "install", "aigw-server", "lib") + "/*",
            "dev.aigw.server.MainKt",
            "--data", DATA_DIR,
            "--no-browser",
        ],
        cwd=ROOT,
        env=env,
        stdout=lf,
        stderr=subprocess.STDOUT,
    )
    try:
        # 日志里的中文在 GBK 控制台上会乱码，所以只认 ASCII 锚点：
        # UI 行是 `... http://127.0.0.1:<n>/`，网关行是 `... http://127.0.0.1:<n>/v1`
        ui_port = find_port(log, r"http://127\.0\.0\.1:(\d+)/\s*$")
        if not ui_port:
            print("  服务端未起来，日志尾部：")
            print(open(log, encoding="utf-8", errors="replace").read()[-1200:])
            return 1
        gw_port = find_port(log, r"127\.0\.0\.1:(\d+)/v1")
        if not gw_port:
            print("  网关端口未落，日志尾部：")
            print(open(log, encoding="utf-8", errors="replace").read()[-1200:])
            return 1
        print("== 被测实例 UI:%d 网关:%d ==" % (ui_port, gw_port))

        # 3) 注册故障上游为自定义供应商
        code, out = http_post(
            "http://127.0.0.1:%d/ui/custom/save" % ui_port,
            {
                "name": "chaos",
                "key": "chaos",
                "baseUrl": "http://127.0.0.1:%d/v1" % CHAOS_PORT,
                "apiKeys": ["chaos-key"],
                "models": ["echo"],
            },
        )
        if '"ok":true' not in out.replace(" ", ""):
            note(False, "注册故障上游", out[:200])
            return 1
        note(True, "注册故障上游", "custom:chaos")

        # 4) 熔断阈值抬到 100、maxAttempts 压到 1。
        #
        # 不这么做，模式之间会互相污染：500 模式把唯一供应商打到熔断后，
        # 后面的 half/drip/bigchunk 全都拿到「熔断隔离中，直接跳过」，
        # 验的就不是那三种故障了。阈值 100 让 7 个模式各打一次也不会断；
        # maxAttempts=1 保证一次请求只打一次上游，客户端看到的行为可预测。
        http_post(
            "http://127.0.0.1:%d/ui/strategy/save" % ui_port,
            {
                "enabled": True,
                "retry": {"maxAttempts": 1},
                "circuitBreaker": {"failureThreshold": 100, "openDurationMs": 3600000},
                "modelCooldown": {"cooldownMs": 60000},
            },
        )

        # 5) 开隐私脱敏（对照组需要）
        http_post(
            "http://127.0.0.1:%d/ui/strategy/save" % ui_port,
            {"security": {"privacyRedactionEnabled": True}},
        )
        code, out = http_get("http://127.0.0.1:%d/ui/strategy" % ui_port)
        redaction_on = '"privacyRedactionEnabled":true' in out.replace(" ", "")
        note(redaction_on, "隐私脱敏已开启", "（对照组前置条件）")

        # 6) 逐模式断言
        for mode in modes:
            http_post("http://127.0.0.1:%d/__reset" % CHAOS_PORT, {})
            http_post("http://127.0.0.1:%d/__mode" % CHAOS_PORT, {"mode": mode})
            print("\n== 模式 %s ==" % mode)
            expect(mode, gw_port, ui_port)

        # 6) 对照组哈希：脱敏关 vs 脱敏开
        print("\n== 对照组哈希（同一原文，两条路径）==")
        http_post("http://127.0.0.1:%d/__mode" % CHAOS_PORT, {"mode": "ok"})

        http_post(
            "http://127.0.0.1:%d/ui/strategy/save" % ui_port,
            {"security": {"privacyRedactionEnabled": False}},
        )
        http_post("http://127.0.0.1:%d/__reset" % CHAOS_PORT, {})
        _, body_off, _ = stream_chat(gw_port)
        content_off, bad_off = client_content(body_off)

        http_post(
            "http://127.0.0.1:%d/ui/strategy/save" % ui_port,
            {"security": {"privacyRedactionEnabled": True}},
        )
        http_post("http://127.0.0.1:%d/__reset" % CHAOS_PORT, {})
        _, body_on, _ = stream_chat(gw_port)
        content_on, bad_on = client_content(body_on)

        note(bad_off == 0 and bad_on == 0, "对照组两条路径都无残缺帧", "off=%d on=%d" % (bad_off, bad_on))
        note(
            sha256(ECHO_TEXT) == sha256(content_off),
            "脱敏关：客户端内容 == 原文",
            "sha=%s" % sha256(content_off)[:16],
        )
        note(
            sha256(content_off) == sha256(content_on),
            "脱敏开还原后 sha256 == 脱敏关",
            "%s vs %s" % (sha256(content_off)[:16], sha256(content_on)[:16]),
        )
        note("__AIGW_" not in content_on, "客户端内容不含占位符前缀")

        ctrl_received = json.loads(http_get("http://127.0.0.1:%d/__received" % CHAOS_PORT)[1])
        last = (ctrl_received.get("received") or [""])[-1]
        note(SECRET not in last, "上游没看到原始密钥", "收到长度 %d" % len(last))
        note("__AIGW_" in last, "上游确实看到了占位符（脱敏真生效）")

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        lf.close()
        chaos.shutdown()

    print("\n== 结论 ==")
    if FAILS:
        print("  %d 条不符合期望：" % len(FAILS))
        for f in FAILS:
            print("   - " + f)
        return 1
    print("  全部模式符合预先写定的期望。")
    return 0


def expect(mode, gw_port, ui_port):
    if mode == "ok":
        status, body, _ = stream_chat(gw_port)
        content, bad = client_content(body)
        note(bad == 0, "所有 data 行都是合法 JSON", "坏帧 %d" % bad)
        note("200" in status, "HTTP 200", status)
        note(sha256(ECHO_TEXT) == sha256(content), "内容逐字节一致", "sha=%s" % sha256(content)[:16])
        note("[DONE]" in body, "带终止帧")
        note("__AIGW_" not in content, "无占位符泄漏")

    elif mode == "rate429":
        status, body, _ = stream_chat(gw_port)
        note(not status.startswith("HTTP/1.1 200"), "不是 200", status)
        note("429" in status, "客户端拿到 429（限流如实上报，不伪装成 500）", status)
        note("rate_limit_exceeded" in body, "错误码 rate_limit_exceeded", body[:160])

    elif mode == "server500":
        status, body, _ = stream_chat(gw_port)
        note(not status.startswith("HTTP/1.1 200"), "不是 200", status)
        note("502" in status, "客户端拿到 502", status)
        note("upstream_error" in body, "错误码 upstream_error", body[:160])

    elif mode == "half":
        status, body, _ = stream_chat(gw_port)
        content, bad = client_content(body)
        note(bad == 0, "断流后没有残缺帧传给客户端", "坏帧 %d" % bad)
        note(len(content) > 0, "客户端收到了上游已发出的半截", "%d 字符" % len(content))
        # 关键：断流必须给出终止信号，否则客户端只能一直等到自己超时
        note(
            "[DONE]" in body or "upstream_interrupted" in body,
            "断流后补了终止帧（不是裸断流）",
            body[-160:].replace("\n", "\\n"),
        )
        note(content != ECHO_TEXT, "内容确实不完整（上游只发了半截）")

    elif mode == "drip":
        status, body, first = stream_chat(gw_port)
        content, bad = client_content(body)
        note(bad == 0, "没有残缺帧", "坏帧 %d" % bad)
        note(sha256(ECHO_TEXT) == sha256(content), "逐字节完整（慢速多帧不丢字）", "sha=%s" % sha256(content)[:16])
        # 上游每字符 50ms；若网关攒包，首字要等全文才出
        note(first < 5.0, "首字延迟 < 5s（没有攒包）", "%.2fs" % first)

    elif mode == "bigchunk":
        status, body, _ = stream_chat(gw_port)
        content, bad = client_content(body)
        note(bad == 0, "没有残缺帧", "坏帧 %d" % bad)
        note(len(content) > 90_000, "96KB 单帧未被截断", "%d 字符" % len(content))
        note("[DONE]" in body, "带终止帧")

    elif mode == "splitph":
        status, body, _ = stream_chat(gw_port)
        content, bad = client_content(body)
        note(bad == 0, "没有残缺帧", "坏帧 %d" % bad)
        note(sha256(ECHO_TEXT) == sha256(content), "占位符被劈成两帧后仍拼回原文", "sha=%s" % sha256(content)[:16])
        note("__AIGW_" not in content, "无占位符泄漏", content[-60:])


if __name__ == "__main__":
    sys.exit(main())
