import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const sha256b64url = (s: string) => createHash('sha256').update(s).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// The label is historical: changing it would make every stored secret (app env vars, Lark tokens) unreadable.
const key = createHash('sha256').update('aisa-hub:enc:' + config.secret).digest();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

/** Short-lived signed token, e.g. for download links an agent fetches with curl. */
export function signToken(payload: string, ttlMs: number): string {
  const exp = Date.now() + ttlMs;
  const mac = createHmac('sha256', config.secret).update(`${payload}|${exp}`).digest('base64url');
  return `${exp}.${mac}`;
}

export function verifyToken(payload: string, token: string): boolean {
  const [exp, mac] = token.split('.');
  if (!exp || !mac || !Number.isFinite(Number(exp)) || Number(exp) < Date.now()) return false;
  return safeEqual(mac, createHmac('sha256', config.secret).update(`${payload}|${exp}`).digest('base64url'));
}
