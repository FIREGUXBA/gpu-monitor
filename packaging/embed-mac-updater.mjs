import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const sparkleVersion = '2.10.1';
// From Sparkle's Package.swift for this release.
const sparkleChecksum = '4c2e48a3e50ebcc2c88a58a4c7264a1a99c3c31857ce754357afb9cdb323022a';

export function macUpdaterConfig(arch, env) {
  const publicKey = env.SPARKLE_PUBLIC_ED_KEY?.trim();
  const customFeed = env.SPARKLE_FEED_URL;
  if (!publicKey && !customFeed) return;
  if (!publicKey || !/^[A-Za-z0-9+/]{43}=$/.test(publicKey)
      || Buffer.from(publicKey, 'base64').toString('base64') !== publicKey) {
    throw new Error('SPARKLE_PUBLIC_ED_KEY 必须是 Sparkle 提供的 EdDSA 公钥');
  }
  const feed = new URL(customFeed ||
    `https://github.com/FIREGUXBA/gpu-monitor/releases/latest/download/appcast-macos-${arch}.xml`);
  if (feed.protocol !== 'https:' || feed.username || feed.password) {
    throw new Error('SPARKLE_FEED_URL 必须是 HTTPS URL');
  }
  return { publicKey, feed: feed.href };
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

async function sparkleSDK(staging, cache, architecture) {
  const localFramework = process.env.SPARKLE_FRAMEWORK_PATH;
  if (localFramework) {
    const framework = resolve(localFramework);
    return { framework, license: resolve(process.env.SPARKLE_LICENSE_PATH || join(framework, '..', 'LICENSE')) };
  }
  const archive = join(cache, `Sparkle-${sparkleVersion}-SPM.zip`);
  const download = existsSync(archive) ? archive : join(staging, 'Sparkle.zip');
  if (download !== archive) {
    run('curl', ['--fail', '--location', '--retry', '2', '--output', download,
      `https://github.com/sparkle-project/Sparkle/releases/download/${sparkleVersion}/Sparkle-for-Swift-Package-Manager.zip`]);
  }
  const checksum = createHash('sha256').update(await readFile(download)).digest('hex');
  if (checksum !== sparkleChecksum) throw new Error(`Sparkle 下载校验失败，将缓存中的 ${archive} 删除后重试`);
  if (download !== archive) await rename(download, archive);
  const unpacked = join(staging, 'sparkle');
  run('ditto', ['-x', '-k', archive, unpacked]);
  const xcframework = join(unpacked, 'Sparkle.xcframework');
  const libraries = JSON.parse(execFileSync('plutil', [
    '-extract', 'AvailableLibraries', 'json', '-o', '-', join(xcframework, 'Info.plist'),
  ], { encoding: 'utf8' }));
  const slice = libraries.find(({ SupportedPlatform, SupportedArchitectures }) =>
    SupportedPlatform === 'macos' && SupportedArchitectures.includes(architecture));
  if (!slice) throw new Error(`Sparkle SDK 不支持 ${architecture}`);

  const license = join(cache, `Sparkle-${sparkleVersion}-LICENSE`);
  if (!existsSync(license)) {
    const downloadLicense = join(staging, 'Sparkle-LICENSE');
    run('curl', ['--fail', '--location', '--retry', '2', '--output', downloadLicense,
      `https://raw.githubusercontent.com/sparkle-project/Sparkle/${sparkleVersion}/LICENSE`]);
    await rename(downloadLicense, license);
  }
  return { framework: join(xcframework, slice.LibraryIdentifier, slice.LibraryPath), license };
}

export async function embedMacUpdater(app, staging, cache, arch, { publicKey, feed }) {
  const contents = join(app, 'Contents');
  const architecture = arch === 'x64' ? 'x86_64' : arch;
  const { framework, license } = await sparkleSDK(staging, cache, architecture);
  const headerDir = resolve(process.env.NODE_HEADERS_DIR || join(dirname(process.execPath), '..', 'include', 'node'));
  if (!existsSync(join(framework, 'Headers', 'Sparkle.h'))) throw new Error(`缺少 Sparkle SDK 头文件：${framework}`);
  if (!existsSync(join(headerDir, 'node_api.h'))) throw new Error('请通过 NODE_HEADERS_DIR 指定 Node.js 头文件目录');

  await copyFile(license, join(contents, 'Resources', 'Sparkle-LICENSE.txt'));
  run('ditto', [framework, join(contents, 'Frameworks', 'Sparkle.framework')]);
  run('xcrun', ['clang', '-arch', architecture, '-mmacosx-version-min=12.0',
    '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup', '-I', headerDir, '-F', dirname(framework),
    '-framework', 'Cocoa', '-framework', 'Sparkle', '-Wl,-rpath,@executable_path/../Frameworks',
    'packaging/mac-updater.m', '-o', join(contents, 'Frameworks', 'mac-updater.node')]);

  const plist = join(contents, 'Info.plist');
  for (const [key, type, value] of [
    ['SUFeedURL', 'string', feed],
    ['SUPublicEDKey', 'string', publicKey],
    ['SUEnableAutomaticChecks', 'bool', 'YES'],
    ['SUAllowsAutomaticUpdates', 'bool', 'NO'],
    ['SUVerifyUpdateBeforeExtraction', 'bool', 'YES'],
  ]) {
    run('plutil', ['-insert', key, `-${type}`, value, plist]);
  }
}
