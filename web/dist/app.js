// AI Gateway — WebView2 前端
// 全部状态由服务端 /ui/state 提供；前端只做渲染与交互，不发推理请求。
// 关键设计：页面切换只重建 DOM，数据刷新只改文本节点（不整块重绘），
// 因此 2 秒一拍的心跳在长列表/大表格下也不会有可感卡顿。

'use strict';

/**
 * 请求封装。
 *
 * 统一做三件原本散落各处的事：
 * 1. **超时**：`fetch` 没有默认超时，后端卡住时界面会一直转圈（点「刷新额度」
 *    那种要等上游几十秒的接口除外，那些自己传 timeout）。
 * 2. **错误归一**：网络失败、非 200、非 JSON 一律返回 `{ok:false,message}`，
 *    调用方只需要看 ok。原来每处都写 `try/catch`，漏一处就变成未捕获的
 *    `Unhandled (in promise) SyntaxError: Unexpected token 'B'`——正是本轮巡检
 *    抓到的唯一一个运行时异常。
 * 3. **不缓存**：状态类接口必须拿到当下的值。
 */
const api = {
  async get(path, params, timeoutMs = 8000) {
    const url = params ? `${path}?${new URLSearchParams(params)}` : path;
    return api._send(url, { cache: 'no-store', method: 'GET' }, timeoutMs);
  },
  async post(path, body, timeoutMs = 15000) {
    return api._send(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }, timeoutMs);
  },
  async _send(url, init, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      const text = await r.text();
      if (!r.ok) {
        // 后端错误体也是 JSON（{ok:false,message}），能解析就用它的 message
        const parsed = tryParse(text);
        return {
          ok: false,
          message: (parsed && parsed.message) || `HTTP ${r.status} ${r.statusText}`,
        };
      }
      const parsed = tryParse(text);
      if (parsed == null) {
        return { ok: false, message: '响应不是 JSON：' + text.slice(0, 120) };
      }
      return parsed;
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
      return {
        ok: false,
        message: aborted ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）`
          : '连不上本地服务：' + (e && e.message ? e.message : e),
        offline: true,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

function tryParse(text) {
  if (text == null || text === '') return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/**
 * 全局状态。
 *
 * 只放「跨渲染周期必须活着的东西」：当前页、服务端快照、未保存的编辑副本。
 * 页面级的一次性数据（比如某张卡的画布对象）一律不进这里——早先往这里塞
 * 那些，结果是切页后旧对象还在，画到已经不存在的 canvas 上。
 */
const S = {
  page: 'overview',
  state: null,
  logLines: [],
  logSeq: -1,
  logFilter: '全部',
  models: [],
  calls: [],
  modelLoaded: false,
  callsLoaded: false,
  chain: [],
  chainSynced: false,
  chainDirty: false,
  refreshingCredits: false,
  pollCancel: false,
  strategy: null,
  strategyFetchedAt: 0,
  strategyCtx: null,
  /* 路由组页的编辑态：groupsLoaded 表示已从服务端取过一次；
     editing 是当前正在编辑的组副本（null = 未进入编辑），
     groupDirty 只在「草稿与已保存值不同」时为 true，用于离开页面前提示。 */
  groups: [],
  groupsLoaded: false,
  groupSel: null,
  groupDraft: null,
  groupDirty: false,
  groupCtx: null,
  /* 自定义供应商页：customLoaded 表示已从服务端取过一次，
     custom 是服务端返回的条目（含注册状态与规范化后的真实端点）。 */
  custom: [],
  customLoaded: false,
  media: null,
  backupList: null,
  backupLoaded: false,
  tableSig: '',
  activitySig: '',
  saveStrategy: null,
  /* 强制更新状态：forceShown 记住已弹过的版本号（同一版本只弹一次，
     否则每拍心跳都会把用户关不掉的弹窗重新推上来）；
     forceOpen 为 true 时遮罩点击不关闭（见 showForceUpdateModal）。
     gateLocked 为 true 时整页被盖板锁死（见 lockShell）。 */
  forceShown: null,
  forceOpen: false,
  gateLocked: false,
  gateKeyGuard: false,
};

// ---------------------------------------------------------------- 基础工具

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** 数字缩写：1.2w / 3.4亿。负数与 null 都按 0 处理，避免表格里出现 NaN。 */
function fmtNum(n) {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(1) + 'w';
  return v.toLocaleString('zh-CN');
}
/**
 * 精确金额：千分位，不做 w/亿 缩写。
 *
 * 额度/余额是"钱"，`fmtNum` 的 2.0w 会把 20000 与 20499 显示成同一个值，
 * 用户无法据此判断还剩多少。token 数那种量级模糊无所谓的才用 `fmtNum`。
 */
function fmtAmount(n) {
  const v = Number(n || 0);
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}
function fmtTime(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function relTime(ms) {
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 0) return '刚刚';
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------- 剪贴板

/**
 * 复制文本，带降级路径。
 *
 * `navigator.clipboard` 在两种情况下会失败：窗口失去焦点、或运行环境没有
 * 授予 clipboard-write 权限（WebView2 默认**不弹**权限框，直接 reject）。
 * 这时退回 `execCommand('copy')` + 隐藏 textarea——老 API 但到处都能用。
 * 两条都失败才报错，让用户手动选中。
 */
async function copyText(text) {
  const value = String(text || '');
  if (!value) { toast('没有可复制的内容', 'warn'); return; }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      toast('已复制', 'ok');
      return;
    }
  } catch (_) { /* 落到下面的降级路径 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) { toast('已复制', 'ok'); return; }
  } catch (_) { /* 继续报错 */ }
  toast('复制失败，请手动选中文本', 'err');
}

const PROVIDER_COLORS = [
  '#2572E6', '#459025', '#D0601D', '#8B5CF6', '#0EA5E9',
  '#D63D3D', '#CA8A04', '#14B8A6',
];
const providerColor = (i) => PROVIDER_COLORS[i % PROVIDER_COLORS.length];

/** 供应商成功率卡的统计窗口（与后端 providerStatsJson 的 take(200) 对齐）。 */
const PROVIDER_STATS_WINDOW = 200;

// ---------------------------------------------------------------- Toast / Modal

function toast(msg, kind = 'info', ms = 3200) {
  const box = $('#toasts');
  const t = el('div', `toast ${kind}`, msg);
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 200ms'; }, ms);
  setTimeout(() => t.remove(), ms + 220);
}

function modal(title, bodyHtml, buttons) {
  // 任何弹窗打开都先解除「强制遮罩防关闭」标记：普通弹窗必须能点遮罩关掉。
  // 强制窗在 modal() 返回后再自己置回 true（见 showForceUpdateModal）。
  S.forceOpen = false;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  const foot = $('#modalFoot');
  foot.innerHTML = '';
  (buttons || [{ text: '关闭', primary: true }]).forEach((b) => {
    const btn = el('button', 'btn' + (b.primary ? ' primary' : ''), b.text);
    btn.addEventListener('click', () => {
      if (b.onClick) b.onClick();
      if (!b.keepOpen) closeModal();
    });
    foot.appendChild(btn);
  });
  $('#modalMask').hidden = false;
}
function closeModal() { $('#modalMask').hidden = true; }
$('#modalMask').addEventListener('click', (e) => {
  if (e.target.id === 'modalMask') closeModal();
});

/**
 * 输入弹窗：返回 Promise<string|null>，替代原生 prompt。
 *
 * `settle` 保证只结算一次：原来按 Enter 时先 resolve 再 closeModal，
 * 而 closeModal 之后按钮的 onClick 还可能被触发第二次 resolve——
 * Promise 只会采纳第一次，但第二次的 `$('#askInput').value` 会在节点已销毁时抛 TypeError。
 */
function askInput(title, label, value = '', placeholder = '') {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    modal(title, `
      <div class="field">
        <label>${esc(label)}</label>
        <input type="text" id="askInput" value="${esc(value)}" placeholder="${esc(placeholder)}">
      </div>`, [
      { text: '取消', onClick: () => settle(null) },
      { text: '确定', primary: true, onClick: () => settle($('#askInput')?.value ?? null) },
    ]);
    setTimeout(() => $('#askInput')?.focus(), 30);
    $('#askInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        settle($('#askInput')?.value ?? null);
        closeModal();
      }
    });
  });
}

function confirmBox(title, message) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    modal(title, `<div>${esc(message)}</div>`, [
      { text: '取消', onClick: () => settle(false) },
      { text: '确定', primary: true, onClick: () => settle(true) },
    ]);
  });
}

// ---------------------------------------------------------------- 主题

function applyTheme(theme) {
  document.documentElement.setAttribute('data-kd-theme', theme === 'light' ? 'light' : 'dark');
  try { localStorage.setItem('aigw-theme', theme); } catch (_) { /* 隐私模式忽略 */ }
}
function initTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem('aigw-theme') || 'dark'; } catch (_) { /* 同上 */ }
  applyTheme(saved);
}

/**
 * 主题切换。**配色只有一个所有者：前端**。
 *
 * C# 标题栏的调色是启动时读 `ui-theme.txt` 定的，所以这里切完必须把结果写回去，
 * 下次启动标题栏才跟页面一致。写盘是异步的，失败不影响当前显示。
 */
async function toggleThemeFromHost() {
  const cur = document.documentElement.getAttribute('data-kd-theme');
  const next = cur === 'light' ? 'dark' : 'light';
  applyTheme(next);
  // 画布颜色是读取 CSS 变量后画上去的，不重绘就还是旧主题的色
  renderPage();
  const r = await api.post('/ui/theme', { theme: next });
  if (r && r.ok === false) toast('主题未能保存：' + r.message, 'warn');
}

// C# 标题栏的主题按钮通过 ExecuteScriptAsync 调这里（HTML 里已没有主题按钮）
window.aigwToggleTheme = toggleThemeFromHost;

/**
 * 侧栏接入地址：在**最后一个 `/`** 处显式断成两行。
 *
 * 侧栏可用宽度 143px 装不下 `http://127.0.0.1:18237/v1`；只靠 CSS
 * `word-break: break-all` 会按字符任意断，实测断成 `…/v` + `1`
 * （端口后面那个 `1` 掉到下一行，地址看起来像两段乱码）。
 * 断在 `/v1` 前面是唯一的语义边界：上一行是 host:port，下一行是版本路径。
 */
function setBaseUrl(node, url) {
  node.textContent = '';
  const cut = url.lastIndexOf('/');
  if (cut <= 0) { node.textContent = url; return; }
  node.appendChild(document.createTextNode(url.slice(0, cut)));
  node.appendChild(el('br'));
  node.appendChild(document.createTextNode(url.slice(cut)));
}

// ---------------------------------------------------------------- 导航

const PAGES = {
  overview: ['概览', '本地网关运行状态'],
  logs: ['运行日志', '最近 300 条网关事件'],
  providers: ['供应商', '登录、导入与额度刷新'],
  accounts: ['账号', '启停、排序与额度明细'],
  models: ['模型目录', '上游模型清单（按供应商前缀路由）'],
  smartRoute: ['智能路由', 'model="auto" 的兜底链：只有顺序与可用性'],
  groups: ['路由组', '自建 group/<组名>：策略、权重与分流规则'],
  gateway: ['网关设置', '端口、API Key 与日志策略'],
  keys: ['客户端密钥', '白名单、限额与用量'],
  calls: ['调用记录', '逐条请求的耗时、Token 与错误'],
  strategy: ['高级策略', '账号选择、故障转移与并发闸门'],
  // media 的定义**刻意保留**：本项目当前定位「仅 LLM 转发」，不跟进上游的
  // 图片生成 / 语音转写，侧栏已移除入口。但渲染代码与 PAGES 条目留着——
  // 以后要跟进时，index.html 加回那一个 <a data-page="media"> 即可，不用重写整页。
  // 删掉反而会在恢复时丢掉 400 行可复用代码。
  media: ['媒体实测', '图片生成与语音转写的真实链路验证'],
  backup: ['备份与恢复', '数据目录快照；恢复在下次启动时执行'],
};

function go(page) {
  S.page = page;
  // 每次进入智能路由页都重新取一次服务端候选链（可能被别处改过），
  // 但不影响用户在本页已做的未保存改动之外的其它状态。
  if (page === 'smartRoute') S.chainSynced = false;
  // 路由组页：离开再回来时重新拉一次（另一个页面可能改过 auto 组）。
  // 正在编辑的草稿保留在 S.groupDraft 里，不因为刷新列表而丢。
  if (page === 'groups' && !S.groupDirty) S.groupsLoaded = false;
  // 自定义供应商：每次进供应商页都重读（账号页删除账号会改变账号数）
  if (page === 'providers') S.customLoaded = false;
  // 备份页每次进入都重读：别处可能刚删了备份，或上次恢复已经落地
  if (page === 'backup') S.backupLoaded = false;
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.page === page);
  });
  const [title, sub] = PAGES[page] || ['—', ''];
  $('#pageTitle').textContent = title;
  $('#pageSubtitle').textContent = sub;
  renderPage();
  // 每次进入日志页都全量重取：可能已经关掉客户端很久，增量水位早就过期了
  if (page === 'logs') reloadLogs();
}

document.querySelectorAll('.nav-item').forEach((n) => {
  n.addEventListener('click', () => go(n.dataset.page));
});

// ---------------------------------------------------------------- 状态渲染

/**
 * 状态与实例身份。
 *
 * **所有节点访问都要判空**：侧栏从 Swing 自绘换成 WebView2 时，原来的 #statusDot /
 * #statusPill 被一并删掉了，但这里还在更新它们——于是整条 renderStatus 在第一个
 * 元素上就抛 TypeError，后面「接入地址」「派生实例标记」全部被跳过。
 * 症状是接入地址永远停在「—」，而且不报任何可见错误（异常落在心跳的 try 里）。
 */
function renderStatus() {
  const s = S.state;
  if (!s) return;
  setIf('statusDot', (n) => n.classList.toggle('on', s.running));
  setIf('statusPill', (n) => {
    n.classList.toggle('on', s.running);
    n.textContent = s.running ? '运行中' : '已停止';
  });
  setIf('sidebarUrl', (n) => { setBaseUrl(n, s.localUrl || '—'); });
  renderInstanceBadge(s);
}

/** 元素存在才动它：缺失的装饰节点不该阻断后面的关键更新。 */
function setIf(id, fn) {
  const n = document.getElementById(id);
  if (n) fn(n);
}

/**
 * 派生实例标记。
 *
 * 同机可以同时开多个实例（每个数据目录一个），窗口长得一模一样，
 * 不标出来就分不清自己点的是哪一份数据。默认数据目录（derived=false）不显示，
 * 单实例用户看不到这一行。
 */
function renderInstanceBadge(s) {
  const node = document.getElementById('instBadge');
  if (!node) return;
  if (!s.derived) {
    node.hidden = true;
    return;
  }
  const dir = s.dataDir || '';
  const base = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
  node.textContent = `派生实例 · ${base}`;
  node.title = `数据目录：${dir}\n网关 ${s.port}，管理面 ${s.uiPort || ''}`;
  node.hidden = false;
}

/** 指标卡：只更新文本节点。已存在的卡片不重建 DOM，避免每秒 1 帧的重排。 */
function updateMetrics() {
  const s = S.state;
  if (!s) return;
  const p = s.pool, t = s.today;
  const setV = (key, value, cls) => {
    const node = document.querySelector(`[data-metric="${key}"] .value`);
    if (!node) return;
    if (node.textContent !== value) node.textContent = value;
    node.className = 'value' + (cls ? ' ' + cls : '');
  };
  const setN = (key, value) => {
    const node = document.querySelector(`[data-metric="${key}"] .note`);
    if (node && node.textContent !== value) node.textContent = value;
  };

  setV('accounts', p.total > 0 ? `${p.usable}/${p.total}` : `${p.usable}`,
    p.usable === 0 && p.total > 0 ? 'warn' : null);
  setN('accounts', p.total === 0 ? '池内暂无账号'
    : p.usable === 0 ? '全部不可用'
    : p.disabled > 0 ? `禁用 ${p.disabled} 个` : '全部可用');

  setV('requests', String(t.requests));
  const y = s.yesterdayRequests || 0;
  if (y > 0 && t.requests > 0) {
    const delta = (t.requests - y) / y * 100;
    setN('requests', `${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta).toFixed(1)}% 较昨日`);
  } else {
    setN('requests', t.requests === 0 ? '今日暂无调用' : '无昨日数据可对比');
  }

  setV('tokens', fmtNum(t.totalTokens));
  setN('tokens', `输入 ${fmtNum(t.promptTokens)} · 输出 ${fmtNum(t.completionTokens)}`);

  const modelCount = (s.modelsMeta || {}).count || 0;
  setV('models', modelCount > 0 ? String(modelCount) : '—');
  // 0 个模型有三种完全不同的原因：还没拉过目录 / 池里没账号 / 正在拉。
  // 文案必须分开，否则用户会以为点一下刷新就出东西。
  setN('models', modelCount > 0 ? '各供应商目录合计'
    : s.pool.total === 0 ? '先登录供应商'
      : '尚未拉取目录（模型页可拉取）');

  if (p.creditsKnown === 0) {
    setV('credits', '—');
    setN('credits', '尚未同步额度');
  } else {
    setV('credits', fmtAmount(p.totalCredits), 'gold');
    setN('credits', `已同步 ${p.creditsKnown} 个账号`);
  }

  const done = t.success + t.failed;
  if (done === 0) {
    setV('success', '—');
    setN('success', '今日暂无完成调用');
  } else {
    const pct = t.success / done * 100;
    setV('success', pct.toFixed(1) + '%', pct >= 95 ? 'ok' : 'warn');
    setN('success', t.failed > 0 ? `失败 ${t.failed} 次` : '全部成功');
  }
}

// ---------------------------------------------------------------- 概览页

function renderOverview() {
  const body = $('#pageBody');
  body.innerHTML = '';

  // 指标卡 6 张：auto-fit 网格，窄窗口自动折行
  const metrics = el('div', 'metrics');
  const mk = (key, label) => {
    const c = el('div', 'metric');
    c.dataset.metric = key;
    c.appendChild(el('div', 'label', label));
    c.appendChild(el('div', 'value', '—'));
    c.appendChild(el('div', 'note', ''));
    metrics.appendChild(c);
  };
  mk('accounts', '账号就绪');
  mk('requests', '今日请求');
  mk('tokens', '今日 tokens');
  mk('models', '模型数');
  mk('credits', '剩余额度');
  mk('success', '成功率');
  body.appendChild(metrics);

  // 首次启动引导：池内 0 账号时概览原来只有一排 0 和两块空画布，
  // 新装用户看不出下一步该去哪。这里给一条明确的路径，账号一到位就自动消失。
  if ((S.state?.pool?.total || 0) === 0) body.appendChild(buildOnboarding());

  // 版本条：永远显示（不是只在有新版本时出现）。
  // 理由——用户需要一个能随时点「检查更新」的地方；而且更新源是 GitHub raw，
  // 国内经常连不上，把「上次检查结果 / 连不上」摆出来比静默失败诚实得多。
  body.appendChild(buildVersionCard());

  // 接入地址条
  const urlCard = el('div', 'card');
  const urlBody = el('div', 'card-body url-bar');
  const lbl = el('span', 'url-bar-label', '接入地址');
  const urlNode = el('span', 'mono url-bar-value', S.state?.localUrl || '—');
  const copyBtn = el('button', 'btn sm', '复制');
  copyBtn.addEventListener('click', () => copyText(S.state?.localUrl));
  urlBody.append(lbl, urlNode, copyBtn);
  urlCard.appendChild(urlBody);
  body.appendChild(urlCard);

  // 拓扑 + 容量分布（两栏）
  const callCount = (S.state?.today?.requests || 0);
  const viz = el('div', 'split2');
  viz.appendChild(cardWith('实时调度拓扑',
    callCount > 0 ? '近 20 次调用' : '尚无调用', (b) => {
    // 拓扑 hover 的提示框同样要相对卡片定位，包一层 cap-wrap（同容量卡）
    const wrap = el('div', 'cap-wrap');
    const canvas = el('canvas');
    canvas.id = 'topoCanvas';
    canvas.height = 190;
    wrap.appendChild(canvas);
    const legend = el('div', 'legend');
    legend.id = 'topoLegend';
    wrap.appendChild(legend);
    wrap.appendChild(buildCapTooltip());
    b.appendChild(wrap);
    wireTopoHover(wrap);
    requestAnimationFrame(() => drawTopology());
  }));
  viz.appendChild(cardWith('上下文容量分布', '按各家模型数占比', (b) => {
    // 单独包一层定位容器：提示框要相对卡片定位，而 .card-body 没有 position，
    // 直接挂在 body 上会跑到最近的定位祖先（整页）去。
    const wrap = el('div', 'cap-wrap');
    const canvas = el('canvas');
    canvas.id = 'capCanvas';
    canvas.height = 190;
    wrap.appendChild(canvas);
    const legend = el('div', 'legend');
    legend.id = 'capLegend';
    wrap.appendChild(legend);
    wrap.appendChild(buildCapTooltip());
    b.appendChild(wrap);
    wireCapHover(wrap);
    requestAnimationFrame(() => drawCapacity());
  }));
  body.appendChild(viz);

  // 消耗趋势 + 最近调用（两栏）
  const bottom = el('div', 'split2');
  bottom.appendChild(cardWith('消耗趋势', '近 14 天 · 双纵轴', (b) => {
    const wrap = el('div', 'cap-wrap');
    const canvas = el('canvas');
    canvas.id = 'trendCanvas';
    canvas.height = 152;
    wrap.appendChild(canvas);
    wrap.appendChild(buildCapTooltip());
    b.appendChild(wrap);
    wireTrendHover(wrap);
    requestAnimationFrame(() => drawTrend());
  }));
  bottom.appendChild(cardWith('最近调用', '', (b) => {
    const box = el('div');
    box.id = 'activityBox';
    b.appendChild(box);
  }));
  body.appendChild(bottom);

  // 最近错误 + 供应商成功率（两栏）
  const extra = el('div', 'split2');
  extra.appendChild(cardWith('最近错误', '只看失败与中断', (b) => {
    const box = el('div');
    box.id = 'errorsBox';
    b.appendChild(box);
  }));
  extra.appendChild(cardWith('供应商成功率', `最近 ${PROVIDER_STATS_WINDOW} 条调用`, (b) => {
    const box = el('div');
    box.id = 'providerStatsBox';
    b.appendChild(box);
  }));
  body.appendChild(extra);

  updateMetrics();
  renderActivity();
  renderRecentErrors();
  renderProviderStats();
  // 首屏：立刻画一次，再用 ResizeObserver 兜住「布局刚完成、宽度从 0 变成真实值」这一帧
  requestAnimationFrame(drawAllCharts);
  watchCanvas('topoCanvas', drawTopology);
  watchCanvas('capCanvas', drawCapacity);
  watchCanvas('trendCanvas', drawTrend);
}

/**
 * 版本条（概览页，永远显示）。
 *
 * 三个状态：
 * - **有强制更新**：整条变警示色 + 主按钮「立即更新」，并立刻弹一次强制窗（不给「稍后」）；
 * - **有普通更新**：主按钮「下载新版」，可以关掉；
 * - **无更新 / 检查失败**：主按钮「检查更新」。
 *
 * 为什么由这里驱动而不是在心跳里检测：`/ui/state` 里带的是**已缓存**的更新结果
 * （服务端后台 6 小时查一次，见 Main.scheduleUpdateCheck）。本页只负责画出来，
 * 另加一个手动按钮打 `/ui/update/check?refresh=1` 硬刷。
 */
function buildVersionCard() {
  const card = el('div', 'card ver-card');
  card.id = 'versionCard';
  const body = el('div', 'card-body ver-body');
  card.appendChild(body);

  const left = el('div', 'ver-left');
  const line1 = el('div', 'ver-line1');
  const name = el('span', 'ver-name', 'AI Gateway');
  const badge = el('span', 'ver-badge');
  badge.id = 'verBadge';
  const cur = el('span', 'ver-cur mono');
  cur.id = 'verCurrent';
  line1.append(name, badge, cur);
  left.appendChild(line1);

  const sub = el('div', 'ver-sub');
  sub.id = 'verSub';
  left.appendChild(sub);
  body.appendChild(left);

  const actions = el('div', 'ver-actions');
  const btnCheck = el('button', 'btn sm', '检查更新');
  btnCheck.id = 'verCheckBtn';
  const btnGo = el('button', 'btn sm primary', '下载新版');
  btnGo.id = 'verGoBtn';
  btnGo.hidden = true;
  actions.append(btnCheck, btnGo);
  body.appendChild(actions);

  btnCheck.addEventListener('click', () => checkUpdateNow(btnCheck));
  btnGo.addEventListener('click', openDownloadPage);

  // 首帧用已有缓存画出来（不阻塞渲染，也不发请求）
  paintVersionCard(S.state?.update || null);
  // 还没查过就补一次联网检查。只在本页进入时补，不会成心跳负担。
  const u = S.state?.update;
  if (!u || u.checked === false) setTimeout(() => checkUpdateNow(null, true), 600);
  return card;
}

/**
 * 画版本条。入参是 `/ui/state.update` 或 `/ui/update/check` 的返回体，字段一致。
 *
 * **强制态单独一条路径**：按钮变「立即更新」、隐藏「检查更新」，
 * 并立刻弹一次不可关闭的强制窗（[showForceUpdateModal]）。
 */
function paintVersionCard(u) {
  const badge = document.getElementById('verBadge');
  const cur = document.getElementById('verCurrent');
  const sub = document.getElementById('verSub');
  const btnGo = document.getElementById('verGoBtn');
  const btnCheck = document.getElementById('verCheckBtn');
  if (!badge || !cur || !sub || !btnGo || !btnCheck) return;

  const current = (u && u.current) || (S.state && S.state.version) || '—';
  cur.textContent = 'v' + current;

  const hasUpdate = !!(u && u.hasUpdate);
  // 闸门（服务端）与 mandatory（清单）取并集：闸门一旦落下就不可撤销，
  // 界面必须跟着它显示。否则会出现「网关已停、弹窗已在，版本条却写着已是最新」
  // 这种自相矛盾的画面——用户在弹窗底下看到的每一句话都该是同一件事。
  const gateClosed = !!(u && u.gateClosed);
  const mandatory = !!(u && u.mandatory) || gateClosed;
  const failed = !!(u && u.ok === false);

  badge.className = 'ver-badge';
  if (mandatory) {
    badge.classList.add('warn');
    badge.textContent = '强制更新';
  } else if (hasUpdate) {
    badge.classList.add('info');
    badge.textContent = '有新版本';
  } else if (failed) {
    badge.classList.add('muted');
    badge.textContent = '检查失败';
  } else if (u && u.checked === false) {
    badge.classList.add('muted');
    badge.textContent = '尚未检查';
  } else {
    badge.classList.add('ok');
    badge.textContent = '已是最新';
  }

  btnGo.hidden = !mandatory;                 // 强制态即使 hasUpdate=false 也要给出口
  btnGo.textContent = mandatory ? '立即更新' : '下载新版';
  btnCheck.hidden = mandatory;               // 强制态只留一条口子

  const latest = (u && u.latest) || '';
  const notes = (u && u.releaseNotes) || '';
  if (mandatory) {
    // 由闸门落下的场景 latest 可能等于 current（清单已被放回同版），
    // 这时不要显示"最新 vX"那种没有信息量的句子，直接说为什么被拦。
    sub.textContent = (u && u.gateReason) || `必须更新到 v${latest || '新版'} 才能继续使用`;
  } else if (failed) {
    sub.textContent = (u && u.message) || '连不上更新源，可手动打开下载页';
  } else if (hasUpdate) {
    sub.textContent = `最新 v${latest}${notes ? ' · ' + notes : ''}`;
  } else if (u && u.checked === false) {
    sub.textContent = '程序打开时自动检查';
  } else {
    // 「已是最新」不再挂「更新源 XX 前检查过 · 后台每 6 小时自动检查」那串灰字：
    // 检查机制属于实现细节，用户只需要知道结论。有用的是最后检查的时间点——
    // 万一结论是旧的（比如刚好错过了刚发的版本），用户能自己判断要不要手动点一下。
    const at = (u && u.checkedAt) ? relTime(u.checkedAt) : '';
    sub.textContent = at ? `上次检查：${at}` : '';
  }

  if (mandatory) showForceUpdateModal(u);
}

/** 手动检查更新：绕过 30 分钟缓存，直接打 GitHub。 */
async function checkUpdateNow(btn, silent = false) {
  const b = btn || document.getElementById('verCheckBtn');
  const go = document.getElementById('verGoBtn');
  const orig = b ? b.textContent : '';
  if (b) { b.disabled = true; b.textContent = '检查中…'; }
  if (go) go.disabled = true;
  const r = await api.post('/ui/update/check?refresh=1', {}, 12000);
  if (b) { b.disabled = false; b.textContent = orig || '检查更新'; }
  if (go) go.disabled = false;

  if (!r || r.ok === false) {
    // 手点要给出信息；自动触发那次静默（服务端已记住「检查失败」，卡片会显示）
    if (!silent) toast((r && r.message) || '检查更新失败', 'err');
    paintVersionCard(Object.assign({ checked: true, ok: false },
      r || {}, { current: (r && r.current) || (S.state && S.state.version) }));
    return;
  }
  paintVersionCard(r);
  if (r.hasUpdate && r.mandatory) return; // 强制窗已由 paintVersionCard 弹出
  if (r.hasUpdate) toast(`发现新版本 v${r.latest}`, 'ok', 5000);
  else if (!silent) toast('已是最新版本', 'ok');
  // 同步回 S.state，避免下一拍心跳用旧值把卡片盖回去
  if (S.state) S.state.update = r;
}

/** 打开夸克网盘下载页。外壳会把外部导航转给系统浏览器（见 ShellWindow.OnNavigationStarting）。 */
function openDownloadPage() {
  const url = (S.state?.update?.downloadUrl) || 'https://pan.quark.cn/s/8fd93162bcab';
  try {
    window.open(url, '_blank');
  } catch (_) {
    copyText(url);
    toast('已复制下载地址，请粘贴到浏览器打开', 'info', 5000);
  }
}

/**
 * 强制更新弹窗。
 *
 * **刻意不可关闭**（不渲染「关闭」按钮，点遮罩也不关）：这是"强制"两个字的含义。
 * 唯一出口是「立即更新」→ 系统浏览器打开网盘页，或「关闭窗口」（进程不退，
 * 后台网关仍处于被强制停止的状态）。
 * 「退出」这个口子必须有——否则用户没网/网盘打不开时会被永久困在窗口里，
 * 那就不是强制更新，是死锁。
 *
 * 只在服务端判定 `mandatory:true` 时调用（口径见 UpdateChecker.buildResult）。
 */
function showForceUpdateModal(u) {
  if (S.forceShown === (u && u.latest)) return; // 同一版本只弹一次，别每拍心跳都弹
  S.forceShown = u && u.latest;

  const notes = (u && u.releaseNotes) ? esc(u.releaseNotes) : '';
  const rows = `
    <div class="force-ver">
      <span class="mono">当前 v${esc((u && u.current) || '—')}</span>
      <span class="force-arrow">→</span>
      <span class="mono strong">最新 v${esc((u && u.latest) || '—')}</span>
    </div>
    ${notes ? `<div class="force-notes">${notes}</div>` : ''}
    <div class="force-tip">新版放在夸克网盘，需手动下载后覆盖安装。点「立即更新」会打开系统浏览器。</div>
    ${(u && u.downloadName) ? `<div class="force-file mono">${esc(u.downloadName)}</div>` : ''}`;

  modal('必须更新才能继续使用', rows, [
    { text: '关闭窗口', onClick: quitApp },
    { text: '立即更新', primary: true, keepOpen: true, onClick: openDownloadPage },
  ]);

  // 锁死弹窗下方整页：只挡视觉不挡操作的话，用户按 Esc / 点侧栏 / 用键盘
  // 都能绕过去改配置。真正的强制在服务端（网关不启动），这一层是让界面也一致。
  lockShell(`当前 v${(u && u.current) || '—'}，必须更新到 v${(u && u.latest) || '新版'} 才能继续使用`);

  // 遮罩点击不关：modal() 装了全局遮罩监听会关掉，这里在 capture 阶段挡掉。
  // 只在强制态生效，普通弹窗行为不变。
  const mask = $('#modalMask');
  if (mask && !mask.dataset.forceGuard) {
    mask.dataset.forceGuard = '1';
    mask.addEventListener('click', (e) => {
      if (e.target.id === 'modalMask' && S.forceOpen) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }
  S.forceOpen = true;
}

/**
 * 强制更新锁：把弹窗下方的整页锁死。
 *
 * 单靠弹窗挡住视线是不够的——它只挡视觉，不挡操作：
 * 用户按 Esc、点侧栏、Tab 键切焦点、或者干脆用键盘在后台操作，界面照样能被改动。
 * 「禁止更新」要落三层才有意义：
 * 1. **服务端**：网关不启动 / 已启动的被停掉（见 `EngineHost.enforceGate`）——
 *    这层才是真正生效的，客户端绕不过它；
 * 2. **这一层 UI 锁**：`.force-lock` 盖住整个 `.shell`，`pointer-events: none`
 *    让侧栏、按钮、表格全部点不动，同时 `inert` 属性把焦点链断掉（键盘也进不去）；
 * 3. **弹窗本身**：只有「关闭窗口」+「立即更新」两个出口，遮罩点击不关。
 *
 * 不用 `disabled` 逐个设按钮：页面有几百个按钮且随心跳重绘，漏一个就漏一个。
 * 一层盖板 + `inert` 是唯一不会漏的写法。
 */
function lockShell(reason) {
  S.gateLocked = true;
  document.body.classList.add('gate-locked');
  const shell = document.querySelector('.shell');
  if (shell) {
    shell.setAttribute('inert', '');     // 连 Tab/键盘焦点一起断
    shell.setAttribute('aria-hidden', 'true');
  }
  let cover = document.getElementById('gateCover');
  if (!cover) {
    cover = el('div', 'gate-cover');
    cover.id = 'gateCover';
    cover.setAttribute('role', 'presentation');
    // 盖板只在强制态存在；其余时候整个节点都删掉（见 unlockShell）
    const tip = el('div', 'gate-cover-tip');
    tip.textContent = reason || '必须更新后才能继续使用';
    cover.appendChild(tip);
    document.body.appendChild(cover);
  } else {
    const tip = cover.querySelector('.gate-cover-tip');
    if (tip) tip.textContent = reason || '必须更新后才能继续使用';
  }
  // Esc / Ctrl+W 之类快捷键在 WebView2 里改不了，但页面内所有 keydown 都吞掉，
  // 避免用户在后台用键盘触发操作（真正的键盘出口只剩外壳的窗口按钮）。
  if (!S.gateKeyGuard) {
    S.gateKeyGuard = true;
    window.addEventListener('keydown', (e) => {
      if (!S.gateLocked) return;
      // 允许 Tab 在弹窗内移动（弹窗在 body 上，不在 inert 的 shell 里）
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }
}

function unlockShell() {
  S.gateLocked = false;
  S.gateKeyGuard = false;
  document.body.classList.remove('gate-locked');
  const shell = document.querySelector('.shell');
  if (shell) {
    shell.removeAttribute('inert');
    shell.removeAttribute('aria-hidden');
  }
  const cover = document.getElementById('gateCover');
  if (cover) cover.remove();
}

/**
 * 关闭窗口（不是退出进程）。
 *
 * 与标题栏 X 同语义：外壳的 `close` 指令现在只隐藏窗口、保留后端与托盘图标，
 * 真正退出只有托盘菜单「退出」一条路。
 */
function quitApp() {
  try {
    if (window.chrome && chrome.webview) {
      chrome.webview.postMessage(JSON.stringify({ cmd: 'close' }));
      return;
    }
  } catch (_) { /* 开发态浏览器里没有 chrome.webview，继续走下面的提示 */ }
  toast('请点窗口右上角的关闭按钮', 'info', 4000);
}

/**
 * 首次启动引导条：只在「池内 0 账号」时出现。
 *
 * 为什么需要：新装第一眼概览是 6 个 0、两块空画布，既没说明为什么空，
 * 也没告诉人去哪。三步步进把「登录供应商 → 拉模型 → 用出去」串起来，
 * 每一步都直接跳到对应页面，不用用户自己摸导航。
 */
function buildOnboarding() {
  const card = el('div', 'card onb');
  const body = el('div', 'onb-body');

  const head = el('div', 'onb-head');
  head.appendChild(el('h3', '', '还没有可用账号，按这三步就能跑通'));
  head.appendChild(el('span', 'hint', '完成后这条提示会自动消失'));
  body.appendChild(head);

  const steps = el('div', 'onb-steps');
  const mkStep = (idx, title, desc, page, label) => {
    const s = el('div', 'onb-step');
    s.appendChild(el('span', 'onb-idx', String(idx)));
    s.appendChild(el('span', 'onb-title', title));
    s.appendChild(el('span', 'onb-desc', desc));
    const b = el('button', 'btn sm', label);
    b.addEventListener('click', () => go(page));
    s.appendChild(b);
    return s;
  };
  steps.appendChild(mkStep(1, '登录供应商',
    '6 家里挑一家，浏览器回调 / 设备码 / 短信任选', 'providers', '去供应商'));
  steps.appendChild(mkStep(2, '拉模型目录',
    '目录来自上游，拉完才知道能用哪些模型', 'models', '去模型目录'));
  steps.appendChild(mkStep(3, '配置接入',
    '默认允许无 Key 调用，改客户端 base_url 即可', 'gateway', '去网关设置'));
  body.appendChild(steps);
  card.appendChild(body);
  return card;
}

function cardWith(title, hint, build) {
  const c = el('div', 'card');
  const h = el('div', 'card-head');
  h.appendChild(el('h3', '', title));
  if (hint) h.appendChild(el('span', 'hint', hint));
  c.appendChild(h);
  const b = el('div', 'card-body');
  build(b);
  c.appendChild(b);
  return c;
}

// ---------------------------------------------------------------- 画布绘制

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 用 devicePixelRatio 放大画布，否则高 DPI 屏上线条是糊的。
 *  宽高都取**布局后的实际值**；宽度异常小（<60）说明布局还没完成，
 *  直接返回 null 让调用方跳过——用错宽度画出来的图会短一截，
 *  而且之后不会自动纠正（这正是首版两根拓扑连线挤在一起的原因）。 */
function setupCanvas(id, cssHeight) {
  const c = document.getElementById(id);
  if (!c) return null;
  const w = c.clientWidth;
  if (!w || w < 60) return null;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr);
  c.height = Math.round(cssHeight * dpr);
  c.style.height = cssHeight + 'px';
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h: cssHeight };
}

/** 画布尺寸一变就重画：窗口缩放、切页回来、首屏布局完成，都靠它自动纠正。 */
const canvasWatchers = new WeakMap();

function watchCanvas(id, drawFn) {
  const c = document.getElementById(id);
  if (!c || canvasWatchers.has(c)) return;
  const ro = new ResizeObserver(() => {
    // 尺寸变化会连带触发绘制；绘制本身不改变布局，不会死循环
    requestAnimationFrame(drawFn);
  });
  ro.observe(c);
  canvasWatchers.set(c, ro);
}

/** 首屏布局未完成时 canvas 宽度可能还是 0，补一次延迟重画。 */
function drawAllCharts() {
  drawTopology();
  drawCapacity();
  drawTrend();
}

/**
 * 画布卡片的空态：把 canvas 藏起来，在同一个父容器里插一个 DOM 空态块。
 *
 * 为什么不用 fillText：画布只能按像素坐标近似居中（容量卡原来直接画在左上角
 * 4,22，和拓扑卡的正中留白并列时明显不是一套东西），字号也不跟 CSS 令牌走，
 * 高 DPI 下还要自己乘 dpr。DOM 空态与表格页的空态完全同款，且能写两行说明。
 */
function showCanvasEmpty(canvasId, big, desc) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  const box = c.parentElement;
  if (!box) return;
  c.style.display = 'none';
  let ph = box.querySelector('.canvas-empty');
  if (!ph) {
    ph = el('div', 'empty canvas-empty');
    box.insertBefore(ph, c);
  }
  // 内容变了才重写，避免每 2 秒心跳重建 DOM
  const html = `<span class="big">${esc(big)}</span><span>${esc(desc)}</span>`;
  if (ph.dataset.sig !== html) {
    ph.dataset.sig = html;
    ph.innerHTML = html;
  }
}

/** 有数据时把 canvas 放回来，并清掉空态块。 */
function hideCanvasEmpty(canvasId) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  if (c.style.display === 'none') c.style.display = '';
  const box = c.parentElement;
  const ph = box && box.querySelector('.canvas-empty');
  if (ph) ph.remove();
}

function drawTopology() {
  // 判空必须在 setupCanvas 之前：空态会把 canvas 设成 display:none，
  // 此时 clientWidth=0，setupCanvas 会返回 null 直接 return，永远走不到恢复分支。
  const providers = (S.state?.providers || []).filter((p) => p.accountCount > 0);
  if (providers.length === 0) {
    // 空态交给 DOM 而不是画布上的 fillText：
    // 画布坐标写死 (w/2, h/2) 只能近似居中，字号也不跟 CSS 走；
    // 换成一个固定高度的 .empty 盒子，与账号/模型/密钥页的空态完全同款。
    showCanvasEmpty('topoCanvas', '暂无供应商账号', '登录一家后这里会画出调度拓扑');
    const legend0 = document.getElementById('topoLegend');
    if (legend0) legend0.innerHTML = '';
    topoGeom = null;
    topoHover = null;
    return;
  }
  hideCanvasEmpty('topoCanvas');

  const ctx = setupCanvas('topoCanvas', 190);
  if (!ctx) return;
  const { g, w, h } = ctx;
  const colors = {
    text: cssVar('--text') || '#F5F5F5',
    text2: cssVar('--text2') || '#8A8A8A',
    plate: cssVar('--plate') || '#191919',
    line: cssVar('--line') || 'rgba(245,245,245,.14)',
    brand: cssVar('--brand') || '#2572E6',
    brandLight: cssVar('--brand-light') || '#283549',
    gold: '#C08A2E',
  };
  g.clearRect(0, 0, w, h);

  const pad = 14, hubW = 88, hubH = 56;
  const hubX = pad, hubY = h / 2 - hubH / 2;
  const branchX = hubX + hubW + 24;
  const branchW = Math.max(70, w - branchX - pad);

  const shown = providers.slice(0, 6);
  const rows = shown.length;
  const rowH = Math.min(38, (h - pad * 2) / rows);
  const startY = (h - rowH * rows) / 2;
  const hubCX = hubX + hubW, hubCY = h / 2;
  const running = S.state?.running;
  // 命中矩形先记下来（CSS 像素，与 mousemove 的 offsetX/Y 同一坐标系），
  // 中枢一块 + 每个分支一行。hover 时按这里的数据回填高亮。
  topoGeom = { hubX, hubY, hubW, hubH, branchX, branchW, rowH, startY, shown };

  // 连线
  shown.forEach((p, i) => {
    const cy = startY + rowH * i + rowH / 2;
    const color = providerColor(i);
    // 权重下限 0.18：完全没调用过的供应商线也要看得出「连着」，否则拓扑看起来像断了
    const w = Math.max(0.18, p.weight || 0);
    const alpha = 0.32 + w * 0.55;
    g.strokeStyle = hexA(color, alpha);
    g.lineWidth = 1.2 + w * 3.2;
    g.beginPath();
    const dx = branchX - hubCX;
    g.moveTo(hubCX, hubCY);
    g.bezierCurveTo(hubCX + dx * 0.42, hubCY, branchX - dx * 0.42, cy, branchX, cy);
    g.stroke();
  });

  const hv = topoHover;
  const hubOn = hv && hv.kind === 'hub';

  // 中枢
  g.fillStyle = running ? colors.brandLight : colors.plate;
  roundRect(g, hubX, hubY, hubW, hubH, 8);
  g.strokeStyle = running ? colors.brand : colors.line;
  g.lineWidth = hubOn ? 1.8 : 1;
  roundRect(g, hubX, hubY, hubW, hubH, 8, true);
  g.textAlign = 'center';
  g.font = '600 11px ' + (cssVar('--font') || 'sans-serif');
  g.fillStyle = running ? colors.brand : colors.text2;
  g.fillText('网关', hubX + hubW / 2, hubY + 24);
  g.font = '10px ' + (cssVar('--mono') || 'monospace');
  g.fillStyle = colors.text2;
  g.fillText(':' + (S.state?.port || 0), hubX + hubW / 2, hubY + 40);

  // 分支
  shown.forEach((p, i) => {
    const y = startY + rowH * i + 3;
    const bh = rowH - 6;
    const color = providerColor(i);
    const active = p.activeCount > 0 && running;
    const on = hv && hv.kind === 'branch' && hv.i === i;
    const dim = hv && hv.kind === 'branch' && hv.i !== i;
    g.fillStyle = active ? 'rgba(192,138,46,.16)' : colors.plate;
    roundRect(g, branchX, y, branchW, bh, 6);
    g.strokeStyle = on ? color : active ? colors.gold : colors.line;
    // 悬停中的分支边框加粗一档，未悬停的分支整体压淡，视线落在目标上
    g.globalAlpha = dim ? 0.45 : 1;
    g.lineWidth = on ? 1.8 : 1;
    roundRect(g, branchX, y, branchW, bh, 6, true);
    // 色点
    g.fillStyle = color;
    g.beginPath();
    g.arc(branchX + 14, y + bh / 2, 3.5, 0, Math.PI * 2);
    g.fill();
    // 右侧数字先算宽度，名称可用宽度 = 剩余空间（不再硬编码预留，否则名字长一点就被截断）
    g.font = '10px ' + (cssVar('--mono') || 'monospace');
    const right = active ? `${p.activeCount} 在途` : `${p.usableCount}/${p.accountCount}`;
    const rightW = g.measureText(right).width;
    const nameMax = branchW - 24 - rightW - 18;
    g.textAlign = 'left';
    g.font = (branchW < 200 ? '11px ' : '12px ') + (cssVar('--font') || 'sans-serif');
    g.fillStyle = colors.text;
    g.fillText(clip(g, p.name, nameMax), branchX + 24, y + bh / 2 + 4);
    g.textAlign = 'right';
    g.font = '10px ' + (cssVar('--mono') || 'monospace');
    g.fillStyle = active ? colors.gold : colors.text2;
    g.fillText(right, branchX + branchW - 10, y + bh / 2 + 4);
    g.globalAlpha = 1;
  });
  g.textAlign = 'left';

  // 图例
  const legend = document.getElementById('topoLegend');
  if (legend) {
    legend.innerHTML = '';
    providers.slice(0, 8).forEach((p, i) => {
      const item = el('span');
      const dot = el('i');
      dot.style.background = providerColor(i);
      item.appendChild(dot);
      item.appendChild(document.createTextNode(`${p.name} · ${p.callCount} 次`));
      legend.appendChild(item);
    });
  }
}

/**
 * 拓扑图 hover：命中分支行（供应商卡）或中枢（网关）即高亮 + 弹明细提示。
 *
 * 与环形图同一套路：绘制时缓存命中矩形（topoGeom），mousemove 做
 * 一次矩形包含判断就重画；提示框复用 .cap-tip，跟随光标、不抢事件。
 * 挂在画布外层 wrap 上而不是 canvas 本身——切页重建后 wrap 是新节点，
 * 监听跟着节点走（与 wireCapHover 传 wrap 同理）。
 */
function wireTopoHover(wrap) {
  const c = wrap && wrap.querySelector('canvas');
  if (!c || c.dataset.topoWired) return;
  c.dataset.topoWired = '1';
  const tip = wrap.querySelector('.cap-tip');

  const clear = () => {
    if (topoHover) {
      topoHover = null;
      if (tip) tip.classList.remove('on');
      drawTopology();
    }
  };

  c.addEventListener('mousemove', (e) => {
    if (!topoGeom) { clear(); return; }
    const r = c.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const gm = topoGeom;
    let hit = null;
    if (x >= gm.hubX && x <= gm.hubX + gm.hubW && y >= gm.hubY && y <= gm.hubY + gm.hubH) {
      hit = { kind: 'hub' };
    } else {
      for (let i = 0; i < gm.shown.length; i++) {
        const ry = gm.startY + gm.rowH * i;
        if (y >= ry && y <= ry + gm.rowH && x >= gm.branchX - 8 && x <= gm.branchX + gm.branchW + 8) {
          hit = { kind: 'branch', i };
          break;
        }
      }
    }
    const sig = hit ? hit.kind + (hit.i ?? '') : '';
    const cur = topoHover ? topoHover.kind + (topoHover.i ?? '') : '';
    if (sig === cur) {
      if (hit) moveCapTip(tip, e);
      return;
    }
    topoHover = hit;
    if (!hit) {
      if (tip) tip.classList.remove('on');
      drawTopology();
      return;
    }
    const name = tip.querySelector('.tip-name span');
    const dot = tip.querySelector('.tip-name i');
    const sub = tip.querySelector('.tip-sub');
    if (hit.kind === 'hub') {
      const st = S.state || {};
      if (dot) dot.style.background = 'var(--brand)';
      if (name) name.textContent = '网关中枢';
      if (sub) sub.textContent = `${st.running ? '运行中' : '已停止'} · 端口 :${st.port || 0} · `
        + `监听 ${(st.localUrl || '—').replace('http://', '')}`;
    } else {
      const p = topoGeom.shown[hit.i];
      if (dot) dot.style.background = providerColor(hit.i);
      if (name) name.textContent = p.name;
      if (sub) sub.textContent = `账号 ${p.usableCount}/${p.accountCount} 可用 · 近 20 次调用 ${p.callCount} · `
        + (p.activeCount > 0 ? `${p.activeCount} 个在途` : '无在途请求');
    }
    if (tip) tip.classList.add('on');
    drawTopology();
    moveCapTip(tip, e);
  });
  c.addEventListener('mouseleave', clear);
}

/** 环形图当前命中段（-1 = 没命中）。mousemove 只做一次极坐标判断就重画。 */
let capHover = -1;
/** 上一次绘制的扇段角度，供命中判断用；空态/未绘制时为 null。 */
let capGeom = null;

/** 拓扑图当前悬停对象：{kind:'branch', i} 或 {kind:'hub'}；-1 表示无。 */
let topoHover = null;
/** 拓扑分支行的命中矩形（CSS 像素，画布坐标系）。绘制时缓存。 */
let topoGeom = null;

/** 环形图的悬浮提示 DOM，挂在 .cap-wrap 里，绝对定位跟随光标。 */
function buildCapTooltip() {
  const tip = el('div', 'cap-tip');
  const name = el('div', 'tip-name');
  const dot = el('i');
  name.appendChild(dot);
  name.appendChild(el('span'));
  tip.appendChild(name);
  tip.appendChild(el('div', 'tip-sub'));
  return tip;
}

function fillCapTip(tip, s) {
  if (!tip || !s) return;
  const dot = tip.querySelector('.tip-name i');
  const label = tip.querySelector('.tip-name span');
  const sub = tip.querySelector('.tip-sub');
  if (dot) dot.style.background = s.color;
  if (label) label.textContent = s.name;
  if (sub) sub.textContent = `${s.count} 个模型 · ${s.pct}`;
}

/** 提示框贴着光标，但不出卡片：右溢出翻到左侧，上溢出翻到下方。 */
function moveCapTip(tip, e) {
  if (!tip) return;
  const wrap = tip.parentElement;
  if (!wrap) return;
  const wr = wrap.getBoundingClientRect();
  const bw = tip.offsetWidth, bh = tip.offsetHeight;
  let x = e.clientX - wr.left + 14;
  let y = e.clientY - wr.top - bh - 10;
  if (x + bw > wr.width - 4) x = e.clientX - wr.left - bw - 14;
  if (y < 4) y = e.clientY - wr.top + 18;
  if (y + bh > wr.height - 2) y = wr.height - bh - 2;
  if (x < 4) x = 4;
  tip.style.left = Math.round(x) + 'px';
  tip.style.top = Math.round(y) + 'px';
}

/**
 * 环形图 hover：环段、图例两处都能触发，命中即高亮该段并弹提示。
 *
 * 传 wrap 而不是自己 getElementById：cardWith 的 build() 跑在卡片挂进文档**之前**，
 * 那时 canvas 还查不到，直接 return 就永远没绑上事件（首版就是这么丢的 hover）。
 * 节点是局部变量，先绑监听、后挂文档，监听会跟着节点走。
 * 只挂一次（data-hoverWired 标记），因为画布卡片每次切页都是重建的新节点。
 */
function wireCapHover(wrap) {
  const c = wrap && wrap.querySelector('canvas');
  if (!c || c.dataset.hoverWired) return;
  c.dataset.hoverWired = '1';
  const tip = wrap.querySelector('.cap-tip');
  const legend = wrap.querySelector('.legend');

  const clear = () => {
    if (capHover === -1) return;
    capHover = -1;
    if (tip) tip.classList.remove('on');
    drawCapacity();
  };

  c.addEventListener('mousemove', (e) => {
    if (!capGeom) { clear(); return; }
    const r = c.getBoundingClientRect();
    const dx = e.clientX - r.left - capGeom.cx;
    const dy = e.clientY - r.top - capGeom.cy;
    const d = Math.hypot(dx, dy);
    let hit = -1;
    // 环带内外各留 2/4px 容差，指到细缝或描边上也算命中
    if (d >= capGeom.rIn - 2 && d <= capGeom.rOut + 4) {
      // atan2 落在 (-π,π]，扇区从 -π/2 顺时针铺到 3π/2，统一到同一区间才能比较
      let ang = Math.atan2(dy, dx);
      if (ang < capGeom.base) ang += Math.PI * 2;
      for (let i = 0; i < capGeom.segs.length; i++) {
        const s = capGeom.segs[i];
        if (ang >= s.a0 && ang <= s.a1) { hit = i; break; }
      }
    }
    if (hit === capHover) {
      if (hit !== -1) moveCapTip(tip, e);
      return;
    }
    capHover = hit;
    if (hit === -1) {
      if (tip) tip.classList.remove('on');
      drawCapacity();
      return;
    }
    fillCapTip(tip, capGeom.segs[hit]);
    if (tip) tip.classList.add('on');
    drawCapacity();
    moveCapTip(tip, e);
  });
  c.addEventListener('mouseleave', clear);

  if (legend && !legend.dataset.hoverWired) {
    legend.dataset.hoverWired = '1';
    // 图例行只做高亮，不弹提示：光标在图例上时提示框会盖住正在读的那一行
    legend.addEventListener('mouseover', (e) => {
      const it = e.target.closest('[data-i]');
      if (!it || !capGeom) return;
      const i = Number(it.dataset.i);
      if (!Number.isInteger(i)) return;
      // 图例行只做高亮不弹提示；先把环段残留的提示框收掉，
      // 否则从环上移到同一段的图例行时提示框会留在原地
      if (tip) tip.classList.remove('on');
      if (i === capHover) return;
      capHover = i;
      drawCapacity();
    });
    legend.addEventListener('mouseleave', clear);
  }
}

function drawCapacity() {
  const byProvider = (S.state?.modelsMeta || {}).byProvider || {};
  const total0 = Object.values(byProvider).reduce((s, x) => s + Number(x || 0), 0);
  // 同拓扑：先判空再取画布，否则 canvas 被隐藏后 clientWidth=0 永远恢复不了
  if (total0 === 0) {
    showCanvasEmpty('capCanvas', '暂无模型目录',
      S.state?.pool?.total === 0 ? '先登录供应商再拉取' : '点模型目录页「拉取模型目录」');
    const lg0 = document.getElementById('capLegend');
    if (lg0) { lg0.innerHTML = ''; delete lg0.dataset.sig; }
    const tip0 = document.getElementById('capCanvas')?.parentElement?.querySelector('.cap-tip');
    if (tip0) tip0.classList.remove('on');
    capGeom = null;
    capHover = -1;
    return;
  }
  hideCanvasEmpty('capCanvas');

  const ctx = setupCanvas('capCanvas', 190);
  if (!ctx) return;
  const { g, w, h } = ctx;
  g.clearRect(0, 0, w, h);

  const providers = S.state?.providers || [];
  const segs = Object.entries(byProvider)
    .map(([id, count]) => ({ id, count: Number(count) || 0,
      name: providers.find((p) => p.id === id)?.name || id }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count);

  const total = segs.reduce((s, x) => s + x.count, 0);
  if (!segs.length || !total) return;
  // pct 必须写回 segs 本身：图例直接读 s.pct，只存进 capGeom.segs 的话图例会显示 undefined
  segs.forEach((s) => { s.pct = ((s.count / total) * 100).toFixed(1) + '%'; });

  const colors = {
    text: cssVar('--text') || '#F5F5F5',
    text2: cssVar('--text2') || '#8A8A8A',
    plate: cssVar('--plate') || '#191919',
  };
  const font = cssVar('--font') || 'sans-serif';

  // 环形几何：直径按画布高度缩放（双栏下卡片只有 ~269 CSS px 宽，不能按宽度算）
  const rOut = Math.max(40, Math.min(76, h * 0.40));
  const thick = Math.max(16, Math.min(26, h * 0.12));
  const rIn = rOut - thick;
  const cx = Math.round(w / 2);
  const cy = Math.round(h / 2);
  // 段间留缝；单段时无缝，否则 2π 两端会各画半个缺口
  const gap = segs.length > 1 ? 0.035 : 0;
  const base = -Math.PI / 2; // 12 点方向起针，顺时针铺

  const arc = (a0, a1, fill, ro, ri) => {
    g.beginPath();
    g.arc(cx, cy, ro, a0, a1);
    g.arc(cx, cy, ri, a1, a0, true);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };

  const hv = (capHover >= 0 && capHover < segs.length) ? capHover : -1;

  // 底板先铺满整圈，段与段之间的缝透出底色，而不是断口
  arc(base, base + Math.PI * 2, colors.plate, rOut, rIn);

  const span = Math.PI * 2 - gap * (segs.length - 1);
  let a = base;
  capGeom = { cx, cy, rIn, rOut, base, segs: [] };
  segs.forEach((s, i) => {
    const frac = s.count / total;
    const sweep = span * frac;
    const color = providerColor(i);
    const on = i === hv;
    // 悬停：当前段向外鼓 4px、向内收 2px，其余段压暗，视线一下就落在目标上
    arc(a, a + sweep, on ? color : (hv >= 0 ? hexA(color, 0.45) : color),
      on ? rOut + 4 : rOut, on ? rIn - 2 : rIn);
    // pct 已在 segs 上算好，这里原样带进命中几何，图例与提示框读同一份
    capGeom.segs.push({ a0: a, a1: a + sweep, color, ...s });
    a += sweep + gap;
  });

  // 中心：常态给合计大数，悬停换成该段的占比。字号按内圈直径选，
  // 长字符串（供应商名）一律 clip 到 rIn*1.7，否则会压到环带上。
  g.textAlign = 'center';
  if (hv >= 0) {
    const s = capGeom.segs[hv];
    g.font = '600 18px ' + font;
    g.fillStyle = s.color;
    g.fillText(s.pct, cx, cy - 2);
    g.font = '10.5px ' + font;
    g.fillStyle = colors.text2;
    g.fillText(clip(g, s.name, rIn * 1.7), cx, cy + 15);
  } else {
    g.font = '600 20px ' + font;
    g.fillStyle = colors.text;
    g.fillText(String(total), cx, cy - 2);
    g.font = '10.5px ' + font;
    g.fillStyle = colors.text2;
    g.fillText(`个模型 · ${segs.length} 家`, cx, cy + 15);
  }
  g.textAlign = 'left';

  // 图例：数据没变就不重建（重建会把正在 hover 的那一行换掉，触发 mouseleave 打架）
  const lg = document.getElementById('capLegend');
  if (lg) {
    const sig = segs.map((s) => s.id + ':' + s.count).join('|');
    if (lg.dataset.sig !== sig) {
      lg.dataset.sig = sig;
      lg.innerHTML = '';
      const shown = segs.slice(0, 8);
      shown.forEach((s, i) => {
        const item = el('span');
        item.dataset.i = String(i);
        const dot = el('i');
        dot.style.background = providerColor(i);
        item.appendChild(dot);
        item.appendChild(document.createTextNode(`${s.name} ${s.count} · ${s.pct}`));
        lg.appendChild(item);
      });
      if (segs.length > shown.length) {
        lg.appendChild(el('span', null, `其余 ${segs.length - shown.length} 家`));
      }
    }
    lg.querySelectorAll('[data-i]').forEach((n) => {
      n.classList.toggle('hot', Number(n.dataset.i) === hv);
    });
  }
}

/** 趋势图 hover：命中天下标（-1 无）；trendGeom 缓存各天的 x 坐标带。 */
let trendHover = -1;
let trendGeom = null;

/**
 * 把最大值抬到「好看的上界」：1 / 2 / 2.5 / 5 × 10^n。
 *
 * 直接拿序列最大值当轴顶，刻度会变成 2423393 / 1211696.5 / 0 这种读不出来的数，
 * 曲线还顶在画布边缘。抬到整档后是 250w / 125w / 0 这类量级，顶部也留出余量。
 */
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const f = v / base;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * base;
}

/** 取指定有效数字位数（刻度标注用：让 155.725 变成 156）。 */
function roundSig(v, digits) {
  if (!(v > 0)) return 0;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp - digits + 1);
  return Math.round(v / base) * base;
}

/**
 * 为一条序列算「自适应纵轴」。
 *
 * 返回 `{ max, log, f(v), at(t) }`：
 *  - `max` 原始最大值（0 表示这条序列全空，调用方不画刻度）
 *  - `log` 是否走了对数压缩
 *  - `f(v)` 值 → 0..1 的纵向位置（1 = 顶部）
 *  - `at(t)` 纵向位置 → 该处应标注的原始值（画刻度用）
 *
 * **为什么需要对数**：14 天里既有「一天 16 token」也有「一天 240 万 token」，
 * 纯线性会把这 16 压成离地 0.0004px——看上去就是「那天没调用」。量级跨度超过
 * 30 倍时改用 log1p（+1 让 0 值仍然落在基线、不会取到 -Infinity），
 * 小值也能看出起伏。跨度不大时坚持线性：线性的「面积感」更直观。
 */
function buildAxis(data) {
  const xs = (data || []).map((v) => Math.max(0, Number(v || 0)));
  const max = xs.length ? Math.max(...xs) : 0;
  const minPos = xs.length ? Math.min(...xs.filter((v) => v > 0)) : 0;
  if (max <= 0) return { max: 0, log: false, f: () => 0, at: () => 0 };

  // 判据用「正数最小值与最大值之比」：拿 0 值参与会永远 >= 跨度，等于没判。
  const log = minPos > 0 && max / minPos >= 30;
  if (!log) {
    const top = niceCeil(max);
    return {
      max,
      log: false,
      f: (v) => Math.min(1, Math.max(0, Number(v || 0) / top)),
      at: (t) => top * t,
    };
  }
  const top = Math.log1p(max);
  return {
    max,
    log: true,
    f: (v) => Math.min(1, Math.max(0, Math.log1p(Number(v || 0)) / top)),
    at: (t) => {
      if (t >= 1) return roundSig(max, 4);
      if (t <= 0) return 0;
      // 对数轴的中线会落在 155.725 这种值上：取 3 位有效数字再标。
      // 不能抬到 niceCeil 整档——那会让「该位置对应的值」与标注值不一致，
      // 刻度就骗人了；也不能原样标，三位小数既难看又占宽度（会顶出画布边缘）。
      return roundSig(Math.expm1(top * t), 3);
    },
  };
}

function drawTrend() {
  const trend = S.state?.trend || { prompt: [], completion: [] };
  const prompt = trend.prompt || [];
  const completion = trend.completion || [];
  const n = Math.max(prompt.length, completion.length);
  // 全零也要走空态：14 天数组是恒有长度的（后端固定填 14 个 0），
  // 只判 n===0 永远不成立，结果是满屏 0 数据却画出 0–1 的坐标轴与一条贴地的线，
  // 看着像「有数据但全是 0」，实际是「从来没调用过」。
  // 判空必须在 setupCanvas 之前（空态会隐藏 canvas，之后 clientWidth=0 恢复不了）。
  const sum = [...prompt, ...completion].reduce((s, v) => s + Number(v || 0), 0);
  if (n === 0 || sum === 0) {
    showCanvasEmpty('trendCanvas', '近 14 天暂无调用', '有请求后这里画输入 / 输出 token 曲线');
    trendGeom = null;
    trendHover = -1;
    return;
  }
  hideCanvasEmpty('trendCanvas');

  const ctx = setupCanvas('trendCanvas', 170);
  if (!ctx) return;
  const { g, w, h } = ctx;
  const colors = {
    text2: cssVar('--text2') || '#8A8A8A',
    text: cssVar('--text') || '#F5F5F5',
    plate: cssVar('--plate') || '#191919',
    line: cssVar('--line-light') || 'rgba(245,245,245,.08)',
    brand: cssVar('--brand') || '#2572E6',
    ok: cssVar('--ok') || '#459025',
  };
  g.clearRect(0, 0, w, h);

  // **输入与输出各用独立纵轴，且各自自适应量级**。
  //
  // 原来共用一条 0..max(全部) 的轴：典型用量下输入动辄几十万 token、输出只有几千，
  // 共用轴把输出压成贴底的一条直线——用户看到的就是「输出一直无法形成折线」。
  // 现在左轴量输入、右轴量输出，两条曲线各自铺满纵向空间。
  // 左右各留 52px：两侧都要写刻度值。实测 42px 不够——`242.3w` 在 9.5px
  // monospace 下约 34px，加 6px 间距就顶到画布边缘，截图里左半截被裁掉。
  const padL = 52, padR = 52, padT = 20, padB = 22;
  const cw = w - padL - padR, ch = h - padT - padB;

  // 一侧全 0 时不画该侧刻度：画出来只是 0.5/0 这种无意义标签，
  // 还会让人以为那一路「有过刻度」。
  const axisIn = buildAxis(prompt);
  const axisOut = buildAxis(completion);

  const monoFont = '9.5px ' + (cssVar('--mono') || 'monospace');
  const titleFont = '10px ' + (cssVar('--font') || 'sans-serif');
  // 轴标题放顶部留白里，颜色即曲线色：比底部图例省地方，也让「哪条轴对应哪条线」
  // 一眼对上（底部图例在 299px 双栏下会被右轴刻度挤掉）。
  // 走了对数压缩的轴要显式标出来，否则「低值被抬高了」会被误读成量级变大。
  g.font = titleFont;
  g.fillStyle = colors.brand;
  g.textAlign = 'left';
  g.fillText(axisIn.log ? '输入 (对数)' : '输入', padL, 12);
  g.fillStyle = colors.ok;
  g.textAlign = 'right';
  g.fillText(axisOut.log ? '输出 (对数)' : '输出', w - padR, 12);
  g.textAlign = 'left';

  g.strokeStyle = colors.line;
  g.lineWidth = 1;
  g.font = monoFont;
  for (let i = 0; i <= 2; i++) {
    const t = 1 - i / 2;                       // 1 = 顶部，0 = 底部
    const y = padT + ch * (i / 2);
    g.beginPath();
    g.moveTo(padL, y);
    g.lineTo(w - padR, y);
    g.stroke();
    if (axisIn.max > 0) {
      g.fillStyle = colors.brand;
      g.textAlign = 'right';
      g.fillText(fmtNum(axisIn.at(t)), padL - 6, y + 3);
    }
    if (axisOut.max > 0) {
      g.fillStyle = colors.ok;
      g.textAlign = 'left';
      g.fillText(fmtNum(axisOut.at(t)), w - padR + 6, y + 3);
    }
  }
  g.textAlign = 'left';

  const px = (i) => padL + (n <= 1 ? cw / 2 : (cw * i) / (n - 1));
  // 两条线各自归一化到自己的轴（线性或对数）
  const pyIn = (v) => padT + ch * (1 - axisIn.f(v));
  const pyOut = (v) => padT + ch * (1 - axisOut.f(v));

  // hover 高亮：命中天画一条贯穿竖线（缝隙色），数据点放大一档。
  // 画在数据线**下面**，不遮曲线本体。
  if (trendHover >= 0 && trendHover < n) {
    const hx = px(trendHover);
    g.strokeStyle = colors.line;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(hx, padT);
    g.lineTo(hx, padT + ch);
    g.stroke();
  }

  const line = (data, color, py, hot) => {
    if (data.length === 0) return;
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.beginPath();
    data.forEach((v, i) => {
      const x = px(i), y = py(v);
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    });
    g.stroke();
    g.fillStyle = color;
    data.forEach((v, i) => {
      g.beginPath();
      g.arc(px(i), py(v), hot === i ? 3.6 : 2.2, 0, Math.PI * 2);
      g.fill();
    });
  };
  line(prompt, colors.brand, pyIn, trendHover);
  line(completion, colors.ok, pyOut, trendHover);

  // hover 天的日期刻度：悬停时把那一天的「MM-DD」画在 x 轴上，替代固定刻度歧义
  if (trendHover >= 0 && trendHover < n) {
    const d = new Date(Date.now() - (n - 1 - trendHover) * 86400000);
    const p2 = (x) => String(x).padStart(2, '0');
    g.font = monoFont;
    g.fillStyle = colors.text;
    g.textAlign = 'center';
    g.fillText(`${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, px(trendHover), h - 6);
    g.textAlign = 'left';
  }

  // 缓存每天命中带：相邻两点的中点分界，padL/padR 之外不算命中
  trendGeom = {
    padL, padR, n,
    xAt(i) { return px(i); },
    boundary(i) { return (px(Math.max(0, i - 1)) + px(i)) / 2; },
  };
}

/**
 * 趋势图 hover：x 落进哪一天的命中带就高亮那天并弹数值提示。
 * 14 天最多 14 个带，线性扫一遍足够；空态/未绘制时 trendGeom 为 null 直接清。
 */
function wireTrendHover(wrap) {
  const c = wrap && wrap.querySelector('canvas');
  if (!c || c.dataset.trendWired) return;
  c.dataset.trendWired = '1';
  const tip = wrap.querySelector('.cap-tip');

  const clear = () => {
    if (trendHover !== -1) {
      trendHover = -1;
      if (tip) tip.classList.remove('on');
      drawTrend();
    }
  };

  c.addEventListener('mousemove', (e) => {
    if (!trendGeom) { clear(); return; }
    const r = c.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let hit = -1;
    if (x >= trendGeom.padL - 4 && x <= c.clientWidth - trendGeom.padR + 4) {
      for (let i = 0; i < trendGeom.n; i++) {
        // 用「到哪天中点更近」定带：i 天的带 = 与左右邻点各取一半
        const lo = i === 0 ? trendGeom.padL - 4 : trendGeom.boundary(i);
        const hi = i === trendGeom.n - 1 ? c.clientWidth - trendGeom.padR + 4 : trendGeom.boundary(i + 1);
        if (x >= lo && x < hi) { hit = i; break; }
      }
    }
    if (hit === trendHover) {
      if (hit !== -1) moveCapTip(tip, e);
      return;
    }
    trendHover = hit;
    if (hit === -1) {
      if (tip) tip.classList.remove('on');
      drawTrend();
      return;
    }
    const trend = S.state?.trend || {};
    const pv = Number((trend.prompt || [])[hit] || 0);
    const cv = Number((trend.completion || [])[hit] || 0);
    const d = new Date(Date.now() - (trendGeom.n - 1 - hit) * 86400000);
    const p2 = (v) => String(v).padStart(2, '0');
    const name = tip.querySelector('.tip-name span');
    const dot = tip.querySelector('.tip-name i');
    const sub = tip.querySelector('.tip-sub');
    if (dot) dot.style.background = 'var(--brand)';
    if (name) name.textContent = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    if (sub) sub.textContent = `输入 ${fmtNum(pv)} · 输出 ${fmtNum(cv)} · 合计 ${fmtNum(pv + cv)} tokens`;
    if (tip) tip.classList.add('on');
    drawTrend();
    moveCapTip(tip, e);
  });
  c.addEventListener('mouseleave', clear);
}

function roundRect(g, x, y, w, h, r, strokeOnly) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
  if (strokeOnly) g.stroke(); else g.fill();
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function clip(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

// ---------------------------------------------------------------- 最近调用

function renderActivity() {
  const box = document.getElementById('activityBox');
  if (!box) return;
  const rows = S.state?.recentCalls || [];
  if (rows.length === 0) {
    // 与同排三张画布卡的空态保持同款：一行标题 + 一行说明，
    // 原来只有「暂无调用记录」一行，高度和排版跟左边三张卡明显不齐。
    box.innerHTML = '<div class="empty canvas-empty"><span class="big">暂无调用记录</span>'
      + '<span>客户端发出请求后这里滚动显示最近 20 条</span></div>';
    return;
  }
  const html = rows.map((r) => {
    const ok = r.status === 'SUCCESS';
    const kind = ok ? 'ok' : r.status === 'ABORTED' ? 'warn' : 'err';
    // 请求模型与实际模型都显示：auto/组名这类逻辑名后面跟箭头给出真实模型，
    // 两者一致（直连具体模型）时只显示一个，不制造视觉噪音。
    const real = r.upstreamModel || '';
    const modelText = real && real !== r.model ? `${r.model} → ${real}` : r.model;
    return `<div class="activity-row">
      <span class="mono activity-model" title="${esc(modelText)}">${esc(modelText)}</span>
      <span class="activity-meta">${fmtNum(r.totalTokens)} tok</span>
      <span class="activity-dur">${r.durationMillis} ms</span>
      <span class="tag ${kind}">${ok ? '成功' : r.status === 'ABORTED' ? '中断' : '失败'}</span>
    </div>`;
  }).join('');
  box.innerHTML = html;
  wireActivityHover(box, rows);
}

/**
 * 「最近调用」行 hover：整行提亮 + 跟随光标的明细提示。
 *
 * 行内只放得下「模型 · tokens · 耗时 · 状态」，供应商、流式、首字延迟、
 * 输入输出拆分都挤不下——这些进提示框。rows 与 DOM 顺序一致，闭包直取。
 * 提示框复用环形图的 .cap-tip 样式（绝对定位、跟随光标、不抢事件）。
 *
 * 心跳每 2 秒 renderActivity 重写 box.innerHTML：监听挂在 box 上不会丢
 * （box 节点不换），但 append 进去的 tip 会被 innerHTML 抹掉——所以这里
 * 每次都查 tip 在不在、不在就重挂一次（比记 dataset 标记省一个状态位）。
 */
function wireActivityHover(box, rows) {
  let tip = box.querySelector('.cap-tip');
  if (!tip) {
    box.classList.add('cap-wrap');
    tip = buildCapTooltip();
    box.appendChild(tip);
  }
  let cur = -1;

  box.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.activity-row');
    const idx = row ? Array.prototype.indexOf.call(box.querySelectorAll('.activity-row'), row) : -1;
    if (idx === -1 || !rows[idx]) {
      if (cur !== -1) { cur = -1; tip.classList.remove('on'); }
      return;
    }
    if (idx !== cur) {
      cur = idx;
      const r = rows[idx];
      const ok = r.status === 'SUCCESS';
      const dot = tip.querySelector('.tip-name i');
      const label = tip.querySelector('.tip-name span');
      const sub = tip.querySelector('.tip-sub');
      if (dot) dot.style.background = ok ? 'var(--ok)' : r.status === 'ABORTED' ? 'var(--warn)' : 'var(--err)';
      if (label) label.textContent = r.model;
      if (sub) {
        const real = r.upstreamModel && r.upstreamModel !== r.model ? `（实际 ${r.upstreamModel}）` : '';
        const fb = r.firstByteMillis >= 0 ? `${r.firstByteMillis}ms` : '无首字';
        sub.textContent = `${fmtTime(r.at)} · ${r.providerId}${real}${r.streaming ? ' · 流式' : ''} · `
          + `输入 ${fmtNum(r.promptTokens)} / 输出 ${fmtNum(r.completionTokens)} · 首字 ${fb}`;
      }
      tip.classList.add('on');
      moveCapTip(tip, e);
      return;
    }
    moveCapTip(tip, e);
  });
  box.addEventListener('mouseleave', () => {
    cur = -1;
    tip.classList.remove('on');
  });
}

// ---------------------------------------------------------------- 日志页

function renderLogs() {
  const body = $('#pageBody');
  body.innerHTML = '';
  const card = el('div', 'card fill');

  const head = el('div', 'card-head');
  head.appendChild(el('h3', '', '运行日志'));
  const hint = el('span', 'hint');
  hint.id = 'logHint';
  head.appendChild(hint);
  card.appendChild(head);

  const tabs = el('div', 'log-tabs');
  ['全部', '错误', '签到', '额度', '调用', '系统'].forEach((name) => {
    const t = el('div', 'log-tab' + (S.logFilter === name ? ' active' : ''), name);
    t.dataset.filter = name;
    t.addEventListener('click', () => {
      S.logFilter = name;
      document.querySelectorAll('.log-tab').forEach((x) => {
        x.classList.toggle('active', x.dataset.filter === name);
      });
      paintLogs(true);
    });
    tabs.appendChild(t);
  });
  card.appendChild(tabs);

  const box = el('div', 'log-box');
  box.id = 'logBox';
  card.appendChild(box);
  body.appendChild(card);

  // 首次进入强制回填全部（服务端只推增量，页面切回来会缺历史）
  paintLogs(true);
}

function logCategory(line) {
  if (line.level === 'ERROR' || line.level === 'WARN') return '错误';
  const t = line.text || '';
  if (t.includes('签到')) return '签到';
  if (t.includes('额度') || t.includes('积分')) return '额度';
  if (t.includes('/v1/chat') || t.includes('首字出站') || t.includes('流式转发') ||
      t.includes('上游已应答') || t.includes('收到请求') || t.includes('故障转移') ||
      t.includes('熔断') || t.includes('冷却') || t.includes('超时') || t.includes('凭证刷新') ||
      t.includes('账号限速')) return '调用';
  return '系统';
}

function paintLogs(force) {
  const box = document.getElementById('logBox');
  if (!box) return;
  const filtered = S.logFilter === '全部'
    ? S.logLines
    : S.logLines.filter((l) => logCategory(l) === S.logFilter);
  const hint = document.getElementById('logHint');
  if (hint) hint.textContent = `共 ${S.logLines.length} 条 · 显示 ${filtered.length} 条`;
  box.textContent = filtered.map((l) => `${fmtTime(l.at)} [${l.level}] ${l.text}`).join('\n');
  box.scrollTop = force ? box.scrollHeight : box.scrollTop;
  // 只有贴着底部时才自动滚动，否则用户往上翻会被强行拉回
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 40) {
    box.scrollTop = box.scrollHeight;
  }
}

// ---------------------------------------------------------------- 供应商页

function renderProviders() {
  const body = $('#pageBody');
  body.innerHTML = '';
  const providers = S.state?.providers || [];

  const actions = $('#pageActions');
  actions.innerHTML = '';
  const bRefresh = el('button', 'btn', '刷新额度');
  bRefresh.id = 'btnRefreshCredits';
  bRefresh.addEventListener('click', () => doRefreshCredits());
  actions.append(bRefresh);

  // 自定义供应商区块要异步取一次（不进 /ui/state：那是 2 秒一拍的心跳）
  if (!S.customLoaded) {
    loadCustomProviders().then(() => {
      if (S.page === 'providers') renderPage();
    });
  }

  const card = el('div', 'card');
  card.appendChild(headWith('供应商', `${providers.length} 家`));
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'grid');
  // 登录按钮并进「名称」列：列数从 7 减到 6，窄窗口下操作按钮才不会被挤出可视区
  // （首版 7 列 + 能力多标签，实际把「操作」列推到了横向滚动之外）
  table.id = 'tblProviders';
  table.innerHTML = `<thead><tr>
    <th>ID</th><th>名称 / 操作</th><th>登录方式</th><th class="num">账号</th><th>能力</th>
  </tr></thead>`;
  const tbody = el('tbody');
  providers.forEach((p) => {
    const tr = el('tr');
    const caps = (p.capabilities || '').split(',').filter(Boolean)
      .map((c) => `<span class="tag">${esc(capLabel(c))}</span>`).join(' ') || '—';
    tr.innerHTML = `
      <td class="mono">${esc(p.id)}</td>
      <td class="cell-name"></td>
      <td class="cell-muted">${esc(authKindLabel(p.authKind))}</td>
      <td class="num">${p.usableCount}/${p.accountCount}</td>
      <td>${caps}</td>`;
    const nameCell = tr.children[1];
    const nm = el('span', 'cell-name-text', p.name + (p.custom ? ' · 自定义' : ''));
    const login = el('button', 'btn sm', p.authKind === 'SMS_CODE' ? '短信登录'
      : (p.authKind === 'NONE' || p.authKind === 'API_KEY') ? '导入凭证' : '登录');
    login.addEventListener('click', () => doLogin(p));
    nameCell.append(nm, login);
    tbody.appendChild(tr);
  });
  if (providers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty">暂无供应商</div></td></tr>';
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  body.appendChild(card);

  // 额度刷新结果就地回显，不弹模态窗（旧版弹窗阻塞 EDT 就是卡顿的直接原因）
  const status = el('div', 'inline-status');
  status.id = 'creditStatus';
  body.appendChild(status);

  // 自定义供应商：内置那 7 家之外的中转站入口（媒体实测页的转写要靠它）
  renderCustomProviders(body);
}

/**
 * 供应商页里的自定义供应商区块。
 *
 * core 的自定义供应商（OpenAI 兼容中转）是「非内置上游」的唯一入口，
 * 也是「媒体实测」页语音转写能跑起来的前提。但原先它只能靠手改
 * `settings/custom.json`：供应商页写着「导入凭证」，媒体页写着「先在供应商页
 * 导入一个自定义供应商」，而那一页根本没有新建入口——闭环断在最前面。
 *
 * 三条与后端的约定（后端见 UiRoutes.customJson / saveCustomConfig）：
 * 1. **保存走 `/ui/custom/save`（单条）**，不是整表：另一个窗口可能正在编辑别的条目。
 * 2. **改名要带 `originalKey`**：providerId 是 `custom:<key>`，key 变了等于换了供应商，
 *    后端靠这个字段把旧账号搬过去。
 * 3. **界面只显示后端规范化后的地址**：`https://api.x.com` 会被补成 `/v1`，
 *    用户必须能看见最终会打哪个地址，否则 404 只能靠抓包才知道差在哪。
 */
function renderCustomProviders(body) {
  const card = el('div', 'card');
  // 未加载时不能写「0 家」：数据还在路上，写 0 会让人以为配置丢了
  const head = headWith('自定义供应商',
    (S.customLoaded ? `${S.custom.length} 家` : '读取中…')
    + ' · OpenAI 兼容中转，可填多个 Key');
  card.appendChild(head);

  const list = el('div', 'custom-list');
  list.id = 'customList';

  if (!S.customLoaded) {
    list.innerHTML = '<div class="empty"><span class="big">正在读取</span><span>settings/custom.json</span></div>';
    card.appendChild(list);
    body.appendChild(card);
    return;
  }

  if (S.custom.length === 0) {
    list.innerHTML = `<div class="empty"><span class="big">还没有自定义供应商</span>
      <span>不属于内置 7 家的中转站用这里添加；填好地址与 Key 后可拉模型目录</span></div>`;
  } else {
    S.custom.forEach((c) => {
      const row = el('div', 'custom-item');
      // 第一行：显示名 + 计数标签 + 操作。
      // **provider id 不进这一行**：`custom:<短名>` 是长 id，标尺 90px 的
      // .chain-tag 会把它截成「custom:probe-…」，而它恰是客户端要填的前缀。
      const head2 = el('div', 'chain-head');
      head2.appendChild(el('span', 'custom-name', c.name || c.key));
      head2.appendChild(el('span', 'tag', `${c.accountCount} 账号`));
      head2.appendChild(el('span', 'tag', `${c.modelCount} 模型`));
      // 出图能力单独一个标签：媒体实测页说「没有图像供应商」时，用户要能在
      // 供应商页看出「这家能不能出图、在哪一栏填」，否则两边对不上。
      if (c.supportsImage) {
        head2.appendChild(el('span', 'tag ok', `出图 ${c.imageCount}`));
      }
      if (!c.registered) {
        const warn = el('span', 'tag err', '未登记');
        warn.title = '配置已保存但没登记进路由表；保存一次该条即可完成登记';
        head2.appendChild(warn);
      }
      const act = el('div', 'chain-act');
      const ed = el('button', 'mini-btn', '✎');
      ed.title = '编辑';
      ed.addEventListener('click', () => editCustomProvider(c));
      const rm = el('button', 'mini-btn danger', '✕');
      rm.title = '删除（连带删除其下所有账号）';
      rm.addEventListener('click', () => removeCustomProvider(c));
      act.append(ed, rm);
      head2.appendChild(act);
      row.appendChild(head2);

      // 第二行：provider id 独占一行（长 id 只折行、不截断）
      const pid = el('span', 'custom-pid selectable', c.providerId);
      pid.title = '作为模型前缀：' + c.providerId + '/*';
      row.appendChild(pid);

      // 第三行：规范化后的真实请求地址
      const url = el('span', 'custom-url selectable', c.chatEndpoint);
      url.title = '实际请求地址（已按 OpenAI 兼容规则规范化）';
      row.appendChild(url);
      list.appendChild(row);
    });
  }
  card.appendChild(list);

  const bar = el('div', 'action-row');
  const bNew = el('button', 'btn primary', '添加自定义供应商');
  bNew.id = 'btnNewCustom';
  bNew.addEventListener('click', () => editCustomProvider(null));
  const bReload = el('button', 'btn', '重新登记');
  bReload.title = '把 custom.json 里的条目重新登记进路由表（不重启）';
  bReload.addEventListener('click', async () => {
    setBtnBusy(bReload, true, '登记中…');
    // 必须真的调后端 reload：只重读列表的话「未登记」标记永远不会消失，
    // 用户点完以为修好了，实际供应商仍然不在路由表里（账号也导不进来）。
    const r = await api.post('/ui/custom/reload', {}, 20000);
    setBtnBusy(bReload, false, '');
    if (r.ok === false) { toast('登记失败：' + r.message, 'err', 5000); return; }
    toast(r.message || '已重新登记', 'ok', 4000);
    await loadCustomProviders();
    await loadState();
    if (S.page === 'providers') renderPage();
  });
  bar.append(bNew, bReload);
  card.appendChild(bar);
  body.appendChild(card);
}

/** 给一个当前没被占用的兜底短名：relay1、relay2 …（中文显示名用得上）。 */
function nextCustomKey() {
  const taken = new Set((S.custom || []).map((c) => c.key));
  for (let i = 1; i < 1000; i++) {
    const k = 'relay' + i;
    if (!taken.has(k)) return k;
  }
  return 'relay' + Date.now().toString(36);
}

/** 打开新建 / 编辑表单（模态窗，不占整页）。 */
function editCustomProvider(existing) {
  const isNew = !existing;
  const c = existing || {};
  const body = `
    <div class="form-grid custom-form">
      <div class="field">
        <label>短名</label>
        <input type="text" id="ccKey" value="${esc(c.key || '')}"
               placeholder="自动从名称生成，如 my-relay">
        <span class="desc">作为供应商 id：<code>custom/&lt;短名&gt;</code>；
          只能含 a-z 0-9 _ -；显示名是纯中文时请在这里手动填一个</span>
      </div>
      <div class="field">
        <label>显示名</label>
        <input type="text" id="ccName" value="${esc(c.name || '')}" placeholder="例如 我的中转">
      </div>
    </div>
    <div class="field" style="margin-top:10px">
      <label>接口地址</label>
      <input type="text" id="ccUrl" value="${esc(c.baseUrl || '')}"
             placeholder="https://api.example.com 或 https://api.example.com/v1">
      <span class="desc" id="ccUrlHint">${c.baseUrl
        ? '实际请求：' + esc(c.chatEndpoint)
        : '只填域名即可，会自动补 /v1；贴了 /chat/completions 也会被剥掉'}</span>
    </div>
    <div class="field" style="margin-top:10px">
      <label>API Key（可留空，之后在账号页逐个导入）</label>
      <textarea id="ccKeys" rows="2"
        placeholder="每行一个 Key，例如 sk-xxxx"></textarea>
      <span class="desc">已有 ${c.accountCount || 0} 个账号；这里填的 Key 会同步进账号池</span>
    </div>
    <div class="field" style="margin-top:10px">
      <label>模型名（每行一个，可留空后用「拉取」）</label>
      <textarea id="ccModels" rows="3" placeholder="gpt-4o-mini">${esc((c.models || []).join('\n'))}</textarea>
    </div>
    <div class="field" style="margin-top:10px">
      <label>图像模型（可留空；填了才认为这家能出图）</label>
      <textarea id="ccImageModels" rows="2"
        placeholder="gpt-image-1 / dall-e-3 / flux-pro …">${esc((c.imageModels || []).join('\n'))}</textarea>
      <span class="desc" id="ccImageHint">${c.supportsImage
        ? '实际请求：' + esc(c.imageEndpoint || '')
        : '不填则本供应商不参与 /v1/images/generations；媒体实测页的出图只能靠内置图像供应商'}</span>
    </div>
    <div class="action-row" style="margin-top:10px">
      <button class="btn sm" id="btnPullModels">拉取模型列表</button>
      <span class="inline-status" id="ccStatus"></span>
    </div>
    <pre class="mono-block" id="ccPullOut" style="display:none"></pre>`;

  modal(isNew ? '添加自定义供应商' : ('编辑 ' + (c.name || c.key)), body, [
    { text: '取消' },
    {
      text: '保存', primary: true, keepOpen: true,
      onClick: () => saveCustomProvider(existing),
    },
  ]);

  // 短名跟着显示名自动派生：用户不必知道 id 规则，但保存后能看到结果
  const inName = $('#ccName');
  const inKey = $('#ccKey');
  if (inName && inKey) {
    inName.addEventListener('input', () => {
      if (isNew && !inKey.dataset.touched) {
        // 中文名派生不出合法短名（`[^a-z0-9_-]` 全被压成 `-`，trim 后为空）。
        // 这时不能留空让用户去撞「短名不能为空」——给一个递增的 `relayN` 兜底，
        // 用户想改再改；短名是 provider id 的一部分，必须有一个值。
        const slug = inName.value.trim().toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
        inKey.value = slug || nextCustomKey();
      }
    });
    inKey.addEventListener('input', () => { inKey.dataset.touched = '1'; });
  }

  const pull = $('#btnPullModels');
  if (pull) pull.addEventListener('click', () => pullCustomModels(existing));
}

/** 拉模型：用当前表单里「还没保存」的地址与 Key，失败原因原样显示。 */
async function pullCustomModels(existing) {
  const btn = $('#btnPullModels');
  const st = $('#ccStatus');
  const out = $('#ccPullOut');
  const url = ($('#ccUrl')?.value || '').trim();
  if (!url) { setStatus(st, '先填接口地址', 'err'); return; }
  const keyFirst = ($('#ccKeys')?.value || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  setBtnBusy(btn, true, '拉取中…');
  setStatus(st, '正在请求 /models…', 'muted');
  const r = await api.post('/ui/custom/models', {
    baseUrl: url,
    apiKey: keyFirst,
    key: existing?.key || ($('#ccKey')?.value || '').trim(),
  }, 60000);
  setBtnBusy(btn, false, '');
  if (r.ok === false) {
    // 四种失败原因（401 / 404 / 网络 / 非 OpenAI 兼容）说法不同，原样展示
    setStatus(st, r.message || '拉取失败', 'err');
    if (out) out.style.display = 'none';
    return;
  }
  const models = r.models || [];
  const hint = $('#ccUrlHint');
  if (hint && r.modelsEndpoint) hint.textContent = '模型地址：' + r.modelsEndpoint;
  if (models.length > 0) {
    const ta = $('#ccModels');
    const cur = (ta?.value || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const merged = [...new Set([...cur, ...models])];
    if (ta) ta.value = merged.join('\n');
    setStatus(st, `拉到 ${models.length} 个模型，已并入下面的列表（共 ${merged.length} 条）`, 'ok');
  } else {
    setStatus(st, '上游没有返回任何模型，请手动填写模型 id', 'warn');
  }
}

/** 保存当前表单。 */
async function saveCustomProvider(existing) {
  const btn = $('#ccStatus');
  const key = ($('#ccKey')?.value || '').trim();
  const name = ($('#ccName')?.value || '').trim();
  const url = ($('#ccUrl')?.value || '').trim();
  if (!url) { setStatus(btn, '接口地址不能为空', 'err'); return; }
  const apiKeys = ($('#ccKeys')?.value || '').split('\n')
    .map((s) => s.trim()).filter(Boolean)
    // 用户可能整段粘贴 `{"apiKey":"..."}`：只取里面的值
    .map((s) => {
      if (!s.startsWith('{')) return s;
      try { return (JSON.parse(s).apiKey || '').trim() || s; } catch (_) { return s; }
    });
  const models = ($('#ccModels')?.value || '').split('\n')
    .map((s) => s.trim()).filter(Boolean);
  const imageModels = ($('#ccImageModels')?.value || '').split('\n')
    .map((s) => s.trim()).filter(Boolean);

  setStatus(btn, '保存中…', 'muted');
  const r = await api.post('/ui/custom/save', {
    key,
    name,
    baseUrl: url,
    apiKeys,
    models,
    imageModels,
    // 编辑态下短名可能被改：后端靠 originalKey 定位旧条目并把账号搬过去
    originalKey: existing?.key || '',
  }, 30000);
  if (r.ok === false) { setStatus(btn, '保存失败：' + r.message, 'err'); return; }
  toast(r.message || '已保存', 'ok', 4200);
  closeModal();
  await loadCustomProviders();
  await loadState();
  if (S.page === 'providers') renderPage();
}

/** 删除：连带删账号，所以必须先确认。 */
async function removeCustomProvider(c) {
  const ok = await confirmBox('删除自定义供应商',
    `将删除「${c.name || c.key}」（${c.providerId}），并连带删除其下 ${c.accountCount} 个账号。`
    + '模型目录里属于它的模型也会消失。此操作不可撤销。');
  if (!ok) return;
  const r = await api.post('/ui/custom/delete', { key: c.key }, 30000);
  toast(r.ok === false ? ('删除失败：' + r.message) : (r.message || '已删除'),
    r.ok === false ? 'err' : 'ok', 4200);
  if (r.ok === false) return;
  await loadCustomProviders();
  await loadState();
  if (S.page === 'providers') renderPage();
}

/** 读一次自定义供应商列表（幂等读端点）。 */
async function loadCustomProviders() {
  const r = await api.get('/ui/custom');
  if (r.ok === false) {
    toast('读取自定义供应商失败：' + r.message, 'err', 5000);
    S.custom = [];
    S.customLoaded = true;
    return;
  }
  S.custom = r.items || [];
  S.customLoaded = true;
}

function headWith(title, hint) {
  const h = el('div', 'card-head');
  h.appendChild(el('h3', '', title));
  if (hint) h.appendChild(el('span', 'hint', hint));
  return h;
}

/** AuthKind 枚举 → 中文。取值以 core 的 Provider.AuthKind 为准。 */
function authKindLabel(k) {
  const map = {
    WEBVIEW_CALLBACK: '浏览器回调',
    OAUTH_LOOPBACK: '浏览器授权',
    DEVICE_CODE: '设备码',
    SMS_CODE: '短信验证码',
    NONE: '粘贴凭证',
    API_KEY: 'API Key',
    BROWSER: '浏览器授权',
  };
  return map[k] || k || '—';
}

/** ProviderCapability 枚举 → 中文。未知枚举原样显示，但会加下划线提示「未翻译」。 */
function capLabel(c) {
  const map = {
    CREDIT_REFRESH: '额度刷新',
    CHECKIN: '签到',
    TASKS: '任务',
    POINTS: '积分',
    POINTS_BILLS: '积分账单',
    IMAGE: '图像',
    AUDIO: '音频',
    CHAT: '对话',
    MODELS: '模型',
  };
  return map[c] || c;
}

/**
 * 登录入口：按 authKind 分三种流程。
 *
 * 每种流程都要能「取消而不留残局」：设备码轮询用 [S.pollCancel] 打断，
 * 浏览器授权只提示一次链接（引擎自己监听回环端口，账号会自动出现）。
 */
async function doLogin(p) {
  if (p.authKind === 'SMS_CODE') {
    const phone = await askInput('短信登录 ' + p.name, '手机号（不带 +86）', '', '13800000000');
    if (!phone) return;
    toast('正在发送验证码…', 'info');
    const sent = await api.post('/ui/login/sms/send', { providerId: p.id, phone: phone.trim() });
    if (!sent.ok) { toast('发送失败：' + sent.message, 'err', 5000); return; }
    const code = await askInput('输入验证码', '收到的短信验证码', '', '6 位数字');
    if (!code) return;
    const r = await api.post('/ui/login/sms/complete', {
      providerId: p.id, phone: phone.trim(), code: code.trim(), msgid: sent.msgid,
    });
    if (r.ok) {
      toast(`登录成功${r.nickname ? '：' + r.nickname : ''}`, 'ok');
      await loadState();
    } else {
      toast('登录失败：' + r.message, 'err', 5000);
    }
    return;
  }

  if (p.authKind === 'NONE') {
    const raw = await askInput('导入 ' + p.name, '粘贴凭证 JSON 或裸 Key');
    if (!raw) return;
    const r = await api.post('/ui/account/import', { providerId: p.id, raw: raw.trim() });
    toast(r.ok ? '已导入' : '导入失败：' + r.message, r.ok ? 'ok' : 'err');
    if (r.ok) await loadState();
    return;
  }

  // 浏览器回调 / 设备码 / OAuth loopback
  toast('正在创建授权…', 'info');
  const t = await api.post('/ui/login/browser', { providerId: p.id }, 30000);
  if (t.ok === false) { toast('创建授权失败：' + t.message, 'err', 5000); return; }

  if (t.pollState) {
    S.pollCancel = false;
    modal('设备授权 ' + p.name, `
      <div>已在浏览器打开授权页。完成授权后本窗口会自动继续，也可以点「取消」中止等待。</div>
      <pre class="mono-block">${esc(t.loginUrl)}</pre>`, [
      { text: '取消', onClick: () => { S.pollCancel = true; } },
    ]);
    pollLoop(p.id, t.pollState, t.region || '');
  } else {
    modal('登录 ' + p.name, `
      <div>已在浏览器打开授权页（回环端口由引擎监听，5 分钟内有效）。完成后账号会自动出现在「账号」页。</div>
      <pre class="mono-block">${esc(t.loginUrl)}</pre>`);
  }
}

/**
 * 设备码轮询。
 *
 * 每 3 秒一次、最多 120 次（6 分钟）。用 `S.pollCancel` 支持用户中途取消：
 * 取消后立即停表并关窗，不让后台继续发请求。
 */
async function pollLoop(providerId, state, region) {
  const INTERVAL_MS = 3000;
  const MAX_TRIES = 120;
  for (let i = 0; i < MAX_TRIES; i++) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    if (S.pollCancel) {
      closeModal();
      toast('已取消授权等待', 'info');
      return;
    }
    const r = await api.post('/ui/login/poll', { providerId, state, region });
    if (r.state === 'success') {
      closeModal();
      toast('登录成功', 'ok');
      await loadState();
      return;
    }
    if (r.state === 'failed') {
      closeModal();
      toast('授权失败：' + (r.error || '未知原因'), 'err', 5000);
      return;
    }
  }
  closeModal();
  toast('设备授权等待超时，请重试', 'err');
}

/**
 * 刷新全部账号额度。
 *
 * 三条防呆（旧 Swing 版栽过的坑一条不落）：
 * 1. **按钮禁用 + 文案切换**：不加的话用户会连点，后台同时跑几轮刷新，上游直接限流。
 * 2. **结果就地回显**：不弹模态窗（模态窗会阻塞 UI 线程，就是旧版"点一下卡死"的原因）。
 * 3. **超时单独给足**：这个接口要等上游逐账号返回，默认 15 秒必然不够。
 */
async function doRefreshCredits() {
  if (S.refreshingCredits) return;
  S.refreshingCredits = true;
  const btn = document.getElementById('btnRefreshCredits');
  const status = document.getElementById('creditStatus');
  setBtnBusy(btn, true, '刷新中…');
  setStatus(status, '正在刷新全部账号额度…', 'muted');
  try {
    const r = await api.post('/ui/credits/refresh', {}, 180000);
    if (r.ok === false) {
      setStatus(status, '刷新失败：' + r.message, 'err');
      toast('刷新失败：' + r.message, 'err', 6000);
      return;
    }
    setStatus(status, r.summary || '刷新完成', r.known > 0 ? 'ok' : 'warn');
    const failed = (r.results || []).filter((x) => !x.known);
    if (failed.length > 0) {
      const names = failed.map((f) => f.nickname || f.uid).join('、');
      toast(`${failed.length} 个账号额度未取到：${names}`, 'err', 6000);
    } else {
      toast(r.summary || '额度已刷新', 'ok');
    }
    await loadState();
  } finally {
    S.refreshingCredits = false;
    setBtnBusy(btn, false, '刷新额度');
  }
}

/** 按钮忙碌态：禁用 + 换文案，一处封装避免每处都写两行。 */
function setBtnBusy(btn, busy, busyText) {
  if (!btn) return;
  if (busy) {
    btn.dataset.idleText = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.idleText || btn.textContent;
    delete btn.dataset.idleText;
  }
}

/** 就地状态文字：kind = ok / warn / err / muted。 */
function setStatus(node, text, kind) {
  if (!node) return;
  node.textContent = text;
  node.className = 'inline-status' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------- 账号页

/** 昵称显示：WorkBuddy 的 uid 是完整 UUID（36 字符），会把表格撑到操作列看不见。
 *  超过 22 字符时中间省略，保留首 10 + 尾 6 —— 两个 uuid 靠尾部就能区分。 */
function shortName(s, max = 22) {
  const v = String(s || '');
  if (v.length <= max) return v;
  return v.slice(0, 10) + '…' + v.slice(-6);
}

function renderAccounts() {
  const body = $('#pageBody');
  body.innerHTML = '';
  const accounts = S.state?.accounts || [];
  const providers = S.state?.providers || [];

  const actions = $('#pageActions');
  actions.innerHTML = '';
  const bCheckin = el('button', 'btn primary', '一键签到');
  bCheckin.addEventListener('click', doCheckinAll);
  const bCredits = el('button', 'btn', '刷新额度');
  bCredits.id = 'btnRefreshCredits';
  bCredits.addEventListener('click', doRefreshCredits);
  actions.append(bCheckin, bCredits);

  const card = el('div', 'card');
  card.appendChild(headWith('账号', `${accounts.length} 个`));
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'grid grid-fixed');
  // 为什么必须 table-layout:fixed：
  // 「说明」列装的是上游原话（「上游返回的权益包没有可解析的额度」之类），
  // auto 布局下它按内容撑到 196px，把 6 列总宽顶到 651px>容器 602px，
  // 最右侧的「操作」列正好是唯一交互列，被推出可视区——截图里只剩「停」和半个箭头。
  // fixed 布局严格按下面的宽度分配，余量全给「昵称」，列宽不再随文案漂移。
  table.id = 'tblAccounts';
  table.innerHTML = `<thead><tr>
    <th>供应商</th><th>昵称</th><th class="num">余额</th>
    <th>状态</th><th>说明</th><th>操作</th>
  </tr></thead>`;
  const tbody = el('tbody');
  accounts.forEach((a) => {
    const tr = el('tr');
    const pname = providers.find((p) => p.id === a.providerId)?.name || a.providerId;
    const state = a.disabled ? ['凭证失效', 'err']
      : !a.enabled ? ['已停用', '']
      : a.reason ? ['额度异常', 'warn'] : ['可用', 'ok'];
    const balance = a.creditsKnown
      ? (a.creditUnit === 'percent'
        ? `${fmtAmount(a.credits)}%`
        : `${fmtAmount(a.credits)}${a.creditUnit ? ' ' + a.creditUnit : ''}`)
      : '—';
    const note = a.detail || a.reason || '—';
    const name = a.nickname || a.uid;
    tr.innerHTML = `
      <td>${esc(pname)}</td>
      <td class="mono" title="${esc(name)}">${esc(shortName(name))}${a.raised ? ' <span class="tag brand">优先</span>' : ''}</td>
      <td class="num${a.creditsKnown ? ' gold' : ''}">${esc(balance)}</td>
      <td><span class="tag ${state[1]}">${state[0]}</span></td>
      <td class="cell-note" title="${esc(note)}">${esc(note)}</td>
      <td></td>`;
    const ops = el('div', 'row-ops');

    const tog = el('button', 'mini-btn', a.enabled ? '停' : '启');
    tog.title = a.enabled ? '停用该账号' : '启用该账号';
    tog.addEventListener('click', async () => {
      // 先乐观改按钮，再等服务端确认：这个操作要落盘，往返 20ms 但用户手速更快
      setBtnBusy(tog, true, '…');
      const r = await api.post('/ui/account/enable',
        { providerId: a.providerId, uid: a.uid, enabled: !a.enabled });
      setBtnBusy(tog, false, '');
      if (r.ok === false) toast('切换失败：' + r.message, 'err');
      await loadState();
    });
    const up = el('button', 'mini-btn', '↑');
    up.title = '上移优先级';
    up.addEventListener('click', async () => {
      const r = await api.post('/ui/account/priority', { providerId: a.providerId, uid: a.uid, up: true });
      if (r.ok === false && r.message) toast(r.message, 'warn');
      await loadState();
    });
    const down = el('button', 'mini-btn', '↓');
    down.title = '下移优先级';
    down.addEventListener('click', async () => {
      const r = await api.post('/ui/account/priority', { providerId: a.providerId, uid: a.uid, up: false });
      if (r.ok === false && r.message) toast(r.message, 'warn');
      await loadState();
    });
    const del = el('button', 'mini-btn danger', '✕');
    del.title = '删除账号';
    del.addEventListener('click', async () => {
      const yes = await confirmBox('删除账号', `确定删除 ${pname} / ${name}？删除后需重新登录。`);
      if (!yes) return;
      const r = await api.post('/ui/account/delete', { providerId: a.providerId, uid: a.uid });
      toast(r.ok ? '已删除' : '删除失败：' + r.message, r.ok ? 'ok' : 'err');
      await loadState();
    });
    ops.append(tog, up, down, del);
    tr.lastElementChild.appendChild(ops);
    tbody.appendChild(tr);
  });
  if (accounts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty"><span class="big">还没有账号</span><span>去「供应商」页登录或导入凭证</span></div></td></tr>';
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  body.appendChild(card);
}

/**
 * 一键签到（全量，不是选中谁签谁）。
 *
 * 结果用弹窗一次性列全：签到是「一批账号各有各的结果」，
 * 只用 toast 会说不出谁失败、为什么失败。
 */
async function doCheckinAll() {
  toast('正在批量签到全部支持签到的账号…', 'info', 5000);
  const r = await api.post('/ui/checkin/all', {}, 120000);
  if (r.ok === false) { toast(r.message || '签到失败', 'err', 5000); return; }
  const rows = (r.results || []).map((x) => `
    <div class="result-row">
      <span class="tag ${x.ok ? 'ok' : 'err'}">${x.ok ? '成功' : '失败'}</span>
      <span class="result-name">${esc(x.nickname)}</span>
      <span class="result-note">${esc(x.message || '')}</span>
    </div>`).join('');
  modal('签到结果', `<div class="modal-summary">${esc(r.summary)}</div>${rows}`);
  await loadState();
}

// ---------------------------------------------------------------- 模型页

/**
 * 模型目录。
 *
 * 拉取是**显式动作**（点按钮才打上游）：一次要遍历全部供应商，冷启动时
 * 自动拉会让首屏等好几秒。拉到的结果只存在前端内存里，不写回服务端快照——
 * 快照里的模型数是缓存值，两者口径不同，混用会出现「点了拉取但数字没变」。
 */
function renderModels() {
  const body = $('#pageBody');
  body.innerHTML = '';

  const actions = $('#pageActions');
  actions.innerHTML = '';
  const bLoad = el('button', 'btn primary', S.modelLoaded ? '重新拉取目录' : '拉取模型目录');
  bLoad.addEventListener('click', async () => {
    setBtnBusy(bLoad, true, '拉取中…');
    const r = await api.get('/ui/models', null, 180000);
    setBtnBusy(bLoad, false, '');
    if (r.ok === false) {
      toast('拉取失败：' + r.message, 'err', 6000);
      return;
    }
    S.models = r.models || [];
    S.modelLoaded = true;
    toast(`已拉取 ${r.count} 个模型`, 'ok');
    // 拉完要把快照也刷一遍：概览的「模型数」读的是服务端缓存，不同步会出现两个页面对不上
    await loadState();
    if (S.page === 'models') renderPage();
  });
  actions.appendChild(bLoad);

  const card = el('div', 'card');
  card.appendChild(headWith('模型目录', S.modelLoaded ? `${S.models.length} 个` : '未拉取（点右上角拉取）'));
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'grid');
  table.innerHTML = '<thead><tr><th>模型 ID（客户端调用用这个）</th><th>名称</th><th>供应商</th><th>来源</th></tr></thead>';
  const tbody = el('tbody');
  if (S.modelLoaded && S.models.length > 0) {
    S.models.forEach((m) => {
      const tr = el('tr');
      tr.innerHTML = `
        <td class="mono selectable">${esc(m.id)}</td>
        <td>${esc(m.name)}</td>
        <td>${esc(m.providerId)}</td>
        <td>${m.cached ? '<span class="tag warn">缓存</span>' : '<span class="tag ok">实时</span>'}</td>`;
      tbody.appendChild(tr);
    });
  } else {
    const empty = S.modelLoaded
      ? ['目录为空', '检查各供应商登录状态，或到「供应商」页刷新额度']
      : ['模型目录尚未拉取', '点右上角「拉取模型目录」，会向上游请求一次'];
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty">
      <span class="big">${empty[0]}</span><span>${empty[1]}</span></div></td></tr>`;
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  body.appendChild(card);
}

// ---------------------------------------------------------------- 智能路由页

function renderSmartRoute() {
  const body = $('#pageBody');
  body.innerHTML = '';
  const auto = S.state?.auto || {};

  // 首次进入这一页时把服务端的候选链拷进工作副本。
  // 用 chainSynced 只同步一次：之后用户在页面上增删/排序都不该被心跳覆盖，
  // 心跳里也不碰 S.chain（否则每次刷新都会把用户未保存的改动打回去）。
  if (!S.chainSynced) {
    S.chain = (auto.chain || []).slice();
    S.chainSynced = true;
  }

  const actions = $('#pageActions');
  actions.innerHTML = '';
  const bSave = el('button', 'btn primary', '保存顺序');
  bSave.id = 'btnSaveChain';
  bSave.addEventListener('click', saveChain);
  actions.appendChild(bSave);

  // 顶部：开关 + 状态
  const topCard = el('div', 'card');
  const topBody = el('div', 'card-body row-inline');

  const sw = el('label', 'switch');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = !!auto.enabled;
  sw.append(cb, el('span', 'track'));
  sw.appendChild(el('span', '', '启用 Auto'));
  cb.addEventListener('change', async () => {
    cb.disabled = true;
    const r = await api.post('/ui/auto/toggle', { enabled: cb.checked });
    cb.disabled = false;
    if (r.ok === false) {
      cb.checked = !cb.checked;   // 回滚视觉状态，别让开关和真实配置不一致
      toast('切换失败：' + r.message, 'err');
      return;
    }
    await loadState();
    // 打开开关但候选链仍为空时，必须把**原因**说出来：
    // core 的 rebuild 只有在「有可用账号的供应商」存在时才会建 auto 组，
    // 否则 disableGroup() 后直接返回——组根本不会被创建，界面上看不出任何东西
    // （开关是开的、摘要写着「候选链为空」，用户会以为是 bug 而不是「没账号」）。
    if (cb.checked) {
      const usable = (S.state?.providers || []).filter((p) => p.enabled && p.usableCount > 0).length;
      if (usable === 0) {
        toast('已开启，但没有可用账号：Auto 组不会生成。先到「账号」页登录/导入至少一个账号', 'warn', 8000);
      } else if ((S.state?.auto?.chainCount ?? 0) === 0) {
        toast('已开启，但候选链仍为空：到右栏模型池点「加入」，或先关掉再打开一次开关（会自动生成初始链）', 'warn', 7000);
      }
    }
    if (S.page === 'smartRoute') renderPage();
  });

  const stPill = el('span', 'pill' + (auto.enabled && auto.groupEnabled ? ' on' : ''),
    auto.enabled && auto.groupEnabled ? '运行中' : '已关闭');
  const summary = el('span', 'hint wrap', auto.summary
    ? `model="auto" → ${auto.summary}（${auto.candidates} 个候选，失败自动切换）`
    : auto.enabled ? '候选链为空：从下方模型池加入' : '关闭后客户端请求 model="auto" 不再可用');

  const bPrune = el('button', 'btn sm', '清理失效候选');
  bPrune.addEventListener('click', async () => {
    setBtnBusy(bPrune, true, '清理中…');
    const r = await api.post('/ui/auto/prune', {});
    setBtnBusy(bPrune, false, '');
    if (r.ok === false) { toast('清理失败：' + r.message, 'err'); return; }
    toast(r.removed > 0 ? `已清理 ${r.removed} 个失效候选` : '没有失效候选', 'ok');
    await loadState();
    if (S.page === 'smartRoute') renderPage();
  });

  topBody.append(sw, stPill, summary, bPrune);
  topCard.appendChild(topBody);
  body.appendChild(topCard);

  // 定位说明条。
  //
  // 这两页的差别此前只写在副标题里（还都不是同一套说法），一眼看去都是
  // 「一堆 供应商/模型 的列表」，用户直接问「是不是重复了」。
  // 结论是不重复：本页维护的是 model="auto" 这一条的**兜底顺序**（只排序、失败换下一个，
  // 没有权重/没有规则），而对外的其它模型名由「路由组」页管（策略/权重/7 类分流规则）。
  // 把这条区别做成页面上一行可读的话，并给一个跳转入口，才不会再被当成同一件事。
  body.appendChild(buildScopeNote({
    kind: 'auto',
    title: '坐标：model = "auto" 的兜底顺序',
    descHtml: '这里只决定「auto 先试谁、再试谁」，按顺序往下换，不带权重也不带条件。'
      + '想要「按 token 数 / 图片 / 时段分流到不同模型」，去路由组页建 '
      + '<span class="nowrap">group/&lt;组名&gt;</span>。',
    linkText: '去路由组 →',
    linkPage: 'groups',
  }));

  // 左右两栏：候选链 + 模型池
  const split = el('div', 'split2 split-fill');
  split.appendChild(buildChainCard());
  split.appendChild(buildPoolCard());
  body.appendChild(split);
}

/**
 * 页面顶部的「这页负责什么」说明条。
 *
 * 两个页面（智能路由 / 路由组）在视觉上高度相似，靠正文差异解释不够；
 * 用一条固定样式的窄条给出坐标 + 一条跳转链接，用户一眼就能分清。
 * kind 只影响配色：auto 用品牌蓝（它是网关内建逻辑），group 用中性色（自建能力）。
 */
function buildScopeNote(o) {
  const box = el('div', 'scope-note' + (o.kind === 'auto' ? ' brand' : ''));
  const text = el('div', 'scope-text');
  text.appendChild(el('div', 'scope-title', o.title));
  const desc = el('div', 'scope-desc');
  // 文案里带 `group/<组名>` 这类尖括号：直接拼进 textContent 没问题，
  // 但换行时会从 `<` 后面断开，把 `>` 甩到下一行行首（实测截图里就是那样）。
  // 允许传 descHtml，用 .nowrap 的 span 把那一段锁成一整块。
  if (o.descHtml) desc.innerHTML = o.descHtml;
  else desc.textContent = o.desc || '';
  text.appendChild(desc);
  box.appendChild(text);
  if (o.linkPage) {
    const link = el('button', 'btn sm', o.linkText);
    link.addEventListener('click', () => go(o.linkPage));
    box.appendChild(link);
  }
  return box;
}

/**
 * 候选链卡片。
 *
 * 每条两行：第一行「序号 + 供应商 + 排序/移除」，第二行模型名独占整行。
 * 单行放不下——双栏时每栏只有约 300 CSS px，序号 18 + tag 66 + 三个按钮 62
 * 已吃掉 146，真实模型名（`sn-deepseek-v4.1-flash-1017`）必然截成「…-fla」，
 * 等于看不出选的是哪个。
 */
function buildChainCard() {
  const card = el('div', 'card fill');
  card.appendChild(headWith('候选链', `${S.chain.length} 个`));
  const list = el('div', 'scroll-420');
  list.id = 'chainList';

  if (S.chain.length === 0) {
    // 池未拉取时右栏只有一个「拉取」按钮，写「从右侧点加入」会让用户找不到
    const hint = S.modelLoaded
      ? ['候选链为空', '从右侧模型池点「加入」挑模型']
      : ['候选链为空', '先拉取模型目录，再从右侧模型池加入'];
    list.innerHTML = `<div class="empty"><span class="big">${hint[0]}</span><span>${hint[1]}</span></div>`;
  } else {
    S.chain.forEach((m, i) => {
      const row = el('div', 'chain-item');
      const head = el('div', 'chain-head');
      head.appendChild(el('span', 'chain-idx', String(i + 1)));
      head.appendChild(el('span', 'chain-tag', m.providerId));

      const act = el('div', 'chain-act');
      const up = el('button', 'mini-btn', '↑');
      up.title = '上移';
      up.disabled = i === 0;
      up.addEventListener('click', () => moveChain(i, i - 1));
      const down = el('button', 'mini-btn', '↓');
      down.title = '下移';
      down.disabled = i === S.chain.length - 1;
      down.addEventListener('click', () => moveChain(i, i + 1));
      const rm = el('button', 'mini-btn danger', '✕');
      rm.title = '从候选链移除（需点「保存顺序」才生效）';
      rm.addEventListener('click', () => {
        S.chain.splice(i, 1);
        S.chainDirty = true;
        renderPage();
      });
      act.append(up, down, rm);
      head.appendChild(act);
      row.appendChild(head);

      const name = el('span', 'chain-model selectable', m.model);
      name.title = m.model;   // 截断时悬停也能读到全文
      row.appendChild(name);
      list.appendChild(row);
    });
  }
  card.appendChild(list);
  return card;
}

/** 模型池卡片（未拉取时只放一个拉取按钮 + 一句原因说明）。 */
function buildPoolCard() {
  const card = el('div', 'card fill');
  card.appendChild(headWith('可用模型池', S.modelLoaded ? `${S.models.length} 个` : '未拉取'));
  const bodyEl = el('div', 'card-body flush');

  if (!S.modelLoaded) {
    const btn = el('button', 'btn sm btn-pad', '拉取模型目录');
    btn.addEventListener('click', () => pullModels(btn));
    bodyEl.appendChild(btn);
    // 零账号时点这个按钮必然拉到空目录（上游没有可鉴权的账号），
    // 先把原因说清楚，别让用户以为拉一下就有。
    const hint = (S.state?.pool?.total || 0) === 0
      ? '池内没有账号，拉取只会返回空目录；先去登录供应商'
      : '拉完才能从右侧「加入」候选链';
    bodyEl.appendChild(el('div', 'pool-hint', hint));
  } else {
    const list = el('div', 'scroll-420');
    S.models.forEach((m) => {
      const row = el('div', 'chain-item');
      const head = el('div', 'chain-head');
      head.appendChild(el('span', 'chain-tag', m.providerId));
      const add = el('button', 'btn sm push-right', '加入');
      add.addEventListener('click', () => {
        const bare = m.id.includes('/') ? m.id.slice(m.id.indexOf('/') + 1) : m.id;
        if (S.chain.some((c) => c.providerId === m.providerId && c.model === bare)) {
          toast('已在候选链中', 'info');
          return;
        }
        S.chain.push({ providerId: m.providerId, model: bare, priority: 100 });
        S.chainDirty = true;
        renderPage();
      });
      head.appendChild(add);
      row.appendChild(head);
      const name = el('span', 'chain-model selectable', m.id);
      name.title = m.id;
      row.appendChild(name);
      list.appendChild(row);
    });
    bodyEl.appendChild(list);
  }
  card.appendChild(bodyEl);
  return card;
}

/** 在候选链里交换两项（边界直接忽略）。 */
function moveChain(from, to) {
  if (to < 0 || to >= S.chain.length) return;
  const tmp = S.chain[from];
  S.chain[from] = S.chain[to];
  S.chain[to] = tmp;
  S.chainDirty = true;
  renderPage();
}

/** 拉取模型目录（模型页与智能路由页的池共用）。 */
async function pullModels(btn) {
  setBtnBusy(btn, true, '拉取中…');
  const r = await api.get('/ui/models', null, 180000);
  setBtnBusy(btn, false, '');
  if (r.ok === false) {
    toast('拉取失败：' + r.message, 'err', 6000);
    return;
  }
  S.models = r.models || [];
  S.modelLoaded = true;
  toast(`已拉取 ${r.count} 个模型`, 'ok');
  await loadState();
  if (S.page === 'smartRoute' || S.page === 'models') renderPage();
}

/**
 * 保存候选链顺序。
 *
 * priority 用「长度 - 下标」：core 按 priority 降序取候选，这样第 1 项优先级最高
 * 且相邻项至少差 1，用户后续手动插入也有空间。
 */
async function saveChain() {
  if (S.chain.length === 0) {
    toast('候选链为空，先加入至少一个模型', 'warn');
    return;
  }
  const btn = document.getElementById('btnSaveChain');
  setBtnBusy(btn, true, '保存中…');
  const r = await api.post('/ui/auto/chain', {
    members: S.chain.map((m, i) => ({
      providerId: m.providerId,
      model: m.model,
      priority: S.chain.length - i,
    })),
  });
  setBtnBusy(btn, false, '保存顺序');
  if (r.ok === false) {
    toast('保存失败：' + r.message, 'err', 5000);
    return;
  }
  toast(`已保存 ${S.chain.length} 个候选（即时生效）`, 'ok');
  await loadState();
  // 保存后以服务端为准重新拉一次（服务端会顺手清掉失效候选）
  S.chainSynced = false;
  S.chainDirty = false;
  if (S.page === 'smartRoute') renderPage();
}

// ---------------------------------------------------------------- 路由组页

/**
 * 路由组。
 *
 * core 早就有完整的路由组能力（`RoutingGroup` + 策略 + 规则 + `group/<id>` 对外 id），
 * 但界面上只有智能路由页维护的那一个 `auto` 组——自建组、权重、分流规则
 * 全都只能手改 `settings/routing_groups.json`。这一页把它补齐。
 *
 * 两条与后端的分工约定：
 * 1. **保存走 `/ui/groups/save` 而不是 `/ui/groups`**：后者是整表覆盖，
 *    在这页保存会顺手把 auto 组（智能路由页维护的候选链）覆盖成旧值。
 * 2. **`auto` 组只读**：它的成员由智能路由页按目录生成与清理，
 *    这里给个编辑入口只会让两页互相打回。
 */
const GROUP_STRATEGY = {
  ORDER: ['按优先级', 'priority 降序；同级按 weight 加权随机'],
  WEIGHT: ['纯权重随机', '忽略 priority，每次按 weight 抽一个'],
};

/** 星期几（1=周一，core 的 daysOfWeek 就是这个口径）。 */
const DAYS = [[1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [7, '日']];

function renderGroups() {
  const body = $('#pageBody');
  body.innerHTML = '';

  const actions = $('#pageActions');
  actions.innerHTML = '';
  const bNew = el('button', 'btn primary', '新建组');
  bNew.id = 'btnNewGroup';
  bNew.addEventListener('click', () => newGroup());
  const bReload = el('button', 'btn', '刷新');
  bReload.addEventListener('click', async () => {
    setBtnBusy(bReload, true, '刷新中…');
    await loadGroups();
    setBtnBusy(bReload, false, '');
    if (S.page === 'groups') renderPage();
  });
  actions.append(bNew, bReload);

  if (!S.groupsLoaded) {
    S.groupsLoaded = true;
    loadGroups().then(() => {
      if (S.page === 'groups') renderPage();
    });
    body.innerHTML = `<div class="empty"><span class="big">正在读取路由组</span>
      <span>settings/routing_groups.json</span></div>`;
    return;
  }

  body.appendChild(buildScopeNote({
    kind: 'group',
    title: '坐标：自建对外模型名 group/<组名>',
    descHtml: '这里建的是普通模型入口：选策略（顺序 / 加权 / 轮询…）、给成员配权重、'
      + '再加 7 类分流条件（token、图片、时段…）。<span class="nowrap">model="auto"</span>'
      + ' 本身不在这里维护，它的候选顺序在智能路由页。',
    linkText: '去智能路由 →',
    linkPage: 'smartRoute',
  }));

  body.appendChild(buildGroupTable());
  // 草稿存在时优先显示草稿：切页再回来不该丢掉正在编辑的组
  if (S.groupDraft) body.appendChild(buildGroupEditor(S.groupDraft));
}

/** 组列表：只列**自建组**。auto 是 core 内建的兜底组，归「智能路由」页维护。 */
function buildGroupTable() {
  // 把 auto 从表里摘出来：它以前混在这张表里（灰掉删除按钮 + 一行蓝 tag），
  // 结果两页都出现一个叫 auto 的组，看着就像同一个东西开在两个页面。
  // auto 的存在感交给上面的说明条，这里只留用户真正能编辑的组。
  const mine = S.groups.filter((g) => !g.isAuto);
  const autoGroup = S.groups.find((g) => g.isAuto);

  const card = el('div', 'card');
  card.appendChild(headWith('自建路由组',
    `${mine.length} 个 · 对外 id 是 group/<组名>`));
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'grid grid-fixed compact');
  table.id = 'tblGroups';
  table.innerHTML = `<thead><tr>
    <th>组名</th><th>策略</th><th class="num">成员</th><th class="num">规则</th>
    <th>状态</th><th>操作</th>
  </tr></thead>`;

  const tbody = el('tbody');
  if (mine.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty">
      <span class="big">还没有自建路由组</span>
      <span>点右上角「新建组」，把几个模型合成一个对外模型名</span></div></td></tr>`;
  } else {
    mine.forEach((g) => {
      const tr = el('tr', 'clickable');
      if (g.id === S.groupSel) tr.classList.add('selected');
      const state = !g.enabled ? '<span class="tag">已停用</span>'
        : g.memberCount === 0 ? '<span class="tag warn">无成员</span>'
        : g.usableMembers === 0 ? '<span class="tag err">全部失效</span>'
        : `<span class="tag ok">${g.usableMembers}/${g.memberCount}</span>`;
      const strat = GROUP_STRATEGY[g.strategy] ? GROUP_STRATEGY[g.strategy][0] : g.strategy;
      tr.innerHTML = `
        <td class="mono">${esc(g.id)}</td>
        <td class="cell-note">${esc(strat)}</td>
        <td class="num">${g.memberCount}</td>
        <td class="num">${g.ruleCount}</td>
        <td>${state}</td>
        <td></td>`;
      const ops = el('div', 'row-ops');
      const edit = el('button', 'mini-btn', '✎');
      edit.title = '编辑';
      edit.addEventListener('click', () => openGroup(g));
      const del = el('button', 'mini-btn danger', '✕');
      del.title = '删除该组';
      del.addEventListener('click', () => removeGroup(g));
      ops.append(edit, del);
      tr.lastElementChild.appendChild(ops);
      tr.addEventListener('click', (e) => {
        // 点按钮时不重复打开（按钮自己的 handler 已经处理）
        if (e.target.closest('button')) return;
        openGroup(g);
      });
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);

  // 底部一行：auto 组的情况（只读），避免用户以为「我的组怎么少了一个」。
  if (autoGroup) {
    const foot = el('div', 'group-foot');
    const st = autoGroup.enabled ? `${autoGroup.usableMembers}/${autoGroup.memberCount} 可用` : '已停用';
    foot.innerHTML = `<span class="hint wrap">另有系统内建 <span class="mono">auto</span> 组（`
      + `${esc(st)}，${autoGroup.ruleCount} 条规则）：它由「智能路由」页维护，不在本表。</span>`;
    // wide：20px 固定宽装不下两个汉字（实测 sw 23 > w 20），走 .mini-btn.wide 按内容撑宽
    const jump = el('button', 'mini-btn wide', '查看');
    jump.title = '去智能路由页';
    jump.addEventListener('click', () => go('smartRoute'));
    foot.appendChild(jump);
    card.appendChild(foot);
  }
  return card;
}

/** 从服务端取全部组（读端点，GET）。 */
async function loadGroups() {
  const r = await api.get('/ui/groups');
  if (r.ok === false) {
    toast('读取路由组失败：' + r.message, 'err', 5000);
    S.groups = [];
    return;
  }
  S.groups = r.groups || [];
}

/** 打开某个组：auto 组直读服务端值（只读展示），其它组进编辑态。 */
function openGroup(g) {
  S.groupSel = g.id;
  S.groupDraft = {
    id: g.id,
    name: g.name || '',
    enabled: g.enabled !== false,
    strategy: g.strategy || 'ORDER',
    members: (g.members || []).map((m) => ({ ...m })),
    rules: (g.rules || []).map((r) => ({ ...r })),
    isAuto: !!g.isAuto,
  };
  S.groupDirty = false;
  renderPage();
}

/** 新建：先给一个可编辑的空草稿，组名留空让用户填。 */
function newGroup() {
  S.groupSel = null;
  S.groupDraft = { id: '', name: '', enabled: true, strategy: 'ORDER', members: [], rules: [] };
  S.groupDirty = false;
  renderPage();
}

/**
 * 编辑区。
 *
 * 三张卡而不是一个大表单：组信息（12 个字段以内）+ 成员（有序列表）+ 规则（列表）。
 * 成员与规则都是「可变长列表」，塞进 form-grid 会让每一个条目都占一整行网格，
 * 600px 宽下等于每屏只看得到两条。
 */
function buildGroupEditor(g) {
  const wrap = el('div', 'card-stack');
  const isAuto = !!g.isAuto;

  // ---- 组信息
  const { card, body: infoBody } = formCard(
    isAuto ? '组信息（只读）' : '组信息',
    isAuto ? 'auto 组由「智能路由」页维护' : '组名即对外模型 id',
  );
  const grid = el('div', 'form-grid');
  const inId = textInput(g.id, '例如 media-hd');
  inId.id = 'grId';
  if (isAuto) inId.disabled = true;
  const inName = textInput(g.name, '显示名（可留空）');
  inName.id = 'grName';
  if (isAuto) inName.disabled = true;
  const selStrat = el('select');
  selStrat.id = 'grStrategy';
  Object.entries(GROUP_STRATEGY).forEach(([k, [label]]) => {
    const o = el('option', '', label);
    o.value = k;
    if (k === g.strategy) o.selected = true;
    selStrat.appendChild(o);
  });
  if (isAuto) selStrat.disabled = true;
  const cbEnabled = el('input');
  cbEnabled.type = 'checkbox';
  cbEnabled.checked = g.enabled !== false;
  const swEnabled = el('label', 'switch');
  swEnabled.append(cbEnabled, el('span', 'track'), el('span', '', '启用'));
  if (isAuto) cbEnabled.disabled = true;

  grid.append(
    labelField('组名', inId, el('span', 'desc', '客户端填 group/<组名>；不能含斜杠')),
    labelField('显示名', inName, el('span', 'desc', '只影响本页与模型目录里的名字')),
    labelField('组内策略', selStrat,
      el('span', 'desc', (GROUP_STRATEGY[g.strategy] || GROUP_STRATEGY.ORDER)[1])),
    labelField('启用', swEnabled, el('span', 'desc', '停用后该组不再参与路由，成员与规则保留')),
  );
  infoBody.appendChild(grid);

  // 对外 id：客户端要复制的就是这一串
  const keyRow = el('div', 'action-row tight');
  const idText = el('span', 'route-id', g.id ? `group/${g.id}` : 'group/<组名>');
  idText.id = 'grRouteId';
  if (g.id) {
    const bCopy = el('button', 'btn sm', '复制');
    bCopy.addEventListener('click', () => copyText(idText.textContent));
    keyRow.append(idText, bCopy);
  } else {
    keyRow.append(idText);
  }
  infoBody.appendChild(keyRow);
  wrap.appendChild(card);

  // ---- 成员
  wrap.appendChild(buildMembersCard(g, isAuto));
  // ---- 规则
  wrap.appendChild(buildRulesCard(g, isAuto));

  // ---- 保存 / 放弃
  if (!isAuto) {
    const bar = el('div', 'action-row');
    const bSave = el('button', 'btn primary', '保存组');
    bSave.id = 'btnSaveGroup';
    bSave.addEventListener('click', () => saveGroupDraft(bSave));
    const bDrop = el('button', 'btn', '放弃改动');
    bDrop.addEventListener('click', () => {
      S.groupDraft = null;
      S.groupDirty = false;
      S.groupSel = null;
      renderPage();
    });
    const st = el('span', 'inline-status');
    st.id = 'grSaveStatus';
    bar.append(bSave, bDrop, st);
    wrap.appendChild(bar);
  }

  // 控件句柄集中存放：保存时要读多个输入框
  S.groupCtx = { inId, inName, selStrat, cbEnabled };
  /**
   * 输入即写回草稿，而不是等保存时才读 DOM。
   *
   * 本页会**重建**整块编辑区（加成员、加规则、成员上移下移都走 renderPage），
   * 重建时输入框的值来自 `g.id` / `g.name`。原先只把值留在 DOM 里，
   * 于是「填了组名 → 加个成员 → 组名没了 → 保存报『组名不能为空』」。
   * 这条只有走完整流程（填空 → 触发重建 → 保存）才会暴露。
   */
  const markDirty = () => { S.groupDirty = true; };
  inId.addEventListener('input', () => {
    g.id = inId.value.trim();
    markDirty();
    // 组名只影响「对外 id」那行提示，就地改文本而不是重绘（重绘会抢光标）
    const rid = $('#grRouteId');
    if (rid) rid.textContent = g.id ? `group/${g.id}` : 'group/<组名>';
  });
  inName.addEventListener('input', () => { g.name = inName.value; markDirty(); });
  [selStrat, cbEnabled].forEach((n) => n.addEventListener('change', () => {
    g.strategy = selStrat.value;
    g.enabled = cbEnabled.checked;
    markDirty();
  }));
  return wrap;
}

/** 成员卡：有序列表 + 从模型目录挑。 */
function buildMembersCard(g, isAuto) {
  const { card, body } = formCard('成员', `${g.members.length} 个 · 顺序即候选顺序`);
  const list = el('div', 'scroll-420');

  if (g.members.length === 0) {
    list.innerHTML = `<div class="empty"><span class="big">没有成员</span>
      <span>组内至少要有一个模型，否则这个组对外不可用</span></div>`;
  } else {
    g.members.forEach((m, i) => {
      const row = el('div', 'chain-item');
      const head = el('div', 'chain-head');
      head.appendChild(el('span', 'chain-idx', String(i + 1)));
      head.appendChild(el('span', 'chain-tag', m.providerId));

      const act = el('div', 'chain-act');
      const up = el('button', 'mini-btn', '↑');
      up.disabled = isAuto || i === 0;
      up.addEventListener('click', () => moveMember(i, -1));
      const down = el('button', 'mini-btn', '↓');
      down.disabled = isAuto || i === g.members.length - 1;
      down.addEventListener('click', () => moveMember(i, 1));
      const rm = el('button', 'mini-btn danger', '✕');
      rm.disabled = isAuto;
      rm.addEventListener('click', () => {
        g.members.splice(i, 1);
        S.groupDirty = true;
        renderPage();
      });
      act.append(up, down, rm);
      head.appendChild(act);
      row.appendChild(head);

      // 第二行：模型名独占整行 + priority / weight 两个窄输入
      // （单行放不下：双栏时每栏约 299px，序号 + tag + 按钮已吃掉 146px）
      const line2 = el('div', 'member-line2');
      const name = el('span', 'chain-model selectable', m.model);
      name.title = m.model;
      const prIn = numInput(m.priority, 100, 0, 1000);
      prIn.className = 'weight-in';
      prIn.title = '优先级：数字大的先试';
      prIn.disabled = isAuto;
      prIn.addEventListener('change', () => {
        m.priority = toIntOr(prIn.value, 100);
        S.groupDirty = true;
      });
      const wtIn = numInput(m.weight, 1, 1, 20);
      wtIn.className = 'weight-in';
      wtIn.title = '权重：随机抽取时的相对份数';
      wtIn.disabled = isAuto;
      wtIn.addEventListener('change', () => {
        m.weight = toIntOr(wtIn.value, 1);
        S.groupDirty = true;
      });
      line2.append(name, el('span', 'desc', 'pri'), prIn, el('span', 'desc', 'w'), wtIn);
      row.appendChild(line2);
      list.appendChild(row);
    });
  }
  body.appendChild(list);

  if (!isAuto) {
    const bar = el('div', 'action-row');
    const bAdd = el('button', 'btn sm btn-pad', '从模型目录添加');
    bAdd.addEventListener('click', () => pickMember(g));
    bar.appendChild(bAdd);
    body.appendChild(bar);
  }
  return card;
}

function moveMember(from, to) {
  const ms = S.groupDraft?.members || [];
  if (to < 0 || to >= ms.length) return;
  const tmp = ms[from];
  ms[from] = ms[to];
  ms[to] = tmp;
  S.groupDirty = true;
  renderPage();
}

/**
 * 从模型目录挑一个成员。
 *
 * 目录没拉过就先拉一次（同模型页的按钮），否则弹窗里只有一个空列表，
 * 用户会以为「没有模型可用」而不是「还没拉」。
 */
async function pickMember(g) {
  if (!S.modelLoaded) {
    toast('正在拉取模型目录…', 'info');
    const r = await api.get('/ui/models', null, 180000);
    if (r.ok === false) { toast('拉取失败：' + r.message, 'err', 6000); return; }
    S.models = r.models || [];
    S.modelLoaded = true;
  }
  const provs = [...new Set(S.models.map((m) => m.providerId))];
  const body = `
    <div class="field">
      <label>只看某个供应商（可选）</label>
      <select id="pickProv">
        <option value="">全部（${S.models.length} 个模型）</option>
        ${provs.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}
      </select>
    </div>
    <div class="scroll-420" id="pickList" style="margin-top:10px"></div>`;
  modal('添加成员', body, [{ text: '关闭' }]);

  const list = $('#pickList');
  const paint = () => {
    const only = $('#pickProv').value;
    const items = S.models.filter((m) => !only || m.providerId === only);
    list.innerHTML = '';
    if (items.length === 0) {
      list.innerHTML = '<div class="empty"><span class="big">没有可选项</span><span>该供应商目录为空</span></div>';
      return;
    }
    items.forEach((m) => {
      const bare = m.id.includes('/') ? m.id.slice(m.id.indexOf('/') + 1) : m.id;
      const row = el('div', 'chain-item');
      const head = el('div', 'chain-head');
      head.appendChild(el('span', 'chain-tag', m.providerId));
      const already = g.members.some((x) => x.providerId === m.providerId && x.model === bare);
      const add = el('button', 'btn sm push-right', already ? '已加入' : '加入');
      add.disabled = already;
      add.addEventListener('click', () => {
        g.members.push({ providerId: m.providerId, model: bare, priority: 100, weight: 1 });
        S.groupDirty = true;
        closeModal();
        renderPage();
      });
      head.appendChild(add);
      row.appendChild(head);
      const name = el('span', 'chain-model selectable', m.id);
      name.title = m.id;
      row.appendChild(name);
      list.appendChild(row);
    });
  };
  $('#pickProv').addEventListener('change', paint);
  paint();
}

/** 规则卡：每条规则一张小卡（目标 + 条件摘要 + 编辑/删除）。 */
function buildRulesCard(g, isAuto) {
  const { card, body } = formCard('分流规则', `${g.rules.length} 条 · 命中则优先交给指定成员`);
  const list = el('div', 'scroll-420');

  if (g.rules.length === 0) {
    list.innerHTML = `<div class="empty"><span class="big">没有规则</span>
      <span>不加规则时，组内按策略顺序轮流/加权选取</span></div>`;
  } else {
    g.rules.forEach((r, i) => {
      const row = el('div', 'rule-item');
      const head = el('div', 'rule-head');
      head.appendChild(el('span', 'chain-idx', String(i + 1)));
      head.appendChild(el('span', 'chain-tag', r.targetProviderId));
      const act = el('div', 'rule-act');
      const ed = el('button', 'mini-btn', '✎');
      ed.disabled = isAuto;
      ed.addEventListener('click', () => editRule(g, i));
      const rm = el('button', 'mini-btn danger', '✕');
      rm.disabled = isAuto;
      rm.addEventListener('click', () => {
        g.rules.splice(i, 1);
        S.groupDirty = true;
        renderPage();
      });
      act.append(ed, rm);
      head.appendChild(act);
      row.appendChild(head);
      const target = el('span', 'rule-target selectable', r.targetModel);
      target.title = r.targetModel;
      row.appendChild(target);
      const detail = el('span', 'rule-detail', ruleSummary(r));
      detail.title = ruleSummary(r);
      row.appendChild(detail);
      list.appendChild(row);
    });
  }
  body.appendChild(list);

  if (!isAuto) {
    const bar = el('div', 'action-row');
    const bAdd = el('button', 'btn sm btn-pad', '添加规则');
    bAdd.addEventListener('click', () => editRule(g, -1));
    bar.appendChild(bAdd);
    body.appendChild(bar);
  }
  return card;
}

/** 规则条件的可读摘要（只列真正设置过的条件，没设的不出现）。 */
function ruleSummary(r) {
  const bits = [];
  if ((r.minPromptTokens || 0) > 0) bits.push(`输入 ≥ ${fmtNum(r.minPromptTokens)} tokens`);
  if (r.requireImage) bits.push('带图片');
  if (r.compactOnly) bits.push('压缩请求');
  if (r.folders && r.folders.length) bits.push(`目录 ${r.folders.join(' / ')}`);
  if ((r.startMinuteOfDay ?? -1) >= 0 && (r.endMinuteOfDay ?? -1) >= 0) {
    bits.push(`${minToHhmm(r.startMinuteOfDay)}–${minToHhmm(r.endMinuteOfDay)}`);
  }
  if (r.daysOfWeek && r.daysOfWeek.length) {
    bits.push('周' + r.daysOfWeek.map((d) => DAYS.find((x) => x[0] === d)?.[1] || d).join(''));
  }
  return bits.length ? '命中：' + bits.join('，') : '无条件（恒命中，等于把这个成员提到最前）';
}

function minToHhmm(m) {
  const v = Math.max(0, Math.min(1439, Number(m) || 0));
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}
function hhmmToMin(s) {
  const t = String(s || '').trim();
  if (!t) return -1;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;   // null 表示「填了但格式不对」，由调用方报错
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * 添加 / 编辑一条规则。
 *
 * 用一个弹窗而不是行内表单：规则有 7 类条件，行内展开会把整页推得很长，
 * 而编辑规则是低频动作，弹窗的「关闭即放弃」语义也更清楚。
 *
 * 按钮走 `keepOpen` + 自己关：`modal()` 的默认行为是点完就关，
 * 而这里校验失败必须留在原地（否则用户要重填一遍全部条件）。
 */
function editRule(g, index) {
  const editing = index >= 0;
  const r = editing ? { ...g.rules[index] } : {
    targetProviderId: '', targetModel: '', minPromptTokens: 0,
    requireImage: false, compactOnly: false, folders: [],
    startMinuteOfDay: -1, endMinuteOfDay: -1, daysOfWeek: [],
  };
  const provs = (S.state?.providers || []).map((p) => p.id);
  const days = new Set(r.daysOfWeek || []);
  const hasWindow = (r.startMinuteOfDay ?? -1) >= 0 && (r.endMinuteOfDay ?? -1) >= 0;

  const body = `
    <div class="form-grid narrow">
      <div class="field">
        <label>目标供应商</label>
        <select id="ruleProv">
          ${provs.map((p) => `<option value="${esc(p)}"${p === r.targetProviderId ? ' selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>目标模型</label>
        <input type="text" id="ruleModel" value="${esc(r.targetModel)}" placeholder="必须已在成员列表里">
      </div>
    </div>
    <div class="form-sub">命中条件（都留空表示恒命中）</div>
    <div class="form-grid narrow">
      <div class="field">
        <label>输入 ≥ tokens</label>
        <input type="number" id="ruleTokens" min="0" max="999999" value="${r.minPromptTokens || 0}">
      </div>
      <div class="field">
        <label>时段（HH:MM-HH:MM，可跨午夜）</label>
        <input type="text" id="ruleTime" placeholder="留空＝不限"
               value="${hasWindow ? minToHhmm(r.startMinuteOfDay) + '-' + minToHhmm(r.endMinuteOfDay) : ''}">
      </div>
    </div>
    <div class="field mt-12">
      <label>工作目录（前缀匹配，逗号分隔）</label>
      <input type="text" id="ruleFolders" value="${esc((r.folders || []).join(','))}"
             placeholder="~/work/acme, D:/proj/site">
    </div>`;

  // 收集并校验，成功则写回草稿。返回 true 表示可以关窗。
  const collect = () => {
    const providerId = $('#ruleProv').value;
    const model = $('#ruleModel').value.trim();
    if (!providerId || !model) { toast('目标供应商与模型都要填', 'err'); return false; }
    // 规则指向的成员必须真在组里：core 的 orderMembers 找不到成员会静默跳过，
    // 界面上就会出现「存了一条永远不生效的规则」。
    if (!g.members.some((m) => m.providerId === providerId && m.model === model)) {
      toast(`组内没有 ${providerId}/${model}，先把它加成成员`, 'err', 5000);
      return false;
    }
    const timeRaw = $('#ruleTime').value.trim();
    let start = -1;
    let end = -1;
    if (timeRaw) {
      const parts = timeRaw.split('-');
      if (parts.length !== 2) { toast('时段格式应为 HH:MM-HH:MM', 'err'); return false; }
      start = hhmmToMin(parts[0]);
      end = hhmmToMin(parts[1]);
      if (start == null || end == null || start < 0 || end < 0) {
        toast('时段格式应为 HH:MM-HH:MM（24 小时制）', 'err');
        return false;
      }
    }
    const folders = $('#ruleFolders').value.split(',')
      .map((s) => s.trim()).filter((s) => s.length > 0);
    const next = {
      targetProviderId: providerId,
      targetModel: model,
      minPromptTokens: Math.max(0, toIntOr($('#ruleTokens').value, 0)),
      requireImage: !!$('#ruleImg')?.checked,
      compactOnly: !!$('#ruleCompact')?.checked,
      folders,
      startMinuteOfDay: start,
      endMinuteOfDay: end,
      daysOfWeek: [...days].sort((a, b) => a - b),
    };
    if (editing) g.rules[index] = next; else g.rules.push(next);
    S.groupDirty = true;
    return true;
  };

  modal(editing ? '编辑规则' : '添加规则', body, [
    { text: '取消' },
    {
      text: '确定', primary: true, keepOpen: true,
      onClick: () => { if (collect()) { closeModal(); renderPage(); } },
    },
  ]);

  // 开关与星期选择在弹窗打开后插入：需要活节点的事件绑定，innerHTML 做不到
  const bodyEl = $('#modalBody');
  const swRow = el('div', 'action-row tight');
  const mkSwitch = (id, label, checked) => {
    const inp = el('input');
    inp.type = 'checkbox';
    inp.id = id;
    inp.checked = !!checked;
    const sw = el('label', 'switch');
    sw.append(inp, el('span', 'track'), el('span', '', label));
    return sw;
  };
  swRow.append(mkSwitch('ruleImg', '请求带图片', r.requireImage),
    mkSwitch('ruleCompact', '上下文压缩请求', r.compactOnly));
  bodyEl.appendChild(swRow);

  const dayBox = el('div', 'field mt-10');
  dayBox.appendChild(el('label', '', '生效星期（全不选＝每天）'));
  const pick = el('div', 'day-pick');
  DAYS.forEach(([n, ch]) => {
    const chip = el('div', 'day-chip' + (days.has(n) ? ' on' : ''), '周' + ch);
    chip.addEventListener('click', () => {
      if (days.has(n)) days.delete(n); else days.add(n);
      chip.classList.toggle('on');
    });
    pick.appendChild(chip);
  });
  dayBox.appendChild(pick);
  bodyEl.appendChild(dayBox);
}

/** 保存草稿（单组端点：不影响 auto 组与其它组）。 */
async function saveGroupDraft(btn) {
  const g = S.groupDraft;
  const ctx = S.groupCtx;
  if (!g || !ctx) { toast('页面尚未就绪', 'err'); return; }
  const id = ctx.inId.value.trim();
  if (!id) {
    toast('组名不能为空', 'err');
    ctx.inId.focus();
    return;
  }
  if (id.includes('/')) {
    toast('组名不能含斜杠（对外 id 会自动加 group/ 前缀）', 'err');
    ctx.inId.focus();
    return;
  }
  if (id === 'auto') {
    toast('auto 是智能路由页保留的组名，换一个', 'err');
    return;
  }
  if (g.members.length === 0) {
    toast('至少加一个成员，否则这个组对外不可用', 'err');
    return;
  }
  const dup = S.groups.some((x) => x.id === id && x.id !== g.id);
  if (dup) {
    toast(`已存在同名组「${id}」`, 'err');
    return;
  }

  setBtnBusy(btn, true, '保存中…');
  const payload = {
    group: {
      id,
      name: ctx.inName.value.trim(),
      enabled: ctx.cbEnabled.checked,
      strategy: ctx.selStrat.value,
      members: g.members.map((m) => ({
        providerId: m.providerId,
        model: m.model,
        priority: toIntOr(m.priority, 100),
        weight: Math.max(1, toIntOr(m.weight, 1)),
      })),
      rules: g.rules,
    },
  };
  const r = await api.post('/ui/groups/save', payload);
  setBtnBusy(btn, false, '保存组');
  if (r.ok === false) {
    toast('保存失败：' + r.message, 'err', 5000);
    return;
  }
  toast(r.message || '已保存', 'ok');
  S.groupDirty = false;
  await loadGroups();
  // 组名改了：草稿的 id 要跟着改，否则再点保存会新建出第二个组
  if (S.groupDraft) S.groupDraft.id = id;
  S.groupSel = id;
  await loadState();
  if (S.page === 'groups') renderPage();
}

async function removeGroup(g) {
  const yes = await confirmBox('删除路由组',
    `确定删除「${g.displayName}」？客户端再请求 group/${g.id} 会退回按供应商前缀解析。`);
  if (!yes) return;
  const r = await api.post('/ui/groups/delete', { id: g.id });
  if (r.ok === false) { toast('删除失败：' + r.message, 'err', 5000); return; }
  toast(r.message || '已删除', 'ok');
  if (S.groupDraft && S.groupDraft.id === g.id) {
    S.groupDraft = null;
    S.groupSel = null;
  }
  await loadGroups();
  if (S.page === 'groups') renderPage();
}

// ---------------------------------------------------------------- 网关设置页

/**
 * 网关设置。
 *
 * 这一页全是输入控件，所以**永远不允许心跳重建**（见 loadState 里的
 * `page === 'gateway'` 分支）：一次重建就把用户正在敲的端口打回原值。
 * 保存与重启是两个独立动作——端口改动只有重启网关才生效，这一点必须写在状态行里，
 * 否则用户会以为「保存了但没变化 = 功能坏了」。
 */
function renderGateway() {
  const body = $('#pageBody');
  body.innerHTML = '';
  const settings = S.state?.settings || {};

  $('#pageActions').innerHTML = '';

  const card = el('div', 'card');
  card.appendChild(headWith('网关设置', '改动即时生效（端口需重启）'));
  const cb = el('div', 'card-body pad-top');
  const grid = el('div', 'form-grid');

  /** 一行字段：label + 控件 + 可选说明。返回控件本身，便于后面读值。 */
  const field = (label, desc, input) => {
    const f = el('div', 'field');
    f.appendChild(el('label', '', label));
    f.appendChild(input);
    if (desc) f.appendChild(el('span', 'desc', desc));
    grid.appendChild(f);
    return input;
  };

  const portIn = field('监听端口', '客户端接入用的端口，改后需重启网关',
    numInput(settings.port, 8790, 1, 65535));
  const keyIn = field('API Key', '客户端调用时需带的 Key；留空表示不校验',
    textInput(settings.apiKey || '', '留空表示不校验'));
  const providerIn = field('默认供应商', '模型名不带前缀时落到这里',
    textInput(settings.defaultProvider || '', 'trae / codebuddy …'));
  const rotateIn = field('最多换号次数', '单次请求失败最多换几个账号',
    numInput(settings.maxRotate, 3, 0, 20));
  const retentionIn = field('调用记录保留天数', '超期记录每日自动清理',
    numInput(settings.logRetentionDays, 30, 1, 3650));

  cb.appendChild(grid);

  const switches = el('div', 'switch-grid');
  const swField = (label, desc, checked) => {
    const box = el('div', 'field');
    const sw = el('label', 'switch');
    const inp = el('input');
    inp.type = 'checkbox';
    inp.checked = !!checked;
    sw.append(inp, el('span', 'track'));
    sw.appendChild(el('span', '', label));
    box.appendChild(sw);
    if (desc) box.appendChild(el('span', 'desc', desc));
    switches.appendChild(box);
    return inp;
  };

  const allowNoKey = swField('允许无 Key 调用', '关闭后客户端必须带 API Key', settings.allowNoKey);
  const exposeLan = swField('局域网监听', '开启后同网段设备可访问', settings.exposeLan);
  const onlyUsable = swField('只暴露可用模型', '隐藏上游内部条目', settings.onlyUsableModels);
  const verbose = swField('详细日志', '记录请求/响应全文，占用更多存储', settings.verboseLogging);
  const callLog = swField('写入调用记录', '关闭后不再记录每条调用', settings.callLoggingEnabled);

  cb.appendChild(switches);

  const saveRow = el('div', 'action-row');
  const saveBtn = el('button', 'btn primary', '保存设置');
  const status = el('span', 'inline-status');
  const restartBtn = el('button', 'btn', '重启网关');

  saveBtn.addEventListener('click', async () => {
    // 端口单独校验：空值 / NaN 直接拦下，别等后端 coerceIn 静默改成 8790
    const port = parseInt(portIn.value, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      setStatus(status, '端口必须是 1–65535 的整数', 'err');
      return;
    }
    setBtnBusy(saveBtn, true, '保存中…');
    const r = await api.post('/ui/settings', {
      port,
      apiKey: keyIn.value,
      defaultProvider: providerIn.value,
      maxRotate: toIntOr(rotateIn.value, 3),
      logRetentionDays: toIntOr(retentionIn.value, 30),
      allowNoKey: allowNoKey.checked,
      exposeLan: exposeLan.checked,
      onlyUsableModels: onlyUsable.checked,
      verboseLogging: verbose.checked,
      callLoggingEnabled: callLog.checked,
    });
    setBtnBusy(saveBtn, false, '');
    if (r.ok === false) {
      setStatus(status, '保存失败：' + r.message, 'err');
      return;
    }
    setStatus(status, '已保存。端口改动需点「重启网关」才生效', 'ok');
    toast('设置已保存', 'ok');
    await loadState();
  });

  restartBtn.addEventListener('click', async () => {
    setBtnBusy(restartBtn, true, '重启中…');
    setStatus(status, '正在重启网关…', 'muted');
    const stop = await api.post('/ui/gateway/stop', {}, 30000);
    if (stop.ok === false) {
      setBtnBusy(restartBtn, false, '');
      setStatus(status, '停止失败：' + stop.message, 'err');
      return;
    }
    // 等端口真正释放：立刻 start 会撞 TIME_WAIT，表现为「重启后仍是旧端口」
    await new Promise((r) => setTimeout(r, 800));
    const start = await api.post('/ui/gateway/start', {}, 30000);
    setBtnBusy(restartBtn, false, '');
    if (start.ok === false) {
      setStatus(status, '启动失败：' + start.message, 'err');
      return;
    }
    await loadState();
    const cur = (S.state?.settings || {}).port;
    setStatus(status, `网关已重启，当前监听 ${cur}`, 'ok');
    toast('网关已重启', 'ok');
  });

  saveRow.append(saveBtn, restartBtn, status);
  cb.appendChild(saveRow);
  card.appendChild(cb);
  body.appendChild(card);
}

/** 数字输入框：统一 min/max，避免每个字段各写三行。 */
function numInput(value, fallback, min, max) {
  const inp = el('input');
  inp.type = 'number';
  inp.value = value != null ? value : fallback;
  if (min != null) inp.min = String(min);
  if (max != null) inp.max = String(max);
  return inp;
}

function textInput(value, placeholder) {
  const inp = el('input');
  inp.type = 'text';
  inp.value = value || '';
  if (placeholder) inp.placeholder = placeholder;
  return inp;
}

/** parseInt 的兜底版本：NaN / 空串回落到默认值，避免把 null 发给后端。 */
function toIntOr(raw, fallback) {
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------- 客户端密钥

/**
 * 客户端密钥。
 *
 * 密钥本体直接展示（本机单用户工具，界面上要能复制出来）；列表为空时也
 * 不该报错——默认允许无 Key 调用，一个密钥都不建同样能用。
 */
function renderKeys() {
  const body = $('#pageBody');
  body.innerHTML = '';
  const keys = S.state?.clientKeys || [];

  const actions = $('#pageActions');
  actions.innerHTML = '';
  const bAdd = el('button', 'btn primary', '新建密钥');
  bAdd.addEventListener('click', async () => {
    const name = await askInput('新建客户端密钥', '名称（便于区分调用方）', '', '我的笔记本');
    if (!name) return;
    setBtnBusy(bAdd, true, '创建中…');
    const r = await api.post('/ui/keys', { op: 'add', name: name.trim() });
    setBtnBusy(bAdd, false, '');
    if (r.ok === false) {
      toast('创建失败：' + r.message, 'err');
      return;
    }
    toast('已创建，可在列表里复制', 'ok');
    await loadState();
  });
  actions.appendChild(bAdd);

  const card = el('div', 'card');
  card.appendChild(headWith('客户端密钥', `${keys.length} 个`));
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'grid compact');
  table.id = 'tblKeys';
  table.innerHTML = `<thead><tr>
    <th>名称</th><th>密钥</th><th>状态</th><th>创建时间</th><th>操作</th>
  </tr></thead>`;
  const tbody = el('tbody');

  if (keys.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty">
      <span class="big">还没有客户端密钥</span>
      <span>不建也能用：当前允许无 Key 调用，建了则可用于区分调用方</span></div></td></tr>`;
  } else {
    keys.forEach((k) => {
      const tr = el('tr');
      tr.innerHTML = `
        <td>${esc(k.name)}</td>
        <td class="mono selectable">${esc(k.secret || '')}</td>
        <td>${k.enabled ? '<span class="tag ok">启用</span>' : '<span class="tag">停用</span>'}</td>
        <td class="cell-muted">${k.createdAtMillis
          ? new Date(k.createdAtMillis).toLocaleDateString('zh-CN') : '—'}</td>
        <td></td>`;
      const ops = el('div', 'row-ops');
      const copy = el('button', 'mini-btn', '⧉');
      copy.title = '复制密钥';
      copy.addEventListener('click', () => copyText(k.secret));
      const del = el('button', 'mini-btn danger', '✕');
      del.title = '删除密钥';
      del.addEventListener('click', async () => {
        const yes = await confirmBox('删除密钥', `确定删除「${k.name}」？使用该密钥的客户端会立刻失效。`);
        if (!yes) return;
        const r = await api.post('/ui/keys', { op: 'remove', id: k.id });
        toast(r.ok ? '已删除' : '删除失败：' + r.message, r.ok ? 'ok' : 'err');
        await loadState();
      });
      ops.append(copy, del);
      tr.lastElementChild.appendChild(ops);
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  body.appendChild(card);
}

// ---------------------------------------------------------------- 调用记录

/**
 * 调用记录。
 *
 * 首次进入自动加载一次（旧版要手动点「刷新」才看到数据，等于空页劝退）；
 * 之后由用户手动刷新——这张表只读快照，不该跟着 2 秒心跳抖动。
 */
function renderCalls() {
  const body = $('#pageBody');
  body.innerHTML = '';
  const rows = S.calls || [];

  const actions = $('#pageActions');
  actions.innerHTML = '';
  const bRefresh = el('button', 'btn', '刷新');
  bRefresh.addEventListener('click', async () => {
    setBtnBusy(bRefresh, true, '加载中…');
    await loadCalls();
    setBtnBusy(bRefresh, false, '');
    toast(`已加载 ${S.calls.length} 条`, 'ok');
    if (S.page === 'calls') renderPage();
  });
  actions.appendChild(bRefresh);

  if (!S.callsLoaded) {
    S.callsLoaded = true;
    loadCalls().then(() => {
      if (S.page === 'calls') renderPage();
    });
  }

  const card = el('div', 'card');
  card.appendChild(headWith('调用记录', `${rows.length} 条`));
  const wrap = el('div', 'table-wrap');
  // 8 列 / 「模型」列是长路由名（trae/deepseek-v4.1-flash）→ auto 布局实测 722px，
  // 容器 602px，横向溢出 129px（右边「耗时」「尝试」两列看不到）。
  // 固定布局 + 显式列宽，模型列吃余量并按省略号截断；短值表把内边距降到 5px 换宽度。
  const table = el('table', 'grid grid-fixed compact');
  table.id = 'tblCalls';
  table.innerHTML = `<thead><tr>
    <th>时间</th><th>模型</th><th>账号</th><th>状态</th>
    <th class="num">tokens</th><th class="num">首字</th><th class="num">耗时</th><th class="num">尝试</th>
  </tr></thead>`;
  const tbody = el('tbody');
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty">
      <span class="big">暂无调用记录</span>
      <span>客户端发出请求后这里会逐条列出；也可点右上角「刷新」</span></div></td></tr>`;
  } else {
    rows.forEach((r) => {
      const tr = el('tr', 'clickable');
      const kind = r.status === 'SUCCESS' ? 'ok' : r.status === 'ABORTED' ? 'warn' : 'err';
      const stateText = r.status === 'SUCCESS' ? '成功' : r.status === 'ABORTED' ? '中断' : '失败';
      // 请求模型 → 实际模型：auto/组名/大小写别名展开后的真实模型一目了然
      const real = r.upstreamModel || '';
      const modelText = real && real !== r.model ? `${r.model} → ${real}` : r.model;
      tr.innerHTML = `
        <td class="cell-muted">${relTime(r.at)}</td>
        <td class="mono" title="${esc(modelText)}">${esc(modelText)}</td>
        <td>${esc(r.account)}</td>
        <td><span class="tag ${kind}">${stateText}${r.httpStatus ? ' ' + r.httpStatus : ''}</span></td>
        <td class="num">${fmtNum(r.totalTokens)}</td>
        <td class="num">${r.firstByteMillis >= 0 ? r.firstByteMillis + 'ms' : '—'}</td>
        <td class="num">${r.durationMillis}ms</td>
        <td class="num">${r.tries}</td>`;
      tr.addEventListener('click', () => showCallDetail(r));
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  body.appendChild(card);
}

/** 拉调用记录（只在调用记录页使用，其它页不请求）。 */
async function loadCalls() {
  const r = await api.get('/ui/calls', { limit: 200 });
  S.calls = r.ok === false ? [] : (r.records || []);
}

/** 调用详情：请求体/响应正文/上游原文三段原样展示，便于对照排查。 */
function showCallDetail(r) {
  const rows = [
    ['请求模型', `<span class="mono">${esc(r.model)}</span>`],
    ['实际模型', `<span class="mono">${esc(r.upstreamModel || '（旧记录未记）')}</span>`],
    ['账号', `${esc(r.providerId)} / ${esc(r.account)}`],
    ['状态', `${esc(r.status)}${r.httpStatus ? ' · HTTP ' + r.httpStatus : ''}`],
    ['Tokens', `输入 ${fmtNum(r.promptTokens)} · 输出 ${fmtNum(r.completionTokens)} · 合计 ${fmtNum(r.totalTokens)}`],
    ['首字延迟', r.firstByteMillis >= 0 ? r.firstByteMillis + ' ms' : '未产生'],
    ['总耗时', `${r.durationMillis} ms（尝试 ${r.tries} 次）`],
  ];
  if (r.error) rows.push(['错误', `<span class="text-err">${esc(r.error)}</span>`]);

  const kv = rows.map(([k, v]) =>
    `<span class="kv-key">${k}</span><span class="kv-val">${v}</span>`).join('');
  const blocks = [
    ['请求体', r.requestBody],
    ['响应正文', r.responseBody],
    ['上游原文', r.rawResponse],
  ].map(([label, text]) => `
    <div class="field">
      <label>${label}</label>
      <pre>${esc(text || '（空）')}</pre>
    </div>`).join('');

  modal('调用详情', `<div class="kv-grid">${kv}</div>${blocks}`, [{ text: '关闭', primary: true }]);
}

// ---------------------------------------------------------------- 高级策略

/** 账号策略枚举 → 中文 + 一行解释（解释必须说明「什么时候该用」，不是复述枚举名）。 */
const STRATEGIES = {
  SMART: ['智能（默认）', '优先级优先，同级按余额。日常推荐'],
  ORDER: ['严格按优先级', '优先级再按 uid 字典序，顺序稳定不随机'],
  ROTATE: ['轮询', '请求级游标依次推进，均摊负载'],
  USAGE: ['余额最多先用', '适合多个号额度都很大、想先用掉大的'],
  PACE: ['到期前用完', '剩余额度 ÷ 距重置小时数，最大者优先，少让额度作废'],
};

/**
 * 高级策略。
 *
 * 这些全是 core 早就实现、但旧界面从来没有入口的能力：策略枚举能在 core 里选中，
 * 却只能改 `settings/failover.json` 才生效。这里做成可读可写的一页。
 *
 * **这一页绝不能被心跳重建**：全是输入框，重建一次就把用户输到一半的数值打回原值。
 * 心跳只调 [paintStrategyStatus]（重画右下角「运行现状」，不碰任何输入控件）。
 */
function renderStrategy() {
  const body = $('#pageBody');
  body.innerHTML = '';
  const st = S.strategy;
  if (!st) {
    body.innerHTML = `<div class="empty"><span class="big">策略数据加载中</span>
      <span>正在读取 settings/failover.json</span></div>`;
    // 首次进入是异步的：拉到之后必须主动重画一次，否则会一直停在「加载中」
    loadStrategy().then(() => {
      if (S.page === 'strategy' && S.strategy) renderPage();
    });
    return;
  }
  const fo = st.failover || {};

  const actions = $('#pageActions');
  actions.innerHTML = '';
  const bSave = el('button', 'btn primary', '保存策略');
  bSave.id = 'btnSaveStrategy';
  bSave.addEventListener('click', () => saveStrategy(bSave));
  actions.appendChild(bSave);

  // 三张卡的控件句柄集中在 S.strategyCtx：保存时要读十几个输入框，
  // 靠闭包一层层往外传会让 renderStrategy 变成一棵难以追踪的表达式树。
  const acc = buildAccountStrategyCard(fo);
  const par = buildFailoverParamsCard(fo);
  const sec = buildSecurityCard(st);
  const statusCard = buildStrategyStatusCard();
  S.strategyCtx = {
    cbFo: acc.cbFo,
    selStrategy: acc.selStrategy,
    inCooldown: acc.inCooldown,
    inAttempts: par.inAttempts,
    inBackoff: par.inBackoff,
    inMaxBackoff: par.inMaxBackoff,
    inMultiplier: par.inMultiplier,
    inJitter: par.inJitter,
    inThreshold: par.inThreshold,
    inOpenMs: par.inOpenMs,
    inHalfOpen: par.inHalfOpen,
    inPerAccount: par.inPerAccount,
    inGlobal: par.inGlobal,
    inQueue: par.inQueue,
    inMcMs: par.inMcMs,
    inMcMax: par.inMcMax,
    cbSanitize: sec.cbSanitize,
    cbPrivacy: sec.cbPrivacy,
    inMinInterval: sec.inMinInterval,
    inJitterMs: sec.inJitterMs,
  };
  body.appendChild(acc.card);
  body.appendChild(par.card);
  body.appendChild(sec.card);
  body.appendChild(statusCard);

  paintStrategyStatus();
}

/** 卡片骨架：head + body（body 统一 12px 上内边距，避免每张卡各写一遍）。 */
function formCard(title, hint) {
  const card = el('div', 'card');
  card.appendChild(headWith(title, hint));
  const bodyEl = el('div', 'card-body pad-top');
  card.appendChild(bodyEl);
  return { card, body: bodyEl };
}

function buildAccountStrategyCard(fo) {
  const { card, body } = formCard('账号选择策略', '决定一次请求先试哪个账号');
  const grid = el('div', 'form-grid');

  // ---- 策略下拉 + 随选随变的说明
  const selStrategy = el('select');
  Object.entries(STRATEGIES).forEach(([k, [name]]) => {
    const o = el('option', '', name);
    o.value = k;
    if (k === fo.accountStrategy) o.selected = true;
    selStrategy.appendChild(o);
  });
  const descStrategy = el('span', 'desc', strategyDesc(fo.accountStrategy));
  selStrategy.addEventListener('change', () => {
    descStrategy.textContent = strategyDesc(selStrategy.value);
  });
  grid.appendChild(labelField('选用哪个账号', selStrategy, descStrategy));

  // ---- 报错账号冷却
  const inCooldown = numInput(fo.accountCooldownMs, 15000, 0, 600000);
  grid.appendChild(labelField('报错账号冷却（毫秒）', inCooldown,
    el('span', 'desc', '刚报错的账号短期跳过，避免连续撞同一个墙；0 表示不冷却')));

  // ---- 故障转移总开关
  const cbFo = el('input');
  cbFo.type = 'checkbox';
  cbFo.checked = fo.enabled !== false;
  const swFo = el('label', 'switch');
  swFo.append(cbFo, el('span', 'track'), el('span', '', '启用'));
  grid.appendChild(labelField('故障转移总开关', swFo,
    el('span', 'desc', '关闭后单供应商内仍重试，但不再跨供应商换家')));

  body.appendChild(grid);
  return { card, body, cbFo, selStrategy, inCooldown };
}

function buildFailoverParamsCard(fo) {
  const { card, body } = formCard('故障转移参数', '改动即时写入 settings/failover.json');
  const grid = el('div', 'form-grid narrow');
  const retry = fo.retry || {};
  const cbk = fo.circuitBreaker || {};
  const cc = fo.concurrency || {};
  const mc = fo.modelCooldown || {};

  const num = (label, desc, value, min, max, step) => {
    const inp = numInput(value, null, min, max);
    if (step != null) inp.step = String(step);
    grid.appendChild(labelField(label, inp, el('span', 'desc', desc)));
    return inp;
  };

  const inAttempts = num('单供应商最大尝试', '含首次请求，1–10', retry.maxAttempts, 1, 10, 1);
  const inBackoff = num('初始退避（毫秒）', '第 2 次尝试前等待', retry.initialBackoffMs, 0, 10000, 50);
  const inMaxBackoff = num('退避上限（毫秒）', '指数增长截断在此值', retry.maxBackoffMs, 0, 60000, 100);
  const inMultiplier = num('退避倍数', '每次翻几倍，1–5', retry.backoffMultiplier, 1, 5, 0.1);
  const inJitter = num('抖动比例', '±比例随机化，避免同刻雪崩，0–1', retry.jitterRatio, 0, 1, 0.05);
  const inThreshold = num('熔断失败阈值', '连续失败几次断开该供应商，1–100', cbk.failureThreshold, 1, 100, 1);
  const inOpenMs = num('熔断静默（毫秒）', '断开多久后放探针', cbk.openDurationMs, 1000, 3600000, 1000);
  const inHalfOpen = num('半开成功次数', '探针连续成功几次才恢复，1–10', cbk.halfOpenSuccessCount, 1, 10, 1);
  const inPerAccount = num('单账号在途上限', '0 不限；默认 1 因为上游按账号限流并发流', cc.maxPerAccount, 0, 20, 1);
  const inGlobal = num('全网关在途上限', '0 不限', cc.maxGlobal, 0, 100, 1);
  const inQueue = num('排队超时（毫秒）', '许可被占满时最多等多久，超时按 429 拒绝', cc.queueTimeoutMs, 0, 120000, 1000);
  const inMcMs = num('模型级冷却（毫秒）', '「该模型已超限」后跳过该模型的时长', mc.cooldownMs, 1000, 7200000, 1000);
  const inMcMax = num('冷却上限（毫秒）', '避免误判出超长冷却', mc.maxCooldownMs, 1000, 7200000, 1000);

  body.appendChild(grid);
  return { card, body, inAttempts, inBackoff, inMaxBackoff, inMultiplier, inJitter,
    inThreshold, inOpenMs, inHalfOpen, inPerAccount, inGlobal, inQueue, inMcMs, inMcMax };
}

/**
 * 安全防护卡。
 *
 * core 早就实现了一整套（敏感词零宽脱敏 / 账号级限速 / 本地隐私占位符），
 * 但界面从来没有入口，只能手改 `settings/security.json`。
 * 三个开关的含义差别很大，说明文字必须写「代价是什么」，不能只复述开关名。
 */
function buildSecurityCard(st) {
  const { card, body } = formCard('安全防护', '改动即时写入 settings/security.json');
  const grid = el('div', 'form-grid');
  const sec = st.security || {};

  const cbSanitize = el('input');
  cbSanitize.type = 'checkbox';
  cbSanitize.checked = !!sec.sanitizeEnabled;
  const swSanitize = el('label', 'switch');
  swSanitize.append(cbSanitize, el('span', 'track'), el('span', '', '启用'));
  grid.appendChild(labelField('敏感词零宽脱敏', swSanitize,
    el('span', 'desc', '只改 system 消息里的敏感词（插零宽空格），不动 user 输入')));

  const cbPrivacy = el('input');
  cbPrivacy.type = 'checkbox';
  cbPrivacy.checked = !!sec.privacyRedactionEnabled;
  const swPrivacy = el('label', 'switch');
  swPrivacy.append(cbPrivacy, el('span', 'track'), el('span', '', '启用'));
  grid.appendChild(labelField('本地隐私脱敏', swPrivacy,
    el('span', 'desc', 'Key / 邮箱出网前换成占位符，响应回来再还原；上游看到的是记号')));

  const inMinInterval = numInput(sec.minIntervalMillis || 0, 0, 0, 60000);
  grid.appendChild(labelField('账号限速间隔（毫秒）', inMinInterval,
    el('span', 'desc', '两次上游调用的最短间隔；0 不限，开启会明显拖慢首字')));

  const inJitterMs = numInput(sec.jitterMillis || 0, 0, 0, 10000);
  grid.appendChild(labelField('节拍抖动（毫秒）', inJitterMs,
    el('span', 'desc', '在间隔上叠加 0–该值的随机，避免固定节奏被风控打标')));

  if ((sec.extraWordsCount || 0) > 0) {
    grid.appendChild(labelField('自定义敏感词', el('span', 'tag', `${sec.extraWordsCount} 条`),
      el('span', 'desc', '词表在 settings/security.json 里编辑，本页只读')));
  }

  body.appendChild(grid);
  return { card, body, cbSanitize, cbPrivacy, inMinInterval, inJitterMs };
}

function buildStrategyStatusCard() {
  const card = el('div', 'card');
  card.appendChild(headWith('运行现状', '仅内存态，重启即清空'));
  const bodyEl = el('div', 'card-body pad-top status-stack');
  bodyEl.id = 'strategyStatus';
  card.appendChild(bodyEl);
  return card;
}

/** label + 控件 + 说明，三件套成组（每个字段都要写，抽出来省掉 3 行/字段）。 */
function labelField(label, input, desc) {
  const f = el('div', 'field');
  f.appendChild(el('label', '', label));
  f.appendChild(input);
  if (desc) f.appendChild(desc);
  return f;
}

function strategyDesc(key) {
  return (STRATEGIES[key] || [])[1] || '';
}

/**
 * 保存策略。
 *
 * 数值全部走 [toNumOr]：输入框留空 / 输入非数字时 `parseInt` 得到 NaN，
 * 直接发给后端会被 coerceIn 静默改成一个意外值。这里统一回落「当前值」，
 * 并明确告诉用户哪个字段没填。
 */
async function saveStrategy(btn) {
  const need = (node, label, isFloat) => {
    const v = isFloat ? parseFloat(node.value) : parseInt(node.value, 10);
    if (!Number.isFinite(v)) throw new Error(`${label} 不是有效数字`);
    return v;
  };

  let payload;
  try {
    const ctx = S.strategyCtx;
    if (!ctx) throw new Error('页面尚未就绪，请稍后重试');
    payload = {
      enabled: ctx.cbFo.checked,
      accountStrategy: ctx.selStrategy.value,
      accountCooldownMs: need(ctx.inCooldown, '报错账号冷却'),
      retry: {
        maxAttempts: need(ctx.inAttempts, '单供应商最大尝试'),
        initialBackoffMs: need(ctx.inBackoff, '初始退避'),
        maxBackoffMs: need(ctx.inMaxBackoff, '退避上限'),
        backoffMultiplier: need(ctx.inMultiplier, '退避倍数', true),
        jitterRatio: need(ctx.inJitter, '抖动比例', true),
      },
      circuitBreaker: {
        failureThreshold: need(ctx.inThreshold, '熔断失败阈值'),
        openDurationMs: need(ctx.inOpenMs, '熔断静默'),
        halfOpenSuccessCount: need(ctx.inHalfOpen, '半开成功次数'),
      },
      concurrency: {
        maxPerAccount: need(ctx.inPerAccount, '单账号在途上限'),
        maxGlobal: need(ctx.inGlobal, '全网关在途上限'),
        queueTimeoutMs: need(ctx.inQueue, '排队超时'),
      },
      modelCooldown: {
        cooldownMs: need(ctx.inMcMs, '模型级冷却'),
        maxCooldownMs: need(ctx.inMcMax, '冷却上限'),
      },
      security: {
        sanitizeEnabled: ctx.cbSanitize.checked,
        privacyRedactionEnabled: ctx.cbPrivacy.checked,
        minIntervalMillis: need(ctx.inMinInterval, '账号限速间隔'),
        jitterMillis: need(ctx.inJitterMs, '节拍抖动'),
      },
    };
  } catch (e) {
    toast('保存失败：' + e.message, 'err', 5000);
    return;
  }

  setBtnBusy(btn, true, '保存中…');
  const r = await api.post('/ui/strategy/save', payload);
  setBtnBusy(btn, false, '');
  if (r.ok === false) {
    toast('保存失败：' + r.message, 'err', 5000);
    return;
  }
  S.strategy = r.strategy || S.strategy;
  toast('策略已保存（即时生效）', 'ok');
  await loadState();
  if (S.page === 'strategy') paintStrategyStatus();
}

/**
 * 拉一次策略快照。
 *
 * **绝不在这个函数里 renderPage()**：这一页全是输入框，每 2 秒重建会把用户
 * 正在编辑的数值打回原值（旧 Swing 界面就栽在同类问题上）。
 */
async function loadStrategy() {
  const r = await api.get('/ui/strategy');
  if (r.ok === false) return;
  S.strategy = r;
  if (S.page === 'strategy') paintStrategyStatus();
}

/** 只重画「运行现状」：熔断、冷却、亲和条数。输入控件不受影响。 */
function paintStrategyStatus() {
  const box = document.getElementById('strategyStatus');
  if (!box || !S.strategy) return;
  const st = S.strategy;
  box.innerHTML = '';

  // ---- 会话亲和
  const affSize = (st.affinity || {}).size || 0;
  const rowAff = el('div', 'status-row');
  rowAff.appendChild(el('span', '', `会话亲和表：${affSize} 条绑定`));
  rowAff.appendChild(el('span', 'desc', '同一会话优先落回上次作答的账号，保住上游提示词缓存'));
  const bAffinity = el('button', 'btn sm', '清空亲和');
  bAffinity.addEventListener('click', async () => {
    setBtnBusy(bAffinity, true, '清空中…');
    const r = await api.post('/ui/affinity/clear', {});
    setBtnBusy(bAffinity, false, '');
    toast(r.message || (r.ok ? '已清空' : '清空失败'), r.ok === false ? 'err' : 'ok');
    loadStrategy();
  });
  rowAff.appendChild(bAffinity);
  box.appendChild(rowAff);

  // ---- 熔断现状（只列非 CLOSED 的，避免 11 家全列占版面）
  const breakers = st.breakers || [];
  if (breakers.length === 0) {
    box.appendChild(el('span', 'desc', '熔断状态：全部供应商正常（CLOSED）'));
  } else {
    const row = el('div', 'status-row wrap');
    row.appendChild(el('span', '', '熔断中：'));
    breakers.forEach((b) => {
      row.appendChild(el('span', 'tag ' + (b.state === 'OPEN' ? 'err' : 'warn'),
        `${b.name} ${b.state}`));
    });
    box.appendChild(row);
  }

  // ---- 模型级冷却
  const cooling = st.cooling || [];
  if (cooling.length === 0) {
    box.appendChild(el('span', 'desc', '模型级冷却：无（没有模型被判超限）'));
    return;
  }
  const row = el('div', 'status-row wrap');
  row.appendChild(el('span', '', '模型冷却中：'));
  cooling.forEach((c) => {
    row.appendChild(el('span', 'tag warn',
      `${c.key.split('|').pop()} ${Math.round(c.remainingMs / 1000)}s`));
  });
  const bCool = el('button', 'btn sm', '全部解除');
  bCool.addEventListener('click', async () => {
    setBtnBusy(bCool, true, '解除中…');
    const r = await api.post('/ui/cooling/clear', {});
    setBtnBusy(bCool, false, '');
    toast(r.message || (r.ok ? '已清空' : '清空失败'), r.ok === false ? 'err' : 'ok');
    loadStrategy();
  });
  row.appendChild(bCool);
  box.appendChild(row);
}

// ---------------------------------------------------------------- 媒体实测

/**
 * 媒体实测：图片生成 + 语音转写。
 *
 * 两条链路都**走真实网关**（`/v1/images/generations`、`/v1/audio/transcriptions`），
 * 所以界面上看到的结果就是客户端会拿到的结果——不会出现「界面能出图、客户端报错」。
 *
 * 页面状态放在 `S.media` 而不是闭包里：切页走一圈回来，上一次的提示词与结果还在。
 */
function renderMedia() {
  const body = $('#pageBody');
  body.innerHTML = '';
  $('#pageActions').innerHTML = '';
  if (!S.media) S.media = {};

  // 出图能力的空态归因要用到 S.custom（判断「自定义供应商有没有填图像模型」），
  // 而 S.custom 只在供应商页加载。不在这里补一次的话，直接进媒体页时它会恒为空，
  // 空态永远落到「内置供应商」那句 —— 用户明明有自定义供应商，却被告知「没有图像供应商」。
  if (!S.customLoaded) {
    loadCustomProviders().then(() => {
      if (S.page === 'media') renderPage();
    });
  }

  body.appendChild(buildImageCard());
  body.appendChild(buildTranscribeCard());
}

function buildImageCard() {
  const card = el('div', 'card');
  card.appendChild(headWith('图片生成', 'POST /v1/images/generations · 走真实网关链路'));
  const bodyEl = el('div', 'card-body pad-top stack-12');

  const row = el('div', 'form-grid media-grid');
  const inModel = textInput(S.media.imageModel || '', '留空自动选');
  row.appendChild(labelField('模型（留空由网关自选）', inModel,
    el('span', 'desc', '不带前缀时网关按「默认供应商」解析')));
  const inN = numInput(S.media.imageN || 1, 1, 1, 4);
  row.appendChild(labelField('张数', inN, null));
  const inSize = textInput(S.media.imageSize || '', '留空用默认');
  row.appendChild(labelField('尺寸', inSize, null));
  bodyEl.appendChild(row);

  const taPrompt = el('textarea');
  taPrompt.rows = 3;
  taPrompt.value = S.media.imagePrompt || '';
  taPrompt.placeholder = '描述要生成的画面';
  bodyEl.appendChild(labelField('提示词', taPrompt, null));

  const rowB = el('div', 'action-row tight');
  const bGen = el('button', 'btn primary', '生成');
  const imgStatus = el('span', 'inline-status');
  bGen.addEventListener('click', async () => {
    const prompt = taPrompt.value.trim();
    if (!prompt) { toast('先写提示词', 'err'); return; }
    S.media.imageModel = inModel.value;
    S.media.imageN = toIntOr(inN.value, 1);
    S.media.imageSize = inSize.value;
    S.media.imagePrompt = prompt;
    setBtnBusy(bGen, true, '生成中…');
    setStatus(imgStatus, '生成中…（上游出图通常 10–60 秒）', 'muted');
    const r = await api.post('/ui/media/image', {
      model: inModel.value.trim(),
      prompt,
      n: S.media.imageN,
      size: inSize.value.trim(),
    }, 200000);
    setBtnBusy(bGen, false, '');
    if (r.ok === false) {
      S.media.images = [];
      setStatus(imgStatus, '失败：' + (r.message || '未知错误'), 'err');
    } else {
      S.media.images = r.images || [];
      setStatus(imgStatus, `出图 ${r.count} 张，耗时 ${(r.elapsedMs / 1000).toFixed(1)} 秒`, 'ok');
    }
    renderPage();
  });
  rowB.append(bGen, imgStatus);
  bodyEl.appendChild(rowB);

  const gallery = el('div', 'media-gallery');
  const imgs = S.media.images || [];
  if (imgs.length === 0) {
    gallery.appendChild(el('span', 'desc', '还没有结果'));
  } else {
    imgs.forEach((im) => {
      const box = el('div', 'thumb');
      const pic = el('img');
      pic.src = im.dataUrl;
      pic.alt = '生成的图片';
      box.appendChild(pic);
      gallery.appendChild(box);
    });
  }
  bodyEl.appendChild(gallery);

  // 能力提示：从快照里数，比「点一次才知道 400」有用
  const provs = S.state?.providers || [];
  const imgProv = provs.filter((p) => p.image && p.accountCount > 0);
  const audProv = provs.filter((p) => p.audio && p.accountCount > 0);
  const hint = el('div', 'hint-stack');
  if (imgProv.length > 0) {
    hint.appendChild(el('span', '', `图像供应商：${imgProv.map((p) => p.name).join('、')}`));
  } else {
    // 空态的归因要分两句：内置供应商没能力是一回事，自定义供应商没填图像模型是另一回事。
    // 混成一句「没有已登录账号声明了图像能力」时，用户会去账号页翻，而问题在配置里。
    const customs = (S.custom || []).filter((c) => c.accountCount > 0);
    const customNoImage = customs.filter((c) => !c.supportsImage);
    const names = customNoImage.map((c) => c.name || c.key).join('、');
    hint.appendChild(el('span', '',
      customNoImage.length > 0
        ? `图像供应商：无（自定义供应商「${names}」没有填图像模型；到供应商页编辑它，在「图像模型」里填一个真实模型名即可出图）`
        : '图像供应商：无（内置供应商里没有已登录账号声明了图像能力，点生成会返回 400）'));
  }
  hint.appendChild(el('span', '',
    audProv.length > 0
      ? `转写供应商：${audProv.map((p) => p.name).join('、')}`
      : '转写供应商：无（内置供应商都不支持 audio/transcriptions，需自定义供应商）'));
  bodyEl.appendChild(hint);

  card.appendChild(bodyEl);
  return card;
}

function buildTranscribeCard() {
  const card = el('div', 'card');
  card.appendChild(headWith('语音转写', 'POST /v1/audio/transcriptions · multipart 真实转发'));
  const bodyEl = el('div', 'card-body pad-top stack-12');

  const row = el('div', 'form-grid media-grid');
  const inFile = el('input');
  inFile.type = 'file';
  inFile.accept = 'audio/*';
  row.appendChild(labelField('音频文件', inFile, null));
  const inTModel = textInput(S.media.transcribeModel || '', '留空自动选');
  row.appendChild(labelField('模型', inTModel, null));
  const inLang = textInput(S.media.language || 'zh', 'zh / en，可留空');
  row.appendChild(labelField('语言', inLang, null));
  bodyEl.appendChild(row);

  const rowD = el('div', 'action-row tight');
  const bTr = el('button', 'btn primary', '转写');
  const trStatus = el('span', 'inline-status');
  bTr.addEventListener('click', async () => {
    const file = inFile.files && inFile.files[0];
    if (!file) { toast('先选一个音频文件', 'err'); return; }
    // 前端先卡一道体积：base64 会把内容放大约 4/3，服务端上限 40MB（约合 30MB 原始文件）。
    // 不拦的话要等几十秒上传完才收到 413，用户只会觉得「点了没反应」。
    if (file.size > MAX_AUDIO_BYTES) {
      toast(`音频 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_AUDIO_BYTES / 1024 / 1024} MB 上限`,
        'err', 6000);
      return;
    }
    S.media.transcribeModel = inTModel.value;
    S.media.language = inLang.value;

    setBtnBusy(bTr, true, '转写中…');
    setStatus(trStatus, `读取 ${file.name}（${(file.size / 1024).toFixed(0)} KB）…`, 'muted');
    let b64;
    try {
      b64 = await readFileAsBase64(file);
    } catch (e) {
      setBtnBusy(bTr, false, '');
      setStatus(trStatus, '读取文件失败：' + (e && e.message ? e.message : e), 'err');
      return;
    }
    const r = await api.post('/ui/media/transcribe', {
      base64: b64,
      fileName: file.name,
      mimeType: file.type || '',
      model: inTModel.value.trim(),
      language: inLang.value.trim(),
    }, 200000);
    setBtnBusy(bTr, false, '');
    if (r.ok === false) {
      S.media.text = null;
      setStatus(trStatus, '失败：' + (r.message || '未知错误'), 'err');
    } else {
      S.media.text = r.text;
      setStatus(trStatus, `完成，${r.text.length} 字，耗时 ${(r.elapsedMs / 1000).toFixed(1)} 秒`, 'ok');
    }
    renderPage();
  });
  rowD.append(bTr, trStatus);
  bodyEl.appendChild(rowD);

  const out = el('pre', 'transcript');
  out.textContent = S.media.text || '（转写结果会显示在这里）';
  if (!S.media.text) out.classList.add('empty-text');
  out.classList.add('selectable');
  bodyEl.appendChild(out);

  const audProv = (S.state?.providers || []).filter((p) => p.audio && p.accountCount > 0);
  if (audProv.length === 0) {
    bodyEl.appendChild(el('span', 'desc',
      '当前没有可用转写供应商：内置供应商都不支持 audio/transcriptions，'
      + '需先在「供应商」页导入一个自定义供应商并填好凭证。'));
  }

  card.appendChild(bodyEl);
  return card;
}

/**
 * 读文件成 base64（去掉 data URL 前缀）。
 *
 * WebView2 里拿不到真实文件路径，只能把内容读出来传给后端重建 multipart。
 * 用 `FileReader.readAsDataURL` 而不是 `readAsArrayBuffer` + 手工转 base64：
 * 后者在几十 MB 音频上会把主线程卡住好几秒。
 */
/** 原始音频上限：base64 之后不超过服务端的 40MB 请求体上限。 */
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const comma = s.indexOf(',');
      if (comma < 0) { reject(new Error('无法读取文件内容')); return; }
      resolve(s.substring(comma + 1));
    };
    fr.onerror = () => reject(fr.error || new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------- 备份与恢复

/**
 * 备份与恢复。
 *
 * 这一页只做两件事：让用户拿到一份可回滚的快照；让用户知道"恢复还没生效"。
 * 恢复是两段式的——点了之后只登记，真正的替换发生在下次进程启动
 * （旧进程正持有 secure/ 下的文件句柄，边跑边替换会读到半个账号池）。
 * 界面必须把这件事说清楚，否则用户点完发现"什么都没变"，会以为功能坏了。
 */
async function loadBackup() {
  const r = await api.get('/ui/backup');
  if (!r || r.ok === false) {
    S.backupList = null;
    S.backupLoaded = true;
    return;
  }
  S.backupList = r;
  S.backupLoaded = true;
}

function renderBackup() {
  const body = $('#pageBody');
  body.innerHTML = '';

  if (!S.backupLoaded) {
    S.backupLoaded = true;
    body.innerHTML = `<div class="empty"><span class="big">正在读取备份目录</span>
      <span>扫描 &lt;数据目录&gt;/../backups</span></div>`;
    loadBackup().then(() => {
      if (S.page === 'backup') renderPage();
    });
    return;
  }

  const d = S.backupList;
  if (!d) {
    body.innerHTML = `<div class="empty"><span class="big">读不到备份目录</span>
      <span>管理面接口未响应，稍后重试或看运行日志</span></div>`;
    return;
  }

  const actions = $('#pageActions');
  actions.innerHTML = '';
  const bNew = el('button', 'btn primary', '立即备份');
  bNew.id = 'btnBackupNow';
  bNew.addEventListener('click', () => createBackup(bNew));
  actions.appendChild(bNew);

  // ---- 待恢复提示：必须排在最上面，否则用户会以为"已经恢复了"
  const pending = d.pending;
  if (pending) {
    const card = el('div', 'card card-alert');
    card.appendChild(headWith('有一次恢复等待生效', '重启应用后执行'));
    const b = el('div', 'card-body pad-top');
    b.appendChild(el('p', 'desc', `待恢复：${pending.name}（登记于 ${new Date(pending.requestedAtMillis).toLocaleString('zh-CN')}）`));
    if (!pending.available) {
      b.appendChild(el('p', 'desc err-text',
        '备份文件已不存在（可能被移动或删除），重启时会自动跳过。可以先取消，再重新挑一份。'));
    } else {
      b.appendChild(el('p', 'desc',
        '重启时先把当前数据整体快照一份（回滚点），再替换白名单内的条目。'
        + 'webview2 缓存与调用记录的取舍以备份时的选择为准。'));
    }
    const row = el('div', 'action-row');
    const cancel = el('button', 'btn', '取消这次恢复');
    cancel.addEventListener('click', async () => {
      setBtnBusy(cancel, true, '取消中…');
      const r = await api.post('/ui/backup/cancel', {});
      setBtnBusy(cancel, false, '');
      toast(r.ok ? '已取消' : '取消失败：' + r.message, r.ok ? 'ok' : 'err');
      if (r.ok) { await loadBackup(); if (S.page === 'backup') renderPage(); }
    });
    row.appendChild(cancel);
    b.appendChild(row);
    card.appendChild(b);
    body.appendChild(card);
  }

  // ---- 上次恢复结果：失败必须显式可见（静默失败是最坏的结果）
  const last = d.lastRestore;
  if (last) {
    const card = el('div', 'card');
    card.appendChild(headWith('上次恢复', new Date(last.atMillis).toLocaleString('zh-CN')));
    const b = el('div', 'card-body pad-top');
    const p = el('p', last.failed ? 'desc err-text' : 'desc', last.message || '');
    b.appendChild(p);
    if (last.rollback) b.appendChild(el('p', 'desc', `回滚包：${last.rollback}（在下面的列表里，可直接恢复回去）`));
    card.appendChild(b);
    body.appendChild(card);
  }

  // ---- 备份列表
  const items = d.items || [];
  const card = el('div', 'card');
  card.appendChild(headWith('备份列表', `${items.length} 份 · ${d.dir}`));
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'grid grid-fixed compact');
  table.id = 'tblBackup';
  // 5 列、内容区 602px：时间 96 / 大小 66 / 条目 44 / 版本 52 / 操作 余量。
  // 列宽按最长真实值量（「11-20 00:22」≈ 76、「2.4 MB」= 46、「0.9.9」= 34），
  // 留出内边距后加起来约 258，剩下的全给操作列——两个按钮在 90px 里放得下。
  table.innerHTML = `<thead><tr>
    <th style="width:96px">创建时间</th><th style="width:66px">体积</th>
    <th class="num" style="width:44px">条目</th><th style="width:52px">版本</th>
    <th style="width:96px">操作</th>
  </tr></thead>`;
  const tbody = el('tbody');
  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty">
      <span class="big">还没有备份</span>
      <span>点右上角「立即备份」，会在数据目录旁边生成一份 .zip（含 master.key，否则密文解不开）</span></div></td></tr>`;
  } else {
    items.forEach((it) => {
      const tr = el('tr');
      // 时间列用 atMillis 格式化，不用文件名里的时间戳：
      // `20261120-001822` 这种紧凑串扫一眼读不出来，而这里本来就排了序、
      // 只差"这是哪一天几点"这一个信息。
      const when = new Date(it.atMillis);
      const p2 = (x) => String(x).padStart(2, '0');
      const whenText = `${p2(when.getMonth() + 1)}-${p2(when.getDate())} `
        + `${p2(when.getHours())}:${p2(when.getMinutes())}`;
      tr.innerHTML = `
        <td class="cell-muted mono">${esc(whenText)}</td>
        <td class="cell-muted">${esc(it.sizeText || '—')}</td>
        <td class="num cell-muted">${it.entryCount || 0}</td>
        <td class="cell-muted">${esc(it.appVersion || '—')}</td>
        <td></td>`;
      tr.title = it.name + (it.includeCallLogs ? '' : '\n（不含调用记录）');
      const ops = el('div', 'row-ops');
      const restore = el('button', 'mini-btn wide', '恢复');
      restore.title = '把数据替换成这份备份（重启后生效）';
      restore.addEventListener('click', () => requestRestore(it.name));
      const del = el('button', 'mini-btn danger', '✕');
      del.title = '删除这份备份';
      del.addEventListener('click', async () => {
        const yes = await confirmBox('删除备份', `确定删除 ${it.name}？删掉后这份回滚点就没了。`);
        if (!yes) return;
        const r = await api.post('/ui/backup/delete', { name: it.name });
        toast(r.ok ? '已删除' : '删除失败：' + r.message, r.ok ? 'ok' : 'err');
        if (r.ok) { await loadBackup(); if (S.page === 'backup') renderPage(); }
      });
      ops.append(restore, del);
      tr.lastElementChild.appendChild(ops);
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  body.appendChild(card);

  // ---- 说明卡：范围与位置必须写出来，否则用户不知道"备份到底带走了什么"
  const info = el('div', 'card');
  info.appendChild(headWith('备份范围', '白名单制，不是整目录打包'));
  const ib = el('div', 'card-body pad-top stack-12');
  ib.appendChild(el('p', 'desc',
    `存放目录：${d.dir}（在数据目录之外——放在里面的话「先清空再解压」会把备份自己删掉）`));
  ib.appendChild(el('p', 'desc mono selectable', (d.scope || []).join(' · ')));
  ib.appendChild(el('p', 'desc',
    '不含 webview2/（Chromium 缓存，约 80 MB，与本项目数据无关）、.instance.json（写死旧端口）、'
    + '.update-cache.json。调用记录默认带上；关掉后包会小一半，但恢复后「调用记录」页是空的。'));
  ib.appendChild(el('p', 'desc',
    '恢复会先把当前数据整体快照一份（回滚包），再替换上面这些条目；'
    + '回滚包同样出现在列表里，恢复错了可以直接回退。'));
  info.appendChild(ib);
  body.appendChild(info);
}

async function createBackup(btn) {
  setBtnBusy(btn, true, '备份中…');
  // 带调用记录时整包约 2–3 MB、100+ 个小文件，给足超时
  const r = await api.post('/ui/backup/create', { includeCallLogs: true }, 60000);
  setBtnBusy(btn, false, '');
  if (r.ok === false) {
    toast('备份失败：' + r.message, 'err', 6000);
    return;
  }
  toast(r.message || '已备份', 'ok', 5000);
  await loadBackup();
  if (S.page === 'backup') renderPage();
}

async function requestRestore(name) {
  const yes = await confirmBox('恢复这份备份',
    `将把当前数据替换为 ${name}。\n\n`
    + '为了能回滚，重启时会先自动快照一份当前数据。\n'
    + '恢复在下次启动时执行——现在点确定只是登记，不会立刻改动任何文件。');
  if (!yes) return;
  const r = await api.post('/ui/backup/restore', { name });
  toast(r.message || (r.ok ? '已登记恢复' : '登记失败'), r.ok ? 'ok' : 'err', 6000);
  if (r.ok) { await loadBackup(); if (S.page === 'backup') renderPage(); }
}

// ---------------------------------------------------------------- 渲染调度

function renderPage() {
  const p = $('#pageActions');
  if (p) p.innerHTML = '';
  switch (S.page) {
    case 'overview': renderOverview(); break;
    case 'logs': renderLogs(); break;
    case 'providers': renderProviders(); break;
    case 'accounts': renderAccounts(); break;
    case 'models': renderModels(); break;
    case 'smartRoute': renderSmartRoute(); break;
    case 'groups': renderGroups(); break;
    case 'gateway': renderGateway(); break;
    case 'keys': renderKeys(); break;
    case 'calls': renderCalls(); break;
    case 'strategy': renderStrategy(); break;
    case 'media': renderMedia(); break;
    case 'backup': renderBackup(); break;
  }
  // 概览页之外的页面没有指标卡，updateMetrics 自然空转
}

// ---------------------------------------------------------------- 数据轮询

/**
 * 心跳：拉一次快照并按当前页做「最小必要更新」。
 *
 * 三条规矩（每一条都对应一个踩过的坑）：
 * 1. **输入框正在编辑时不重建当前页**：否则用户输一半的数字被心跳打回原值。
 * 2. **表格按数据签名重建**：每拍重建会丢选中态并闪烁。
 * 3. **连不上时让界面说话**：断线只写 console 的话，用户看到的是"数字不动了"，
 *    会以为程序挂了。这里在侧栏状态上标出「已断开」并每次重连成功时清掉。
 */
async function loadState() {
  const s = await api.get('/ui/state');
  if (!s || s.ok === false) {
    markOffline(s && s.message);
    return;
  }
  markOnline();
  S.state = s;
  renderStatus();

  // 强制更新静默升级：后台 6 小时查一次的结果会在 `state.update` 里出现，
  // 用户可能一直停在别的页面（不知道要回概览看）。这里每拍检查一次，
  // 命中 mandatory 就立刻弹——与概览页的版本条共用同一套判定。
  // 同一版本只弹一次由 S.forceShown 保证。
  //
  // `gateClosed` 是**服务端**的闸门状态（已启动的网关会被停掉）。
  // 用它而不是用前端自己的 mandatory 判断：那是唯一无法被绕过的一层，
  // 界面只是跟着它显示。两者同时看，任一命中都锁。
  const gated = !!(s.update && (s.update.mandatory || s.update.gateClosed));
  if (gated) {
    if (!S.gateLocked) lockShell(s.update.gateReason || undefined);
    if (!S.forceOpen) showForceUpdateModal(s.update);
  } else if (S.gateLocked) {
    // 装上新版后 gateClosed 会变 false（APP_VERSION 变了、清单不再更高），
    // 这里要主动解锁并撤掉弹窗，否则用户装完新版回来还是一堵死墙。
    unlockShell();
    S.forceShown = null;
    S.forceOpen = false;
    closeModal();
  }

  const focus = document.activeElement;
  const editing = focus && (focus.tagName === 'INPUT' || focus.tagName === 'TEXTAREA');

  if (S.page === 'overview') {
    updateMetrics();
    renderActivityLight();
    renderRecentErrorsLight();
    renderProviderStatsLight();
    // 版本条也要跟着心跳更新：后台检查完把结果写进 state.update，
    // 不重画的话「检查失败 → 已是最新」这种状态变化要等切页才看得到。
    paintVersionCard(s.update);
    requestAnimationFrame(drawAllCharts);
  } else if (S.page === 'logs') {
    paintLogs(false);
  } else if (S.page === 'accounts' || S.page === 'providers') {
    const sig = JSON.stringify([s.accounts, s.pool, (s.modelsMeta || {}).count]);
    if (sig !== S.tableSig && !editing) {
      S.tableSig = sig;
      renderPage();
    }
  }
  // 高级策略页：输入控件一律不重建，只按 2 秒节奏重拉「运行现状」
  if (S.page === 'strategy' && !editing) {
    const now = Date.now();
    if (now - S.strategyFetchedAt > 2000) {
      S.strategyFetchedAt = now;
      loadStrategy();
    }
  }
}

/** 断线/恢复提示：只在状态翻转时动手，不每拍改 DOM。 */
let offlineSince = 0;
function markOffline(message) {
  if (offlineSince === 0) {
    offlineSince = Date.now();
    setIf('sidebarUrl', (n) => { n.textContent = '连接断开'; });
    toast('与本地服务的连接断开：' + (message || '未知原因'), 'err', 6000);
  }
}
function markOnline() {
  if (offlineSince !== 0) {
    offlineSince = 0;
    toast('已重新连接本地服务', 'ok');
    if (S.state) renderStatus();
  }
}

/** 最近调用只改内容不重建容器，避免每拍闪一下。 */
function renderActivityLight() {
  const box = document.getElementById('activityBox');
  if (!box) return;
  const rows = S.state?.recentCalls || [];
  const sig = rows.map((r) => `${r.id}:${r.status}:${r.totalTokens}`).join('|');
  if (sig === S.activitySig) return;
  S.activitySig = sig;
  renderActivity();
}

/**
 * 「最近错误」卡：只列 FAILED / ABORTED 的调用，最近在前，最多 8 条。
 *
 * 每行四段：相对时间 / 供应商+实际模型 / 错误摘要 / 状态标签。
 * 错误原文动辄几百字，这里截一行（title 里留全文），完整原文在「调用记录」页点详情。
 */
function renderRecentErrors() {
  const box = document.getElementById('errorsBox');
  if (!box) return;
  const rows = (S.state?.recentCalls || []).filter((r) => r.status !== 'SUCCESS');
  if (rows.length === 0) {
    box.innerHTML = '<div class="empty canvas-empty"><span class="big">近期没有失败</span>'
      + '<span>调用失败或中断时会出现在这里</span></div>';
    return;
  }
  const html = rows.slice(0, 8).map((r) => {
    const kind = r.status === 'ABORTED' ? 'warn' : 'err';
    const stateText = r.status === 'ABORTED' ? '中断' : '失败';
    const real = r.upstreamModel && r.upstreamModel !== r.model ? ` · ${r.upstreamModel}` : '';
    const err = (r.error || '未知错误').replace(/\s+/g, ' ').trim();
    return `<div class="err-row">
      <span class="err-time">${relTime(r.at)}</span>
      <span class="err-src mono">${esc(r.providerId + real)}</span>
      <span class="err-msg" title="${esc(err)}">${esc(err)}</span>
      <span class="tag ${kind}">${stateText}</span>
    </div>`;
  }).join('');
  box.innerHTML = html;
}

/** 每拍按数据签名刷新「最近错误」，内容没变不动 DOM。 */
function renderRecentErrorsLight() {
  const box = document.getElementById('errorsBox');
  if (!box) return;
  const rows = (S.state?.recentCalls || []).filter((r) => r.status !== 'SUCCESS').slice(0, 8);
  const sig = rows.map((r) => `${r.id}:${r.status}:${r.error}`).join('|');
  if (sig === S.errorsSig) return;
  S.errorsSig = sig;
  renderRecentErrors();
}

/**
 * 「供应商成功率」卡：按 providerStats（最近 200 条）列每家的
 * 请求数 / 成功率 / 失败数，带一条成功率横条做视觉对比。
 * 没有调用的供应商显示 0 次——保留行让用户看到「这家还没被调用过」。
 */
function renderProviderStats() {
  const box = document.getElementById('providerStatsBox');
  if (!box) return;
  const rows = S.state?.providerStats || [];
  const called = rows.filter((r) => r.requests > 0);
  if (called.length === 0) {
    box.innerHTML = '<div class="empty canvas-empty"><span class="big">暂无调用</span>'
      + '<span>有请求后按供应商统计成功率与失败数</span></div>';
    return;
  }
  const html = called.map((r) => {
    const pct = Number(r.successRate || 0);
    const kind = pct >= 90 ? 'ok' : pct >= 60 ? 'warn' : 'err';
    const failPart = r.failed + r.aborted;
    return `<div class="ps-row">
      <span class="ps-name">${esc(r.name)}</span>
      <span class="ps-bar"><i class="${kind}" style="width:${Math.max(2, Math.round(pct))}%"></i></span>
      <span class="ps-pct mono">${r.successRate || '—'}%</span>
      <span class="ps-nums">${fmtNum(r.requests)} 次 · 失败 ${fmtNum(failPart)}</span>
    </div>`;
  }).join('');
  box.innerHTML = html;
}

/** 签名刷新：数据没变不重写（否则横条 CSS 过渡每拍重放，闪个不停）。 */
function renderProviderStatsLight() {
  const box = document.getElementById('providerStatsBox');
  if (!box) return;
  const rows = S.state?.providerStats || [];
  const sig = rows.map((r) => `${r.providerId}:${r.requests}:${r.successRate}`).join('|');
  if (sig === S.providerStatsSig) return;
  S.providerStatsSig = sig;
  renderProviderStats();
}

/**
 * 日志环形缓冲上限：比服务端多留一半（服务端一次最多给 300 条），
 * 翻历史时不会刚滚到底就被截掉。
 */
const LOG_CAP = 500;

async function pollLogs() {
  // 水位由前端自己维护（S.logSeq），服务端只按 since 返回增量。
  // 服务端持水位时，页面刷新或多标签页会互相顶高，新会话永远拿不到历史
  // ——这正是日志页一片空白的原因。
  const r = await api.get('/ui/logs', { since: S.logSeq }, 6000);
  if (r.ok === false || !r.lines || r.lines.length === 0) return;
  S.logLines.push(...r.lines);
  if (S.logLines.length > LOG_CAP) S.logLines = S.logLines.slice(-LOG_CAP);
  if (typeof r.nextSince === 'number') S.logSeq = r.nextSince;
  if (S.page === 'logs') paintLogs(false);
}

/** 全量重取日志（切进日志页 / 首屏）。会把水位重置为最新，避免重复追加。 */
async function reloadLogs() {
  const r = await api.get('/ui/logs', { since: -1 }, 10000);
  if (r.ok === false) return;
  S.logLines = r.lines || [];
  if (typeof r.nextSince === 'number') S.logSeq = r.nextSince;
  if (S.page === 'logs') paintLogs(true);
}

// ---------------------------------------------------------------- 轮询调度

/**
 * 心跳只在「窗口可见且页面在前台」时跑。
 *
 * 三个导致停表的场景，全都必须显式处理，否则后台会一直空转发请求：
 * 窗口最小化（visibilitychange）、切到别的应用（无事件但 visibility 仍是 visible，
 * 所以用 `document.hidden` 只能挡一部分）、以及页面正在编辑输入框（不暂停，只是不重建）。
 */
const heartbeat = {
  stateTimer: null,
  logTimer: null,
  start() {
    if (this.stateTimer) return;
    this.stateTimer = setInterval(loadState, 2000);
    this.logTimer = setInterval(() => {
      if (S.page === 'logs' && !document.hidden) pollLogs();
    }, 1000);
  },
  stop() {
    if (this.stateTimer) { clearInterval(this.stateTimer); this.stateTimer = null; }
    if (this.logTimer) { clearInterval(this.logTimer); this.logTimer = null; }
  },
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    heartbeat.stop();
  } else {
    // 回到前台立刻补一次，别让用户看着几秒前的旧数字
    loadState();
    heartbeat.start();
  }
});

// 窗口尺寸变化：画布要重算（旧 Swing 最痛的地方，这里是浏览器原生响应）
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  // 80ms 去抖：拖动窗口时每帧重绘三张画布会掉帧，松手后再画
  resizeTimer = setTimeout(() => {
    if (S.page === 'overview') drawAllCharts();
  }, 80);
});

// ---------------------------------------------------------------- 兜底

/**
 * 全局异常兜底：把未捕获错误显示出来，而不是只写 console。
 *
 * 桌面应用没有"开发者工具默认打开"这回事，异常落在 console 里等于消失。
 * 这里限流（10 秒最多一条），避免某个每帧抛错的循环把 toast 刷屏。
 */
let lastErrorAt = 0;
let lastErrorMsg = '';
function reportError(scope, err) {
  const msg = (err && (err.message || err.reason && err.reason.message)) || String(err || '未知错误');
  const now = Date.now();
  if (now - lastErrorAt < 10_000 && msg === lastErrorMsg) return;
  lastErrorAt = now;
  lastErrorMsg = msg;
  console.error('[aigw] ' + scope, err);
  toast(`${scope}出错：${msg}`, 'err', 6000);
}

window.addEventListener('error', (e) => reportError('界面', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError('异步任务', e.reason));

// ---------------------------------------------------------------- 启动

initTheme();
loadState().then(() => {
  go('overview');
  // 首屏就把日志与策略拉好：切过去时立刻有内容，不用先看一帧「加载中」
  reloadLogs();
  loadStrategy();
  heartbeat.start();
});
