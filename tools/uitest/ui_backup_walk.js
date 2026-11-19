// 备份与恢复页的深度巡检。
//
// 通用 ui_walk.js 只会点页面上已经存在的按钮，而这一页有三个特征它验不到：
// 1. 恢复是**两段式**的（登记 → 重启生效），"点了没反应"与"功能坏了"在界面上长得一样；
// 2. 待恢复卡与上次恢复卡只在特定状态下出现，需要真的造出那个状态；
// 3. 备份列表是动态增删的，要确认创建后列表真的多了一条、删除后真的少了一条。
//
// 本脚本只打测试数据目录（.tmp/bk-test），不碰正式数据。
//
// 用法: node ui_backup_walk.js <baseUrl> <outFile>
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:18278';
const OUT = process.argv[3] || 'backup-walk.json';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startChrome() {
  // 每轮唯一 profile：固定目录会把旧 app.js 缓存住，读到的是上一版前端
  const profile = path.join(os.tmpdir(), 'aigw-cdp-backup-' + Date.now());
  return spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-application-cache', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, '--window-size=1240,820', 'about:blank',
  ], { stdio: 'ignore', detached: false });
}

async function waitEndpoint() {
  // 必须取 page 级 socket：浏览器级 socket 发 Runtime.enable 会得到 -32601
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((x) => x.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* chrome 还没起来 */ }
    await sleep(200);
  }
  throw new Error('chrome devtools endpoint not ready');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expr, awaitPromise) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: !!awaitPromise, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    }
    return r.result?.value;
  }
}

const SYNC = (body) => `(function(){ ${body} })()`;

async function main() {
  const chrome = startChrome();
  let result = null;
  try {
    const wsUrl = await waitEndpoint();
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new Cdp(ws);

    const exceptions = [];
    const consoleErrors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(JSON.stringify(m.params).slice(0, 300));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 300));
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(2800);

    result = await runSteps(cdp, exceptions, consoleErrors);
  } catch (e) {
    result = { fatal: String((e && e.stack) || e) };
  } finally {
    try { chrome.kill(); } catch (_) { /* 已退出 */ }
  }

  const out = result || {};
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify({
    steps: (out.steps || []).length,
    issues: (out.issues || []).length,
    exceptions: (out.exceptions || []).length,
    consoleErrors: (out.consoleErrors || []).length,
    overflow: ((out.layout || {}).overflow || []).length,
    fatal: out.fatal || null,
  }));
  if ((out.issues || []).length) console.log('ISSUES: ' + JSON.stringify(out.issues));
  if (out.fatal) console.error(out.fatal.slice(0, 400));
  process.exit(out.fatal ? 2 : ((out.issues || []).length === 0
    && (out.exceptions || []).length === 0 ? 0 : 1));
}

async function runSteps(cdp, exceptions, consoleErrors) {
  const steps = [];
  const issues = [];
  const need = (cond, msg) => { if (!cond) issues.push(msg); };

  const poll = async (expr, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await cdp.eval(SYNC('return ' + expr + ';'));
      if (v) return v;
      await sleep(200);
    }
    return null;
  };

  /** 关掉所有弹窗：巡检里任何模态框都会挡住后续点击。 */
  const dismissModals = async () => {
    await cdp.eval(SYNC(`
      const m = document.getElementById('modalMask');
      if (m && !m.hidden) {
        const btns = Array.from(m.querySelectorAll('button'));
        const ok = btns.find((b) => /确定|确认|是|删除/.test(b.textContent)) || btns[btns.length - 1];
        if (ok) ok.click();
      }
      return true;
    `));
  };

  // ---- 1. 进备份页
  await cdp.eval(SYNC(`
    const n = document.querySelector('.nav-item[data-page="backup"]');
    if (n) n.click();
    return true;
  `));
  await sleep(1000);
  const pageReady = await poll(`document.querySelectorAll('#pageBody .card').length >= 2`);
  const cardCount = await cdp.eval(SYNC("return document.querySelectorAll('#pageBody .card').length;"));
  steps.push('备份页卡片数：' + cardCount);
  need(pageReady, '卡片少于 2 张（应有「备份列表」+「备份范围」）：' + cardCount);

  // 侧栏条目必须存在（新增第 12 项时要确认没被 footer 压住）
  const navOk = await cdp.eval(SYNC(`
    const n = document.querySelector('.nav-item[data-page="backup"]');
    if (!n) return null;
    const r = n.getBoundingClientRect();
    const foot = document.querySelector('.sidebar-foot');
    const fr = foot ? foot.getBoundingClientRect() : null;
    const sc = document.querySelector('.nav-scroll');
    return JSON.stringify({
      visible: r.width > 0 && r.height > 0 && r.bottom <= (fr ? fr.top : 1e9) + 0.5,
      bottom: Math.round(r.bottom),
      footTop: fr ? Math.round(fr.top) : null,
      scrollOverflow: sc ? sc.scrollHeight - sc.clientHeight : null,
    });
  `));
  steps.push('侧栏备份项：' + navOk);
  need(navOk && JSON.parse(navOk).visible, '侧栏「备份与恢复」被 footer 压住或不可见：' + navOk);

  // ---- 2. 新建备份
  const before = await cdp.eval(`fetch('/ui/backup').then(r=>r.json()).then(d=>d.count)`, true);
  steps.push('创建前备份数：' + before);

  const clicked = await cdp.eval(SYNC(`
    const b = document.getElementById('btnBackupNow');
    if (!b) return false;
    b.click();
    return true;
  `));
  need(clicked, '找不到「立即备份」按钮');
  // 备份 100+ 文件，先等 3 秒取 toast（它 5 秒就消失，等 6 秒再读会读到空串——
  // 本轮第一次跑就是这么误判成"没有成功提示"的），再等落盘完成读接口
  await sleep(3000);
  const toastText = await cdp.eval(SYNC(`
    const box = document.getElementById('toasts');
    return box ? Array.from(box.children).map(t => t.textContent).join(' | ') : '';
  `));
  steps.push('创建后 toast：' + toastText.slice(0, 160));
  need(/已备份/.test(toastText), '创建后没有成功提示：' + toastText.slice(0, 120));

  await sleep(4000);
  const after = await cdp.eval(`fetch('/ui/backup').then(r=>r.json()).then(d=>d.count)`, true);
  steps.push('创建后备份数（接口）：' + after);
  need(after === (before || 0) + 1, '备份数没有 +1（' + before + ' → ' + after + '）');

  // 界面上的行数也要跟着变（不依赖接口，独立证据）
  const rows = await cdp.eval(SYNC(`
    const t = document.getElementById('tblBackup');
    return t ? t.querySelectorAll('tbody tr').length : -1;
  `));
  steps.push('列表行数：' + rows);
  need(rows === after, '列表行数 ' + rows + ' 与接口备份数 ' + after + ' 不一致');

  // ---- 3. 点「恢复」→ 弹二次确认 → 登记 pending → 出现待恢复卡
  const restoreHit = await cdp.eval(SYNC(`
    const t = document.getElementById('tblBackup');
    if (!t) return false;
    const row = t.querySelector('tbody tr');
    if (!row) return false;
    const btn = Array.from(row.querySelectorAll('button')).find((b) => /恢复/.test(b.textContent));
    if (!btn) return false;
    btn.click();
    return true;
  `));
  need(restoreHit, '列表首行没有「恢复」按钮');
  await sleep(900);
  await dismissModals();
  await sleep(1500);

  const pending = await cdp.eval(`fetch('/ui/backup').then(r=>r.json()).then(d=>JSON.stringify(d.pending))`, true);
  steps.push('登记后的 pending：' + pending);
  need(pending && pending !== 'null', '没有登记待恢复请求：' + pending);

  // 待恢复卡必须出现在页面上（这是最容易漏渲染的一块）
  const alertCard = await cdp.eval(SYNC(`
    const has = Array.from(document.querySelectorAll('#pageBody .card'))
      .some((c) => (c.querySelector('.card-head') || {}).textContent?.includes('等待生效'));
    return has;
  `));
  steps.push('待恢复卡渲染：' + !!alertCard);
  need(alertCard, '「有一次恢复等待生效」卡片没有渲染');

  // ---- 4. 取消恢复 → 卡消失
  const cancelHit = await cdp.eval(SYNC(`
    const b = Array.from(document.querySelectorAll('#pageBody button'))
      .find((x) => /取消这次恢复/.test(x.textContent));
    if (!b) return false;
    b.click();
    return true;
  `));
  need(cancelHit, '待恢复卡里没有「取消这次恢复」按钮');
  await sleep(2000);
  const pending2 = await cdp.eval(`fetch('/ui/backup').then(r=>r.json()).then(d=>JSON.stringify(d.pending))`, true);
  steps.push('取消后 pending：' + pending2);
  need(pending2 === 'null', '取消失败，pending 仍在：' + pending2);

  // ---- 5. 删除自己刚建的那份 → 行数回落
  await dismissModals();
  await sleep(400);
  const delHit = await cdp.eval(SYNC(`
    const t = document.getElementById('tblBackup');
    if (!t) return false;
    const row = t.querySelector('tbody tr');
    if (!row) return false;
    const btn = Array.from(row.querySelectorAll('button')).find((b) => /✕/.test(b.textContent));
    if (!btn) return false;
    btn.click();
    return true;
  `));
  need(delHit, '列表首行没有删除按钮');
  await sleep(900);
  await dismissModals();
  await sleep(1800);
  const afterDel = await cdp.eval(`fetch('/ui/backup').then(r=>r.json()).then(d=>d.count)`, true);
  steps.push('删除后备份数：' + afterDel);
  need(afterDel === after - 1, '删除后数量没有 -1（' + after + ' → ' + afterDel + '）');

  // ---- 6. 溢出检查（5 列固定宽表：内容区仅 602 CSS px）
  const layout = await cdp.eval(SYNC(`
    const body = document.getElementById('pageBody');
    const over = [];
    if (body) {
      const br = body.getBoundingClientRect();
      body.querySelectorAll('*').forEach((n) => {
        const r = n.getBoundingClientRect();
        if (r.width > 0 && r.right > br.right + 1.5) {
          over.push((n.className || n.tagName) + ' right=' + Math.round(r.right));
        }
      });
    }
    const t = document.getElementById('tblBackup');
    return JSON.stringify({
      bodyW: body ? Math.round(body.getBoundingClientRect().width) : 0,
      bodyScrollW: body ? body.scrollWidth : 0,
      tableW: t ? Math.round(t.getBoundingClientRect().width) : 0,
      tableScrollW: t ? t.scrollWidth : 0,
      overflow: over.slice(0, 8),
    });
  `));
  steps.push('布局：' + layout);
  const L = JSON.parse(layout || '{}');
  need((L.overflow || []).length === 0, '内容区横向溢出：' + JSON.stringify(L.overflow));
  need((L.tableScrollW || 0) <= (L.tableW || 0) + 1, '表格自身横向溢出：' + L.tableW + ' → ' + L.tableScrollW);

  // ---- 7. 切走再切回：确认状态是从服务端读回来的
  await cdp.eval(SYNC(`const n=document.querySelector('.nav-item[data-page="overview"]'); if(n) n.click(); return true;`));
  await sleep(800);
  await cdp.eval(SYNC(`const n=document.querySelector('.nav-item[data-page="backup"]'); if(n) n.click(); return true;`));
  await sleep(1200);
  const back = await cdp.eval(SYNC(`
    const t = document.getElementById('tblBackup');
    return JSON.stringify({
      rows: t ? t.querySelectorAll('tbody tr').length : -1,
      cards: document.querySelectorAll('#pageBody .card').length,
    });
  `));
  steps.push('切回后：' + back);

  return {
    steps,
    issues,
    exceptions,
    consoleErrors,
    layout: L,
  };
}

main().catch((e) => {
  console.error('FATAL ' + ((e && e.stack) || e));
  process.exit(2);
});
