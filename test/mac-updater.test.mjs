import assert from 'node:assert/strict';
import test from 'node:test';
import { macUpdaterConfig } from '../packaging/embed-mac-updater.mjs';

test('macOS packaging chooses a separate updates feed for each architecture', () => {
  const publicKey = Buffer.alloc(32, 1).toString('base64');
  const env = { SPARKLE_PUBLIC_ED_KEY: publicKey };
  assert.equal(macUpdaterConfig('arm64', {}), undefined);
  assert.deepEqual(macUpdaterConfig('arm64', env), {
    publicKey,
    feed: 'https://github.com/FIREGUXBA/gpu-monitor/releases/latest/download/appcast-macos-arm64.xml',
  });
  assert.match(macUpdaterConfig('x64', env).feed, /appcast-macos-x64\.xml$/);
});

test('macOS packaging rejects malformed keys, insecure feeds and URL credentials', () => {
  const publicKey = Buffer.alloc(32, 1).toString('base64');
  assert.throws(() => macUpdaterConfig('arm64', { SPARKLE_PUBLIC_ED_KEY: 'invalid' }), /EdDSA/);
  assert.throws(() => macUpdaterConfig('arm64', { SPARKLE_FEED_URL: 'https://example.com/updates.xml' }), /EdDSA/);
  for (const feed of ['http://localhost/appcast.xml', 'file:///tmp/appcast.xml', 'https://user@example.com/appcast.xml']) {
    assert.throws(() => macUpdaterConfig('arm64', {
      SPARKLE_PUBLIC_ED_KEY: publicKey, SPARKLE_FEED_URL: feed,
    }), /HTTPS/);
  }
  assert.equal(macUpdaterConfig('arm64', {
    SPARKLE_PUBLIC_ED_KEY: publicKey, SPARKLE_FEED_URL: 'https://example.com/appcast.xml',
  }).feed, 'https://example.com/appcast.xml');
});
