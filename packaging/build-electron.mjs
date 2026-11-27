import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { packager } from '@electron/packager';
import { embedMacUpdater, macUpdaterConfig } from './embed-mac-updater.mjs';

const [platform, arch] = process.argv.slice(2);
const mac = platform === 'darwin';
const updaterConfig = mac ? macUpdaterConfig(arch, process.env) : undefined;
const name = 'GPU Monitor';
const dist = resolve('dist');
const cache = resolve('.cache');
await mkdir(cache, { recursive: true });
const staging = await mkdtemp(join(cache, 'electron-'));
const source = join(staging, 'app');
const output = `GPU-Monitor-Electron-${mac ? 'macos' : 'windows'}-${arch}`;

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

try {
  await mkdir(join(source, 'public'), { recursive: true });
  for (const file of ['desktop.mjs', 'desktop-lifecycle.mjs', 'windows-updater.mjs', 'migrate.mjs', 'history.mjs', 'server.mjs', 'package.json', 'package-lock.json',
    'public/index.html', 'public/app.css', 'public/app.js', 'public/charts.js',
    'public/favicon.png', 'public/gpu-monitor.png']) {
    await copyFile(file, join(source, file));
  }
  run('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], source);

  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const zip = join(staging, output + '.zip');
  if (mac) {
    await rm(join(source, 'package-lock.json'));
    const [bundle] = await packager({
      dir: source,
      out: staging,
      name,
      icon: resolve('packaging/icons/gpu-monitor'),
      platform,
      arch,
      electronVersion: pkg.devDependencies.electron,
      appBundleId: 'local.gpu-monitor',
      prune: false,
    });
    const app = join(bundle, name + '.app');
    if (updaterConfig) await embedMacUpdater(app, staging, cache, arch, updaterConfig);
    run('codesign', ['--force', '--deep', '--sign', '-', app]);
    run('codesign', ['--verify', '--deep', '--strict', app]);
    run('ditto', ['-c', '-k', '--keepParent', app, zip]);
  } else {
    const { build, Platform, Arch } = await import('electron-builder');
    const installerDir = join(staging, 'installer');
    await build({
      projectDir: source,
      targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
      publish: 'never',
      config: {
        appId: 'local.gpu-monitor',
        productName: name,
        electronVersion: pkg.devDependencies.electron,
        npmRebuild: false,
        directories: { output: installerDir },
        win: {
          icon: resolve('packaging/icons/gpu-monitor.ico'),
          artifactName: 'GPU-Monitor-Setup-${version}-x64.exe',
        },
        nsis: { oneClick: false, allowToChangeInstallationDirectory: true, differentialPackage: false },
        publish: {
          provider: 'generic',
          url: 'https://github.com/FIREGUXBA/gpu-monitor/releases/latest/download/',
        },
      },
    });
    const bundle = join(installerDir, 'win-unpacked');
    await rm(join(bundle, 'resources', 'app-update.yml'));
    await rename(bundle, join(staging, output));
    run('zip', ['-qr', zip, output], staging);
    await mkdir(dist, { recursive: true });
    for (const file of [`GPU-Monitor-Setup-${pkg.version}-x64.exe`, 'latest.yml']) {
      await rename(join(installerDir, file), join(dist, file));
      console.log(join(dist, file));
    }
  }
  run('unzip', ['-tq', zip]);
  await mkdir(dist, { recursive: true });
  await rename(zip, join(dist, output + '.zip'));
  console.log(join(dist, output + '.zip'));
} finally {
  await rm(staging, { recursive: true, force: true });
}
