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
    // totals are summed from the figures as they are printed, so a column never disagrees with its total
    gbTenth: (mib) => Math.round((mib / 1024) * 10) / 10,
    gbSum: (list, key = 'memMib') => list.reduce((s, item) => s + Math.round(((item[key] || 0) / 1024) * 10) / 10, 0).toFixed(1),
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
        const cell = document.createElement('article');
        cell.className = 'gpu-cell';
        const card = document.createElement('div');
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
        // the expand control sits outside the card's button role, so it is a real button, not a nested one
        const expand = document.createElement('button');
        expand.type = 'button';
        expand.className = 'expand';
        expand.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-expand"/></svg>`;
        expand.setAttribute('aria-label', `放大查看 GPU ${g.index}`);
        expand.title = '放大查看';
        expand.addEventListener('click', () => openDetail(g.index));
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
        cell.append(card, expand);
        state.cards.set(g.index, card);
        grid.appendChild(cell);
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

  // the 2-second samples folded into short means: a raw series of 450 points turns a 150px card into a wall of
  // strokes, while a short-window mean still shows the shape of the load
  function bucketHistory(data, pos, width) {
    const hist = data.history || { t: [], util: [] };
    const t = hist.t || [];
    const cutoff = (data.sampledAt || Date.now()) - state.range * 60000;
    let start = 0;
    while (start < t.length && t[start] < cutoff) start++;
    const n = t.length - start;
    if (n <= 0) return null;
    const plot = Math.max(120, (width || 240) - 52);
    const count = Math.max(24, Math.min(90, Math.floor(plot / 6)));
    const size = Math.max(1, Math.ceil(n / count));
    const labels = [], mean = [], mem = [];
    for (let i = start; i < t.length; i += size) {
      let sum = 0, seen = 0, at = null, memSum = 0, memSeen = 0;
      for (let k = i; k < Math.min(i + size, t.length); k++) {
        const v = hist.util[pos]?.[k];
        if (v == null) continue;
        if (at == null) at = t[k];
        sum += v; seen++;
        const m = hist.mem?.[pos]?.[k];
        if (m != null) { memSum += m; memSeen++; }
      }
      if (!seen) continue;
      labels.push(fmt.hhmm(at));
      mean.push(sum / seen);
      mem.push(memSeen ? memSum / memSeen / 1024 : null);
    }
    return labels.length ? { labels, mean, mem } : null;
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
      const buckets = bucketHistory(data, pos, el.clientWidth);
      if (!buckets) { el.textContent = ''; return; }
      Charts.line(el, {
        labels: buckets.labels,
        series: [{ name: '利用率', values: buckets.mean }],
        fill: true,
        format: (v) => `${Math.round(v)}%`,
        tickFormat: (v) => `${v}%`,
        height: Math.round(el.clientHeight) || 88,
        yTicks: [0, 50, 100],
        min: 0,
        max: 100,
        xAt: minutePicks(buckets.labels, el.clientWidth),
      });
    });
  }

  /* ---------- GPU detail: the card opens into its own charts ---------- */
  const gpuDialog = $('#gpuDialog');
  let detailGpu = null;

  function drawDetail() {
    const data = state.data;
    const pos = data ? data.gpus.findIndex((g) => g.index === detailGpu) : -1;
    if (pos < 0) return;
    const g = data.gpus[pos];
    const lineEl = $('#gpuChart'), barEl = $('#gpuMemChart');
    const b = bucketHistory(data, pos, lineEl.clientWidth);
    if (!b) return;
    setText($('#gpuDetailTitle'), `GPU ${g.index}`);
    setText($('#gpuDetailSub'), `${g.name} · 利用率 ${g.util ?? '—'}% · 显存 ${fmt.gb(g.memUsed || 0)} / ${fmt.gb(g.memTotal || 0)} GB · ${g.temp ?? '—'}°C`);
    // memory history only starts with the first sample recorded after this version, so the bars keep their place
    // on the time axis and simply leave the earlier buckets empty
    const withMem = b.mem.some((v) => v != null);
    Charts.line(lineEl, {
      labels: b.labels,
      series: [{ name: '利用率', values: b.mean }],
      fill: true,
      format: (v) => `${Math.round(v)}%`,
      tickFormat: (v) => `${v}%`,
      height: 200,
      yTicks: [0, 50, 100],
      min: 0,
      max: 100,
      xAt: withMem ? [] : minutePicks(b.labels, lineEl.clientWidth),
    });
    $('#gpuMemBlock').hidden = !withMem;
    if (!withMem) return;
    Charts.bars(barEl, {
      labels: b.labels,
      values: b.mem,
      format: (v) => (v == null ? '—' : `${v.toFixed(1)} GB`),
      tickFormat: (v) => `${v}`,
      height: 128,
      xAt: minutePicks(b.labels, barEl.clientWidth),
    });
  }

  function openDetail(index) {
    const card = state.cards.get(index);
    const from = card ? card.getBoundingClientRect() : null;
    detailGpu = index;
    gpuDialog.showModal();
    drawDetail();
    // grow out of the card the visitor clicked, so the two read as one surface
    if (from && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const to = gpuDialog.getBoundingClientRect();
      gpuDialog.animate([
        { transformOrigin: 'top left', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`, opacity: 0.6 },
        { transformOrigin: 'top left', transform: 'none', opacity: 1 },
      ], { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)' });
    }
  }

  // the same morph in reverse: the panel folds back into the card it came from
  let closing = false;
  function closeDetail() {
    if (!gpuDialog.open || closing) return;
    const card = state.cards.get(detailGpu);
    if (!card || matchMedia('(prefers-reduced-motion: reduce)').matches) { gpuDialog.close(); return; }
    const from = gpuDialog.getBoundingClientRect(), to = card.getBoundingClientRect();
    closing = true;
    gpuDialog.animate([
      { transformOrigin: 'top left', transform: 'none', opacity: 1 },
      { transformOrigin: 'top left', transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`, opacity: 0 },
    ], { duration: 220, easing: 'cubic-bezier(.4, 0, .9, .55)' }).onfinish = () => { closing = false; gpuDialog.close(); };
  }

  $('#gpuDetailClose').addEventListener('click', closeDetail);
  gpuDialog.addEventListener('click', (e) => { if (e.target === gpuDialog) closeDetail(); });
  // closedby="none" on the dialog keeps Esc from closing it before the fold-back can run
  gpuDialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeDetail(); } });
  gpuDialog.addEventListener('close', () => { detailGpu = null; closing = false; });
  for (const el of [$('#gpuChart'), $('#gpuMemChart')]) {
    el.addEventListener('pointerenter', () => { el._hovered = true; });
    el.addEventListener('pointerleave', () => { el._hovered = false; if (gpuDialog.open) drawDetail(); });
  }

  /* ---------- kpis ---------- */
  function renderKpis(data) {
    // both figures come from the per-card values on screen (31.9 + 29.3 + …), never from the unrounded sum
    const used = data.gpus.reduce((s, g) => s + fmt.gbTenth(g.memUsed || 0), 0).toFixed(1);
    const total = data.gpus.reduce((s, g) => s + fmt.gbTenth(g.memTotal || 0), 0).toFixed(1);
    const utils = data.gpus.map((g) => g.util).filter((v) => v != null);
    const avg = utils.length ? Math.round(utils.reduce((s, v) => s + v, 0) / utils.length) : null;
    setText($('#kpiMem'), data.gpus.length ? used : '—');
    setText($('#kpiMemSub'), data.gpus.length ? `/ ${total} GB` : '');
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
      // one process using several GPUs is several rows, so a row is identified by pid and GPU
      const key = `${t.pid}:${t.gpu}`;
      let li = map.get(key);
      if (!li) {
        li = buildTaskRow(t, detail);
        li.classList.add('is-new');
        setTimeout(() => li.classList.remove('is-new'), 320);
        map.set(key, li);
      }
      updateTaskRow(li, t);
      if (ol.children[i] !== li) ol.insertBefore(li, ol.children[i] || null);
      seen.add(key);
    });
    for (const [key, li] of map) {
      if (!seen.has(key)) { li.remove(); map.delete(key); }
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
    // the counts already sit in the KPI strip; this line only says which filter is narrowing the list
    const meta = $('#taskMeta');
    meta.hidden = state.gpu == null;
    setText(meta, state.gpu == null ? '' : `只看 GPU ${state.gpu}`);
    const foot = $('#taskFoot');
    foot.hidden = !tasks.length;
    setText(foot, tasks.length ? `运行最久 ${fmt.dur(Math.max(...tasks.map((t) => t.elapsed || 0)))}` : '');
    $('.lower').classList.toggle('filtered', state.gpu != null);
    renderTaskList($('#taskList'), tasks, false);
  }

  function renderUsers(data) {
    const list = $('#userList');
    list.textContent = '';
    // each user's figure is the sum of the memory its rows print, so the panel and the task list agree
    const byUser = new Map();
    for (const t of data.tasks) {
      const row = byUser.get(t.user) || { user: t.user, tasks: 0, mem: 0 };
      row.tasks += 1;
      row.mem += fmt.gbTenth(t.memMib || 0);
      byUser.set(t.user, row);
    }
    const users = [...byUser.values()].sort((a, b) => b.mem - a.mem);
    if (!users.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '现在没有用户占用 GPU。';
      list.appendChild(empty);
      return;
    }
    const max = users[0].mem || 1;
    for (const u of users) {
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
      setText(li.querySelector('.u-val'), `${u.mem.toFixed(1)} GB`);
      li.querySelector('.u-bar > span').style.width = `${Math.round((u.mem / max) * 100)}%`;
      list.appendChild(li);
    }
  }

  function renderMachine(data) {
    const g0 = data.gpus[0] || {};
    const rows = [
      ['驱动', g0.driver || '—'],
      ['CUDA', data.cuda || '—'],
      ['MIG', g0.mig === 'Disabled' ? '已禁用' : g0.mig === 'Enabled' ? '已启用' : '—'],
      ['运行时长', data.uptime ? fmt.dur(data.uptime) : '—'],
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
    const used = fmt.gbSum(tasks);
    const gpusUsed = new Set(tasks.map((t) => t.gpu)).size;
    setText($('#tasksFinding'), state.gpu == null
      ? `${data.tasks.length} 个进程 · ${data.users.length} 位用户 · 合计 ${used} GB 显存`
      : `GPU ${state.gpu} 上 ${tasks.length} 个进程 · 合计 ${used} GB 显存`);
    setText($('#tasksFoot'), tasks.length
      ? `共 ${tasks.length} 个进程 · 分布在 ${gpusUsed} 张卡 · 最久 ${fmt.dur(Math.max(...tasks.map((t) => t.elapsed || 0)))}`
      : '共 0 个进程');
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
    const label = c?.mode === 'password'
      ? `已登录 ${c.user}@${c.host}:${c.port}，点击切换`
      : c?.mode === 'key'
        ? `免密连接 ${c.host}，点击切换`
        : '登录 SSH';
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
    if (gpuDialog.open && detailGpu != null && !$('#gpuChart')._hovered && !$('#gpuMemChart')._hovered) drawDetail();
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
  const aliasSelect = $('#cAlias');
  const keyFields = $('#keyFields');
  const passFields = $('#passFields');
  let connectMode = 'key';
  let hostsLoaded = false;
  let hostsLoading = false;
  let preferredAlias = '';

  function addAliasOption(alias, isDefault) {
    const opt = document.createElement('option');
    opt.value = alias;
    opt.textContent = isDefault ? `${alias}（默认）` : alias;
    aliasSelect.appendChild(opt);
  }

  function selectAlias(alias) {
    if (!alias) return;
    if (![...aliasSelect.options].some((o) => o.value === alias)) addAliasOption(alias);
    aliasSelect.value = alias;
  }

  function setAliasPlaceholder(text) {
    aliasSelect.textContent = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = text;
    aliasSelect.appendChild(opt);
    aliasSelect.disabled = true;
  }

  async function loadSshHosts() {
    if (hostsLoaded) {
      selectAlias(preferredAlias);
      return;
    }
    if (hostsLoading) return;
    hostsLoading = true;
    try {
      const res = await fetch('/api/ssh-hosts', { cache: 'no-store' });
      if (!res.ok) {
        setAliasPlaceholder(res.status === 404 ? '需要重启监控服务后读取列表' : `读取 ~/.ssh/config 失败（${res.status}）`);
        return;
      }
      const body = await res.json();
      const hosts = body.hosts || [];
      if (!hosts.length) {
        setAliasPlaceholder('~/.ssh/config 里没有可用的 Host');
        return;
      }
      aliasSelect.textContent = '';
      aliasSelect.disabled = false;
      hosts.forEach((h) => addAliasOption(h, h === body.default));
      hostsLoaded = true;
      selectAlias(preferredAlias || hosts[0]);
    } catch {
      setAliasPlaceholder('无法连接本地监控服务');
    } finally {
      hostsLoading = false;
    }
  }

  function setConnectMode(mode) {
    connectMode = mode;
    $$('.mode-tabs button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false'));
    keyFields.hidden = mode !== 'key';
    passFields.hidden = mode !== 'password';
    trustRow.hidden = true;
    setText($('#modeNote'), mode === 'key'
      ? '从本机 ~/.ssh/config 里选择主机，密钥、端口、用户名都来自该配置。'
      : '账号密码登录，适合没有配置免密的主机；密码只保存在本机 macOS 钥匙串。');
  }

  function openConnect() {
    const c = state.data?.connection;
    const pwd = c?.mode === 'password' ? c : null;
    $('#cHost').value = pwd?.host || '';
    $('#cPort').value = pwd?.port || 22;
    $('#cUser').value = pwd?.user || '';
    preferredAlias = c?.mode === 'key' ? (c.host || '') : '';
    passInput.value = '';
    connectError.hidden = true;
    trustFp.checked = false;
    connectClear.hidden = !state.data?.saved;
    setText($('#connectStatus'), pwd
      ? `当前：${pwd.user}@${pwd.host}:${pwd.port}（账号密码）`
      : `当前：${c?.host || state.data?.target || ''}（SSH 配置，免密）`);
    setConnectMode(pwd ? 'password' : 'key');
    void loadSshHosts();
    connectDialog.showModal();
    setTimeout(() => (connectMode === 'password' ? passInput : aliasSelect).focus(), 20);
  }

  function showConnectError(msg) {
    connectError.textContent = msg;
    connectError.hidden = false;
  }

  connectForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const typing = connectMode === 'password';
    const payload = typing
      ? {
          mode: 'password',
          host: $('#cHost').value.trim(),
          port: Number($('#cPort').value || 22),
          user: $('#cUser').value.trim(),
          password: passInput.value,
        }
      : { mode: 'key', host: aliasSelect.value.trim() };
    if (!payload.host) {
      showConnectError(typing ? '请填写主机地址' : '请选择一个 SSH 主机');
      (typing ? $('#cHost') : aliasSelect).focus();
      return;
    }
    if (typing) {
      if (!payload.user) { showConnectError('请填写用户名'); $('#cUser').focus(); return; }
      if (!payload.password) { showConnectError('请填写密码'); passInput.focus(); return; }
      if (trustFp.checked && !trustRow.hidden) payload.trustNewFingerprint = true;
    }
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
  $$('.mode-tabs button').forEach((b) => b.addEventListener('click', () => setConnectMode(b.dataset.mode)));
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