import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateSourceData } from '../migrate.mjs';

test('source migration retries without overwriting files or restoring a cleared login', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gpu-monitor-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'desktop');
  await mkdir(source);
  await mkdir(target);
  await writeFile(join(source, 'connection.json'), '{"mode":"key","host":"test"}');
  await writeFile(join(source, 'history.jsonl'), 'source history');
  await writeFile(join(source, 'unrelated'), 'excluded');
  await writeFile(join(target, '.source-migration-pending'), '');
  await writeFile(join(target, 'history.jsonl'), 'desktop history');

  await migrateSourceData(source, target);
  assert.deepEqual((await readdir(target)).sort(), ['.source-migration-done', 'connection.json', 'history.jsonl']);
  assert.equal(await readFile(join(target, 'history.jsonl'), 'utf8'), 'desktop history');
  await rm(join(target, 'connection.json'));
  await migrateSourceData(source, target);
  await assert.rejects(readFile(join(target, 'connection.json')), { code: 'ENOENT' });
  assert.match(await readFile(join(source, 'connection.json'), 'utf8'), /"host":"test"/);
});

test('installed desktop keeps its existing history and connection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gpu-monitor-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'desktop');
  await mkdir(source);
  await mkdir(target);
  await writeFile(join(source, 'history.jsonl'), 'source history');
  await writeFile(join(target, 'connection.json'), 'old desktop connection');
  await migrateSourceData(source, target);
  assert.deepEqual((await readdir(target)).sort(), ['.source-migration-done', 'connection.json']);
  assert.equal(await readFile(join(target, 'connection.json'), 'utf8'), 'old desktop connection');
});

test('shared routes serve the panel and reject malformed login requests', async () => {
  const { handleRequest } = await import('../server.mjs');
  const request = (path, options) => handleRequest(new Request('gpu-monitor://panel' + path, options));
  assert.match(await (await request('/')).text(), /src="\/app.js"/);
  assert.equal((await request('/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await request('/missing')).status, 404);
  assert.equal((await request('/%zz')).status, 400);
  assert.equal((await request('/..%2fpackage.json')).status, 403);
  assert.equal((await (await request('/api/state')).json()).configured, false);
  assert.ok(Array.isArray((await (await request('/api/ssh-hosts')).json()).hosts));

  const login = (body) => request('/api/connection', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  assert.equal((await request('/api/connection', { method: 'POST' })).status, 415);
  assert.equal((await login('null')).status, 400);
  assert.equal((await login('x'.repeat(8193))).status, 413);
  assert.deepEqual(await (await login('{"mode":"key","host":"-abc"}')).json(), { error: 'SSH 别名或主机不合法' });
});
