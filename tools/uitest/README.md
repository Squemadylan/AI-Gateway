# 自检脚本（tools/uitest）

这六支脚本是本项目「改完自己走一遍」的固定流程。全部用真实进程：真后端 +
真 Chromium（headless + CDP）+ 真壳（WebView2），不是 mock。

## 用法

先起一个后端（测试用独立数据目录，别碰正式数据）：

```bash
# 项目根目录执行
export JAVA_HOME=~/.workbuddy/binaries/jdk-21/jdk-21.0.3+9
java -cp "server/build/install/aigw-server/lib/*" dev.aigw.server.MainKt \
     --data "$(pwd)/.tmp/uitest/data" --no-browser &
# 日志里会打印 UI 端口（默认目录 8792，派生目录 18xxx），下面用 <UI_PORT>
```

一键跑完五步：

```bash
sh tools/uitest/run_all.sh <UI_PORT>
```

或者分开跑：

| 脚本 | 做什么 | 通过标准 |
|---|---|---|
| `api_probe.py <port>` | 91 条请求打 46 个端点：读、写、缺参、非法参、GET 打写接口、畸形 JSON、超大请求体 | 非 200 的必须是语义正确的 400/404/413，**不能有 500** |
| `ui_walk.js <baseUrl> <out.json>` | 真 Chromium 打开页面，13 页逐页点完每个按钮/开关/tab/表格行；每步判断弹窗与 Toast 并关闭 | `exceptions: 0`、`consoleErrors: 0`、`overflow: []` |
| `ui_backup_walk.js <baseUrl> <out.json>` | 备份页的**深度**巡检：创建 → 接口 +1 → 列表行数同步 → toast → 点恢复 → 二次确认 → pending 出现 → 「等待生效」卡渲染 → 取消 → 删除 -1 → 切走切回。通用巡检点不到（恢复是两段式的，且写操作要跳过） | 12 步全通、`issues: []`、`overflow: 0`；宽/窄窗口各跑一轮 |
| `ui_groups_walk.js <baseUrl> <out.json>` | 路由组页的**深度**巡检：新建 → 空成员被拦 → 从模型目录加成员 → 改优先级 → 规则弹窗填全 7 类条件 → 保存 → 切页回来 → auto 只读 → 删除。通用巡检点不到编辑区（它是「点了组才出现」的） | 20 步全通、`exceptions: 0`、`overflow: 0`、`issues: []` |
| `ui_custom_walk.js <baseUrl> <out.json>` | 供应商页「自定义供应商」区块的深度巡检：中文名派生短名 → 保存 → 列表显示规范化端点 → 编辑改名（账号搬过去）→ 拉模型（预期失败要给出可读原因）→ 删除二次确认。通用巡检点不到（表单是模态窗） | 13 步全通、`errors: []`、`overflow: 0` |
| `stress.py <port>` | keep-alive 复用连接 60 轮 × 5 请求、10 线程 × 20 并发写、41MB 请求体、畸形请求 | 全 PASS，且压力后服务仍可响应 |
| `chaos_stream.py [模式…]` | **故障注入矩阵**：自起一个可编程故障上游（正常/429/500/半截断流/慢速 drip/96KB 单帧/占位符被劈开），再自起一个干净实例，逐个模式断言客户端可见行为；末尾做脱敏关 vs 脱敏开的 sha256 对照组 | 7 模式全符合**事先写定**的期望；对照组两侧 sha256 相同 |
| `mutate_redactor.py [M1…]` | **变异测试**：对 `PrivacyRedactor` 手工种三个真实错（回看上限 -1 / flush 丢尾巴 / restore 漏一条映射），验证 `StreamFidelityTest` + `PrivacyRedactorTest` 是否变红；跑完无条件恢复并校验 sha256 | 三个变异全部被抓住，源码恢复后与备份哈希一致 |
| 壳自测 | `shell/out/release/AiGatewayWeb.exe --selftest <out.txt>` | `12 / 12 passed`（命中判定表，含最大化态与按钮区） |

## 备份页为什么要单独一支

通用 `ui_walk.js` 只点页面上已存在的按钮，而备份页有三个它验不到的特征：
① 恢复是两段式的（登记 → 重启生效），「点了没反应」与「功能坏了」在界面上长得一样；
② 「待恢复」与「上次恢复」卡只在特定状态下出现，必须真的造出那个状态；
③ 列表是动态增删的，要确认创建后真的多一条、删除后真的少一条。

注意 **Toast 只活 3–5 秒**：创建备份要等 2–3 秒落盘，先读 toast 再读接口，
顺序反了会把「提示已消失」误判成「没有成功提示」（本轮第一次跑就这么误判过）。

## 为什么这些必须自动化

- **窗口交互**：这台开发机没有交互桌面（`GetForegroundWindow()==0`、光标恒 `(0,0)`），
  外部的 Robot / 鼠标注入全部无效。能验的只有纯函数（命中判定 → `--selftest`）
  和进程内触发的路径（`--dragtest` / `--screenshot`）。
- **偶发 400**：静态资源曾经走 chunked，连接复用时残留字节会被下一个请求
  当成新的请求行。单发几次 curl 永远测不出来，必须「同一连接连发几十次」。
- **空数据目录**：全新安装是另一条代码路径（首次引导条、0 账号、
  无 `.instance.json`）。只测有数据的目录会漏掉这条。

## 截图

`AI Gateway.exe --screenshot <png> --page <key> --quit` 用
`CapturePreviewAsync` 导出**真实渲染像素**。
不要用屏幕 BitBlt / PrintWindow：Chromium 是 GPU 合成、不走 GDI，
截出来是空白或别的内容（本项目为此浪费过两轮排查）。
