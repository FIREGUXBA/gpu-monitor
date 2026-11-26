import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { startWindowsUpdater } from '../windows-updater.mjs';

test('Windows checks silently at startup and reports the same check when requested manually', async () => {
  let checks = 0;
  const messages = [];
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {
    checks++;
    await setImmediate();
    return { isUpdateAvailable: false };
  };
  const dialog = { showMessageBox: (_, options) => messages.push(options.message) };
  const manualCheck = startWindowsUpdater(updater, {}, dialog, assert.fail);
  await setImmediate();
  assert.deepEqual(messages, []);
  manualCheck();
  manualCheck();
  await setImmediate();
  assert.equal(checks, 2);
  assert.deepEqual(messages, ['当前已是最新版本。']);
});

test('Windows downloads and restarts only after confirming the update', async () => {
  const actions = [];
  let response = 1;
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => ({
    isUpdateAvailable: true, updateInfo: { version: '0.1.2' },
  });
  updater.downloadUpdate = async () => {
    actions.push('download');
    updater.emit('download-progress', { percent: 50 });
  };
  const window = { setProgressBar: (value) => actions.push(value) };
  const dialog = { showMessageBox: async (_, options) => {
    assert.match(options.message, /0\.1\.2/);
    return { response };
  } };
  const manualCheck = startWindowsUpdater(updater, window, dialog, () => actions.push('install'));
  await setImmediate();
  assert.deepEqual(actions, []);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);

  response = 0;
  manualCheck();
  manualCheck();
  await setImmediate();
  assert.deepEqual(actions, [2, 'download', 0.5, 'install', -1]);
});
