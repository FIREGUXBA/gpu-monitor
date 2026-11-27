import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  availableGpus,
  createNotifier,
  evaluateWindow,
  maskSpt,
  renderMessage,
  DEFAULT_RULE,
} from '../notify.mjs';

const RULE = { ...DEFAULT_RULE, windowSec: 60 };

const gpu = (index, util, freeGb) => ({
  index,
  util,
  memTotal: 81920,
  memUsed: 81920 - freeGb * 1024,
});

// Four GPUs; `available` of them idle with plenty of free memory.
const gpus = (available, freeGb = 40) =>
  [0, 1, 2, 3].map((i) => gpu(i, i < available ? 0 : 100, i < available ? freeGb : 1));

const okResponse = () => ({ ok: true, json: async () => ({ success: true }) });

async function setup({ fetchImpl = async () => okResponse(), retryDelays = [0, 0, 0] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gpu-monitor-notify-'));
  const clock = { t: 1_700_000_000_000 };
  const desktops = [];
  const notifier = createNotifier({
    dataDir: dir,
    pollMs: 2000,
    retryDelays,
    fetchImpl,
    notifyDesktop: async (message) => desktops.push(message),
    now: () => clock.t,
  });
  await notifier.update({ spt: 'SPT_abcdefghij', rule: RULE });
  const feed = async (count, available, gen = 0, watch = true) => {
    if (watch) await notifier.startWatch({ cards: 1, minFreeGb: 24 });
    for (let i = 0; i < count; i++) {
      clock.t += 2000;
      await notifier.onSample({ target: 'alpha', host: 'alpha-host', sampledAt: clock.t, gpus: gpus(available) }, gen);
    }
  };
  return { dir, clock, notifier, feed, desktops, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('evaluateWindow needs a full window and a 90% ratio', () => {
  const now = 1_700_000_100_000;
  const watch = { cards: 1, minFreeGb: 0 };
  const spread = (count, ok) =>
    Array.from({ length: count }, (_, i) => ({ t: now - 60000 + Math.round((i * 60000) / (count - 1)), count: i < ok ? 1 : 0 }));

  assert.equal(evaluateWindow([
    { t: now - 20000, count: 1 },
    { t: now - 10000, count: 1 },
  ], watch, RULE, now).qualified, false, 'window not full');
  assert.equal(evaluateWindow(spread(10, 10), watch, RULE, now).qualified, true);
  assert.equal(evaluateWindow(spread(10, 9), watch, RULE, now).qualified, true, 'exactly 90%');
  assert.equal(evaluateWindow(spread(10, 8), watch, RULE, now).qualified, false, '80%');

  const short = spread(10, 10).map((s) => ({ ...s, count: 1 }));
  assert.equal(evaluateWindow(short, { cards: 2, minFreeGb: 0 }, RULE, now).qualified, false, 'count below cards');
});

test('evaluateWindow drops samples from the future', () => {
  const now = 1_700_000_100_000;
  const samples = [
    { t: now - 60000, count: 1 },
    { t: now - 30000, count: 1 },
    { t: now + 10000, count: 99 },
  ];
  assert.equal(evaluateWindow(samples, { cards: 1, minFreeGb: 0 }, RULE, now).samples, 2);
});

test('availableGpus honours utilisation and free memory', () => {
  const gpusIn = [gpu(0, 5, 30), gpu(1, 50, 30), gpu(2, 5, 4), gpu(3, null, 30)];
  assert.deepEqual(availableGpus(gpusIn, { cards: 1, minFreeGb: 24 }).map((g) => g.index), [0]);
  assert.deepEqual(availableGpus(gpusIn, { cards: 1, minFreeGb: 0 }).map((g) => g.index), [0, 2]);
});

test('maskSpt keeps only the last four characters', () => {
  const masked = maskSpt('SPT_abcdefghijkl');
  assert.equal(masked, 'SPT_••••ijkl');
  assert.ok(!masked.includes('abcdefgh'));
  assert.equal(maskSpt(''), '');
});

test('renderMessage covers one, many and more than eight GPUs', () => {
  const watch = { cards: 1, minFreeGb: 24 };
  const one = renderMessage({ target: 'alpha', hostname: 'alpha-host', gpus: [gpu(2, 3, 28.4)], watch, durationMs: 312000 });
  assert.match(one.content, /【alpha · alpha-host】GPU 余量达标/);
  assert.match(one.content, /GPU 2｜可用 28\.4 GB｜利用率 3%/);
  assert.match(one.content, /已持续满足 5 分 12 秒/);
  assert.ok(one.summary.length <= 20);

  const nine = renderMessage({ target: 'alpha', hostname: 'alpha', gpus: Array.from({ length: 9 }, (_, i) => gpu(i, 0, 30)), watch, durationMs: 0 });
  assert.equal(nine.content.match(/GPU \d｜/g).length, 8);
  assert.match(nine.content, /等 9 块/);

  const none = renderMessage({ target: 'alpha', hostname: 'alpha', gpus: [], watch, durationMs: 0 });
  assert.match(none.content, /当前 0 块 GPU 可用/);
});

test('a push retries twice and then succeeds, ending the watch', async (t) => {
  let calls = 0;
  const bodies = [];
  const s = await setup({
    fetchImpl: async (_url, options) => {
      calls++;
      bodies.push(JSON.parse(options.body));
      if (calls < 3) throw new Error('network down');
      return okResponse();
    },
  });
  t.after(s.cleanup);
  await s.feed(35, 2);

  assert.equal(calls, 3);
  assert.equal(bodies[0].spt, 'SPT_abcdefghij');
  assert.match(bodies[0].content, /当前 2 块 GPU 可用（每块 ≥24 GB）/);
  assert.equal(s.notifier.view().watch, null);
  assert.equal(s.notifier.view().lastNotify.ok, true);
  assert.deepEqual(s.notifier.view().lastNotify.cards, [0, 1]);
});

test('a failed push keeps the watch and backs off for 60 seconds', async (t) => {
  const s = await setup({ fetchImpl: async () => { throw new Error('timeout'); } });
  t.after(s.cleanup);
  await s.feed(35, 2);

  const view = s.notifier.view();
  assert.equal(view.watch.cards, 1, 'watch survives a failed push');
  assert.equal(view.lastNotify.ok, false);
  assert.equal(view.lastNotify.error, 'WxPusher：timeout');
  assert.equal(view.pushRetryAt - view.lastNotify.at, 60000);
  assert.equal(s.desktops.length, 1);
  assert.match(s.desktops[0].title, /微信通知失败/);
});

test('a masked SPT echo keeps the stored credential and other fields still apply', async (t) => {
  let sentSpt = null;
  const s = await setup({
    fetchImpl: async (_url, options) => {
      sentSpt = JSON.parse(options.body).spt;
      return okResponse();
    },
  });
  t.after(s.cleanup);

  const masked = s.notifier.view().spt;
  await s.notifier.update({ spt: masked, defaults: { cards: 2, minFreeGb: 8 } });
  assert.equal(s.notifier.view().defaults.cards, 2);
  assert.deepEqual(await s.notifier.test(), { ok: true, error: null });
  assert.equal(sentSpt, 'SPT_abcdefghij');
});

test('invalid config is rejected', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await assert.rejects(s.notifier.update({ spt: 'nope' }), (err) => err.status === 400);
  await assert.rejects(s.notifier.update({ defaults: { cards: 0 } }), (err) => err.status === 400);
  await assert.rejects(s.notifier.update({ rule: { windowSec: 10 } }), (err) => err.status === 400);
  await assert.rejects(s.notifier.startWatch({ cards: 1.5 }), (err) => err.status === 400);
});

test('samples from an old generation never enter the new window', async (t) => {
  let calls = 0;
  const s = await setup({
    fetchImpl: async () => {
      calls++;
      return okResponse();
    },
  });
  t.after(s.cleanup);

  await s.notifier.startWatch({ cards: 1, minFreeGb: 24 });
  s.notifier.resetTarget(2);
  await s.feed(35, 2, 1, false);
  assert.equal(calls, 0, 'stale samples ignored');

  await s.feed(35, 2, 2, false);
  assert.equal(calls, 1, 'fresh samples qualify');
});

test('a switch empties the window but keeps the watch', async (t) => {
  let calls = 0;
  const s = await setup({
    fetchImpl: async () => {
      calls++;
      return okResponse();
    },
  });
  t.after(s.cleanup);

  await s.notifier.startWatch({ cards: 1, minFreeGb: 24 });
  await s.feed(20, 2, 0, false);
  assert.equal(calls, 0);
  s.notifier.resetTarget(5);
  await s.feed(10, 2, 5, false);
  assert.equal(calls, 0, 'window restarts after a switch');
  await s.feed(20, 2, 5, false);
  assert.equal(calls, 1);

  assert.equal(s.notifier.view().watch, null);
});

test('a live session gone for more than two minutes starts a fresh window', async (t) => {
  let calls = 0;
  const s = await setup({
    fetchImpl: async () => {
      calls++;
      return okResponse();
    },
  });
  t.after(s.cleanup);

  await s.notifier.startWatch({ cards: 1, minFreeGb: 24 });
  s.notifier.markUnknown();
  s.clock.t += 121000;
  await s.feed(10, 2, 0, false);
  assert.equal(calls, 0);
  assert.equal(s.notifier.view().watch.cards, 1, 'watch survives the interruption');
});

test('a watch survives a restart', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await s.notifier.startWatch({ cards: 2, minFreeGb: 12 });

  const reloaded = createNotifier({ dataDir: s.dir });
  await reloaded.load();
  assert.deepEqual(reloaded.view().watch?.cards, 2);
  assert.equal(reloaded.view().watch?.minFreeGb, 12);
  assert.equal(reloaded.view().spt, 'SPT_••••ghij');
});

test('Server酱 sends a title and body, then ends the watch', async (t) => {
  let request = null;
  const s = await setup({
    fetchImpl: async (url, options) => {
      request = { url, body: new URLSearchParams(options.body) };
      return { ok: true, json: async () => ({ code: 0 }) };
    },
  });
  t.after(s.cleanup);
  await s.notifier.update({ spt: '', channel: 'serverchan', serverchanKey: 'SCT123456789' });
  await s.feed(35, 2);

  assert.match(request.url, /sctapi\.ftqq\.com\/SCT123456789\.send$/);
  assert.equal(request.body.get('title'), '【alpha · alpha-host】GPU 余量达标');
  assert.match(request.body.get('desp'), /当前 2 块 GPU 可用/);
  assert.match(request.body.get('desp'), /GPU 0｜可用 40\.0 GB/);
  assert.equal(s.notifier.view().watch, null);
  assert.equal(s.notifier.view().lastNotify.ok, true);
});

test('a failed Server酱 response keeps the watch', async (t) => {
  const s = await setup({ fetchImpl: async () => ({ ok: true, json: async () => ({ code: 40001, message: 'bad key' }) }) });
  t.after(s.cleanup);
  await s.notifier.update({ spt: '', channel: 'serverchan', serverchanKey: 'SCT123456789' });
  await s.feed(35, 2);

  assert.equal(s.notifier.view().watch.cards, 1);
  assert.equal(s.notifier.view().lastNotify.error, 'Server酱：bad key');
});

test('a masked SendKey echo keeps the stored key', async (t) => {
  let sentUrl = null;
  const s = await setup({
    fetchImpl: async (url) => {
      sentUrl = url;
      return { ok: true, json: async () => ({ code: 0 }) };
    },
  });
  t.after(s.cleanup);
  await s.notifier.update({ spt: '', channel: 'serverchan', serverchanKey: 'SCT123456789' });
  const masked = s.notifier.view().serverchanKey;
  assert.equal(masked, 'SCT••••6789');

  await s.notifier.update({ serverchanKey: masked });
  assert.deepEqual(await s.notifier.test(), { ok: true, error: null });
  assert.match(sentUrl, /SCT123456789\.send$/);
});

test('no configured credential means no push', async (t) => {
  let calls = 0;
  const s = await setup({
    fetchImpl: async () => {
      calls++;
      return okResponse();
    },
  });
  t.after(s.cleanup);
  await s.notifier.update({ spt: '', channel: 'serverchan', serverchanKey: '' });
  assert.equal(s.notifier.view().ready, false);
  assert.deepEqual(await s.notifier.test(), { ok: false, error: '未配置通知通道' });
  await s.feed(35, 2);
  assert.equal(calls, 0);
  assert.equal(s.notifier.view().watch.cards, 1);
});

test('both configured channels push and either success ends the watch', async (t) => {
  const urls = [];
  const s = await setup({
    fetchImpl: async (url) => {
      urls.push(url);
      return url.includes('sctapi') ? { ok: true, json: async () => ({ code: 0 }) } : okResponse();
    },
  });
  t.after(s.cleanup);
  await s.notifier.update({ channel: 'spt', serverchanKey: 'SCT123456789' });
  await s.feed(35, 2);

  assert.equal(urls.filter((u) => u.includes('wxpusher')).length, 1);
  assert.equal(urls.filter((u) => u.includes('sctapi')).length, 1);
  assert.equal(s.notifier.view().watch, null);
  assert.equal(s.notifier.view().lastNotify.ok, true);
});

test('one failing channel still delivers through the other', async (t) => {
  const s = await setup({
    fetchImpl: async (url) => {
      if (url.includes('sctapi')) throw new Error('serverchan down');
      return okResponse();
    },
  });
  t.after(s.cleanup);
  await s.notifier.update({ channel: 'spt', serverchanKey: 'SCT123456789' });
  await s.feed(35, 2);

  const view = s.notifier.view();
  assert.equal(view.watch, null);
  assert.equal(view.lastNotify.ok, true);
  assert.match(view.lastNotify.error, /Server酱：serverchan down/);
});

test('an invalid SendKey is rejected', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await assert.rejects(s.notifier.update({ serverchanKey: 'no spaces allowed' }), (err) => err.status === 400);
  await assert.rejects(s.notifier.update({ channel: 'email' }), (err) => err.status === 400);
});