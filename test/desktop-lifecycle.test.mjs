import assert from 'node:assert/strict';
import test from 'node:test';
import { createShutdown } from '../desktop-lifecycle.mjs';

test('a failed startup still stops the monitor before quitting', async () => {
  const calls = [];
  const shutdown = createShutdown({
    startup: async () => {
      calls.push('startup');
      throw new Error('window failed to load');
    },
    stop: async () => calls.push('stop'),
    cleanup: () => calls.push('cleanup'),
    quit: () => calls.push('quit'),
  });

  await shutdown.run();
  assert.deepEqual(calls, ['startup', 'stop', 'cleanup', 'quit']);
  assert.equal(shutdown.started, true);
  assert.equal(shutdown.done, true);
});

test('repeated quit requests run the shutdown once', async () => {
  const calls = [];
  let release;
  const gate = new Promise((done) => { release = done; });
  const shutdown = createShutdown({
    startup: () => gate,
    stop: async () => calls.push('stop'),
    cleanup: () => calls.push('cleanup'),
    quit: () => calls.push('quit'),
  });

  const first = shutdown.run();
  assert.equal(shutdown.run(), undefined);
  release();
  await first;
  assert.deepEqual(calls, ['stop', 'cleanup', 'quit']);
});

test('a stop failure still cleans up and quits', async () => {
  const calls = [];
  const shutdown = createShutdown({
    startup: async () => {},
    stop: async () => {
      calls.push('stop');
      throw new Error('ssh close failed');
    },
    cleanup: () => calls.push('cleanup'),
    quit: () => calls.push('quit'),
    onError: () => calls.push('error'),
  });

  await assert.rejects(shutdown.run(), /ssh close failed/);
  assert.deepEqual(calls, ['stop', 'cleanup', 'quit', 'error']);
});
