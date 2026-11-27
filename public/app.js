(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const pad = (n) => String(n).padStart(2, '0');
  const MINUTE = 60000;
  const DAY = 1440 * MINUTE;

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
  const temperatureThresholds = [35, 55, 70, 85];
  const memoryTints = ['#315d89', '#884655', '#376b52', '#654d89', '#876128', '#246b70', '#665748', '#87486f'];
  const memoryColours = new Map();
  const memoryAmount = (mib) => mib < 102.4 ? `${Math.round(mib)} MiB` : fmt.gbUnit(mib);

  function memorySegments(total, tasks, gpu) {
    if (!(total > 0)) return [];
    if (tasks == null) return [{ label: '未记录任务分项', value: total, colour: 'var(--text)' }];
    if (!memoryColours.has(gpu)) memoryColours.set(gpu, new Map());
    const colours = memoryColours.get(gpu);
    const sum = tasks.reduce((n, [, , value]) => n + value, 0);
    // The process and device queries run separately, so their totals can briefly disagree.
    const scale = sum > total ? total / sum : 1;
    const segments = [...tasks].sort(([a], [b]) => a.localeCompare(b)).map(([key, label, value, user]) => {
      if (!colours.has(key)) colours.set(key, memoryTints[colours.size % memoryTints.length]);
      return { label, user, value: value * scale, colour: `color-mix(in srgb, ${colours.get(key)}, white var(--memory-highlight))` };
    });
    if (total > sum) segments.push({ label: '未归属显存', value: total - sum, colour: 'var(--memory-unassigned)' });
    return segments;
  }

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
        const tempGradient = `gpu-temperature-gradient-${state.cards.size}`;
        card.innerHTML = `
          <header class="gpu-head"><h3></h3><span class="gpu-util"><span class="val num"></span><span class="pct">%</span></span></header>
          <div class="spark"></div>
          <div class="gpu-mem"><div class="line"><span>显存</span><span class="num"></span></div><div class="track"></div></div>
          <p class="gpu-meta num">
            <span class="gpu-temp"><svg width="11" height="14" viewBox="0 0 11 14" aria-hidden="true">
              <defs><linearGradient id="${tempGradient}" x1="5.5" y1="13" x2="5.5" y2="1" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stop-color="#DC2626"/>
                <stop offset="100%" stop-color="#FB7185"/>
              </linearGradient></defs>
              <g fill="url(#${tempGradient})">
                <rect x="1.5" y="1.2" width="8" height="1.5" rx="0.75"/>
                <rect x="1.5" y="3.8" width="8" height="1.5" rx="0.75"/>
                <rect x="1.5" y="6.4" width="8" height="1.5" rx="0.75"/>
                <rect x="1.5" y="9" width="8" height="1.5" rx="0.75"/>
                <rect x="1.5" y="11.6" width="8" height="1.5" rx="0.75"/>
              </g>
            </svg><span class="gpu-temp-value"></span></span><span class="gpu-meta-rest"></span>
          </p>`;
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
        const memory = card.querySelector('.gpu-mem');
        const track = memory.querySelector('.track');
        const showMemoryTip = Charts.segmentTooltip(memory, memoryAmount);
        track.addEventListener('pointermove', (e) => showMemoryTip(e, e.target._memorySegment));
        track.addEventListener('pointerleave', () => showMemoryTip());
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
    setText(card.querySelector('.gpu-mem .line .num'), `${fmt.gb(g.memUsed)} / ${fmt.gb(total)} GB`);
    const track = card.querySelector('.gpu-mem .track');
    const segments = memorySegments(g.memUsed, g.taskMem, g.index);
    segments.forEach((segment, i) => {
      const span = track.children[i] || track.appendChild(document.createElement('span'));
      span._memorySegment = segment;
      span.style.backgroundColor = segment.colour;
      span.style.width = total ? `${segment.value / Math.max(total, g.memUsed) * 100}%` : '0%';
    });
    while (track.children.length > segments.length) track.lastElementChild.remove();
    card.setAttribute('aria-description', segments.map(({ label, user, value }) => [label, user, memoryAmount(value)].filter(Boolean).join(' · ')).join('\n'));
    const clock = g.clock == null ? '—' : `${(g.clock / 1000).toFixed(2)} GHz`;
    const temp = g.temp == null ? '—' : `${g.temp}°C`;
    const power = g.power == null ? '—' : `${Math.round(g.power)} W`;
    const limit = g.powerLimit == null ? '—' : `${Math.round(g.powerLimit)} W`;
    const temperature = card.querySelector('.gpu-temp');
    temperature.dataset.level = g.temp == null ? 0 : 1 + temperatureThresholds.filter((threshold) => g.temp >= threshold).length;
    setText(temperature.querySelector('.gpu-temp-value'), temp);
    setText(card.querySelector('.gpu-meta-rest'), ` · ${power} / ${limit} · ${clock}`);
    const on = state.gpu === g.index;
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
    card.setAttribute('aria-label', `GPU ${g.index}：利用率 ${util}%，显存 ${fmt.gb(g.memUsed)} / ${fmt.gb(total)} GB，温度 ${temp}。${on ? '已选中，点按取消筛选。' : '点按只看这张卡上的任务。'}`);
  }

  function clearChart(el, data) {
    el._draw = null;
    setText(el, data.history ? '所选时段暂无采样' : '正在读取历史…');
  }

  // Fold samples into short means while retaining empty buckets on the time axis.
  function bucketHistory(data, pos, width, withTasks = false) {
    const hist = data.history;
    if (!hist?.t.length) return null;
    const { t, util, mem: memory } = hist;
    const plot = Math.max(120, (width || 240) - 52);
    const count = Math.max(24, Math.min(90, Math.floor(plot / 6)));
    const size = Math.ceil(t.length / count);
    const labels = [], mean = [], mem = [], taskMem = [];
    for (let i = 0; i < t.length; i += size) {
      let sum = 0, seen = 0, memSum = 0, memSeen = 0;
      let tasks = null;
      for (let k = i; k < Math.min(i + size, t.length); k++) {
        const v = util[pos]?.[k];
        if (v != null) { sum += v; seen++; }
        const m = memory?.[pos]?.[k];
        if (m == null) continue;
        memSum += m; memSeen++;
        const sample = withTasks ? hist.taskMem?.[pos]?.[k] : null;
        if (sample == null) continue;
        tasks ??= new Map();
        for (const [key, label, value, user] of sample) {
          const previous = tasks.get(key);
          tasks.set(key, [label, (previous?.[1] ?? 0) + value, user ?? previous?.[2] ?? null]);
        }
      }
      labels.push(fmt.hhmm(t[i]));
      mean.push(seen ? sum / seen : null);
      mem.push(memSeen ? memSum / memSeen / 1024 : null);
      if (withTasks) taskMem.push(tasks ? [...tasks].map(([key, [label, value, user]]) => [key, label, value / memSeen, user]) : null);
    }
    return { labels, mean, mem, taskMem };
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

  function drawSparks(data, refreshCharts = false) {
    if (state.route !== 'overview') return;
    data.gpus.forEach((g, pos) => {
      const card = state.cards.get(g.index);
      if (!card) return;
      const el = card.querySelector('.spark');
      if (!el.clientWidth || (el._hovered && !refreshCharts)) return;
      const buckets = bucketHistory(data, pos, el.clientWidth);
      if (!buckets?.mean.some((v) => v != null)) { clearChart(el, data); return; }
      Charts.line(el, {
        labels: buckets.labels,
        series: [{ name: '利用率', values: buckets.mean }],
        fill: buckets.mean.every((v) => v != null),
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
  const gpuDetail = $('#view-gpu');
  const overviewView = $('#view-overview');
  const rangePopover = $('#rangePopover');
  const tempChart = $('#gpuTempChart');
  let detailGpu = null;
  let overviewScroll = 0;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const ZOOM_MS = 320;
  let detailZoom = null;

  function zoomTransform(base, target) {
    return `translate(${target.left - base.left}px, ${target.top - base.top}px) scale(${target.width / base.width}, ${target.height / base.height})`;
  }

  // Pin the detail to its laid-out box so it can fly between the page and the card.
  function pinDetail(base) {
    gpuDetail.hidden = false;
    gpuDetail.style.cssText = `position:fixed;left:${base.left}px;top:${base.top}px;width:${base.width}px;margin:0;padding:var(--pad);z-index:20;pointer-events:none;transform-origin:0 0;background:var(--surface);`;
  }

  function releaseDetail() {
    detailZoom?.forEach((animation) => animation.cancel());
    detailZoom = null;
    gpuDetail.style.cssText = '';
  }

  // Panel and content fly separately: the content fades before the panel shrinks, so the
  // scaled text is never squeezed into the card's shape.
  function flyIn(base, from) {
    const panel = gpuDetail.animate([
      { transform: zoomTransform(base, from), borderRadius: '6px' },
      { transform: 'none', borderRadius: '0px' },
    ], { duration: ZOOM_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    const content = [...gpuDetail.children].map((el) => el.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: ZOOM_MS * 0.6, delay: ZOOM_MS * 0.4, easing: 'linear', fill: 'backwards' },
    ));
    return settleZoom(panel, [panel, ...content], false);
  }

  function flyOut(base, target) {
    const panel = gpuDetail.animate([
      { transform: 'none', borderRadius: '0px' },
      { transform: zoomTransform(base, target), borderRadius: '6px' },
    ], { duration: ZOOM_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });
    const content = [...gpuDetail.children].map((el) => el.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: ZOOM_MS * 0.45, easing: 'linear', fill: 'forwards' },
    ));
    return settleZoom(panel, [panel, ...content], true);
  }

  // Only the panel's timeline decides completion; a content fade interrupted by a hidden
  // block must not strand the pinned detail on screen.
  function settleZoom(panel, animations, hide) {
    detailZoom = animations;
    panel.finished.then(() => {
      if (detailZoom !== animations) return;
      releaseDetail();
      if (hide) {
        gpuDetail.hidden = true;
        gpuDetail.classList.remove('is-zoomed');
      }
    }).catch(() => {});
  }

  function drawTemperature(data, pos) {
    const values = data.history?.temp?.[pos] || [];
    const readings = values.filter((value) => value != null);
    const empty = $('#gpuTempEmpty');
    empty.hidden = readings.length > 0;
    tempChart.hidden = readings.length === 0;
    if (!readings.length) {
      setText(empty, data.history ? '所选时段暂无温度采样' : '正在读取历史…');
      return;
    }
    const labels = data.history.t.map(fmt.hhmm);
    Charts.line(tempChart, {
      labels,
      series: [{ name: '温度', values }],
      smooth: true,
      colourStops: [[38, 'var(--temp-cool)'], [55, 'var(--warning)'], [70, 'var(--temp-warm)'], [85, 'var(--negative)']],
      format: (v) => `${v}°C`,
      height: 140,
      min: Math.min(...readings) - 5,
      max: Math.max(...readings) + 5,
      xAt: minutePicks(labels, tempChart.clientWidth),
    });
  }

  function drawDetail() {
    const data = state.data;
    const pos = data ? data.gpus.findIndex((g) => g.index === detailGpu) : -1;
    if (pos < 0) { closeDetail(); return; }
    const g = data.gpus[pos];
    const lineEl = $('#gpuChart'), barEl = $('#gpuMemChart');
    setText($('#gpuDetailTitle'), `GPU ${g.index}`);
    setText($('#gpuDetailSub'), `${g.name} · 利用率 ${g.util ?? '—'}% · 显存 ${fmt.gb(g.memUsed || 0)} / ${fmt.gb(g.memTotal || 0)} GB · ${g.temp ?? '—'}°C`);
    drawTemperature(data, pos);
    const b = bucketHistory(data, pos, lineEl.clientWidth, true);
    // memory history only starts with the first sample recorded after this version, so the bars keep their place
    // on the time axis and simply leave the earlier buckets empty
    const withMem = b?.mem.some((v) => v != null);
    if (!b?.mean.some((v) => v != null)) clearChart(lineEl, data);
    else Charts.line(lineEl, {
      labels: b.labels,
      series: [{ name: '利用率', values: b.mean }],
      fill: b.mean.every((v) => v != null),
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
      segments: b.mem.map((gb, i) => memorySegments(gb * 1024, b.taskMem[i], g.index)
        .map((segment) => ({ ...segment, value: segment.value / 1024 }))),
      formatSegment: (gb) => memoryAmount(gb * 1024),
      format: (v) => (v == null ? '—' : `${v.toFixed(1)} GB`),
      tickFormat: (v) => `${v}`,
      height: 128,
      xAt: minutePicks(b.labels, barEl.clientWidth),
    });
  }

  function openDetail(index) {
    releaseDetail();
    const card = state.cards.get(index);
    const from = overviewView.hidden || !card ? null : card.getBoundingClientRect();
    if (!overviewView.hidden) overviewScroll = window.scrollY;
    detailGpu = index;
    rangePopover.hidePopover();
    $('#gpuDetailRange').append(rangePopover);
    overviewView.hidden = true;
    gpuDetail.hidden = false;
    gpuDetail.classList.add('is-zoomed');
    window.scrollTo(0, 0);
    drawDetail();
    if (from && !reduceMotion.matches) {
      const base = gpuDetail.getBoundingClientRect();
      pinDetail(base);
      flyIn(base, from);
    }
    $('#gpuDetailBack').focus({ preventScroll: true });
  }

  function focusOverview(card) {
    (card || $('#rangeTrigger')).focus({ preventScroll: true });
    card?.parentElement.querySelector('.expand')?.focus({ preventScroll: true });
  }

  function closeDetail(restoreOverview = true) {
    if (detailGpu == null) return;
    const card = state.cards.get(detailGpu);
    rangePopover.hidePopover();
    $('#historyRange').append(rangePopover);
    detailGpu = null;
    // cancel an in-flight open animation and unpin, so the base box is the natural layout
    releaseDetail();
    if (!restoreOverview || !card || reduceMotion.matches) {
      gpuDetail.hidden = true;
      gpuDetail.classList.remove('is-zoomed');
      if (!restoreOverview) return;
      overviewView.hidden = false;
      if (state.data) drawSparks(state.data, true);
      focusOverview(card);
      window.scrollTo(0, overviewScroll);
      return;
    }
    // The overview scrolls back into place behind the shrinking detail, then the detail
    // lands exactly on its card and fades out.
    const base = gpuDetail.getBoundingClientRect();
    pinDetail(base);
    overviewView.hidden = false;
    window.scrollTo(0, overviewScroll);
    if (state.data) drawSparks(state.data, true);
    const target = card.getBoundingClientRect();
    flyOut(base, target);
    focusOverview(card);
  }

  $('#gpuDetailBack').addEventListener('click', () => closeDetail());
  $$('a[href="#/"]').forEach((link) => link.addEventListener('click', (e) => {
    if (detailGpu == null) return;
    e.preventDefault();
    closeDetail();
  }));
  gpuDetail.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || rangePopover.matches(':popover-open')) return;
    e.preventDefault();
    closeDetail();
  });
  const detailCharts = [$('#gpuChart'), $('#gpuMemChart'), tempChart];
  for (const el of detailCharts) {
    el.addEventListener('pointerenter', () => { el._hovered = true; });
    el.addEventListener('pointerleave', () => { el._hovered = false; if (!gpuDetail.hidden) drawDetail(); });
  }

  /* ---------- kpis ---------- */
  function renderKpis(data) {
    // both figures come from the per-card values on screen (31.9 + 29.3 + …), never from the unrounded sum
    const used = data.gpus.reduce((s, g) => s + fmt.gbTenth(g.memUsed || 0), 0).toFixed(1);
    const total = data.gpus.reduce((s, g) => s + fmt.gbTenth(g.memTotal || 0), 0).toFixed(1);
    const utils = data.gpus.map((g) => g.util).filter((v) => v != null);
    const avg = utils.length ? Math.round(utils.reduce((s, v) => s + v, 0) / utils.length) : null;
    const idle = data.configured === false;
    setText($('#kpiMem'), data.gpus.length ? used : '—');
    setText($('#kpiMemSub'), data.gpus.length ? `/ ${total} GB` : '');
    setText($('#kpiUtil'), avg == null ? '—' : String(avg));
    setText($('#kpiUtil').nextElementSibling, idle ? '' : '%');
    setText($('#kpiTasks'), idle ? '—' : String(data.tasks.length));
    setText($('#kpiTasks').nextElementSibling, idle ? '' : '个进程');
    setText($('#kpiUsers'), idle ? '—' : String(data.users.length));
    setText($('#kpiUsers').nextElementSibling, idle ? '' : '位');
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
      empty.textContent = state.data?.configured === false
        ? '尚未选择服务器，点左下角「登录」选择一台。'
        : state.gpu == null
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
      empty.textContent = state.data?.configured === false
        ? '尚未选择服务器。'
        : '现在没有用户占用 GPU。';
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
    if (data.configured === false) {
      setText($('#tasksFinding'), '尚未选择服务器。');
      setText($('#tasksFoot'), '');
      $('#tasksFoot').hidden = true;
      renderFilterTabs(data);
      renderTaskList($('#taskListFull'), [], true);
      return;
    }
    $('#tasksFoot').hidden = false;
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
    const title = state.route === 'tasks' ? '任务 · GPU 监控' : label ? `GPU 监控 · ${label}` : 'GPU 监控';
    document.title = title;
    setText($('#windowTitle'), title);
  }

  function syncConnectButton() {
    const c = state.data?.connection;
    const btn = $('#connectBtn');
    const label = c?.mode === 'password' && c.host
      ? `已登录 ${c.user}@${c.host}:${c.port}，点击切换`
      : c?.mode === 'key' && c.host
        ? `免密连接 ${c.host}，点击切换`
        : '登录 SSH';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  /* ---------- stamp / notice ---------- */
  function renderStamp() {
    const d = state.data;
    const text = d?.configured === false
      ? '未连接'
      : !d?.sampledAt
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
  function render(data, refreshCharts = false) {
    ensureCards(data.gpus);
    renderStamp();
    syncTitle();
    syncConnectButton();
    const overview = state.route === 'overview';
    if (overview) {
      setText($('#scope'), data.configured === false
        ? '未选择服务器'
        : data.host
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
    drawSparks(data, refreshCharts);
    if (!gpuDetail.hidden && (refreshCharts || !detailCharts.some((el) => el._hovered))) drawDetail();
  }

  /* ---------- polling ---------- */
  let timer = null;
  let prompted = false;
  let latestRequest = 0;
  async function fetchState(historyOnly = false) {
    const request = ++latestRequest;
    const range = state.range;
    const pausedAt = historyOnly ? state.data?.sampledAt : null;
    const query = Array.isArray(range) ? { from: range[0], to: range[1] }
      : pausedAt ? { from: pausedAt - range * MINUTE, to: pausedAt }
      : { minutes: range };
    try {
      const res = await fetch(`/api/state?${new URLSearchParams(query)}`, { cache: 'no-store' });
      if (!res.ok && res.status !== 503) throw new Error(String(res.status));
      const data = await res.json();
      if (request !== latestRequest) return;
      const refreshCharts = Boolean(rangeControl.dataset.query);
      if (historyOnly && state.paused && state.data) {
        if (data.target !== state.data.target) throw new Error('监控目标已变更');
        state.data.history = data.history;
        render(state.data, refreshCharts);
        if (refreshCharts) finishRangeQuery();
        return;
      }
      state.data = data;
      const starting = data.error === '正在采样…';
      state.failed = !!data.error && !starting;
      if (starting) $('#notice').hidden = true;
      else if (!data.error) $('#notice').hidden = true;
      else showNotice();
      render(data, refreshCharts);
      if (refreshCharts) finishRangeQuery();
      if (data.configured === false && !prompted) {
        prompted = true;
        openConnect();
      }
    } catch {
      if (request !== latestRequest) return;
      if (rangeControl.dataset.query) {
        setRangeQuery('error');
        return;
      }
      state.failed = true;
      showNotice();
      renderStamp();
    }
  }

  async function loop() {
    if (!state.paused && rangeControl.dataset.query !== 'loading') await fetchState();
    timer = setTimeout(loop, 2000);
  }

  const customRange = $('#customRange');
  const rangeForm = $('#rangeForm');
  const rangeFrom = $('#rangeFrom');
  const rangeTo = $('#rangeTo');
  const rangeError = $('#rangeError');
  const rangeTrigger = $('#rangeTrigger');
  const detailRangeTrigger = $('#gpuDetailRangeTrigger');
  const rangeControl = $('#historyRange');
  const rangeControls = $$('.history-range');
  const rangeLabels = $$('.range-label');
  const rangeQueryStatuses = $$('.range-query-status');
  const rangeQueryError = $('#rangeQueryError');
  const historyCharts = $$('#gpuGrid, #view-gpu .detail-block');
  const presets = $$('[data-range]');

  function setRangeQuery(status) {
    rangeControls.forEach((el) => {
      if (status) el.dataset.query = status;
      else delete el.dataset.query;
    });
    const busy = status === 'loading';
    historyCharts.forEach((el) => el.setAttribute('aria-busy', String(busy)));
    rangeQueryError.hidden = status !== 'error';
    const message = busy ? '查询中…' : status === 'error' ? '查询失败' : '';
    rangeQueryStatuses.forEach((el) => setText(el, message));
    if (message) live(busy ? '正在查询所选时间范围' : '时间范围查询失败，仍显示上次的图表');
  }

  function finishRangeQuery() {
    setRangeQuery(null);
    live('所选时间范围已加载');
  }

  function localMinute(time) {
    const date = new Date(time);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${fmt.hhmm(time)}`;
  }

  function showRangeForm(show) {
    rangeForm.hidden = !show;
    customRange.setAttribute('aria-expanded', String(show));
    rangeError.hidden = true;
    if (!show) return;
    const now = Date.now();
    const first = Math.ceil((now - DAY) / MINUTE) * MINUTE;
    const last = Math.floor(now / MINUTE) * MINUTE;
    rangeFrom.min = rangeTo.min = localMinute(first);
    rangeFrom.max = rangeTo.max = localMinute(last);
    const [from, to] = Array.isArray(state.range) ? state.range : [Math.max(first, last - state.range * MINUTE), last];
    rangeFrom.value = localMinute(from);
    rangeTo.value = localMinute(to);
  }

  function setRange(btn, range) {
    presets.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    const label = Array.isArray(range)
      ? `自定义 · ${fmt.dur((range[1] - range[0]) / 1000).replace(/分$/, '分钟')}`
      : `最近 ${btn.textContent}`;
    rangeLabels.forEach((el) => setText(el, label));
    rangePopover.hidePopover();
    (gpuDetail.hidden ? rangeTrigger : detailRangeTrigger).focus();
    if (range === state.range && state.data?.history && !rangeControl.dataset.query) return;
    state.range = range;
    setRangeQuery('loading');
    fetchState(state.paused);
  }

  rangePopover.addEventListener('beforetoggle', (event) => {
    if (event.newState === 'open') showRangeForm(Array.isArray(state.range));
  });

  customRange.addEventListener('click', () => {
    showRangeForm(rangeForm.hidden);
    if (!rangeForm.hidden) rangeFrom.focus();
  });

  rangeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const from = new Date(rangeFrom.value).getTime();
    const to = new Date(rangeTo.value).getTime();
    const now = Date.now();
    if (!(from < to) || from < now - DAY || to > now) {
      setText(rangeError, '请选择最近 24 小时内的时段，结束时间须晚于开始时间。');
      rangeError.hidden = false;
      return;
    }
    setRange(customRange, [from, to]);
  });

  function applyRoute() {
    closeDetail(false);
    state.route = location.hash.startsWith('#/tasks') ? 'tasks' : 'overview';
    const tv = $('#view-tasks');
    const notice = $('#notice');
    overviewView.hidden = state.route !== 'overview';
    tv.hidden = state.route !== 'tasks';
    // the active view's h1 is first in DOM order, so headline probes and screen readers meet it first
    notice.after(state.route === 'tasks' ? tv : overviewView);
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
    if (!gpuDetail.hidden) drawDetail();
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
      : '账号密码登录，适合没有配置免密的主机；密码只保存在本机的系统凭据存储中。');
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
    setText($('#connectStatus'), !c?.host
      ? '尚未登录，选择一台服务器开始监控'
      : pwd
        ? `当前：${pwd.user}@${pwd.host}:${pwd.port}（账号密码）`
        : `当前：${c.host}（SSH 配置，免密）`);
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
    if (!confirm('清除已保存的登录？')) return;
    connectClear.disabled = true;
    try {
      const res = await fetch('/api/connection', { method: 'DELETE' });
      if (!res.ok) throw new Error('clear failed');
      connectDialog.close();
      await fetchState();
      live('已清除登录');
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

  presets.forEach((b) => b.addEventListener('click', () => setRange(b, Number(b.dataset.range))));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.paused && rangeControl.dataset.query !== 'loading') fetchState();
  });
  window.addEventListener('hashchange', applyRoute);
  window.addEventListener('resize', () => { if (state.data) drawSparks(state.data); });
  // follow the system until the switch is used for the first time
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!storedTheme()) applyTheme(systemTheme());
  });

  if (document.documentElement.dataset.window && window.OverlayScrollbarsGlobal) {
    const { OverlayScrollbars } = window.OverlayScrollbarsGlobal;
    const scrollbarOptions = { scrollbars: { theme: 'monitor-scrollbar', autoHide: 'leave' } };
    OverlayScrollbars(document.body, scrollbarOptions);
    $$('dialog.modal, #rangePopover').forEach((el) => {
      OverlayScrollbars({ target: el, elements: { viewport: el } }, scrollbarOptions);
    });
  }

  applyRoute();
  syncThemeButton();
  loop();
})();
