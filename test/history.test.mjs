import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('history queries cover the last day, preserve missing readings and bound long responses', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gpu-monitor-history-'));
  process.env.GPU_MONITOR_DATA_DIR = dir;
  delete process.env.SSH_HOST;
  const monitor = await import('../server.mjs');
  t.after(async () => {
    await monitor.stopMonitor();
    await rm(dir, { recursive: true, force: true });
  });

  const hour = 3600000;
  const now = Date.now();
  const expired = now - 25 * hour;
  const old = now - 23 * hour + 60000;
  const recent = now - 3 * hour;
  const rows = [
    { t: expired, util: [99] },
    { t: old, util: [20] },
    { t: old + 2000, util: [40, 30], mem: [1024, 4096], temp: [52, 60] },
    { t: recent, util: [80], mem: [8192], temp: [73], taskMem: [[['200:start', 'legacy #200', 4096]]] },
    { t: now - 2000, util: [5], mem: [2048], temp: [40] },
    { t: now - 1000, util: [5], mem: [2048], temp: [40], taskMem: [[['100:start', 'train #100', 1024, 'trainer']]] },
  ];
  await writeFile(join(dir, 'history.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await monitor.startMonitor();

  const request = (query) => monitor.handleRequest(new Request(`http://localhost/api/state?${new URLSearchParams(query)}`));
  const history = async (query) => (await (await request(query)).json()).history;
  assert.deepEqual(await history({ from: old, to: old + 2000 }), {
    step: 2000,
    t: [old, old + 2000],
    util: [[20, 40], [null, 30]],
    mem: [[null, 1024], [null, 4096]],
    temp: [[null, 52], [null, 60]],
    taskMem: [[null, null], [null, null]],
  });
  assert.deepEqual((await history({ from: old + 1, to: recent - 1 })).util[0].filter((v) => v != null), [40]);
  assert.deepEqual((await history({ from: expired - 1000, to: expired + 1000 })).t, []);
  const short = await history({ minutes: 5 });
  assert.deepEqual(short.util[0], [5, 5]);
  assert.deepEqual(short.taskMem[0], [null, [['100:start', 'train #100', 1024, 'trainer']]]);
  assert.equal((await request({ from: recent, to: old })).status, 400);

  const day = await history({ from: now - 24 * hour, to: now });
  assert.ok(day.t.length <= 720);
  assert.ok(day.util[0].includes(null));
  assert.deepEqual(day.util[0].filter((v) => v != null), [30, 80, 5]);
  assert.deepEqual(day.temp[0].filter((v) => v != null), [52, 73, 40]);
  assert.deepEqual(day.taskMem[0].filter((v) => v != null), [
    [['200:start', 'legacy #200', 4096, null]],
    [['100:start', 'train #100', 512, 'trainer']],
  ]);
});
