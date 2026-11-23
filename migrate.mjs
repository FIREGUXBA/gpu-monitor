import { copyFile, link, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function entries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

const isMonitorFile = (entry) => entry.isFile() &&
  /^(connection\.json|history(?:-[a-f0-9]{12})?\.jsonl)$/.test(entry.name);

export async function migrateSourceData(source, target) {
  const current = await entries(target);
  if (current.some((entry) => entry.name === '.source-migration-done')) return;

  const done = join(target, '.source-migration-done');
  const pending = join(target, '.source-migration-pending');
  if (!current.some((entry) => entry.name === '.source-migration-pending')) {
    if (current.some(isMonitorFile)) {
      await writeFile(done, '');
      return;
    }
    if (!source || source === target) return;
    await mkdir(target, { recursive: true });
    await writeFile(pending, '');
  }

  // An installed copy leaves an interrupted source migration for the next source launch.
  if (!source) throw new Error('源码数据迁移未完成，请从原项目重新启动 GPU Monitor。');
  const files = (await entries(source)).filter(isMonitorFile);
  const staging = await mkdtemp(join(target, '.migration-'));
  try {
    for (const { name } of files) {
      const staged = join(staging, name);
      await copyFile(join(source, name), staged);
      try {
        await link(staged, join(target, name));
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    await rename(pending, done);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
