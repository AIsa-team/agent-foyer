import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { config, paths } from './config.ts';
import { randomToken, sha256 } from './crypto.ts';
import { all, get, now, run } from './db.ts';

const UPLOAD_TTL = 30 * 60 * 1000;

export function createUpload(userId: string, purpose: 'app' | 'skill') {
  const id = 'up_' + randomToken(9);
  const token = randomToken(24);
  run('INSERT INTO uploads (id, token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, sha256(token), userId, purpose, now() + UPLOAD_TTL, now());
  const url = `${config.hubUrl}/upload/${id}?t=${token}`;
  return { id, url };
}

export const uploadFile = (id: string) => path.join(paths.uploads, `${id}.tgz`);

/** Body is a gzipped tarball streamed with `curl --data-binary @file`. */
export async function receiveUpload(id: string, token: string, body: ReadableStream<Uint8Array> | null): Promise<{ ok: true; size: number } | { ok: false; status: number; error: string }> {
  const row = get<{ token_hash: string; status: string; expires_at: number }>('SELECT * FROM uploads WHERE id = ?', id);
  if (!row || row.token_hash !== sha256(token)) return { ok: false, status: 404, error: 'upload not found' };
  if (row.expires_at < now()) return { ok: false, status: 410, error: 'upload link expired, ask the hub for a new one' };
  if (row.status === 'used') return { ok: false, status: 409, error: 'upload already used' };
  if (!body) return { ok: false, status: 400, error: 'empty body' };

  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > config.maxUploadBytes) cb(new Error(`upload larger than ${config.maxUploadBytes / 1024 / 1024} MB`));
      else cb(null, chunk);
    },
  });
  const file = uploadFile(id);
  try {
    await pipeline(Readable.fromWeb(body as import('node:stream/web').ReadableStream), limit, createWriteStream(file));
  } catch (e) {
    rmSync(file, { force: true });
    return { ok: false, status: 413, error: (e as Error).message };
  }
  run("UPDATE uploads SET status = 'received', size = ? WHERE id = ?", size, id);
  return { ok: true, size };
}

/** Marks a received upload as used and returns its file path. */
export function takeUpload(id: string, userId: string, purpose: 'app' | 'skill'): string {
  const row = get<{ user_id: string; status: string; purpose: string }>('SELECT * FROM uploads WHERE id = ?', id);
  if (!row || row.user_id !== userId || row.purpose !== purpose) throw new Error(`upload ${id} not found`);
  if (row.status === 'pending') throw new Error(`upload ${id} has not received any file yet — run the curl upload command first`);
  if (row.status === 'used') throw new Error(`upload ${id} was already used — create a new upload`);
  const file = uploadFile(id);
  if (!existsSync(file)) throw new Error(`upload ${id} file is missing`);
  run("UPDATE uploads SET status = 'used' WHERE id = ?", id);
  return file;
}

/** Extracts only regular files and directories, never symlinks or device files, and never outside dest. */
export async function extractTarball(file: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  await tar.x({
    file,
    cwd: dest,
    strict: true,
    preservePaths: false,
    filter: (_p, entry) => {
      const type = (entry as { type?: string }).type;
      return type === 'File' || type === 'OldFile' || type === 'Directory';
    },
  });
}

/** Deletes upload files that were used or expired. Runs periodically. */
export function cleanupUploads() {
  const stale = all<{ id: string }>("SELECT id FROM uploads WHERE status = 'used' OR expires_at < ?", now() - UPLOAD_TTL);
  for (const { id } of stale) {
    rmSync(uploadFile(id), { force: true });
    run('DELETE FROM uploads WHERE id = ?', id);
  }
}
