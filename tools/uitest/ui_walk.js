// 用真实 Chromium（headless CDP）跑一遍全部页面，逐页点击每个可交互元素。
// 输出：每个页面的按钮清单、点击结果、捕获到的异常 / console.error。
//
// 用法: node ui_walk.js <baseUrl> <outFile>
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:18138';
const OUT = process.argv[3] || 'ui_walk.json';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startChrome() {
  // **每轮用唯一 profile 目录**：持久 profile 会把 app.js / app.css 缓存在磁盘里，
  // 服务端没给 ETag/Last-Modified，浏览器就按启发式规则缓存。
  // 复用固定目录时 `rmSync` 常因上一轮 chrome 还握着句柄而失败（Windows 删不掉），
  // 结果「改了前端，巡检读到的还是上一版」——据此误判过两次。
  const profile = path.join(os.tmpdir(), 'aigw-cdp-' + Date.now());
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-application-cache',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--window-size=1240,820',
    'about:blank',
  ];
  const p = spawn(CHROME, args, { stdio: 'ignore', detached: false });
  return p;
}

async function waitEndpoint() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const page = list.find((x) => x.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('chrome devtools endpoint not ready');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
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
      expression: expr,
      awaitPromise: !!awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    }
    return r.result?.value;
  }
}

const WALK = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { pages: [], errors: [] };
  const modalOpen = () => {
    const m = document.getElementById('modalMask');
    return m && !m.hidden;
  };
  const modalTitle = () => (document.getElementById('modalTitle') || {}).textContent || '';
  const toasts = () => {
    const box = document.getElementById('toasts');
    if (!box) return [];
    return Array.from(box.children).map((t) => t.textContent);
  };
  async function closeModalViaCancel() {
    if (!modalOpen()) return false;
    const foot = document.getElementById('modalFoot');
    const btns = foot ? Array.from(foot.querySelectorAll('button')) : [];
    // 优先「取消」，否则最后一个按钮（关闭）
    const cancel = btns.find((b) => /取消/.test(b.textContent)) || btns[btns.length - 1];
    if (cancel) { cancel.click(); await sleep(120); }
    if (modalOpen()) {
      // 有些弹窗按钮不关闭（keepOpen），直接置位
      document.getElementById('modalMask').hidden = true;
      if (window.S) window.S.pollCancel = true;
    }
    return true;
  }
  function labelOf(node) {
    const txt = (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    const id = node.id ? '#' + node.id : '';
    const title = node.title ? ' [' + node.title + ']' : '';
    return (txt || '(图标)') + id + title;
  }

  // 强制更新弹窗是**模态且不可关闭**的（只有「退出应用」和「立即更新」两个出口，
  // 点遮罩也不关）。更新清单里 force=true 时，巡检每页第一步就被它挡住 ——
  // 实测卡了 13 分钟一个页面都没走完。这里在切页前先把它拆掉：巡检要测的是页面本身。
  // 判定用标题（弹窗挂在通用 modalMask 上，没有独立 id）：
  // 见 app.js showForceUpdateModal -> modal('必须更新才能继续使用', …)。
  // 阻断逻辑自身有独立验证：/ui/update/check 的返回 + 概览页版本条可见性。
  function dismissForceUpdate() {
    const m = document.getElementById('modalMask');
    if (m && !m.hidden && /必须更新|强制更新|需要更新|才能继续使用/.test(modalTitle())) {
      m.hidden = true;
      if (window.S) {
        // 两件事都要做：forceShown 防心跳再弹，forceOpen 让遮罩恢复可点关
        window.S.forceShown = (window.S.state && window.S.state.update && window.S.state.update.latest) || true;
        window.S.forceOpen = false;
      }
      return true;
    }
    return false;
  }

  // 会**留下真实副作用**的按钮：点一下就是停用账号、删供应商、写配置、发起签到。
  // 巡检只验证渲染与弹窗，不该动用户数据——一律跳过并记录。
  // 注意「启」「停」是账号行的单字按钮，也是路由器组的启停开关，必须靠 title 兜底识别。
  // 「保存顺序」「新建组」这类**多字前缀**也要拦（^保存 / ^新建 开头即命中，不点）：
  // 它们要么落盘要么开编辑态，巡检不需要。
  // 本段是模板字符串里的代码，注释里绝对不要出现反引号，否则模板会提前终止（踩过）。
  const MUTATING_LABEL = /^(停|启|删除|删|保存|提交|重置|清空|签到|断开|注销|立即|重载|导入|恢复|新建|添加|移除)/;
  const MUTATING_TITLE = /停用|启用|删除|保存|重置|清空|签到|断开|注销/;
  function isMutating(node) {
    if (!node) return false;
    if (node.getAttribute && node.getAttribute('data-safe') === '1') return false;
    const txt = (node.textContent || '').trim();
    const title = node.title || '';
    return MUTATING_LABEL.test(txt) || MUTATING_TITLE.test(title);
  }

  const PAGES = ['overview','logs','providers','accounts','models','smartRoute','groups','gateway','keys','calls','strategy','media','backup'];
  for (const page of PAGES) {
    // 切页前先拆强制更新弹窗：它是模型态的，不拆则第一页就停在这里（实卡 13 分钟）
    dismissForceUpdate();
    // 切页（走真实导航点击）
    const nav = document.querySelector('.nav-item[data-page="' + page + '"]');
    if (nav) nav.click(); else go(page);
    await sleep(900);
    // 心跳可能在切页后又弹一次
    dismissForceUpdate();

    const rec = {
      page,
      title: (document.getElementById('pageTitle') || {}).textContent || '',
      buttons: [],
      switches: 0,
      inputs: 0,
      modalAfter: null,
      nodeCount: document.getElementById('pageBody').querySelectorAll('*').length,
    };

    // ---- 点页头动作按钮 + 卡片内按钮（一次性取快照，逐个点）
    const clickTargets = () => Array.from(document.querySelectorAll(
      '#pageActions button, #pageBody button, .log-tab'
    ));
    let targets = clickTargets();
    // 记录清单（点击前）
    rec.buttons = targets.map(labelOf);
    rec.switches = document.querySelectorAll('.switch input[type=checkbox]').length;
    rec.inputs = document.querySelectorAll('#pageBody input, #pageBody textarea, #pageBody select').length;

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t.isConnected) continue;   // 点击可能重建 DOM
      const label = labelOf(t);
      // 写操作一律不点：账号页每行有「停/启」按钮，点一下就是真停用并落盘。
      // 本脚本只验证「渲染 + 弹窗 + 不报错」，不该留下任何副作用；带复原的开关在下面单独处理。
      if (isMutating(t)) {
        rec.buttons[rec.buttons.indexOf(label)] = label + ' -> SKIPPED(mutating)';
        continue;
      }
      const before = toasts().length;
      try {
        t.click();
      } catch (e) {
        rec.buttons.push('CLICK-THROW ' + label + ': ' + e.message);
        continue;
      }
      await sleep(500);
      const item = { label, modal: null, toast: null };
      if (modalOpen()) {
        item.modal = modalTitle();
        await closeModalViaCancel();
      }
      const after = toasts();
      if (after.length > before) item.toast = after[after.length - 1];
      rec.buttons[rec.buttons.indexOf(label)] = item.label + ' -> '
        + (item.modal ? 'modal:' + item.modal : '')
        + (item.toast ? ' toast:' + item.toast : '');
      await sleep(250);
    }

    // ---- 点开关（每个都切一次，再切回来）
    const switches = Array.from(document.querySelectorAll('#pageBody .switch input[type=checkbox]'));
    for (let i = 0; i < switches.length; i++) {
      const sw = switches[i];
      if (!sw.isConnected) continue;
      const was = sw.checked;
      sw.click();
      await sleep(450);
      const after = toasts();
      rec.buttons.push('SWITCH#' + i + (was ? ' on->off' : ' off->on')
        + (after.length ? ' toast:' + after[after.length - 1] : ''));
      if (modalOpen()) await closeModalViaCancel();
      const now = document.querySelectorAll('#pageBody .switch input[type=checkbox]')[i];
      if (now && now.isConnected && now.checked !== was) {
        now.click();   // 复原
        await sleep(350);
      }
    }

    // ---- 点日志过滤 tab
    if (page === 'logs') {
      const tabs = Array.from(document.querySelectorAll('.log-tab'));
      for (const tab of tabs) {
        tab.click();
        await sleep(180);
      }
      rec.buttons.push('LOG-TABS ' + tabs.length + ' 个已切换');
    }

    // ---- 点表格行（调用记录详情）
    if (page === 'calls') {
      const row = document.querySelector('#pageBody table tbody tr');
      if (row) {
        row.click();
        await sleep(300);
        rec.modalAfter = modalOpen() ? modalTitle() : null;
        await closeModalViaCancel();
      }
    }

    rec.modalAfter = modalOpen() ? modalTitle() : rec.modalAfter;
    if (modalOpen()) await closeModalViaCancel();
    out.pages.push(rec);
  }
  // 主题切换（走宿主入口，等价标题栏按钮）
  try {
    window.aigwToggleTheme();
    await sleep(600);
    const t1 = document.documentElement.getAttribute('data-kd-theme');
    window.aigwToggleTheme();
    await sleep(600);
    const t2 = document.documentElement.getAttribute('data-kd-theme');
    out.theme = t1 + ' -> ' + t2;
  } catch (e) { out.errors.push('theme: ' + e.message); }

  return out;
})()
`;

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
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');

    // **必须关缓存**。`--user-data-dir` 是持久 profile，Chrome 会缓存 app.js/app.css；
    // 改了前端再跑巡检，读到的还是上一版（会以为改动没生效，或者把已经修好的
    // overflow 问题当成还在）。服务端没给 ETag/Last-Modified，浏览器就按启发式规则缓存。
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(3500);

    // 前置：清掉可能残留的弹窗 / 让页面稳定
    await cdp.eval('document.getElementById("modalMask").hidden = true; 1');

    const res = await cdp.eval(WALK, true);
    if (res && res.__err) {
      result = { fatal: res.__err };
    } else {
      result = res;
    }

    // 收集异常
    const exceptions = [];
    const consoleErrors = [];
    for (const ev of cdp.events) {
      if (ev.method === 'Runtime.exceptionThrown') {
        const d = ev.params.exceptionDetails;
        exceptions.push((d.exception && d.exception.description) || d.text);
      }
      if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
        consoleErrors.push(ev.params.entry.text + ' @ ' + (ev.params.entry.url || ''));
      }
    }
    result = result || {};
    result.exceptions = exceptions;
    result.consoleErrors = consoleErrors;
    // 布局度量：确认没有横向溢出
    const layout = await cdp.eval(`(() => {
      const b = document.getElementById('pageBody');
      const over = [];
      document.querySelectorAll('#pageBody *').forEach((n) => {
        if (n.scrollWidth > n.clientWidth + 2 && n.clientWidth > 0) {
          over.push((n.className || n.tagName) + ' ' + n.scrollWidth + '>' + n.clientWidth);
        }
      });
      return { bodyW: b.clientWidth, bodyScroll: b.scrollWidth, overflow: over.slice(0, 12) };
    })()`);
    result.layout = layout;
    ws.close();
  } finally {
    try { chrome.kill(); } catch (_) { }
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    pages: (result.pages || []).length,
    exceptions: (result.exceptions || []).length,
    consoleErrors: (result.consoleErrors || []).length,
    layout: result.layout,
    fatal: result.fatal,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
