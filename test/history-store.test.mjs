import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHistoryStore } from '../history.mjs';

test('a pending append finishes before the same history file is reloaded', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gpu-monitor-history-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'history.jsonl');
  const store = createHistoryStore({ dataDir: dir });
  await store.use(file);

  const row = { t: Date.now(), util: [5], mem: [1024], temp: [40] };
  store.append(row);
  const write = store.persist(row, file);
  await store.use(file);
  await write;

  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 1);
  assert.equal(store.window(row.t, row.t + 1).util[0][0], 5);
});

test('reload keeps valid rows and drops expired or malformed ones', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gpu-monitor-history-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'history.jsonl');
  const now = Date.now();
  const good = { t: now - 1000, util: [7], mem: [2048], temp: [50] };
  const expired = { t: now - 25 * 3600000, util: [99], mem: [0], temp: [0] };
  await writeFile(file, [JSON.stringify(good), 'not json', JSON.stringify(expired)].join('\n') + '\n');
  const store = createHistoryStore({ dataDir: dir });
  await store.use(file);

  const win = store.window(good.t, good.t + 1);
  assert.deepEqual(win.util[0], [7]);
  assert.equal(win.t.length, 1);
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 1);
});
