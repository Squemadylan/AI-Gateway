#!/bin/sh
# 一键复测：接口 + 全按钮 + 压力 + 壳自测
PY="$USERPROFILE/.workbuddy/binaries/python/versions/3.13.12/python.exe"
NODE="$USERPROFILE/.workbuddy/binaries/node/versions/22.22.2-6/node"
PORT=${1:-18138}
echo "== 壳自测 =="
./shell/out/release/AiGatewayWeb.exe --selftest tools/uitest/selftest-run.txt && tail -1 tools/uitest/selftest-run.txt
echo "== 接口 =="
"$PY" tools/uitest/api_probe.py $PORT | tail -3
echo "== 按钮 =="
"$NODE" tools/uitest/ui_walk.js http://127.0.0.1:$PORT tools/uitest/walk-run.json | tail -8
echo "== 路由组深度 =="
"$NODE" tools/uitest/ui_groups_walk.js http://127.0.0.1:$PORT tools/uitest/groups-walk.json | tail -8
echo "== 自定义供应商深度 =="
"$NODE" tools/uitest/ui_custom_walk.js http://127.0.0.1:$PORT tools/uitest/custom-walk.json | tail -8
echo "== 备份深度 =="
"$NODE" tools/uitest/ui_backup_walk.js http://127.0.0.1:$PORT tools/uitest/backup-walk.json | tail -8
echo "== 压力 =="
"$PY" tools/uitest/stress.py $PORT | tail -3

# 这两支会自己起子进程（网关 + 故障上游），别走管道——管道缓冲会让它挂住
echo "== 流式保真 + 故障注入 =="
"$PY" tools/uitest/chaos_stream.py > tools/uitest/chaos-run.log 2>&1
tail -4 tools/uitest/chaos-run.log
echo "== 脱敏还原变异测试 =="
"$PY" tools/uitest/mutate_redactor.py > tools/uitest/mutation-run.log 2>&1
tail -6 tools/uitest/mutation-run.log
