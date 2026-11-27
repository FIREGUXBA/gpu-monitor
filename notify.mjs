import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PUSH_URL = 'https://wxpusher.zjiecode.com/api/send/message/simple-push';
const SERVERCHAN_URL = 'https://sctapi.ftqq.com';
const SPT_RE = /^SPT_[A-Za-z0-9_-]{8,}$/;
const MASKED_SPT_RE = /^SPT_•+/;
const SERVERCHAN_KEY_RE = /^SCT[A-Za-z0-9]{5,}$/;
const MASKED_KEY_RE = /^[A-Za-z0-9]*•+/;
const CHANNELS = new Set(['spt', 'serverchan']);
const UNKNOWN_MS = 120000;
const RETRY_AFTER_MS = 60000;
const LISTED_GPUS = 8;

export const DEFAULT_RULE = { utilIdlePct: 10, windowSec: 300, tolerance: 0.1 };
export const DEFAULT_WATCH = { cards: 1, minFreeGb: 0 };

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** A GPU whose utilisation and free memory both meet the watch. */
export function availableGpus(gpus, watch, rule = DEFAULT_RULE) {
  if (!watch) return [];
  return (gpus || [])
    .filter((g) => g.util != null && g.util <= rule.utilIdlePct && (g.memTotal - g.memUsed) / 1024 >= watch.minFreeGb)
    .sort((a, b) => a.index - b.index);
}

/** Judge a watch window from its raw samples. Samples from the future are dropped. */
export function evaluateWindow(samples, watch, rule, now, pollMs = 2000) {
  const windowMs = rule.windowSec * 1000;
  const fresh = (samples || []).filter((s) => s.t <= now && s.t >= now - windowMs);
  const windowFull = fresh.length > 0 && now - fresh[0].t >= windowMs - 2 * pollMs;
  const ok = fresh.filter((s) => s.count >= watch.cards).length;
  const ratio = fresh.length ? ok / fresh.length : 0;
  return {
    qualified: windowFull && ratio >= 1 - rule.tolerance - 1e-9,
    windowFull,
    ratio,
    samples: fresh.length,
    durationMs: fresh.length ? now - fresh[0].t : 0,
  };
}

export function maskSpt(spt) {
  if (!spt) return '';
  return `SPT_••••${spt.slice(-4)}`;
}

export function maskKey(key) {
  if (!key) return '';
  return `${key.slice(0, Math.min(3, key.length))}••••${key.slice(-4)}`;
}

function formatDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
}

/** The message the user receives: title names the target, body names each available GPU by index. */
export function renderMessage({ target, hostname, gpus, watch, durationMs }) {
  const name = target || 'GPU 监控';
  const title = `【${hostname && hostname !== name ? `${name} · ${hostname}` : name}】GPU 余量达标`;
  const minimum = watch?.minFreeGb > 0 ? `（每块 ≥${watch.minFreeGb} GB）` : '';
  const listed = (gpus || []).slice(0, LISTED_GPUS).map((g) =>
    `GPU ${g.index}｜可用 ${((g.memTotal - g.memUsed) / 1024).toFixed(1)} GB｜利用率 ${Math.round(g.util)}%`);
  const more = (gpus || []).length > LISTED_GPUS ? [`等 ${gpus.length} 块`] : [];
  return {
    content: [
      title,
      `当前 ${(gpus || []).length} 块 GPU 可用${minimum}`,
      ...listed,
      ...more,
      `已持续满足 ${formatDuration(durationMs)}`,
    ].join('\n'),
    summary: `${(gpus || []).length} 块 GPU 可用 · ${name}`.slice(0, 20),
  };
}

/** WxPusher simple SPT push. Injectable fetch keeps the sender testable. */
export function createSptSender({ fetchImpl = fetch } = {}) {
  return async function send(spt, { content, summary }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetchImpl(PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spt, content, summary, contentType: 1 }),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !(body?.success === true || body?.code === 1000)) {
        throw new Error(body?.msg || `HTTP ${res.status}`);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Server酱 Turbo: one POST to sctapi.ftqq.com, title is the first line. */
export function createServerChanSender({ fetchImpl = fetch } = {}) {
  return async function send(key, { content, summary }) {
    const [title, ...rest] = String(content).split('\n');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetchImpl(`${SERVERCHAN_URL}/${encodeURIComponent(key)}.send`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title: title.slice(0, 32), desp: rest.join('\n\n') || summary || title }).toString(),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !(body?.code === 0 || body?.data?.code === 0)) {
        throw new Error(body?.message || body?.info || `HTTP ${res.status}`);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  };
}

async function desktopNotify({ title, body }) {
  if (!process.versions.electron) return;
  try {
    const { Notification } = await import('electron');
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch {}
}

const emptyConfig = () => ({
  channel: 'spt',
  spt: '',
  serverchanKey: '',
  enabled: true,
  defaults: { ...DEFAULT_WATCH },
  rule: { ...DEFAULT_RULE },
  watch: null,
  lastNotify: null,
});

export function createNotifier({
  dataDir,
  pollMs = 2000,
  fetchImpl = fetch,
  retryDelays = [1000, 3000, 9000],
  notifyDesktop = desktopNotify,
  now = Date.now,
} = {}) {
  const file = join(dataDir, 'notify.json');
  const senders = {
    spt: createSptSender({ fetchImpl }),
    serverchan: createServerChanSender({ fetchImpl }),
  };
  const keyFor = (channel) => (channel === 'serverchan' ? config.serverchanKey : config.spt);
  const configuredChannels = () => ['spt', 'serverchan'].filter((channel) => Boolean(keyFor(channel)));
  const channelLabel = (channel) => (channel === 'serverchan' ? 'Server酱' : 'WxPusher');
  let config = emptyConfig();
  let window = [];
  let targetGen = 0;
  let unknownAt = null;
  let pushRetryAt = 0;
  let pushing = false;
  let stopped = false;
  let lastTarget = null;
  let fileQueue = Promise.resolve();

  const wait = (ms) => new Promise((done) => setTimeout(done, ms));

  function save() {
    const body = JSON.stringify(config, null, 2) + '\n';
    const task = fileQueue.then(async () => {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      try {
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, file);
      } finally {
        await unlink(tmp).catch(() => {});
      }
    });
    fileQueue = task.catch(() => {});
    return task;
  }

  function view() {
    return {
      channel: config.channel,
      spt: maskSpt(config.spt),
      serverchanKey: maskKey(config.serverchanKey),
      hasSpt: Boolean(config.spt),
      hasServerchan: Boolean(config.serverchanKey),
      ready: configuredChannels().length > 0,
      enabled: config.enabled,
      defaults: { ...config.defaults },
      rule: { ...config.rule },
      watch: config.watch && { ...config.watch },
      lastNotify: config.lastNotify && { ...config.lastNotify },
      pushRetryAt,
    };
  }

  function state() {
    return {
      channel: config.channel,
      hasSpt: Boolean(config.spt),
      hasServerchan: Boolean(config.serverchanKey),
      ready: configuredChannels().length > 0,
      enabled: config.enabled,
      watch: config.watch && { ...config.watch },
      lastNotify: config.lastNotify && { ...config.lastNotify },
      pushRetryAt,
    };
  }

  async function load() {
    let raw;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return;
    }
    const merged = emptyConfig();
    try {
      if (typeof raw.spt === 'string' && SPT_RE.test(raw.spt)) merged.spt = raw.spt;
      if (typeof raw.serverchanKey === 'string' && SERVERCHAN_KEY_RE.test(raw.serverchanKey)) merged.serverchanKey = raw.serverchanKey;
      if (CHANNELS.has(raw.channel)) merged.channel = raw.channel;
      if (typeof raw.enabled === 'boolean') merged.enabled = raw.enabled;
      merged.defaults.cards = pickNumber(raw.defaults?.cards, 1, 32, true, merged.defaults.cards);
      merged.defaults.minFreeGb = pickNumber(raw.defaults?.minFreeGb, 0, 1024, false, merged.defaults.minFreeGb);
      merged.rule.utilIdlePct = pickNumber(raw.rule?.utilIdlePct, 0, 100, false, merged.rule.utilIdlePct);
      merged.rule.windowSec = pickNumber(raw.rule?.windowSec, 60, 1800, false, merged.rule.windowSec);
      merged.rule.tolerance = pickNumber(raw.rule?.tolerance, 0, 0.5, false, merged.rule.tolerance);
      merged.watch = {
        cards: pickNumber(raw.watch?.cards, 1, 32, true, NaN),
        minFreeGb: pickNumber(raw.watch?.minFreeGb, 0, 1024, false, NaN),
        createdAt: pickNumber(raw.watch?.createdAt, 0, Number.MAX_SAFE_INTEGER, true, 0),
      };
      if (!(merged.watch.cards >= 1) || merged.watch.minFreeGb !== merged.watch.minFreeGb) merged.watch = null;
      if (raw.lastNotify && typeof raw.lastNotify === 'object') {
        merged.lastNotify = {
          at: pickNumber(raw.lastNotify.at, 0, Number.MAX_SAFE_INTEGER, true, 0),
          ok: raw.lastNotify.ok === true,
          error: typeof raw.lastNotify.error === 'string' ? raw.lastNotify.error.slice(0, 200) : null,
          cards: Array.isArray(raw.lastNotify.cards) ? raw.lastNotify.cards.filter(Number.isInteger).slice(0, 32) : [],
        };
      }
    } catch {
      return;
    }
    config = merged;
  }

  async function update(input) {
    const next = { ...config, defaults: { ...config.defaults }, rule: { ...config.rule } };
    if ('spt' in input) {
      const spt = String(input.spt ?? '').trim();
      // A masked echo from the panel keeps the stored SPT instead of clearing it.
      if (!MASKED_SPT_RE.test(spt)) {
        if (spt && !SPT_RE.test(spt)) throw bad('SPT 格式不正确');
        next.spt = spt;
      }
    }
    if ('serverchanKey' in input) {
      const key = String(input.serverchanKey ?? '').trim();
      // A masked echo from the panel keeps the stored SendKey instead of clearing it.
      if (!MASKED_KEY_RE.test(key)) {
        if (key && !SERVERCHAN_KEY_RE.test(key)) throw bad('Server酱 SendKey 格式不正确');
        next.serverchanKey = key;
      }
    }
    if ('channel' in input) {
      if (!CHANNELS.has(input.channel)) throw bad('未知的通知通道');
      next.channel = input.channel;
    }
    if ('enabled' in input) {
      if (typeof input.enabled !== 'boolean') throw bad('enabled 必须是布尔值');
      next.enabled = input.enabled;
    }
    if (input.defaults && typeof input.defaults === 'object') {
      if ('cards' in input.defaults) next.defaults.cards = pickNumber(input.defaults.cards, 1, 32, true);
      if ('minFreeGb' in input.defaults) next.defaults.minFreeGb = pickNumber(input.defaults.minFreeGb, 0, 1024, false);
    }
    if (input.rule && typeof input.rule === 'object') {
      if ('utilIdlePct' in input.rule) next.rule.utilIdlePct = pickNumber(input.rule.utilIdlePct, 0, 100, false);
      if ('windowSec' in input.rule) next.rule.windowSec = pickNumber(input.rule.windowSec, 60, 1800, false);
      if ('tolerance' in input.rule) next.rule.tolerance = pickNumber(input.rule.tolerance, 0, 0.5, false);
    }
    config = next;
    await save();
    return view();
  }

  async function startWatch(input = {}) {
    const cards = pickNumber(input.cards ?? config.defaults.cards, 1, 32, true);
    const minFreeGb = pickNumber(input.minFreeGb ?? config.defaults.minFreeGb, 0, 1024, false);
    config = { ...config, watch: { cards, minFreeGb, createdAt: now() } };
    window = [];
    unknownAt = null;
    pushRetryAt = 0;
    await save();
    return view();
  }

  async function cancelWatch() {
    config = { ...config, watch: null };
    window = [];
    pushRetryAt = 0;
    await save();
    return view();
  }

  function resetTarget(gen = 0) {
    targetGen = gen;
    window = [];
    unknownAt = null;
    pushRetryAt = 0;
  }

  function markUnknown() {
    if (unknownAt == null) unknownAt = now();
  }

  function onSample(snapshot, gen) {
    if (stopped || gen !== targetGen) return Promise.resolve();
    const at = now();
    // A live session that was gone for longer than 2 minutes starts a fresh window.
    if (unknownAt != null && at - unknownAt >= UNKNOWN_MS) window = [];
    unknownAt = null;
    lastTarget = { target: snapshot.target, host: snapshot.host };
    if (!config.watch || !config.enabled) return Promise.resolve();

    const count = availableGpus(snapshot.gpus, config.watch, config.rule).length;
    window.push({ t: snapshot.sampledAt, count });
    window = window.filter((s) => s.t >= at - config.rule.windowSec * 1000 - pollMs);
    if (!configuredChannels().length || at < pushRetryAt || pushing) return Promise.resolve();

    const result = evaluateWindow(window, config.watch, config.rule, at, pollMs);
    if (!result.qualified) return Promise.resolve();
    return push(snapshot, availableGpus(snapshot.gpus, config.watch, config.rule), result).catch(() => {});
  }

  async function push(snapshot, gpus, result) {
    const watch = config.watch;
    const channels = configuredChannels().map((channel) => ({ channel, key: keyFor(channel) }));
    const message = renderMessage({
      target: snapshot.target,
      hostname: snapshot.host,
      gpus,
      watch,
      durationMs: result.durationMs,
    });
    pushing = true;
    const results = await Promise.allSettled(
      channels.map(({ channel, key }) => sendWithRetry(channel, key, message)),
    );
    pushing = false;
    if (stopped) return;
    const failures = results
      .map((r, i) => (r.status === 'rejected'
        ? `${channelLabel(channels[i].channel)}：${String(r.reason?.message || r.reason).slice(0, 160)}`
        : null))
      .filter(Boolean);
    if (results.some((r) => r.status === 'fulfilled')) {
      config = {
        ...config,
        // A watch replaced or cancelled while the push was in flight must survive.
        watch: config.watch === watch ? null : config.watch,
        lastNotify: { at: now(), ok: true, error: failures.join('；') || null, cards: gpus.map((g) => g.index) },
      };
      pushRetryAt = 0;
      await save();
      return;
    }
    const error = failures.join('；').slice(0, 200) || '推送失败';
    config = {
      ...config,
      lastNotify: { at: now(), ok: false, error, cards: gpus.map((g) => g.index) },
    };
    pushRetryAt = now() + RETRY_AFTER_MS;
    await save();
    await notifyDesktop({ title: `${snapshot.target} · 微信通知失败`, body: error });
  }

  async function sendWithRetry(channel, key, message) {
    let lastError;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      if (attempt) await wait(retryDelays[attempt - 1]);
      if (stopped) throw new Error('已停止');
      try {
        await senders[channel](key, message);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  async function test() {
    const channels = configuredChannels().map((channel) => ({ channel, key: keyFor(channel) }));
    if (!channels.length) return { ok: false, error: '未配置通知通道' };
    const message = {
      content: `【${lastTarget?.target || 'GPU 监控'}】测试消息\n通知已连接，余量达标时会推送到这里。`,
      summary: 'GPU 监控测试消息',
    };
    const results = await Promise.allSettled(
      channels.map(({ channel, key }) => senders[channel](key, message)),
    );
    const failures = results
      .map((r, i) => (r.status === 'rejected'
        ? `${channelLabel(channels[i].channel)}：${String(r.reason?.message || r.reason).slice(0, 160)}`
        : null))
      .filter(Boolean);
    return { ok: results.some((r) => r.status === 'fulfilled'), error: failures.join('；') || null };
  }

  function stop() {
    stopped = true;
  }

  return { load, stop, resetTarget, markUnknown, onSample, update, startWatch, cancelWatch, test, view, state };
}

function pickNumber(value, min, max, integer, fallback = undefined) {
  if (value == null || value === '') {
    if (fallback !== undefined) return fallback;
    throw bad('缺少数值');
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw bad(`数值需在 ${min}–${max} 之间${integer ? '且为整数' : ''}`);
  }
  return n;
}