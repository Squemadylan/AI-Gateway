#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""对 /ui/* 全部端点做一次真实请求，输出状态码与响应摘要。"""
import json
import sys
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:%s" % (sys.argv[1] if len(sys.argv) > 1 else "18138")

RESULTS = []


def call(method, path, body=None, note=""):
    url = BASE + path
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode("utf-8", "replace")
            code = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        code = e.code
    except Exception as e:
        raw, code = "EXC %s" % e, -1
    ms = int((time.time() - t0) * 1000)
    short = raw if len(raw) <= 260 else raw[:260] + "…"
    RESULTS.append((method, path, code, ms, short, note))
    print("%-4s %-26s %3s %6dms  %s" % (method, path, code, ms, short.replace("\n", " ")), flush=True)
    return raw


def main():
    print("== 读接口 ==")
    call("GET", "/ui/state")
    call("GET", "/ui/state?models=1")
    call("GET", "/ui/models")
    call("GET", "/ui/logs?since=-1")
    call("GET", "/ui/logs?since=0&limit=5")
    call("GET", "/ui/calls?limit=20")
    call("GET", "/ui/strategy")
    call("GET", "/ui/groups")
    call("GET", "/ui/custom")
    call("GET", "/ui/backup")
    call("GET", "/")
    call("GET", "/unknown/page")
    call("GET", "/ui/does-not-exist")

    print("== 只读写接口（幂等） ==")
    call("POST", "/ui/theme", {"theme": "light"}, "切浅色")
    call("POST", "/ui/theme", {"theme": "dark"}, "切深色")
    call("POST", "/ui/theme", {"theme": "bogus"}, "非法主题值")
    call("POST", "/ui/affinity/clear", {})
    call("POST", "/ui/cooling/clear", {})
    call("POST", "/ui/auto/prune", {})

    print("== 参数校验（应当返回 ok:false 而不是 500） ==")
    call("POST", "/ui/account/enable", {}, "缺 providerId")
    call("POST", "/ui/account/priority", {"providerId": "trae"}, "缺 uid")
    call("POST", "/ui/account/delete", {"providerId": "__nope__", "uid": "__nope__"}, "不存在的账号")
    call("POST", "/ui/account/import", {"providerId": "trae", "raw": ""}, "空凭证")
    call("POST", "/ui/login/browser", {}, "缺 providerId")
    call("POST", "/ui/login/browser", {"providerId": "__nope__"}, "不存在的供应商")
    call("POST", "/ui/login/poll", {"providerId": "trae", "state": "__bad__"}, "坏 state")
    call("POST", "/ui/login/sms/send", {"providerId": "codebuddy"}, "缺手机号")
    call("POST", "/ui/login/sms/complete", {"providerId": "codebuddy"}, "缺参数")
    call("POST", "/ui/auto/chain", {}, "缺 members")
    call("POST", "/ui/auto/chain", {"members": [{"providerId": "x", "model": ""}]}, "空模型名成员")
    call("POST", "/ui/settings", {}, "空 body（应保持原值）")
    call("POST", "/ui/settings", {"port": "abc"}, "端口非数字")
    call("POST", "/ui/groups", {}, "缺 groups")
    print("== 自定义供应商 ==")
    call("GET", "/ui/custom")
    call("POST", "/ui/custom/save", {}, "缺地址与短名")
    call("POST", "/ui/custom/save", {"name": "纯中文", "baseUrl": "https://x.test"},
         "纯中文名派生不出短名")
    call("POST", "/ui/custom/save", {"key": "probe-custom", "name": "探针中转",
                                     "baseUrl": "https://x.test",
                                     "apiKeys": ["sk-probe"], "models": ["m1", "m2"]},
         "新建（含 key 与模型）")
    call("POST", "/ui/custom/save", {"originalKey": "probe-custom", "key": "probe-c2",
                                     "baseUrl": "https://x.test"}, "改名")
    call("POST", "/ui/custom/models", {}, "拉模型缺地址")
    call("POST", "/ui/custom/models", {"baseUrl": "http://127.0.0.1:1/none", "apiKey": "k"},
         "拉模型：连接被拒（原因要能带回来）")
    call("POST", "/ui/custom/delete", {}, "缺 key")
    call("POST", "/ui/custom/delete", {"key": "__nope__"}, "删不存在的条目")
    call("POST", "/ui/custom/delete", {"key": "probe-c2"}, "删除探针条目")
    call("POST", "/ui/custom/reload", {}, "重新登记（空配置也应 ok")
    call("GET", "/ui/custom/reload", None, "GET 打 reload（应 400）")

    print("== 路由组 ==")
    call("POST", "/ui/groups/save", {}, "缺 group")
    call("POST", "/ui/groups/save", {"group": {"name": "x"}}, "缺组名")
    call("POST", "/ui/groups/save", {"group": {"id": "a/b"}}, "组名含斜杠")
    call("POST", "/ui/groups/save",
         {"group": {"id": "probe-grp", "name": "探针组", "enabled": True, "strategy": "ORDER",
                    "members": [{"providerId": "trae", "model": "probe-model",
                                 "priority": 100, "weight": 1}],
                    "rules": [{"targetProviderId": "trae", "targetModel": "probe-model",
                               "minPromptTokens": 0, "startMinuteOfDay": 1320,
                               "endMinuteOfDay": 120, "daysOfWeek": [1, 3, 5]}]}},
         "新建探针组（含跨午夜规则）")
    call("POST", "/ui/groups/save",
         {"group": {"id": "probe-grp", "enabled": False, "strategy": "WEIGHT",
                    "members": [{"providerId": "trae", "model": "probe-model", "weight": 3}]}},
         "覆盖同名组：换策略/停用")
    call("POST", "/ui/groups/save",
         {"group": {"id": "probe-grp", "strategy": "BOGUS"}}, "非法策略枚举（应回落 ORDER）")
    call("POST", "/ui/groups/delete", {}, "缺 id")
    call("POST", "/ui/groups/delete", {"id": "__nope__"}, "删除不存在的组")
    call("POST", "/ui/groups/delete", {"id": "probe-grp"}, "删除探针组")
    call("POST", "/ui/keys", {"op": "bogus"}, "未知 op")
    call("POST", "/ui/keys", {"op": "add"}, "缺 name")
    call("POST", "/ui/strategy/save", {"accountStrategy": "NOPE"}, "非法策略枚举")
    call("POST", "/ui/strategy/save", {}, "空策略体")
    call("POST", "/ui/media/image", {}, "缺 prompt")
    call("POST", "/ui/media/transcribe", {}, "缺文件")
    call("POST", "/ui/media/transcribe", {"base64": "!!!notbase64!!!"}, "非法 base64")
    call("POST", "/ui/credits/refresh", {"providerId": "__nope__"}, "不存在的供应商")
    call("POST", "/ui/cooling/clear", "not-json", "畸形 JSON")

    print("== 备份 ==")
    # 只测**拒绝路径**：创建/恢复会往测试数据目录里真的写文件，
    # 泛用探针必须跳过写操作（同一目录可能被别的用例复用）。
    call("GET", "/ui/backup")
    call("POST", "/ui/backup/delete", {}, "缺 name")
    call("POST", "/ui/backup/delete", {"name": "../evil.zip"}, "删除穿越路径")
    call("POST", "/ui/backup/delete", {"name": "__nope__.zip"}, "删除不存在的备份")
    call("POST", "/ui/backup/restore", {}, "恢复缺 name")
    call("POST", "/ui/backup/restore", {"name": "../evil.zip"}, "恢复穿越路径")
    call("POST", "/ui/backup/restore", {"name": "__nope__.zip"}, "恢复不存在的备份")
    call("POST", "/ui/backup/cancel", {}, "取消（当前无 pending）")

    print("== 开关类 ==")
    call("POST", "/ui/auto/toggle", {"enabled": False})
    call("POST", "/ui/auto/toggle", {"enabled": True})
    call("POST", "/ui/keys", {"op": "add", "name": "probe-key"}, "新建密钥")
    raw = call("GET", "/ui/state")
    try:
        keys = json.loads(raw).get("clientKeys") or []
    except Exception:
        keys = []
    kid = keys[-1]["id"] if keys else None
    if kid:
        call("POST", "/ui/keys", {"op": "remove", "id": kid}, "删除刚建的密钥")
    else:
        print("!! 无法取到刚建的密钥 id", flush=True)

    print("== 账号操作（在数据副本上做） ==")
    raw = call("GET", "/ui/state")
    st = json.loads(raw)
    accts = st.get("accounts") or []
    if accts:
        a = accts[0]
        call("POST", "/ui/account/enable", {"providerId": a["providerId"], "uid": a["uid"], "enabled": False}, "停用")
        call("POST", "/ui/account/enable", {"providerId": a["providerId"], "uid": a["uid"], "enabled": True}, "启用")
        call("POST", "/ui/account/priority", {"providerId": a["providerId"], "uid": a["uid"], "up": True}, "上移")
        call("POST", "/ui/account/priority", {"providerId": a["providerId"], "uid": a["uid"], "up": False}, "下移")

    print("== 网关启动/停止 ==")
    call("POST", "/ui/gateway/stop", {})
    raw = call("GET", "/ui/state")
    print("   stop 后 running=%s" % json.loads(raw).get("running"), flush=True)
    call("POST", "/ui/gateway/start", {})
    raw = call("GET", "/ui/state")
    print("   start 后 running=%s" % json.loads(raw).get("running"), flush=True)
    call("POST", "/ui/gateway/start", {}, "重复 start")

    print("== 导出 ==")
    body = call("POST", "/ui/account/export", {})
    print("   export len=%d prefix=%r" % (len(body), body[:60]), flush=True)

    print("== 方法校验（本轮重点：GET 不应能改数据） ==")
    call("GET", "/ui/theme?theme=light", None, "GET 改主题")
    call("GET", "/ui/account/delete", None, "GET 删账号（危险）")
    call("GET", "/ui/backup/create", None, "GET 建备份（应 400）")
    call("GET", "/ui/backup/restore?name=x.zip", None, "GET 恢复（应 400）")

    bad = [r for r in RESULTS if r[2] != 200]
    print("\n=== 汇总 %d 个请求，非 200 有 %d 个 ===" % (len(RESULTS), len(bad)))
    for r in bad:
        print("  %s %s -> %s  %s" % (r[0], r[1], r[2], r[4][:120]))


main()
