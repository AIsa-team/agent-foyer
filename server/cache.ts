/**
 * Stale-while-revalidate for slow reads such as Lark OKRs. A value younger than `fresh` is served as is; an older one
 * (up to `keep`) is served at once while a new read runs in the background; without one, callers wait for the read.
 * Values are also stored in the database, so a restart doesn't make the next reader wait.
 */
import { get, run } from './db.ts';

const memory = new Map<string, { at: number; value: unknown }>();
const loading = new Map<string, Promise<unknown>>();

function stored(key: string): { at: number; value: unknown } | undefined {
  const m = memory.get(key);
  if (m) return m;
  const row = get<{ at: number; value: string }>('SELECT at, value FROM cached_reads WHERE key = ?', key);
  if (!row) return undefined;
  const hit = { at: row.at, value: JSON.parse(row.value) as unknown };
  memory.set(key, hit);
  return hit;
}

function load<T>(key: string, read: () => Promise<T>): Promise<T> {
  const running = loading.get(key);
  if (running) return running as Promise<T>;
  const p = read().then((value) => {
    const at = Date.now();
    memory.set(key, { at, value });
    run(`INSERT INTO cached_reads (key, at, value) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET at = excluded.at, value = excluded.value`, key, at, JSON.stringify(value));
    return value;
  }).finally(() => loading.delete(key));
  loading.set(key, p);
  return p;
}

export function cachedRead<T>(key: string, opts: { fresh: number; keep: number; force?: boolean }, read: () => Promise<T>): Promise<T> {
  const hit = opts.force ? undefined : stored(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < opts.fresh) return Promise.resolve(hit.value as T);
  if (hit && age < opts.keep) {
    load(key, read).catch((e) => console.warn('[cache] background refresh failed', key, (e as Error).message));
    return Promise.resolve(hit.value as T);
  }
  return load(key, read);
}

/** Forgets every cached read whose key starts with `prefix`. */
export function forgetReads(prefix: string) {
  for (const k of memory.keys()) if (k.startsWith(prefix)) memory.delete(k);
  run("DELETE FROM cached_reads WHERE substr(key, 1, length(?)) = ?", prefix, prefix);
}

/** Drops stored values older than `keep`, so the table stays small. */
export function pruneReads(keep: number) {
  run('DELETE FROM cached_reads WHERE at < ?', Date.now() - keep);
}
