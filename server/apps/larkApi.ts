/**
 * Lark for apps: a colleague's app can read and write the Lark Base tables it declared, and ask the hub bot to notify
 * the people / groups it declared, always as the person using the app and only after that person agreed.
 *
 * - Declaration (manifest): set by the app's owner (usually their agent, via set_app_lark). Tables are named by an
 *   alias the app code uses, each read or write. The owner must be able to open every table.
 * - Consent: the first time someone uses the app's Lark features, the hub shows what it will do as them; a changed
 *   declaration asks again. Without consent (or without Lark data connected) every call answers consent_required.
 * - Calls come from the browser on the app's own domain (session cookie, JSON only, same origin) or from a container
 *   app's server with the X-Hub-Ticket header the gateway passed it (bound to app + person, valid 15 minutes).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { appUrl, config } from '../config.ts';
import { safeEqual, sha256 } from '../crypto.ts';
import { all, get, now, run, type App, type User } from '../db.ts';
import { tr, UserError } from '../i18n/index.ts';
import { localize } from '../localized.ts';
import { getTenantToken } from '../auth/lark.ts';
import { larkFetch } from '../lark/client.ts';
import { createRecord, fetchRecords, listFields, parseBaseUrl, plainText, resolveAppToken, updateRecord, type Condition } from '../lark/base.ts';
import { connection, WRITE_SCOPE } from '../lark/userToken.ts';
import { canAccessApp } from './access.ts';

// ---------------------------------------------------------------- declaration
export const manifestSchema = z.object({
  tables: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/).describe('alias the app code uses, e.g. "projects"'),
    url: z.string().describe('Lark Base (or wiki) link including ?table=…'),
    access: z.enum(['read', 'write']).describe('write = may add and change records'),
  })).max(10),
  notify: z.object({
    people: z.array(z.string()).max(50).optional().describe('colleagues the app may notify (email, name or open_id)'),
    chats: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/), id: z.string().startsWith('oc_') })).max(10).optional()
      .describe('Lark groups the hub bot is in, by alias'),
  }).optional(),
});
export type ManifestInput = z.infer<typeof manifestSchema>;

interface Table { name: string; url: string; app: string; table: string; view: string | null; access: 'read' | 'write' }
export interface Manifest { tables: Table[]; notify: { people: { id: string; name: string }[]; chats: { name: string; id: string }[] } }

export function manifestOf(app: Pick<App, 'lark_manifest'>): Manifest | null {
  return app.lark_manifest ? (JSON.parse(app.lark_manifest) as Manifest) : null;
}

/** What a consent covers: the tables with their access, and who may be notified. */
const hashOf = (m: Manifest) => sha256(JSON.stringify({
  t: m.tables.map((t) => [t.name, t.app, t.table, t.access]).sort(),
  p: m.notify.people.map((p) => p.id).sort(),
  c: m.notify.chats.map((c) => c.id).sort(),
}));

/** Saves an app's declaration after checking that its owner can open every table. `people` are already open_ids. */
export async function setManifest(owner: User, app: App, input: ManifestInput, people: string[]): Promise<Manifest | null> {
  if (app.owner_id !== owner.id && owner.role !== 'admin') throw new UserError('err.notAppOwner', { slug: app.slug });
  if (!input.tables.length && !people.length && !input.notify?.chats?.length) {
    run('UPDATE apps SET lark_manifest = NULL WHERE slug = ?', app.slug);
    return null;
  }
  const names = new Set<string>();
  const tables: Table[] = [];
  for (const t of input.tables) {
    if (names.has(t.name)) throw new UserError('err.appLark.duplicateName', { name: t.name });
    names.add(t.name);
    const ref = parseBaseUrl(t.url);
    if (!ref.table) throw new UserError('err.data.tableRequired');
    const appToken = await resolveAppToken(owner, ref);
    await listFields(owner, appToken, ref.table, ref.view);
    tables.push({ name: t.name, url: t.url, app: appToken, table: ref.table, view: ref.view ?? null, access: t.access });
  }
  const users = people.map((id) => get<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = ?', id)!).filter(Boolean);
  const m: Manifest = { tables, notify: { people: users, chats: input.notify?.chats ?? [] } };
  run('UPDATE apps SET lark_manifest = ?, updated_at = ? WHERE slug = ?', JSON.stringify(m), now(), app.slug);
  return m;
}

// ---------------------------------------------------------------- consent
export function hasConsent(user: User, app: App): boolean {
  const m = manifestOf(app);
  if (!m) return false;
  return get<{ manifest_hash: string }>('SELECT manifest_hash FROM app_lark_consents WHERE user_id = ? AND app_slug = ?', user.id, app.slug)?.manifest_hash === hashOf(m);
}

export function grantConsent(user: User, app: App) {
  const m = manifestOf(app);
  if (!m) return;
  run(`INSERT INTO app_lark_consents (user_id, app_slug, manifest_hash, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, app_slug) DO UPDATE SET manifest_hash = excluded.manifest_hash, at = excluded.at`, user.id, app.slug, hashOf(m), now());
}

export function revokeConsent(user: User, slug: string) {
  run('DELETE FROM app_lark_consents WHERE user_id = ? AND app_slug = ?', user.id, slug);
}

/** Write tables need the person's write scope; everything needs Lark data connected. */
export function needsConnect(user: User, m: Manifest): { write: boolean } | null {
  const c = connection(user.id);
  const write = m.tables.some((t) => t.access === 'write');
  if (!c.connected || (write && !c.scopes?.includes(WRITE_SCOPE))) return { write };
  return null;
}

export const consentUrl = (slug: string, returnPath: string) => `${config.hubUrl}/auth/app-lark?app=${encodeURIComponent(slug)}&return=${encodeURIComponent(returnPath)}`;

/** For the app page and the consent screen. */
export function describeManifest(user: User | undefined, app: App) {
  const m = manifestOf(app);
  if (!m) return null;
  return {
    tables: m.tables.map((t) => ({ name: t.name, url: t.url, access: t.access })),
    notify: { people: m.notify.people.map((p) => p.name), chats: m.notify.chats.map((c) => c.name) },
    consented: user ? hasConsent(user, app) : false,
  };
}

// ---------------------------------------------------------------- tickets for container apps' servers
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const mac = (payload: string) => createHmac('sha256', config.secret).update(`hub-ticket|${payload}`).digest('base64url');

export function issueTicket(slug: string, userId: string): string {
  const payload = b64(JSON.stringify({ a: slug, u: userId, e: Date.now() + 15 * 60_000 }));
  return `${payload}.${mac(payload)}`;
}

function readTicket(slug: string, ticket: string | undefined): string | undefined {
  if (!ticket) return undefined;
  const [payload, sig] = ticket.split('.');
  if (!payload || !sig || !safeEqual(sig, mac(payload))) return undefined;
  try {
    const t = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { a: string; u: string; e: number };
    return t.a === slug && t.e > Date.now() ? t.u : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- the app-facing API on <slug>.<apps domain>/__hub/
const NOTIFY_PER_HOUR = 60;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > 256 * 1024) req.destroy(new Error('too large'));
      else chunks.push(d);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {});
      } catch {
        reject(new UserError('err.appLark.badJson'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handles /__hub/lark/… and /__hub/notify for an app. `sessionUserId` is the person signed in to the app (cookie);
 * server-to-server calls carry the ticket instead.
 */
export async function handleAppLark(app: App, sessionUser: User | undefined, req: IncomingMessage, res: ServerResponse, locale: string) {
  const url = new URL(req.url ?? '/', 'http://x');
  const ticketUser = readTicket(app.slug, req.headers['x-hub-ticket'] as string | undefined);
  const user = ticketUser ? get<User>('SELECT * FROM users WHERE id = ?', ticketUser) : sessionUser;
  if (!user) return json(res, 401, { error: 'unauthenticated' });
  if (ticketUser && !canAccessApp(app, user)) return json(res, 403, { error: 'forbidden' });
  if (req.method !== 'GET') {
    // browsers: same-origin JSON only, so other sites cannot make a colleague's browser write as them
    if (!ticketUser) {
      const origin = req.headers.origin;
      if (origin && origin !== appUrl(app.slug)) return json(res, 403, { error: 'bad origin' });
      if (!(req.headers['content-type'] ?? '').includes('application/json')) return json(res, 415, { error: 'JSON only' });
    }
  }
  const m = manifestOf(app);
  const back = (req.headers.referer && new URL(req.headers.referer).host === new URL(appUrl(app.slug)).host) ? new URL(req.headers.referer).pathname : '/';
  const consent = consentUrl(app.slug, back);
  try {
    if (url.pathname === '/__hub/lark') {
      return json(res, 200, { declared: describeManifest(user, app), ready: !!m && hasConsent(user, app) && !needsConnect(user, m), consentUrl: consent });
    }
    if (!m) return json(res, 404, { error: tr(locale, 'err.appLark.notDeclared'), code: 'err.appLark.notDeclared' });
    if (!hasConsent(user, app) || needsConnect(user, m)) return json(res, 403, { error: 'consent_required', consentUrl: consent });

    if (url.pathname === '/__hub/notify' && req.method === 'POST') return json(res, 200, await notify(app, m, user, await readJson(req), locale));

    const t = url.pathname.match(/^\/__hub\/lark\/tables\/([a-z][a-z0-9_-]*)(\/fields|\/records(?:\/([A-Za-z0-9]+))?)$/);
    if (!t) return json(res, 404, { error: 'unknown endpoint' });
    const table = m.tables.find((x) => x.name === t[1]);
    if (!table) throw new UserError('err.appLark.unknownTable', { name: t[1], names: m.tables.map((x) => x.name).join(', ') });
    if (t[2] === '/fields') {
      const fields = await listFields(user, table.app, table.table, table.view ?? undefined);
      return json(res, 200, { fields: fields.map((f) => ({ name: f.name, type: f.uiType ?? f.type })) });
    }
    if (req.method === 'GET' && !t[3]) {
      let where: Condition[] | undefined;
      try {
        where = url.searchParams.get('where') ? (JSON.parse(url.searchParams.get('where')!) as Condition[]) : undefined;
      } catch {
        throw new UserError('err.appLark.badJson');
      }
      const fields = await listFields(user, table.app, table.table, table.view ?? undefined);
      const records = await fetchRecords(user, { app: table.app, table: table.table, view: table.view ?? undefined, where, max: Math.min(5000, Number(url.searchParams.get('max') ?? 500)) });
      return json(res, 200, {
        records: records.map((r) => ({ id: r.id, fields: r.fields, text: Object.fromEntries(fields.map((f) => [f.name, plainText(r.fields[f.name], f)])) })),
      });
    }
    if (table.access !== 'write') throw new UserError('err.appLark.readOnly', { name: table.name });
    const body = await readJson(req);
    const fields = (body.fields ?? {}) as Record<string, unknown>;
    if (req.method === 'POST' && !t[3]) return json(res, 200, await createRecord(user, table.app, table.table, fields));
    if ((req.method === 'PATCH' || req.method === 'PUT') && t[3]) return json(res, 200, await updateRecord(user, table.app, table.table, t[3], fields));
    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    if (e instanceof UserError) return json(res, 400, { error: e.localized(locale), code: e.key });
    console.error('[app-lark]', app.slug, e);
    return json(res, 502, { error: (e as Error).message });
  }
}

/** The hub bot tells declared people / groups something on the app's behalf, naming the app and who triggered it. */
async function notify(app: App, m: Manifest, user: User, body: Record<string, unknown>, locale: string) {
  const text = String(body.text ?? '').trim().slice(0, 2000);
  if (!text) throw new UserError('err.appLark.emptyText');
  const link = typeof body.link === 'string' && /^https:\/\//.test(body.link) ? body.link : '';
  const to = (Array.isArray(body.to) ? body.to : [body.to]).map((x) => String(x ?? '').trim()).filter(Boolean);
  // declared recipients, findable by open_id, name or email (people) and alias or id (groups)
  const allowed = new Map<string, { type: 'open_id' | 'chat_id'; id: string }>();
  for (const p of m.notify.people) {
    const email = get<{ email: string | null }>('SELECT email FROM users WHERE id = ?', p.id)?.email;
    for (const k of [p.id, p.name, email?.toLowerCase()]) if (k) allowed.set(k, { type: 'open_id', id: p.id });
  }
  for (const c of m.notify.chats) for (const k of [c.name, c.id]) allowed.set(k, { type: 'chat_id', id: c.id });
  const unknown = to.filter((x) => !allowed.has(x) && !allowed.has(x.toLowerCase()));
  if (!to.length || unknown.length) {
    throw new UserError('err.appLark.notDeclaredRecipient', { who: unknown.join(', ') || '—', allowed: [...m.notify.people.map((p) => p.name), ...m.notify.chats.map((c) => c.name)].join(', ') || '—' });
  }
  const targets = [...new Map(to.map((x) => allowed.get(x) ?? allowed.get(x.toLowerCase())!).map((t) => [t.id, t])).values()];
  const people = targets.filter((t) => t.type === 'open_id');
  const chats = targets.filter((t) => t.type === 'chat_id');
  const recent = get<{ n: number }>('SELECT COUNT(*) AS n FROM app_notify_log WHERE app_slug = ? AND at > ?', app.slug, now() - 3600_000)!.n;
  if (recent + people.length + chats.length > NOTIFY_PER_HOUR) throw new UserError('err.appLark.rateLimited', { n: NOTIFY_PER_HOUR });
  const token = await getTenantToken();
  let sent = 0;
  const send = async (type: 'open_id' | 'chat_id', id: string, L: string) => {
    const name = localize(app, app.i18n, L).name;
    const message = [`【${name}】${text}`, link, tr(L, 'appLark.msg.footer', { user: user.name, app: name, company: config.companyName })].filter(Boolean).join('\n');
    await larkFetch(`/im/v1/messages?receive_id_type=${type}`, { method: 'POST', token, body: JSON.stringify({ receive_id: id, msg_type: 'text', content: JSON.stringify({ text: message }) }) });
    run('INSERT INTO app_notify_log (app_slug, user_id, at) VALUES (?, ?, ?)', app.slug, user.id, now());
    sent++;
  };
  for (const p of people) await send('open_id', p.id, get<{ locale: string | null }>('SELECT locale FROM users WHERE id = ?', p.id)?.locale ?? locale);
  for (const c of chats) await send('chat_id', c.id, config.defaultLocale);
  run('DELETE FROM app_notify_log WHERE at < ?', now() - 2 * 3600_000);
  return { sent };
}

/** Apps whose Lark access this person agreed to (for the profile page). */
export function consentsOf(user: User, locale: string) {
  return all<App & { at: number }>('SELECT a.*, c.at FROM app_lark_consents c JOIN apps a ON a.slug = c.app_slug WHERE c.user_id = ? ORDER BY c.at DESC', user.id)
    .map((a) => ({ slug: a.slug, name: localize(a, a.i18n, locale).name, at: a.at }));
}
