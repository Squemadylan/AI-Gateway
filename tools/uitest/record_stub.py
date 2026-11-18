#!/usr/bin/env python3
"""记录型 OpenAI 兼容桩：把收到的**请求体原文**写进文件，用于验证隐私脱敏。

存在的理由：隐私脱敏这个能力的效果只体现在「上游到底看到了什么」，
网关自己的日志和调用记录都不可作为独立证据（它会把占位符还原后再记录）。
所以这里把 upstream 视角的原文落盘，与客户端发出去的内容直接对比。

用法: python record_stub.py <port> <outfile>
  端点: GET /v1/models, POST /v1/chat/completions（非流式 + 流式）
"""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18999
OUT = sys.argv[2] if len(sys.argv) > 2 else "recorded.jsonl"
_lock = threading.Lock()


def record(kind: str, payload) -> None:
    line = json.dumps({"kind": kind, "payload": payload}, ensure_ascii=False)
    with _lock:
        with open(OUT, "a", encoding="utf-8") as f:
            f.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if path.endswith("/models"):
            self._json(200, {"object": "list", "data": [
                {"id": "rec-chat", "object": "model", "owned_by": "stub"},
            ]})
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if not path.endswith("/chat/completions"):
            record("other", {"path": path, "raw": raw.decode("utf-8", "replace")})
            self._json(404, {"error": {"message": "not implemented"}})
            return

        try:
            req = json.loads(raw.decode("utf-8"))
        except Exception:
            record("bad-json", {"raw": raw.decode("utf-8", "replace")})
            self._json(400, {"error": {"message": "bad json"}})
            return

        record("chat", req)
        model = req.get("model", "")
        stream = bool(req.get("stream"))
        # 回显最后一条 user 内容：脱敏后上游看到的是占位符，把它原样回给客户端，
        # 于是「客户端能不能拿回原文」就有独立证据（占位符漏到客户端 = 还原链路断了）。
        echo = "rec-ok"
        for m in req.get("messages") or []:
            if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
                echo = m["content"]

        if stream:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            frame = {
                "id": "chatcmpl-rec", "object": "chat.completion.chunk", "model": model,
                "choices": [{"index": 0, "delta": {"role": "assistant", "content": echo},
                             "finish_reason": None}],
            }
            self.wfile.write(("data: " + json.dumps(frame, ensure_ascii=False) + "\n\n").encode())
            done = {"id": "chatcmpl-rec", "object": "chat.completion.chunk", "model": model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
            self.wfile.write(("data: " + json.dumps(done, ensure_ascii=False) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return

        self._json(200, {
            "id": "chatcmpl-rec", "object": "chat.completion", "model": model,
            "created": 1,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": echo},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
        })


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[record-stub] listening on {PORT} -> {OUT}", flush=True)
    srv.serve_forever()
