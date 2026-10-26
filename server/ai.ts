/**
 * AI resources for the company's apps: models through any OpenAI-compatible provider, and with AIsa also its data
 * APIs (search, social, finance…), all on one key the admins set (bring your own key). Apps never hold the key: they
 * call /__hub/ai/v1/… (models) and /__hub/ai/apis/v1/… (AIsa's APIs) on their own address, as the person using them,
 * and the hub forwards the call with the key, counts it against the app's and the person's daily limits and records
 * it. Only signed-in colleagues get through, so a public app cannot spend the company's credit for strangers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appUrl, config } from './config.ts';
import { decrypt, encrypt } from './crypto.ts';
import { all, get, now, run, type App, type User } from './db.ts';
import { UserError } from './i18n/index.ts';

// ---------------------------------------------------------------- the provider (one per hub)
/** Ready-made providers: the admin picks one and enters a key. */
export const PRESETS = {
  aisa: {
    label: 'AIsa', baseUrl: `${config.aisaApiBase}/v1`, apisUrl: `${config.aisaApiBase}/apis/v1`,
    keyUrl: 'https://console.aisa.one/api-keys', docsUrl: 'https://aisa.one/docs/api-reference',
  },
  openai: { label: 'OpenAI-compatible', baseUrl: '', apisUrl: null, keyUrl: null, docsUrl: null },
} as const;
export type Preset = keyof typeof PRESETS;

interface Stored { preset: Preset; baseUrl: string; apisUrl: string | null; status?: string; checkedAt?: number; models?: string[] }
export interface Limits { perAppPerDay: number; perPersonPerDay: number }
const DEFAULT_LIMITS: Limits = { perAppPerDay: 500, perPersonPerDay: 200 };

const setting = (key: string) => get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
const saveSetting = (key: string, value: string | null) => {
  if (value === null) run('DELETE FROM settings WHERE key = ?', key);
  else run(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, key, value, now());
};

function stored(): Stored | null {
  const s = setting('ai.provider');
  return s ? (JSON.parse(s) as Stored) : null;
}
const keyOf = () => {
  const k = setting('ai.key');
  return k ? decrypt(k) : null;
};
export const aiLimits = (): Limits => ({ ...DEFAULT_LIMITS, ...(JSON.parse(setting('ai.limits') ?? '{}') as Partial<Limits>) });
const disabledApps = () => new Set(JSON.parse(setting('ai.disabledApps') ?? '[]') as string[]);

/** What anyone may know: whether apps can use AI here, through which provider, with which models and limits. */
export function aiStatus() {
  const s = stored();
  if (!s || !keyOf()) return { configured: false as const };
  return {
    configured: true as const, provider: PRESETS[s.preset].label, models: s.models ?? [], dataApis: !!s.apisUrl,
    ...(PRESETS[s.preset].docsUrl ? { docs: PRESETS[s.preset].docsUrl } : {}), limits: aiLimits(),
  };
}

/** For the admin page: the settings without the key, and how the last check went. */
export function aiSettings() {
  const s = stored();
  return {
    presets: Object.entries(PRESETS).map(([id, p]) => ({ id, ...p })),
    provider: s ? { ...s, keySet: !!keyOf() } : null,
    limits: aiLimits(), disabledApps: [...disabledApps()],
  };
}

const normaliseBase = (u: string) => {
  let url: URL;
  try {
    url = new URL(u.trim());
  } catch {
    throw new UserError('err.ai.badUrl');
  }
  if (url.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) throw new UserError('err.ai.badUrl');
  return url.toString().replace(/\/+$/, '');
};

/** Lists the provider's models with the key: proves the address and key work. */
async function listModels(baseUrl: string, key: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new UserError('err.ai.unreachable', { detail: (e as Error).message });
  }
  if (res.status === 401 || res.status === 403) throw new UserError('err.ai.badKey');
  if (!res.ok) throw new UserError('err.ai.unreachable', { detail: `${res.status}` });
  const body = (await res.json().catch(() => ({}))) as { data?: { id: string }[] };
  return (body.data ?? []).map((m) => m.id).filter(Boolean).sort();
}

/**
 * Sets the provider (admins). An empty key keeps the stored one, so the address can change without retyping it.
 * The key is tried before anything is saved.
 */
export async function saveAiProvider(user: User, input: { preset: string; baseUrl?: string; key?: string }) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  if (!(input.preset in PRESETS)) throw new UserError('err.ai.badPreset');
  const preset = input.preset as Preset;
  const p = PRESETS[preset];
  const baseUrl = normaliseBase(p.baseUrl || input.baseUrl || '');
  const key = input.key?.trim() || keyOf();
  if (!key) throw new UserError('err.ai.keyRequired');
  const models = await listModels(baseUrl, key);
  saveSetting('ai.provider', JSON.stringify({ preset, baseUrl, apisUrl: p.apisUrl, status: 'ok', checkedAt: now(), models } satisfies Stored));
  if (input.key?.trim()) saveSetting('ai.key', encrypt(key));
  return aiSettings();
}

export function removeAiProvider(user: User) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  saveSetting('ai.provider', null);
  saveSetting('ai.key', null);
  return aiSettings();
}

export function saveAiLimits(user: User, input: { limits?: Partial<Limits>; disabledApps?: string[] }) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  if (input.limits) {
    const clean = (n: unknown, d: number) => (Number.isFinite(Number(n)) ? Math.max(0, Math.min(1_000_000, Math.round(Number(n)))) : d);
    const cur = aiLimits();
    saveSetting('ai.limits', JSON.stringify({ perAppPerDay: clean(input.limits.perAppPerDay, cur.perAppPerDay), perPersonPerDay: clean(input.limits.perPersonPerDay, cur.perPersonPerDay) }));
  }
  if (input.disabledApps) saveSetting('ai.disabledApps', JSON.stringify([...new Set(input.disabledApps.map(String))]));
  return aiSettings();
}

// ---------------------------------------------------------------- usage
const DAY = 86_400_000;
const since = (days: number) => now() - days * DAY;

/** Calls in the last 24 hours, for the daily limits. */
const callsToday = (col: 'app_slug' | 'user_id', id: string) => get<{ n: number }>(`SELECT COUNT(*) AS n FROM ai_usage WHERE ${col} = ? AND at > ?`, id, since(1))!.n;

/** The admin page's summary: calls and tokens per app over the last days. */
export function aiUsage(user: User, days = 7) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  const rows = all<{ app_slug: string; calls: number; failed: number; prompt: number | null; completion: number | null; people: number }>(
    `SELECT app_slug, COUNT(*) AS calls, SUM(status >= 400) AS failed, SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion, COUNT(DISTINCT user_id) AS people
     FROM ai_usage WHERE at > ? GROUP BY app_slug ORDER BY calls DESC`, since(days));
  return { days, apps: rows.map((r) => ({ app: r.app_slug, calls: r.calls, failed: r.failed, tokens: (r.prompt ?? 0) + (r.completion ?? 0), people: r.people })) };
}

// ---------------------------------------------------------------- forwarding an app's call
const MAX_BODY = 8 * 1024 * 1024;
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((ok, fail) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_BODY) { req.destroy(); ok(null); return; }
      parts.push(d);
    });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', fail);
  });
}

/** Token counts from an OpenAI-style answer, or from the last usage chunk of a stream. */
function usageOf(text: string): { model?: string; prompt?: number; completion?: number } {
  const take = (o: { model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } }) =>
    ({ model: o.model, prompt: o.usage?.prompt_tokens ?? o.usage?.input_tokens, completion: o.usage?.completion_tokens ?? o.usage?.output_tokens });
  try {
    return take(JSON.parse(text));
  } catch { /* a stream */ }
  const chunks = text.split('\n').filter((l) => l.startsWith('data:') && l.includes('"usage"')).map((l) => l.slice(5).trim());
  for (const c of chunks.reverse()) {
    try {
      return take(JSON.parse(c));
    } catch { /* keep looking */ }
  }
  // a large answer whose start was not kept: its usage block is near the end
  const m = /"usage"\s*:\s*(\{[^{}]*\})/.exec(text);
  try {
    return m ? take({ usage: JSON.parse(m[1]) }) : {};
  } catch {
    return {};
  }
}

/**
 * Handles /__hub/ai/v1/… and /__hub/ai/apis/v1/… for an app, as `user` (from the app's session or its server's
 * ticket; `fromBrowser` when it is the session). Answers 401 to visitors who are not signed in, 404 when the hub has
 * no AI provider (or no data APIs for /apis), 403 when admins switched the app off, 429 past a daily limit.
 */
export async function handleAppAi(app: App, user: User | undefined, fromBrowser: boolean, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const s = stored();
  const key = keyOf();
  if (!s || !key) return send(res, 404, { error: 'ai_not_configured', message: 'This hub has no AI provider; an admin sets one on the admin page.' });
  if (!user) return send(res, 401, { error: 'unauthenticated', message: 'AI is for signed-in colleagues.' });
  if (disabledApps().has(app.slug)) return send(res, 403, { error: 'ai_off_for_app', message: 'Admins switched AI off for this app.' });
  const rest = url.pathname.slice('/__hub/ai'.length);
  const target = rest.startsWith('/v1/') ? `${s.baseUrl}${rest.slice(3)}` : rest.startsWith('/apis/v1/') && s.apisUrl ? `${s.apisUrl}${rest.slice(8)}` : null;
  if (!target || rest.includes('..')) return send(res, 404, { error: 'not_found', message: s.apisUrl ? 'Use /__hub/ai/v1/… for models or /__hub/ai/apis/v1/… for data APIs.' : 'Use /__hub/ai/v1/… for models (this provider has no data APIs).' });
  if (req.method !== 'GET' && fromBrowser) {
    // browsers: same-origin JSON only, so another site cannot spend through a colleague's browser
    const origin = req.headers.origin;
    if (origin && origin !== appUrl(app.slug)) return send(res, 403, { error: 'bad_origin' });
    if (!(req.headers['content-type'] ?? '').includes('application/json')) return send(res, 415, { error: 'json_only' });
  }
  const limits = aiLimits();
  if (callsToday('app_slug', app.slug) >= limits.perAppPerDay) return send(res, 429, { error: 'app_daily_limit', limit: limits.perAppPerDay });
  if (callsToday('user_id', user.id) >= limits.perPersonPerDay) return send(res, 429, { error: 'person_daily_limit', limit: limits.perPersonPerDay });

  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  if (body === null) return send(res, 413, { error: 'too_large', limit: MAX_BODY });
  const started = now();
  const record = (status: number, u: { model?: string; prompt?: number; completion?: number }) =>
    run('INSERT INTO ai_usage (at, app_slug, user_id, path, model, status, ms, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      started, app.slug, user.id, rest.split('?')[0].slice(0, 200), u.model?.slice(0, 100) ?? null, status, now() - started, u.prompt ?? null, u.completion ?? null);
  let upstream: Response;
  try {
    upstream = await fetch(target + url.search, {
      method: req.method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : {}),
        accept: String(req.headers.accept ?? '*/*'),
      },
      body: body && body.length ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    record(502, {});
    return send(res, 502, { error: 'provider_unreachable', message: (e as Error).message });
  }
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store',
  });
  // pass the answer through as it comes (streams included), keeping the end of it to read the token counts
  let tail = '';
  const reader = upstream.body?.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const r = reader ? await reader.read() : { done: true as const, value: undefined };
      if (r.done) break;
      res.write(r.value);
      tail = (tail + dec.decode(r.value, { stream: true })).slice(-65_536);
    }
  } catch { /* the provider or the app hung up */ }
  res.end();
  record(upstream.status, usageOf(tail));
}
