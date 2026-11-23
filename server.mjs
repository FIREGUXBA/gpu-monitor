import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { Client } from 'ssh2';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DATA_DIR = join(ROOT, 'data');
const HISTORY_DEFAULT = join(DATA_DIR, 'history.jsonl');
const CONN_FILE = join(DATA_DIR, 'connection.json');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const SSH_HOST = process.env.SSH_HOST || '';
const POLL_MS = 2000;
const KEEP = 1100;
const RETAIN_MS = 24 * 3600 * 1000;
const COMPACT_EVERY = 1800;
const REMOTE_TIMEOUT = 9000;
const KC_SERVICE = 'gpu-monitor-ssh';

const controlPathFor = (target) =>
  join(
    os.tmpdir(),
    `gpu-monitor-${createHash('sha1').update(`${os.userInfo().username}:${target}`).digest('hex').slice(0, 8)}.sock`,
  );

const sshArgsFor = (target) => [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=8',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=2',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${controlPathFor(target)}`,
  '-o', 'ControlPersist=120',
  '-o', 'LogLevel=ERROR',
  target,
];

const SAMPLE_SCRIPT = `
GPU=$(nvidia-smi --query-gpu=index,name,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,clocks.sm,mig.mode.current,driver_version --format=csv,noheader,nounits) || exit 1
APPS=$(nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits 2>/dev/null)
PIDS=$(printf '%s\\n' "$APPS" | awk -F',' 'NF>=2 {gsub(/ /,"",$2); if ($2 ~ /^[0-9]+$/ && !seen[$2]++) {printf "%s%s", sep, $2; sep=","}}')
echo '#HOST'
hostname
echo '#UP'
cat /proc/uptime
echo '#GPU'
printf '%s\\n' "$GPU"
echo '#APPS'
printf '%s\\n' "$APPS"
echo '#PS'
if [ -n "$PIDS" ]; then ps -ww -o pid=,user:32=,etimes=,args= -p "$PIDS"; fi
echo '#END'
`;

const CUDA_SCRIPT = `nvidia-smi | sed -n 's/.*CUDA Version: \\([0-9.]*\\).*/\\1/p' | head -n 1`;

const active = { mode: 'key', host: null, port: 22, user: null, fingerprint: null };
let savedConfig = false;
let password = null;
let ssh2Client = null;
let ssh2Ready = false;
let ssh2Connecting = null;
let switching = false;
let generation = 0;
let historyFile = HISTORY_DEFAULT;

const keyTarget = () => (active.mode === 'key' && active.host) || SSH_HOST || null;

const currentTarget = () => (active.mode === 'password' ? active.host : keyTarget());

const targetLabel = () =>
  active.mode === 'password' ? `${active.user}@${active.host}:${active.port}` : keyTarget() || '未选择服务器';

const accountKey = (cfg) => `${cfg.user}@${cfg.host}:${cfg.port}`;

const historyFileFor = (cfg) => {
  const key =
    cfg &&
    (cfg.mode === 'password'
      ? accountKey(cfg)
      : cfg.host && cfg.host !== SSH_HOST
        ? `ssh:${cfg.host}`
        : null);
  return key ? join(DATA_DIR, `history-${createHash('sha1').update(key).digest('hex').slice(0, 12)}.jsonl`) : HISTORY_DEFAULT;
};

const errorWithStatus = (status, message) => {
  const e = new Error(message);
  e.status = status;
  return e;
};

function readJson(req) {
  return new Promise((res, rej) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8192) {
        rej(errorWithStatus(413, '请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        res(JSON.parse(body || '{}'));
      } catch {
        rej(errorWithStatus(400, '请求格式错误'));
      }
    });
    req.on('error', rej);
  });
}

/* ---------- 钥匙串与登录配置 ---------- */

function keychain(args) {
  return new Promise((res, rej) => {
    execFile('security', args, { timeout: 8000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        // 不要回传 err.message，它会包含完整命令行和明文密码
        rej(new Error(String(stderr || '').trim().split('\n')[0] || '钥匙串操作失败'));
      } else {
        res(String(stdout || ''));
      }
    });
  });
}

async function keychainGet(account) {
  try {
    const out = await keychain(['find-generic-password', '-s', KC_SERVICE, '-a', account, '-w']);
    return out.replace(/\n$/, '');
  } catch {
    return null;
  }
}

async function keychainSet(account, pw) {
  await keychain(['add-generic-password', '-U', '-s', KC_SERVICE, '-a', account, '-w', pw]);
}

async function keychainDelete(account) {
  try {
    await keychain(['delete-generic-password', '-s', KC_SERVICE, '-a', account]);
  } catch {}
}

function validConfig(cfg) {
  return Boolean(
    cfg &&
      typeof cfg.host === 'string' && cfg.host &&
      typeof cfg.user === 'string' && cfg.user &&
      Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536,
  );
}

async function writeConfigFile(cfg) {
  await mkdir(DATA_DIR, { recursive: true });
  const body = JSON.stringify(
    cfg.mode === 'password'
      ? { mode: 'password', host: cfg.host, port: cfg.port, user: cfg.user, fingerprint: cfg.fingerprint || null }
      : { mode: 'key', host: cfg.host },
    null,
    2,
  ) + '\n';
  await writeFile(CONN_FILE, body, { mode: 0o600 });
  savedConfig = true;
}

async function loadConnection() {
  try {
    const cfg = JSON.parse(await readFile(CONN_FILE, 'utf8'));
    if (cfg && cfg.mode === 'key') {
      if (typeof cfg.host !== 'string' || !cfg.host) return;
      active.mode = 'key';
      active.host = cfg.host;
      active.port = 22;
      active.user = null;
      active.fingerprint = null;
      historyFile = historyFileFor({ mode: 'key', host: cfg.host });
      savedConfig = true;
      return;
    }
    if (!validConfig(cfg)) return;
    active.mode = 'password';
    active.host = cfg.host;
    active.port = cfg.port;
    active.user = cfg.user;
    active.fingerprint = typeof cfg.fingerprint === 'string' ? cfg.fingerprint : null;
    historyFile = historyFileFor({ ...active, mode: 'password' });
    savedConfig = true;
    password = await keychainGet(accountKey(active));
  } catch {}
}

/* ---------- ssh2 密码连接 ---------- */

const fingerprintOf = (key) =>
  'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');

function connectSsh2(cfg, pw, knownFingerprint) {
  return new Promise((res, rej) => {
    const client = new Client();
    let fingerprint = null;
    let mismatch = false;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {}
      if (mismatch) {
        const e = new Error('主机指纹与上次不一致，服务器可能被冒充或重装过；确认后可勾选“信任新的主机指纹”再试');
        e.code = 'FINGERPRINT_MISMATCH';
        e.fingerprint = fingerprint;
        e.stored = knownFingerprint;
        rej(e);
      } else {
        rej(err);
      }
    };
    client.on('ready', () => {
      if (settled) return;
      settled = true;
      res({ client, fingerprint });
    });
    client.on('error', fail);
    client.connect({
      host: cfg.host,
      port: cfg.port,
      username: cfg.user,
      password: pw,
      readyTimeout: 10000,
      keepaliveInterval: 15000,
      hostVerifier: (key) => {
        fingerprint = fingerprintOf(key);
        if (knownFingerprint && knownFingerprint !== fingerprint) {
          mismatch = true;
          return false;
        }
        return true;
      },
    });
  });
}

function closeSsh2() {
  const client = ssh2Client;
  ssh2Client = null;
  ssh2Ready = false;
  try {
    client?.end();
  } catch {}
}

function getSsh2Client() {
  if (ssh2Client && ssh2Ready) return Promise.resolve(ssh2Client);
  if (ssh2Connecting) return ssh2Connecting;
  ssh2Connecting = (async () => {
    if (!password) throw new Error('钥匙串中找不到这台服务器的密码，请重新登录');
    const { client } = await connectSsh2(active, password, active.fingerprint);
    if (active.mode !== 'password') {
      try {
        client.end();
      } catch {}
      throw new Error('连接目标已切换');
    }
    ssh2Client = client;
    ssh2Ready = true;
    const drop = () => {
      if (ssh2Client === client) {
        ssh2Client = null;
        ssh2Ready = false;
      }
    };
    client.on('close', drop);
    client.on('error', drop);
    return client;
  })().finally(() => {
    ssh2Connecting = null;
  });
  return ssh2Connecting;
}

function execSsh2(client, script) {
  return new Promise((res, rej) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      closeSsh2();
      rej(new Error('SSH 命令超时'));
    }, REMOTE_TIMEOUT);
    client.exec(script, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        if (!done) {
          done = true;
          rej(err);
        }
        return;
      }
      let out = '';
      let errOut = '';
      stream.on('data', (d) => {
        out += d;
      });
      stream.stderr.on('data', (d) => {
        errOut += d;
      });
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        if (code === 0) res(out);
        else rej(new Error(String(errOut).trim().split('\n')[0] || `SSH 命令退出码 ${code}`));
      });
      stream.on('error', (e) => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        rej(e);
      });
    });
  });
}

async function runViaSsh2(script) {
  try {
    return await execSsh2(await getSsh2Client(), script);
  } catch (err) {
    if (!password || active.mode !== 'password') throw err;
    closeSsh2();
    return execSsh2(await getSsh2Client(), script);
  }
}

/* ---------- 系统 ssh（默认免密目标） ---------- */

const execRemoteKey = (script, target) =>
  new Promise((res, rej) => {
    execFile('ssh', [...sshArgsFor(target), script], { timeout: REMOTE_TIMEOUT, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || stdout || err.message || err).trim().split('\n')[0];
        const e = new Error(msg || 'ssh 执行失败');
        e.exitCode = err.code;
        e.killed = err.killed;
        rej(e);
      } else {
        res(String(stdout || ''));
      }
    });
  });

async function runViaKey(script, target = keyTarget()) {
  try {
    return await execRemoteKey(script, target);
  } catch (err) {
    // Mac 睡眠或断网后 ControlMaster 的旧 socket 可能失效，清掉重试一次
    if (err.exitCode === 255 || err.killed) {
      try {
        await unlink(controlPathFor(target));
      } catch {}
      return execRemoteKey(script, target);
    }
    throw err;
  }
}

const runRemote = (script) => (active.mode === 'password' ? runViaSsh2(script) : runViaKey(script));

/* ---------- 采样 ---------- */

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const basename = (p) => p.split('/').pop();

function taskTitle(cmd) {
  const toks = cmd.trim().split(/\s+/);
  const i = toks.findIndex((t) => /\.py$/.test(t) || t.endsWith('llamafactory-cli'));
  if (i < 0) return { title: basename(toks[0] || cmd), sub: toks.slice(1).join(' ') };
  let title = basename(toks[i]);
  let j = i + 1;
  const next = toks[j];
  if (next && !next.startsWith('-') && !next.includes('/') && !next.includes('=')) {
    title += ' ' + next;
    j++;
  }
  const rest = toks.slice(j);
  const cfg = cmd.match(/--config[= ]+(\S+)/);
  if (cfg) title += ' · ' + basename(cfg[1]).replace(/\.(ya?ml|json|py)$/i, '');
  const seedIdx = rest.findIndex((t) => /^--(?:random_)?seed(?:=|$)/.test(t));
  let seedVal = null;
  if (seedIdx >= 0) {
    const tok = rest[seedIdx];
    seedVal = tok.includes('=') ? tok.split('=')[1] : rest[seedIdx + 1];
    rest.splice(seedIdx, tok.includes('=') ? 1 : 2);
  }
  let sub = rest.join(' ');
  if (seedVal != null) sub = `seed ${seedVal} · ${sub}`;
  return { title, sub };
}

function splitSections(out) {
  const parts = {};
  let cur = null;
  for (const line of out.split('\n')) {
    const m = /^#(HOST|UP|GPU|APPS|PS|END)\s*$/.exec(line);
    if (m) {
      cur = m[1];
      parts[cur] = [];
      continue;
    }
    if (cur) parts[cur].push(line);
  }
  return parts;
}

function parseGpus(lines) {
  return lines
    .join('\n')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const p = line.split(',').map((s) => s.trim());
      return {
        index: Number(p[0]),
        name: p[1],
        uuid: p[2],
        util: num(p[3]),
        memUsed: num(p[4]),
        memTotal: num(p[5]),
        temp: num(p[6]),
        power: num(p[7]),
        powerLimit: num(p[8]),
        clock: num(p[9]),
        mig: p[10] || null,
        driver: p[11] || null,
      };
    })
    .sort((a, b) => a.index - b.index);
}

const history = { step: POLL_MS, t: [], util: [], mem: [] };
let snapshot = null;
let lastError = null;
let lastGoodAt = null;
let cudaVersion = null;
let cudaPending = false;
let appendCount = 0;
let compacting = false;

function trimHistory() {
  if (history.t.length <= KEEP) return;
  const drop = history.t.length - KEEP;
  history.t.splice(0, drop);
  history.util.forEach((a) => a.splice(0, Math.min(drop, a.length)));
  history.mem.forEach((a) => a.splice(0, Math.min(drop, a.length)));
}

async function loadHistory(file) {
  historyFile = file;
  history.t.length = 0;
  history.util.length = 0;
  history.mem.length = 0;
  try {
    const raw = await readFile(file, 'utf8');
    const now = Date.now();
    const cutoff = now - RETAIN_MS;
    const memCutoff = now - KEEP * POLL_MS;
    const kept = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row.t !== 'number' || !Array.isArray(row.util)) continue;
      if (row.t < cutoff) continue;
      kept.push(line);
      if (row.t < memCutoff) continue;
      while (history.util.length < row.util.length) history.util.push([]);
      row.util.forEach((v, i) => history.util[i].push(num(v)));
      // rows written before memory was recorded keep their slot, so both series stay aligned with t
      while (history.mem.length < row.util.length) history.mem.push([]);
      row.util.forEach((v, i) => history.mem[i].push(num(row.mem?.[i])));
      history.t.push(row.t);
    }
    trimHistory();
    await writeFile(file, kept.length ? kept.join('\n') + '\n' : '');
  } catch {}
}

async function compactHistory(file = historyFile) {
  if (compacting) return;
  compacting = true;
  try {
    const raw = await readFile(file, 'utf8');
    const cutoff = Date.now() - RETAIN_MS;
    const kept = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        if (JSON.parse(line).t >= cutoff) kept.push(line);
      } catch {}
    }
    const tmp = file + '.tmp';
    await writeFile(tmp, kept.length ? kept.join('\n') + '\n' : '');
    await rename(tmp, file);
  } catch {} finally {
    compacting = false;
  }
}

async function persistHistory(t, util, mem, file = historyFile) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(file, JSON.stringify({ t, util, mem }) + '\n');
    appendCount++;
    if (appendCount >= COMPACT_EVERY) {
      appendCount = 0;
      compactHistory(file);
    }
  } catch {}
}

async function ensureCuda(gen) {
  if (cudaVersion || cudaPending) return;
  cudaPending = true;
  try {
    const out = await runRemote(CUDA_SCRIPT);
    if (gen !== generation) return;
    const m = out.match(/\d+\.\d+/);
    if (m) cudaVersion = m[0];
  } catch {} finally {
    cudaPending = false;
  }
}

function errorSnapshot() {
  return {
    target: targetLabel(),
    host: null,
    cuda: cudaVersion,
    uptime: null,
    sampledAt: null,
    pollMs: POLL_MS,
    gpus: [],
    tasks: [],
    users: [],
    history,
    error: lastError,
  };
}

async function sample(gen) {
  const out = await runRemote(SAMPLE_SCRIPT);
  if (gen !== generation) return;
  const parts = splitSections(out);
  if (!parts.END) throw new Error('远程采样输出不完整');

  const gpus = parseGpus(parts.GPU || []);
  if (!gpus.length) throw new Error('远程 nvidia-smi 未返回显卡');

  const apps = (parts.APPS || [])
    .join('\n')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [uuid, pid, mem] = line.split(',').map((s) => s.trim());
      return { uuid, pid: Number(pid), memMib: parseInt(mem, 10) || 0 };
    });

  const procs = new Map();
  for (const line of parts.PS || []) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (m) procs.set(Number(m[1]), { user: m[2], elapsed: Number(m[3]), cmd: m[4].trim() });
  }

  const byUuid = new Map(gpus.map((g) => [g.uuid, g.index]));
  const tasks = apps
    .filter((a) => procs.has(a.pid) && byUuid.has(a.uuid))
    .map((a) => {
      const p = procs.get(a.pid);
      const { title, sub } = taskTitle(p.cmd);
      return {
        pid: a.pid,
        user: p.user,
        gpu: byUuid.get(a.uuid),
        memMib: a.memMib,
        elapsed: p.elapsed,
        cmd: p.cmd,
        title,
        sub,
      };
    })
    .sort((a, b) => a.gpu - b.gpu || b.memMib - a.memMib);

  const userMap = new Map();
  for (const t of tasks) {
    const u = userMap.get(t.user) || { user: t.user, memMib: 0, tasks: 0 };
    u.memMib += t.memMib;
    u.tasks += 1;
    userMap.set(t.user, u);
  }
  const users = [...userMap.values()].sort((a, b) => b.memMib - a.memMib);

  const host = (parts.HOST || []).map((s) => s.trim()).filter(Boolean).pop() || active.host || SSH_HOST;
  const upSec = parseFloat(((parts.UP || []).join(' ').trim().split(/\s+/))[0]);
  const uptime = Number.isFinite(upSec) ? Math.round(upSec) : null;

  const now = Date.now();
  const utils = gpus.map((g) => g.util);
  const mems = gpus.map((g) => g.memUsed);
  history.t.push(now);
  while (history.util.length < gpus.length) history.util.push([]);
  while (history.mem.length < gpus.length) history.mem.push([]);
  gpus.forEach((g, i) => { history.util[i].push(g.util); history.mem[i].push(g.memUsed); });
  trimHistory();
  if (gen !== generation) return;
  await persistHistory(now, utils, mems, historyFile);
  if (gen !== generation) return;

  snapshot = {
    target: targetLabel(),
    host,
    cuda: cudaVersion,
    uptime,
    sampledAt: now,
    pollMs: POLL_MS,
    gpus,
    tasks,
    users,
    history,
    error: null,
  };
  lastError = null;
  lastGoodAt = now;
  void ensureCuda(gen);
}

async function loop() {
  if (switching) {
    setTimeout(loop, 250);
    return;
  }
  if (!currentTarget()) {
    // 没有默认服务器：等用户在界面里选一台，不反复试连
    snapshot = null;
    lastError = null;
    setTimeout(loop, 1000);
    return;
  }
  const started = Date.now();
  const gen = generation;
  try {
    await sample(gen);
  } catch (err) {
    if (gen === generation) {
      lastError = String(err && err.message ? err.message : err).split('\n')[0].slice(0, 200);
      if (!snapshot) snapshot = errorSnapshot();
    }
  }
  setTimeout(loop, Math.max(250, POLL_MS - (Date.now() - started)));
}

/* ---------- 登录 / 清除 ---------- */

async function loginPassword(input) {
  const host = String(input.host ?? '').trim();
  const port = Number(input.port ?? 22);
  const user = String(input.user ?? '').trim();
  const pw = String(input.password ?? '');
  const trustNew = input.trustNewFingerprint === true;
  if (!host || host.length > 253 || /[\s\0]/.test(host)) throw errorWithStatus(400, '主机地址不合法');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw errorWithStatus(400, '端口需在 1–65535 之间');
  if (!user || user.length > 64 || /[\s\0]/.test(user)) throw errorWithStatus(400, '用户名不合法');
  if (!pw) throw errorWithStatus(400, '请输入密码');
  if (pw.length > 1024) throw errorWithStatus(400, '密码过长');

  const cfg = { host, port, user, fingerprint: null };
  const same = active.mode === 'password' && active.host === host && active.port === port && active.user === user;
  const known = !trustNew && same ? active.fingerprint : null;

  switching = true;
  let probe = null;
  try {
    const { client, fingerprint } = await connectSsh2(cfg, pw, known);
    probe = client;
    cfg.fingerprint = fingerprint;

    const out = await execSsh2(probe, SAMPLE_SCRIPT);
    const parts = splitSections(out);
    if (!parts.END) throw errorWithStatus(502, 'SSH 已连接，但远程采样失败');
    const gpus = parseGpus(parts.GPU || []);
    if (!gpus.length) throw errorWithStatus(502, 'SSH 已连接，但没有读到显卡');
    const hostname = (parts.HOST || []).map((s) => s.trim()).filter(Boolean).pop() || host;

    const oldAccount = active.mode === 'password' ? accountKey(active) : null;
    const newAccount = accountKey(cfg);
    await keychainSet(newAccount, pw);
    try {
      await writeConfigFile({ ...cfg, mode: 'password' });
    } catch (err) {
      await keychainDelete(newAccount);
      throw err;
    }

    closeSsh2();
    active.mode = 'password';
    active.host = host;
    active.port = port;
    active.user = user;
    active.fingerprint = fingerprint;
    password = pw;
    ssh2Client = probe;
    ssh2Ready = true;
    const drop = () => {
      if (ssh2Client === probe) {
        ssh2Client = null;
        ssh2Ready = false;
      }
    };
    probe.on('close', drop);
    probe.on('error', drop);
    if (oldAccount && oldAccount !== newAccount) await keychainDelete(oldAccount);

    generation++;
    cudaVersion = null;
    snapshot = null;
    lastError = null;
    lastGoodAt = null;
    await loadHistory(historyFileFor({ ...active, mode: 'password' }));
    return { ok: true, mode: 'password', target: targetLabel(), host: hostname, gpus: gpus.length };
  } catch (err) {
    if (probe) {
      try {
        probe.end();
      } catch {}
    }
    throw err;
  } finally {
    switching = false;
  }
}

async function loginKey(input) {
  const alias = String(input.host ?? '').trim();
  if (!alias || alias.length > 253 || /[\s\0]/.test(alias) || alias.startsWith('-')) {
    throw errorWithStatus(400, 'SSH 别名或主机不合法');
  }

  switching = true;
  try {
    // 先用目标别名跑一遍采样脚本，确认免密可用后再切换
    const out = await runViaKey(SAMPLE_SCRIPT, alias);
    const parts = splitSections(out);
    if (!parts.END) throw errorWithStatus(502, 'SSH 已连接，但远程采样失败');
    const gpus = parseGpus(parts.GPU || []);
    if (!gpus.length) throw errorWithStatus(502, 'SSH 已连接，但没有读到显卡');
    const hostname = (parts.HOST || []).map((s) => s.trim()).filter(Boolean).pop() || alias;

    const oldAccount = active.mode === 'password' ? accountKey(active) : null;
    await writeConfigFile({ mode: 'key', host: alias });
    closeSsh2();
    password = null;
    active.mode = 'key';
    active.host = alias;
    active.port = 22;
    active.user = null;
    active.fingerprint = null;
    if (oldAccount) await keychainDelete(oldAccount);

    generation++;
    cudaVersion = null;
    snapshot = null;
    lastError = null;
    lastGoodAt = null;
    await loadHistory(historyFileFor({ mode: 'key', host: alias }));
    return { ok: true, mode: 'key', target: targetLabel(), host: hostname, gpus: gpus.length };
  } finally {
    switching = false;
  }
}

async function login(input) {
  if (input.mode === 'key') return loginKey(input);
  return loginPassword(input);
}

async function sshHostAliases() {
  try {
    const raw = await readFile(join(os.homedir(), '.ssh', 'config'), 'utf8');
    const hosts = [];
    for (const line of raw.split('\n')) {
      const m = /^\s*Host\s+(.+?)\s*$/i.exec(line.replace(/#.*/, ''));
      if (!m) continue;
      for (const alias of m[1].split(/\s+/)) {
        if (!alias || /[*?!]/.test(alias) || hosts.includes(alias)) continue;
        hosts.push(alias);
      }
    }
    return hosts;
  } catch {
    return [];
  }
}

async function logout() {
  switching = true;
  try {
    closeSsh2();
    const account = active.mode === 'password' ? accountKey(active) : null;
    try {
      await unlink(CONN_FILE);
    } catch {}
    if (account) await keychainDelete(account);
    active.mode = 'key';
    active.host = null;
    active.port = 22;
    active.user = null;
    active.fingerprint = null;
    savedConfig = false;
    password = null;
    generation++;
    cudaVersion = null;
    snapshot = null;
    lastError = null;
    lastGoodAt = null;
    await loadHistory(HISTORY_DEFAULT);
    return { ok: true, target: targetLabel() };
  } finally {
    switching = false;
  }
}

/* ---------- HTTP ---------- */

const connectionInfo = () =>
  active.mode === 'password'
    ? { mode: 'password', host: active.host, port: active.port, user: active.user }
    : { mode: 'key', host: keyTarget() };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');

  const sendJson = (status, body) => {
    res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/api/state') {
    const configured = Boolean(currentTarget());
    const body = snapshot
      ? {
          ...snapshot,
          error: lastError,
          lastGoodAt,
          configured,
          mode: active.mode,
          saved: savedConfig,
          connection: connectionInfo(),
        }
      : {
          target: configured ? targetLabel() : null,
          host: null,
          sampledAt: null,
          gpus: [],
          tasks: [],
          users: [],
          history,
          error: configured ? '正在采样…' : null,
          pollMs: POLL_MS,
          configured,
          mode: active.mode,
          saved: savedConfig,
          connection: connectionInfo(),
        };
    sendJson(snapshot ? 200 : 503, body);
    return;
  }

  if (url.pathname === '/api/ssh-hosts') {
    if (req.method !== 'GET') {
      sendJson(405, { error: 'method not allowed' });
      return;
    }
    sendJson(200, { default: SSH_HOST || null, hosts: await sshHostAliases() });
    return;
  }

  if (url.pathname === '/api/connection') {
    if (req.method === 'POST') {
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
        sendJson(415, { error: '请使用 application/json' });
        return;
      }
      try {
        const input = await readJson(req);
        const result = await login(input);
        sendJson(200, result);
      } catch (err) {
        const body = { error: String(err.message || err) };
        let status = err.status || 502;
        if (err.code === 'FINGERPRINT_MISMATCH') {
          status = 409;
          body.fingerprint = err.fingerprint;
          body.stored = err.stored;
        } else if (err.level === 'client-authentication') {
          status = 401;
        }
        sendJson(status, body);
      }
      return;
    }
    if (req.method === 'DELETE') {
      try {
        sendJson(200, await logout());
      } catch (err) {
        sendJson(500, { error: String(err.message || err) });
      }
      return;
    }
    sendJson(405, { error: 'method not allowed' });
    return;
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    // 一个残缺的百分号转义不能把进程带走（未处理的 Promise 拒绝会直接退出）
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request');
    return;
  }
  if (path === '/') path = '/index.html';
  const file = resolve(PUBLIC, '.' + path);
  if (!file.startsWith(PUBLIC + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

await loadConnection();
await loadHistory(historyFile);
loop();
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，可能监控已经在运行：http://${HOST}:${PORT}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`GPU 监控（${targetLabel()}）: http://${HOST}:${PORT}`);
  if (!currentTarget()) console.log('尚未选择服务器，请在页面左下角「登录」中选择一台。');
});