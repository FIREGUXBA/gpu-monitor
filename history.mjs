import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const METRICS = ['util', 'mem', 'temp'];

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// One owner for the in-memory series, the JSONL file and their order. Reads and writes share a
// queue so a reload cannot overwrite an append that is still in flight.
export function createHistoryStore({ dataDir, pollMs = 2000, retainMs = 86400000, compactEvery = 1800 }) {
  const history = { step: pollMs, t: [], util: [], mem: [], temp: [], taskMem: [] };
  let file = join(dataDir, 'history.jsonl');
  let appendCount = 0;
  let queue = Promise.resolve();
  let useToken = 0;

  const exclusive = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  function clear() {
    for (const key of ['t', ...METRICS, 'taskMem']) history[key].length = 0;
    history.step = pollMs;
  }

  function append(row) {
    for (const metric of METRICS) {
      const series = history[metric];
      while (series.length < row.util.length) series.push(Array(history.t.length).fill(null));
      series.forEach((values, i) => values.push(num(row[metric]?.[i])));
    }
    while (history.taskMem.length < row.util.length) history.taskMem.push(Array(history.t.length).fill(null));
    history.taskMem.forEach((values, i) => values.push(row.taskMem?.[i] ?? null));
    history.t.push(row.t);
  }

  function trim(now) {
    let drop = 0;
    while (history.t[drop] < now - retainMs) drop++;
    if (!drop) return;
    history.t.splice(0, drop);
    for (const metric of METRICS) history[metric].forEach((values) => values.splice(0, drop));
    history.taskMem.forEach((values) => values.splice(0, drop));
  }

  async function compact(target) {
    try {
      const raw = await readFile(target, 'utf8');
      const cutoff = Date.now() - retainMs;
      const kept = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          if (JSON.parse(line).t >= cutoff) kept.push(line);
        } catch {}
      }
      const tmp = target + '.tmp';
      await writeFile(tmp, kept.length ? kept.join('\n') + '\n' : '');
      await rename(tmp, target);
    } catch {}
  }

  async function use(nextFile) {
    file = nextFile;
    const token = ++useToken;
    clear();
    await exclusive(async () => {
      if (token !== useToken) return;
      let raw;
      try {
        raw = await readFile(nextFile, 'utf8');
      } catch {
        return;
      }
      if (token !== useToken) return;
      const cutoff = Date.now() - retainMs;
      const kept = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!row || !Number.isFinite(row.t) || !Array.isArray(row.util)) continue;
        if (row.t < cutoff) continue;
        kept.push(line);
        append(row);
      }
      try {
        await writeFile(nextFile, kept.length ? kept.join('\n') + '\n' : '');
      } catch {}
    });
  }

  async function persist(row, target = file) {
    await exclusive(async () => {
      try {
        await mkdir(dataDir, { recursive: true });
        await appendFile(target, JSON.stringify(row) + '\n');
        appendCount++;
        if (appendCount >= compactEvery) {
          appendCount = 0;
          await compact(target);
        }
      } catch {}
    });
  }

  function window(from, to) {
    const start = history.t.findIndex((time) => time >= from);
    if (start < 0 || history.t[start] > to) return { step: pollMs, t: [], util: [], mem: [], temp: [], taskMem: [] };
    let end = start;
    while (end < history.t.length && history.t[end] <= to) end++;

    if (to - from <= 1100 * pollMs) {
      const result = { step: pollMs, t: history.t.slice(start, end) };
      for (const metric of METRICS) result[metric] = history[metric].map((values) => values.slice(start, end));
      result.taskMem = history.taskMem.map((values) => values.slice(start, end));
      return result;
    }

    // Cap the response size and keep unobserved intervals on the time axis.
    const step = Math.ceil((to - from + 1) / 720);
    const count = Math.floor((to - from) / step) + 1;
    const buckets = Array.from({ length: count }, () => []);
    for (let i = start; i < end; i++) buckets[Math.floor((history.t[i] - from) / step)].push(i);
    const result = { step, t: buckets.map((_, i) => from + i * step) };
    for (const metric of METRICS) {
      result[metric] = history[metric].map((values) => buckets.map((indices) => {
        let sum = 0, seen = 0;
        for (const i of indices) {
          if (values[i] == null) continue;
          sum += values[i];
          seen++;
        }
        return seen ? Math.round(sum / seen * 10) / 10 : null;
      }));
    }
    result.taskMem = history.taskMem.map((values, gpu) => buckets.map((indices) => {
      let samples = 0;
      let recorded = false;
      const sums = new Map();
      for (const i of indices) {
        if (history.mem[gpu][i] == null) continue;
        samples++;
        if (values[i] == null) continue;
        recorded = true;
        for (const [key, label, mib, user] of values[i]) {
          const previous = sums.get(key);
          sums.set(key, [label, (previous?.[1] ?? 0) + mib, user ?? previous?.[2] ?? null]);
        }
      }
      // Divide by every total-memory sample, including samples before a task started.
      return recorded ? [...sums].map(([key, [label, sum, user]]) => [key, label, sum / samples, user]) : null;
    }));
    return result;
  }

  return {
    append,
    trim,
    use,
    persist,
    window,
    get file() {
      return file;
    },
  };
}
