import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const waitFor = async (read, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('timed out waiting for the fake ssh target');
};

// A probe against a live target must change nothing when it fails, and a sample already in flight
// for the old target must not land in the new target's snapshot or history after a switch.
test('a failed probe keeps the active target and a late old sample is discarded', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gpu-monitor-session-'));
  const bin = join(dir, 'bin');
  const started = join(dir, 'started');
  const delay = join(dir, 'delay');
  await mkdir(bin);
  const fakeSsh = join(bin, 'ssh');
  await writeFile(fakeSsh, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const target = args[args.length - 2];
const script = args[args.length - 1] || '';
if (script.includes('CUDA Version')) {
  process.stdout.write('12.4\\n');
  process.exit(0);
}
if (target === 'dead') {
  process.stderr.write('connection refused\\n');
  process.exit(1);
}
if (target === 'alpha' && fs.existsSync(${JSON.stringify(delay)})) {
  fs.writeFileSync(${JSON.stringify(started)}, '');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
}
const host = target === 'beta' ? 'beta-host' : 'alpha-host';
process.stdout.write(
  '#HOST\\n' + host + '\\n#UP\\n1000.5 0.0\\n#GPU\\n' +
  '0, Fake GPU, GPU-' + target + ', 10, 1024, 8192, 40, 55, 100, 1200, Disabled, 550.10\\n' +
  '#APPS\\n\\n#PS\\n\\n#END\\n',
);
`);
  await chmod(fakeSsh, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.GPU_MONITOR_DATA_DIR = dir;
  delete process.env.SSH_HOST;
  const monitor = await import('../server.mjs');
  t.after(async () => {
    await monitor.stopMonitor();
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  });

  const request = (path, options) => monitor.handleRequest(new Request('http://localhost' + path, options));
  const login = (host) => request('/api/connection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'key', host }),
  });
  const state = async () => {
    const res = await request('/api/state?minutes=15');
    return { status: res.status, body: await res.json() };
  };

  await monitor.startMonitor();
  assert.equal((await login('alpha')).status, 200);
  const first = await waitFor(async () => {
    const { status, body } = await state();
    return status === 200 && body.sampledAt ? body : null;
  });
  assert.equal(first.target, 'alpha');
  assert.equal(first.host, 'alpha-host');

  const alphaHistory = join(dir, `history-${createHash('sha1').update('ssh:alpha').digest('hex').slice(0, 12)}.jsonl`);
  const alphaLines = (await readFile(alphaHistory, 'utf8')).trim().split('\n').length;

  const failed = await login('dead');
  assert.equal(failed.status, 502);
  const afterFailure = await state();
  assert.equal(afterFailure.status, 200);
  assert.equal(afterFailure.body.target, 'alpha');
  assert.equal(afterFailure.body.host, 'alpha-host');
  assert.ok(afterFailure.body.sampledAt >= first.sampledAt);
  assert.equal(afterFailure.body.saved, true);

  await rm(started, { force: true });
  await writeFile(delay, '');
  await waitFor(async () => {
    try {
      await readFile(started);
      return true;
    } catch {
      return false;
    }
  });

  assert.equal((await login('beta')).status, 200);
  const switched = await state();
  assert.equal(switched.body.target, 'beta');
  // The delayed alpha reply is still in flight; beta has not been sampled yet, so a snapshot here
  // would be the old target's late sample.
  await new Promise((done) => setTimeout(done, 1200));
  const afterSwitch = await state();
  assert.equal(afterSwitch.body.target, 'beta');
  assert.equal(afterSwitch.body.sampledAt, null);
  assert.equal((await readFile(alphaHistory, 'utf8')).trim().split('\n').length, alphaLines);

  const beta = await waitFor(async () => {
    const { status, body } = await state();
    return status === 200 && body.sampledAt ? body : null;
  });
  assert.equal(beta.host, 'beta-host');
});
