// 高级策略页「安全防护」卡的深度巡检。
//
// 通用 ui_walk.js 只会点页面上已经存在的按钮，且这一页的保存是一个整体动作：
// 勾上两个开关 + 填两个数字 → 保存 → 切走再切回 → 核对值是否被读回，
// 这条往返只有专门的脚本能验。
//
// 用法: node ui_strategy_walk.js <baseUrl> <outFile>
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:18180';
const OUT = process.argv[3] || 'strategy-walk.json';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startChrome() {
  // 每轮唯一 profile：固定目录会把旧 app.js 缓存住，读到的是上一版前端
  const profile = path.join(os.tmpdir(), 'aigw-cdp-strategy-' + Date.now());
  const p = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-application-cache', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, '--window-size=1240,820', 'about:blank',
  ], { stdio: 'ignore', detached: false });
  return p;
}

async function waitEndpoint() {
  // 必须取 **page 级** 的 webSocketDebuggerUrl：Runtime/Page 这些域挂在 page target 上，
  // 用 /json/version 返回的浏览器级 socket 发 Runtime.enable 会得到 -32601。
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

// 注意：ExecuteScriptAsync 不 await Promise，脚本必须**同步 return** 一个值。
// 所以这里不写 async IIFE，改用同步表达式 + 由外部轮询步进。
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
    result = { fatal: String(e && e.stack || e) };
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
  if (out.fatal) console.error(out.fatal.slice(0, 400));
  process.exit(out.fatal ? 2 : ((out.issues || []).length === 0 && (out.exceptions || []).length === 0 ? 0 : 1));
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

  // ---- 进高级策略页
  await cdp.eval(SYNC(`
    const n = document.querySelector('.nav-item[data-page="strategy"]');
    if (n) n.click();
    return true;
  `));
  await sleep(900);
  const pageReady = await poll(`document.querySelectorAll('#pageBody .card').length >= 4`);
  steps.push('高级策略页卡片数：' + await cdp.eval(SYNC("return document.querySelectorAll('#pageBody .card').length;")));
  need(pageReady, '4 张卡片没有全部渲染（账号策略/故障转移/安全防护/运行现状）');

  // ---- 安全防护卡存在，且四个控件就位
  const secCard = await cdp.eval(SYNC(`
    const cards = Array.from(document.querySelectorAll('#pageBody .card'));
    const hit = cards.find((c) => (c.querySelector('.card-head') || {}).textContent?.includes('安全防护'));
    return hit ? true : false;
  `));
  steps.push('安全防护卡存在：' + !!secCard);
  need(secCard, '找不到「安全防护」卡片');

  // 控件顺序：label 文本 → 控件。用 label 文本定位比按下标稳。
  const fields = await cdp.eval(SYNC(`
    const out = [];
    const card = Array.from(document.querySelectorAll('#pageBody .card'))
      .find((c) => (c.querySelector('.card-head') || {}).textContent?.includes('安全防护'));
    if (card) {
      card.querySelectorAll('.field').forEach((f) => {
        const lb = f.querySelector('label');
        out.push((lb ? lb.textContent : '?').trim());
      });
    }
    return out;
  `));
  steps.push('安全防护字段：' + JSON.stringify(fields));
  ['敏感词零宽脱敏', '本地隐私脱敏', '账号限速间隔（毫秒）', '节拍抖动（毫秒）'].forEach((want) => {
    need(fields.some((f) => f.indexOf(want) === 0), '缺字段：' + want);
  });

  // ---- 打开两个开关（用 js 直接置位 + dispatch change，模拟用户点击）
  const toggled = await cdp.eval(SYNC(`
    const card = Array.from(document.querySelectorAll('#pageBody .card'))
      .find((c) => (c.querySelector('.card-head') || {}).textContent?.includes('安全防护'));
    if (!card) return 0;
    const sws = card.querySelectorAll('.switch input[type=checkbox]');
    let n = 0;
    sws.forEach((s) => { if (!s.checked) { s.checked = true; s.dispatchEvent(new Event('change', {bubbles:true})); n++; } });
    return n;
  `));
  steps.push('本轮打开开关数：' + toggled);

  // ---- 填两个数字
  await cdp.eval(SYNC(`
    const card = Array.from(document.querySelectorAll('#pageBody .card'))
      .find((c) => (c.querySelector('.card-head') || {}).textContent?.includes('安全防护'));
    if (!card) return false;
    const inputs = card.querySelectorAll('input[type=number]');
    if (inputs[0]) { inputs[0].value = '1500'; inputs[0].dispatchEvent(new Event('input', {bubbles:true})); }
    if (inputs[1]) { inputs[1].value = '250'; inputs[1].dispatchEvent(new Event('input', {bubbles:true})); }
    return inputs.length;
  `));
  await sleep(300);
  steps.push('已填入 1500 / 250');

  // ---- 点保存
  const saveHit = await cdp.eval(SYNC(`
    const b = document.getElementById('btnSaveStrategy');
    if (!b) return false;
    b.click();
    return true;
  `));
  need(saveHit, '找不到「保存策略」按钮');
  await sleep(2500);

  const toastText = await cdp.eval(SYNC(`
    const box = document.getElementById('toasts');
    return box ? Array.from(box.children).map(t => t.textContent).join(' | ') : '';
  `));
  steps.push('保存后 toast：' + toastText.slice(0, 160));
  need(/已保存|保存成功/.test(toastText), '保存后没有成功提示：' + toastText.slice(0, 120));

  // ---- 数据是否真的落盘：直接打接口核对（这是独立证据，不依赖界面）
  const api = await cdp.eval(`fetch('/ui/strategy').then(r => r.json()).then(d => JSON.stringify(d.security))`, true);
  steps.push('接口读回 security：' + api);
  need(/\\"minIntervalMillis\\":1500/.test(api) || /\\(.*1500.*\\)/.test(api) || api.includes('1500'),
    '接口读回的限速间隔不是 1500：' + api);
  need(api.includes('true'), '接口读回的开关未打开：' + api);

  // ---- 切走再切回：验证值是从服务端读回来的，不是留在 DOM 里
  await cdp.eval(SYNC(`const n=document.querySelector('.nav-item[data-page="overview"]'); if(n) n.click(); return true;`));
  await sleep(800);
  await cdp.eval(SYNC(`const n=document.querySelector('.nav-item[data-page="strategy"]'); if(n) n.click(); return true;`));
  await sleep(1200);
  const back = await cdp.eval(SYNC(`
    const card = Array.from(document.querySelectorAll('#pageBody .card'))
      .find((c) => (c.querySelector('.card-head') || {}).textContent?.includes('安全防护'));
    if (!card) return null;
    const sws = card.querySelectorAll('.switch input[type=checkbox]');
    const nums = card.querySelectorAll('input[type=number]');
    return JSON.stringify({
      sanitize: sws[0] ? sws[0].checked : null,
      privacy: sws[1] ? sws[1].checked : null,
      minInterval: nums[0] ? nums[0].value : null,
      jitter: nums[1] ? nums[1].value : null,
    });
  `));
  steps.push('切回后控件值：' + back);
  need(back && back.includes('"minInterval":"1500"'), '切回后限速间隔没有读回 1500：' + back);
  need(back && back.includes('"sanitize":true'), '切回后脱敏开关没有保持开启');

  // ---- 溢出检查（内容区固定宽，字段多了最容易越界）
  const layout = await cdp.eval(SYNC(`
    const body = document.getElementById('pageBody');
    const over = [];
    if (body) {
      body.querySelectorAll('*').forEach((n) => {
        const r = n.getBoundingClientRect();
        if (r.width > 0 && r.right > body.getBoundingClientRect().right + 1.5) {
          over.push((n.className || n.tagName) + ' right=' + Math.round(r.right));
        }
      });
    }
    return JSON.stringify({
      bodyW: body ? Math.round(body.getBoundingClientRect().width) : 0,
      scrollW: body ? body.scrollWidth : 0,
      overflow: over.slice(0, 8),
    });
  `));
  steps.push('布局：' + layout);

  // ---- 恢复默认（探针数据不留在测试目录）
  await cdp.eval(SYNC(`
    const card = Array.from(document.querySelectorAll('#pageBody .card'))
      .find((c) => (c.querySelector('.card-head') || {}).textContent?.includes('安全防护'));
    if (!card) return false;
    const sws = card.querySelectorAll('.switch input[type=checkbox]');
    sws.forEach((s) => { s.checked = false; s.dispatchEvent(new Event('change', {bubbles:true})); });
    const nums = card.querySelectorAll('input[type=number]');
    nums.forEach((n) => { n.value = '0'; n.dispatchEvent(new Event('input', {bubbles:true})); });
    return true;
  `));
  await sleep(300);
  await cdp.eval(SYNC(`const b=document.getElementById('btnSaveStrategy'); if(b) b.click(); return true;`));
  await sleep(1800);

  const result = {
    steps,
    issues,
    exceptions,
    consoleErrors,
    layout: JSON.parse(layout || '{}'),
  };
  return result;
}

main().catch((e) => {
  console.error('FATAL ' + (e && e.stack || e));
  process.exit(2);
});
