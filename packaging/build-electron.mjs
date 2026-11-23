import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { packager } from '@electron/packager';

const [platform, arch] = process.argv.slice(2);
const mac = platform === 'darwin';
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
  for (const file of ['desktop.mjs', 'migrate.mjs', 'server.mjs', 'package.json', 'package-lock.json',
    'public/index.html', 'public/app.css', 'public/app.js', 'public/charts.js',
    'public/favicon.png', 'public/gpu-monitor.png']) {
    await copyFile(file, join(source, file));
  }
  run('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], source);
  await rm(join(source, 'package-lock.json'));

  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
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

  const zip = join(staging, output + '.zip');
  if (mac) {
    const app = join(bundle, name + '.app');
    run('codesign', ['--force', '--deep', '--sign', '-', app]);
    run('codesign', ['--verify', '--deep', '--strict', app]);
    run('ditto', ['-c', '-k', '--keepParent', app, zip]);
  } else {
    await rename(bundle, join(staging, output));
    run('zip', ['-qr', zip, output], staging);
  }
  run('unzip', ['-tq', zip]);
  await mkdir(dist, { recursive: true });
  await rename(zip, join(dist, output + '.zip'));
  console.log(join(dist, output + '.zip'));
} finally {
  await rm(staging, { recursive: true, force: true });
}
