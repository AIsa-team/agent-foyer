/**
 * Calls to the Lark open platform, with either the app's tenant token or a person's user token.
 * Lark answers HTTP 200 with a non-zero `code` for most failures; those become LarkError.
 */
import { config } from '../config.ts';

export class LarkError extends Error {
  code: number;
  constructor(path: string, code: number, msg: string) {
    super(`Lark API ${path} failed: ${code} ${msg}`);
    this.code = code;
  }
}

/** Codes Lark uses when the token lacks a scope, or the person has no access to the document. */
export const SCOPE_CODES = new Set([99991672, 99991679, 20027]);
export const DENIED_CODES = new Set([1254302, 91403, 131006, 1001002, 1254040, 1254003]);
export const TOKEN_CODES = new Set([99991668, 99991663, 99991677, 20005, 20026, 20037, 20064]);

export async function larkFetch<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  const res = await fetch(config.lark.apiBase + path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(20_000) });
  const body = (await res.json().catch(() => ({ code: res.status, msg: `HTTP ${res.status}` }))) as { code: number; msg?: string; error_description?: string } & T;
  if (body.code !== 0) throw new LarkError(path, body.code, body.msg ?? body.error_description ?? '');
  return body;
}
