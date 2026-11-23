(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const pad = (n) => String(n).padStart(2, '0');

  const state = {
    data: null,
    paused: false,
    range: 15,
    gpu: null,
    route: location.hash.startsWith('#/tasks') ? 'tasks' : 'overview',
    failed: false,
    cards: new Map(),
  };

  const fmt = {
    gb: (mib) => (mib / 1024).toFixed(1),
    gbUnit: (mib) => `${(mib / 1024).toFixed(1)} GB`,
    gb0: (mib) => `${Math.round(mib / 1024)} GB`,
    hhmm: (ts) => {
      const d = new Date(ts);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
    clock: (ts) => {
      const d = new Date(ts);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    },
    dur: (s) => {
      if (s == null) return '—';
      if (s < 60) return `${s} 秒`;
      if (s < 3600) return `${Math.floor(s / 60)} 分`;
      if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
      return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`;
    },
  };

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function live(msg) {
    setText($('#live'), msg);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      return ok;
    }
  }

  /* ---------- GPU cards ---------- */
  function ensureCards(gpus) {
    const grid = $('#gpuGrid');
    if (state.cards.size !== gpus.length) {
      grid.textContent = '';
      state.cards.clear();
      for (const g of gpus) {
        const card = document.createElement('article');
        card.className = 'gpu-card';
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-pressed', 'false');
        card.dataset.gpu = g.index;
        card.innerHTML = `
          <header class="gpu-head"><h3></h3><span class="gpu-util"><span class="val num"></span><span class="pct">%</span></span></header>
          <div class="spark"></div>
          <div class="gpu-mem"><div class="line"><span>显存</span><span class="num"></span></div><div class="track"><span></span></div></div>
          <p class="gpu-meta num"></p>`;
        const toggle = () => {
          state.gpu = state.gpu === g.index ? null : g.index;
          if (state.data) render(state.data);
        };
        card.addEventListener('click', toggle);
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
        const spark = card.querySelector('.spark');
        spark.addEventListener('pointerenter', () => { spark._hovered = true; });
        spark.addEventListener('pointerleave', () => {
          spark._hovered = false;
          if (state.data) drawSparks(state.data);
        });
        state.cards.set(g.index, card);
        grid.appendChild(card);
      }
    }
  }

  function updateCard(card, g) {
    const util = g.util == null ? '—' : String(g.util);
    setText(card.querySelector('h3'), `GPU ${g.index}`);
    card.querySelector('h3').title = g.name;
    const val = card.querySelector('.gpu-util .val');
    setText(val, util);
    setText(card.querySelector('.gpu-util .pct'), '%');
    const total = g.memTotal || 0;
    const pct = total ? Math.min(100, (g.memUsed / total) * 100) : 0;
    setText(card.querySelector('.gpu-mem .line .num'), `${fmt.gb(g.memUsed)} / ${fmt.gb(total)} GB`);
    card.querySelector('.gpu-mem .track > span').style.width = `${pct}%`;
    const clock = g.clock == null ? '—' : `${(g.clock / 1000).toFixed(2)} GHz`;
    const temp = g.temp == null ? '—' : `${g.temp}°C`;
    const power = g.power == null ? '—' : `${Math.round(g.power)} W`;
    const limit = g.powerLimit == null ? '—' : `${Math.round(g.powerLimit)} W`;
    setText(card.querySelector('.gpu-meta'), `${temp} · ${power} / ${limit} · ${clock}`);
    const on = state.gpu === g.index;
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
    card.setAttribute('aria-label', `GPU ${g.index}：利用率 ${util}%，显存 ${fmt.gb(g.memUsed)} / ${fmt.gb(total)} GB，温度 ${temp}。${on ? '已选中，点按取消筛选。' : '点按只看这张卡上的任务。'}`);
  }

  function sliceHistory(data, pos) {
    const hist = data.history || { t: [], util: [] };
    const t = hist.t || [];
    const cutoff = (data.sampledAt || Date.now()) - state.range * 60000;
    let start = 0;
    while (start < t.length && t[start] < cutoff) start++;
    const n = t.length - start;
    if (n <= 0) return { labels: [], values: [] };
    const stride = Math.max(1, Math.ceil(n / 320));
    const idx = [];
    for (let i = start; i < t.length; i += stride) idx.push(i);
    if (idx.at(-1) !== t.length - 1) idx.push(t.length - 1);
    return {
      labels: idx.map((i) => fmt.hhmm(t[i])),
      values: idx.map((i) => hist.util[pos]?.[i] ?? null),
    };
  }

  function minutePicks(labels, width) {
    const n = labels.length;
    if (n <= 1) return n ? [0] : [];
    const firsts = [];
    labels.forEach((l, i) => {
      if (!firsts.length || labels[firsts.at(-1)] !== l) firsts.push(i);
    });
    const plot = Math.max(140, width - 48);
    const gapPx = 54;
    const px = (i) => (i / Math.max(1, n - 1)) * plot;
    const picks = [firsts.at(-1)];
    for (let k = firsts.length - 2; k >= 0 && picks.length < 4; k--) {
      if (px(picks[0]) - px(firsts[k]) >= gapPx) picks.unshift(firsts[k]);
    }
    return picks;
  }

  function drawSparks(data) {
    if (state.route !== 'overview') return;
    data.gpus.forEach((g, pos) => {
      const card = state.cards.get(g.index);
      if (!card) return;
      const el = card.querySelector('.spark');
      if (!el.clientWidth || el._hovered) return;
      const { labels, values } = sliceHistory(data, pos);
      if (!values.length) { el.textContent = ''; return; }
      Charts.line(el, {
        labels,
        series: [{ name: '利用率', values }],
        format: (v) => `${v}%`,
        tickFormat: (v) => `${v}%`,
        height: 88,
        yTicks: [0, 50, 100],
        min: 0,
        max: 100,
        xAt: minutePicks(labels, el.clientWidth),
      });
    });
  }

  /* ---------- kpis ---------- */
  function renderKpis(data) {
    const used = data.gpus.reduce((s, g) => s + (g.memUsed || 0), 0);
    const total = data.gpus.reduce((s, g) => s + (g.memTotal || 0), 0);
    const utils = data.gpus.map((g) => g.util).filter((v) => v != null);
    const avg = utils.length ? Math.round(utils.reduce((s, v) => s + v, 0) / utils.length) : null;
    setText($('#kpiMem'), data.gpus.length ? fmt.gb(used) : '—');
    setText($('#kpiMemSub'), data.gpus.length ? `/ ${fmt.gb(total)} GB` : '');
    setText($('#kpiUtil'), avg == null ? '—' : String(avg));
    setText($('#kpiTasks'), String(data.tasks.length));
    setText($('#kpiUsers'), String(data.users.length));
  }

  /* ---------- tasks ---------- */
  function buildTaskRow(task, detail) {
    const li = document.createElement('li');
    li.className = 'task-row';
    li.dataset.pid = String(task.pid);
    li.innerHTML = `
      <span class="who"><span class="avatar"></span><span class="who-name"></span></span>
      <span class="t-main"><span class="t-name"></span><span class="t-sub"></span></span>
      <span class="t-gpu num"></span>
      <span class="t-mem num"></span>
      <span class="t-eta num"></span>
      <button class="icon-btn" type="button" aria-label="复制完整命令" title="复制完整命令">
        <svg class="icon" aria-hidden="true"><use href="#i-copy"/></svg>
      </button>`;
    const btn = li.querySelector('.icon-btn');
    btn.dataset.copyPid = String(task.pid);
    return li;
  }

  function updateTaskRow(li, task) {
    li.querySelector('.avatar').textContent = (task.user || '?').slice(0, 1).toUpperCase();
    setText(li.querySelector('.who-name'), task.user);
    setText(li.querySelector('.t-name'), task.title);
    setText(li.querySelector('.t-sub'), `#${task.pid} · ${task.sub}`);
    li.querySelector('.t-sub').title = task.cmd;
    setText(li.querySelector('.t-gpu'), `GPU ${task.gpu}`);
    setText(li.querySelector('.t-mem'), fmt.gbUnit(task.memMib));
    setText(li.querySelector('.t-eta'), fmt.dur(task.elapsed));
  }

  function renderTaskList(ol, tasks, detail) {
    const seen = new Set();
    const map = ol._map || (ol._map = new Map());
    ol.querySelector(':scope > .empty')?.remove();
    tasks.forEach((t, i) => {
      let li = map.get(t.pid);
      if (!li) {
        li = buildTaskRow(t, detail);
        li.classList.add('is-new');
        setTimeout(() => li.classList.remove('is-new'), 320);
        map.set(t.pid, li);
      }
      updateTaskRow(li, t);
      if (ol.children[i] !== li) ol.insertBefore(li, ol.children[i] || null);
      seen.add(t.pid);
    });
    for (const [pid, li] of map) {
      if (!seen.has(pid)) { li.remove(); map.delete(pid); }
    }
    if (!tasks.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = state.gpu == null
        ? '这台机器上现在没有 GPU 进程。'
        : `GPU ${state.gpu} 上现在没有任务。`;
      ol.appendChild(empty);
    }
  }

  function renderTasksOverview(data) {
    const tasks = state.gpu == null ? data.tasks : data.tasks.filter((t) => t.gpu === state.gpu);
    setText($('#taskMeta'), `${data.tasks.length} 个进程 · ${data.users.length} 位用户`);
    $('.lower').classList.toggle('filtered', state.gpu != null);
    renderTaskList($('#taskList'), tasks, false);
  }

  function renderUsers(data) {
    const list = $('#userList');
    list.textContent = '';
    if (!data.users.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '现在没有用户占用 GPU。';
      list.appendChild(empty);
      return;
    }
    const max = data.users[0].memMib || 1;
    for (const u of data.users) {
      const li = document.createElement('li');
      li.className = 'user-row';
      li.innerHTML = `
        <span class="avatar"></span>
        <span><span class="u-name"></span><span class="u-sub"></span></span>
        <span class="u-val num"></span>
        <span class="u-bar"><span></span></span>`;
      li.querySelector('.avatar').textContent = (u.user || '?').slice(0, 1).toUpperCase();
      setText(li.querySelector('.u-name'), u.user);
      setText(li.querySelector('.u-sub'), `${u.tasks} 个任务`);
      setText(li.querySelector('.u-val'), fmt.gbUnit(u.memMib));
      li.querySelector('.u-bar > span').style.width = `${Math.round((u.memMib / max) * 100)}%`;
      list.appendChild(li);
    }
  }

  function renderMachine(data) {
    const g0 = data.gpus[0] || {};
    const rows = [
      ['驱动', g0.driver || '—'],
      ['CUDA', data.cuda || '—'],
      ['MIG', g0.mig === 'Disabled' ? '已禁用' : g0.mig === 'Enabled' ? '已启用' : '—'],
      ['系统运行', data.uptime ? fmt.dur(data.uptime) : '—'],
    ];
    const dl = $('#machineList');
    dl.textContent = '';
    for (const [k, v] of rows) {
      const div = document.createElement('div');
      div.innerHTML = `<dt></dt><dd class="num"></dd>`;
      setText(div.querySelector('dt'), k);
      setText(div.querySelector('dd'), v);
      dl.appendChild(div);
    }
  }

  /* ---------- tasks view ---------- */
  function renderFilterTabs(data) {
    const wrap = $('#filterTabs');
    const counts = new Map();
    for (const t of data.tasks) counts.set(t.gpu, (counts.get(t.gpu) || 0) + 1);
    const opts = [{ gpu: null, label: '全部', n: data.tasks.length }];
    for (const g of data.gpus) opts.push({ gpu: g.index, label: `GPU ${g.index}`, n: counts.get(g.index) || 0 });
    const key = JSON.stringify(opts.map((o) => [o.gpu, o.n])) + '|' + state.gpu;
    if (wrap._key === key) return;
    wrap._key = key;
    wrap.textContent = '';
    for (const o of opts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', state.gpu === o.gpu ? 'true' : 'false');
      btn.innerHTML = `${o.label} (<span class="num"></span>)`;
      setText(btn.querySelector('.num'), String(o.n));
      btn.addEventListener('click', () => {
        state.gpu = o.gpu;
        render(state.data);
      });
      wrap.appendChild(btn);
    }
  }

  function renderTasksView(data) {
    const tasks = state.gpu == null ? data.tasks : data.tasks.filter((t) => t.gpu === state.gpu);
    const used = tasks.reduce((s, t) => s + (t.memMib || 0), 0);
    setText($('#tasksFinding'), state.gpu == null
      ? `${data.tasks.length} 个进程 · ${data.users.length} 位用户 · 合计 ${fmt.gbUnit(used)} 显存`
      : `GPU ${state.gpu} 上 ${tasks.length} 个进程 · 合计 ${fmt.gbUnit(used)} 显存`);
    setText($('#tasksFoot'), `共 ${tasks.length} 个进程`);
    renderFilterTabs(data);
    renderTaskList($('#taskListFull'), tasks, true);
  }

  function hostLabel() {
    return state.data?.host || state.data?.target || '服务器';
  }

  function syncTitle() {
    const label = state.data?.host || state.data?.target;
    document.title = state.route === 'tasks' ? '任务 · GPU 监控' : label ? `GPU 监控 · ${label}` : 'GPU 监控';
  }

  function syncConnectButton() {
    const c = state.data?.connection;
    const btn = $('#connectBtn');
    const label = c ? `已登录 ${c.user}@${c.host}:${c.port}，点击切换` : '登录 SSH';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  /* ---------- stamp / notice ---------- */
  function renderStamp() {
    const d = state.data;
    const text = !d?.sampledAt
      ? (state.failed ? '连接中断' : '正在连接…')
      : state.paused
        ? `已暂停 · 数据停在 ${fmt.clock(d.sampledAt)}`
        : `更新于 ${fmt.clock(d.sampledAt)}`;
    setText($('#stamp'), text);
    setText($('#stamp2'), text);
    document.body.classList.toggle('paused', state.paused);
  }

  function showNotice() {
    const n = $('#notice');
    n.hidden = false;
    const d = state.data;
    setText($('#noticeText'), d?.sampledAt
      ? `无法连接 ${hostLabel()}：${d.error || '连接中断'} · 显示 ${fmt.clock(d.sampledAt)} 的旧数据，正在重试…`
      : `无法连接 ${hostLabel()}：${d?.error || '连接中断'} · 正在重试…`);
  }

  /* ---------- render ---------- */
  function render(data) {
    ensureCards(data.gpus);
    renderStamp();
    syncTitle();
    syncConnectButton();
    const overview = state.route === 'overview';
    if (overview) {
      setText($('#scope'), data.host
        ? `${data.host} · ${data.gpus.length} × ${(data.gpus[0]?.name || 'GPU')}`
        : `正在连接 ${data.target || '服务器'}…`);
      setText($('#rack-h'), data.gpus.length ? `${data.gpus.length} 张卡` : '显卡');
    }
    data.gpus.forEach((g) => {
      const card = state.cards.get(g.index);
      if (card) updateCard(card, g);
    });
    renderKpis(data);
    renderTasksOverview(data);
    renderUsers(data);
    renderMachine(data);
    renderTasksView(data);
    drawSparks(data);
  }

  /* ---------- polling ---------- */
  let timer = null;
  async function fetchState() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok && res.status !== 503) throw new Error(String(res.status));
      const data = await res.json();
      state.data = data;
      const starting = data.error === '正在采样…';
      state.failed = !!data.error && !starting;
      if (starting) $('#notice').hidden = true;
      else if (!data.error) $('#notice').hidden = true;
      else showNotice();
      render(data);
    } catch {
      state.failed = true;
      showNotice();
      renderStamp();
    }
  }

  async function loop() {
    if (!state.paused) await fetchState();
    timer = setTimeout(loop, 2000);
  }

  function setRange(btn) {
    state.range = Number(btn.dataset.range);
    $$('.range-tabs button').forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
    if (state.data) render(state.data);
  }

  function applyRoute() {
    state.route = location.hash.startsWith('#/tasks') ? 'tasks' : 'overview';
    const ov = $('#view-overview');
    const tv = $('#view-tasks');
    const notice = $('#notice');
    ov.hidden = state.route !== 'overview';
    tv.hidden = state.route !== 'tasks';
    // the active view's h1 is first in DOM order, so headline probes and screen readers meet it first
    notice.after(state.route === 'tasks' ? tv : ov);
    $$('[data-nav]').forEach((a) => {
      const on = a.dataset.nav === state.route;
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    syncTitle();
    if (state.data) render(state.data);
    window.scrollTo(0, 0);
  }

  /* ---------- theme ---------- */
  const THEME_KEY = 'gpu-theme';

  function storedTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch {
      return null;
    }
  }

  function systemTheme() {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function syncThemeButton() {
    const light = document.documentElement.dataset.theme === 'light';
    const btn = $('#theme');
    btn.querySelector('use').setAttribute('href', light ? '#i-moon' : '#i-sun');
    setText($('#themeLabel'), light ? '深色' : '浅色');
    const label = light ? '切换到深色模式' : '切换到浅色模式';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    syncThemeButton();
    // the charts bake their stroke colours at draw time, so a theme flip needs a redraw
    if (state.data) drawSparks(state.data);
  }

  /* ---------- SSH 登录弹窗 ---------- */
  const connectDialog = $('#connectDialog');
  const connectForm = $('#connectForm');
  const connectError = $('#connectError');
  const trustRow = $('#trustRow');
  const trustFp = $('#trustFp');
  const connectSubmit = $('#connectSubmit');
  const connectClear = $('#connectClear');
  const passInput = $('#cPass');

  function openConnect() {
    const c = state.data?.connection;
    $('#cHost').value = c?.host || '';
    $('#cPort').value = c?.port || 22;
    $('#cUser').value = c?.user || '';
    passInput.value = '';
    connectError.hidden = true;
    trustRow.hidden = true;
    trustFp.checked = false;
    connectClear.hidden = !c;
    setText($('#connectStatus'), c
      ? `当前：${c.user}@${c.host}:${c.port}（密码登录）。保存新目标会替换当前登录。`
      : `当前：默认服务器 ${state.data?.target || 'zhichen-server'}（免密）。填写下方信息可切换到密码登录的服务器。`);
    connectDialog.showModal();
    setTimeout(() => (c ? passInput : $('#cHost')).focus(), 20);
  }

  function showConnectError(msg) {
    connectError.textContent = msg;
    connectError.hidden = false;
  }

  connectForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      host: $('#cHost').value.trim(),
      port: Number($('#cPort').value || 22),
      user: $('#cUser').value.trim(),
      password: passInput.value,
    };
    if (trustFp.checked && !trustRow.hidden) payload.trustNewFingerprint = true;
    trustRow.hidden = true;
    connectError.hidden = true;
    connectSubmit.disabled = true;
    connectSubmit.textContent = '连接中…';
    try {
      const res = await fetch('/api/connection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = body.error || `连接失败（${res.status}）`;
        showConnectError(body.fingerprint ? `${msg}。服务器指纹：${body.fingerprint}` : msg);
        trustRow.hidden = res.status !== 409;
        live('SSH 登录失败');
        return;
      }
      connectDialog.close();
      passInput.value = '';
      location.hash = '#/';
      await fetchState();
      live(`已连接 ${body.target}`);
    } catch {
      showConnectError('无法连接本地监控服务');
    } finally {
      connectSubmit.disabled = false;
      connectSubmit.textContent = '连接并监控';
    }
  });

  connectClear.addEventListener('click', async () => {
    if (!confirm('清除已保存的 SSH 登录，回到默认服务器？')) return;
    connectClear.disabled = true;
    try {
      const res = await fetch('/api/connection', { method: 'DELETE' });
      if (!res.ok) throw new Error('clear failed');
      connectDialog.close();
      await fetchState();
      live('已回到默认服务器');
    } catch {
      showConnectError('清除失败，请稍后重试');
    } finally {
      connectClear.disabled = false;
    }
  });

  $('#connectBtn').addEventListener('click', openConnect);
  $('#connectClose').addEventListener('click', () => connectDialog.close());
  connectDialog.addEventListener('close', () => {
    passInput.value = '';
  });
  connectDialog.addEventListener('click', (e) => {
    if (e.target === connectDialog) connectDialog.close();
  });

  /* ---------- events ---------- */
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy-pid]');
    if (!btn) return;
    const task = state.data?.tasks.find((t) => t.pid === Number(btn.dataset.copyPid));
    if (!task) return;
    if (await copyText(task.cmd)) {
      btn.classList.add('done');
      btn.setAttribute('aria-label', '已复制');
      btn.querySelector('use').setAttribute('href', '#i-check');
      live(`已复制 PID ${task.pid} 的命令`);
      setTimeout(() => {
        btn.classList.remove('done');
        btn.setAttribute('aria-label', '复制完整命令');
        btn.querySelector('use').setAttribute('href', '#i-copy');
      }, 1500);
    } else {
      live('复制失败，请手动选择命令');
    }
  });

  $('#theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    applyTheme(next);
    live(next === 'light' ? '已切换到浅色模式' : '已切换到深色模式');
  });

  $('#pause').addEventListener('click', () => {
    state.paused = !state.paused;
    const btn = $('#pause');
    btn.setAttribute('aria-pressed', state.paused ? 'true' : 'false');
    btn.setAttribute('aria-label', state.paused ? '继续刷新' : '暂停刷新');
    btn.title = state.paused ? '继续刷新' : '暂停刷新';
    btn.querySelector('use').setAttribute('href', state.paused ? '#i-play' : '#i-pause');
    setText($('#pauseLabel'), state.paused ? '继续' : '暂停');
    live(state.paused ? '已暂停刷新' : '已恢复刷新');
    renderStamp();
    if (!state.paused) fetchState();
  });

  $('#retry').addEventListener('click', () => fetchState());

  $$('.range-tabs button').forEach((b) => b.addEventListener('click', () => setRange(b)));

  window.addEventListener('hashchange', applyRoute);
  window.addEventListener('resize', () => { if (state.data) drawSparks(state.data); });
  // follow the system until the switch is used for the first time
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!storedTheme()) applyTheme(systemTheme());
  });

  applyRoute();
  syncThemeButton();
  loop();
})();