/**
 * App requests (需求): someone needs an app and asks a colleague to build it, or puts it in the pool for whoever has
 * time. A request goes open → taken (someone builds it) → done (linked to the app it became) or closed.
 *
 * - Pool requests are seen by the whole company, and each new one is posted to the Lark group an admin chose.
 *   Invitations are seen only by the requester, the invited person, whoever builds it and admins; a declined one
 *   stays private until the requester invites someone else or moves it to the pool.
 * - Colleagues who need the same add "me too" with a line about their case; they hear when it goes live.
 * - Whoever builds it owns the app; the requester becomes a collaborator. Their agents do the same over MCP
 *   (create_app_request, get_app_request, publish_app with request_id).
 */
import { appUrl, config } from './config.ts';
import { all, get, now, run, tx, type App, type User } from './db.ts';
import { isSupportedLocale, tr, UserError } from './i18n/index.ts';
import { localize } from './localized.ts';
import { messenger } from './notify.ts';
import { canAdministerApp, canManageApp } from './apps/access.ts';
import { collaboratorsOf, setCollaborators } from './collab.ts';

export type Status = 'open' | 'taken' | 'done' | 'closed';
type Scope = 'pool' | 'invite';
interface Row {
  id: number; title: string; body: string; due: string | null; scope: Scope; status: Status;
  requester_id: string; invitee_id: string | null; declined_by: string | null; builder_id: string | null;
  app_slug: string | null; close_reason: string | null; via: string; agent: string | null;
  created_at: number; updated_at: number; taken_at: number | null; done_at: number | null;
}

const PER_HOUR = 10;
const CHAT_KEY = 'requests.chat';

const link = (id: number) => `${config.hubUrl}/requests/${id}`;
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const nameOf = (id: string | null) => (id ? get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? '' : '');

// ---------------------------------------------------------------- the group new pool requests go to
/** locale: the language messages to the group are written in */
export interface Chat { id: string; name: string; locale?: string }

export function requestsChat(): Chat | null {
  try {
    return JSON.parse(get<{ value: string }>('SELECT value FROM settings WHERE key = ?', CHAT_KEY)?.value ?? 'null') as Chat | null;
  } catch {
    return null;
  }
}

export function setRequestsChat(user: User, chat: Chat | null) {
  if (user.role !== 'admin') throw new UserError('err.noPermission');
  if (!chat) return void run('DELETE FROM settings WHERE key = ?', CHAT_KEY);
  if (!/^oc_[\w-]+$/.test(chat.id)) throw new UserError('err.requests.badChat');
  run(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  CHAT_KEY, JSON.stringify({
    id: chat.id, name: chat.name.trim().slice(0, 100) || chat.id,
    // the group reads the language chosen for it, else the language of the admin who chose it
    locale: isSupportedLocale(chat.locale) ? chat.locale : user.locale ?? config.defaultLocale,
  }), now());
}

// ---------------------------------------------------------------- messages
async function tell(userId: string | null, text: (locale: string) => string) {
  if (!messenger || !userId) return;
  const locale = get<{ locale: string | null }>('SELECT locale FROM users WHERE id = ?', userId)?.locale ?? config.defaultLocale;
  try {
    await messenger.toPerson(userId, text(locale));
  } catch (e) {
    console.warn('[requests] could not message', userId, (e as Error).message);
  }
}

async function announce(r: Row) {
  const chat = requestsChat();
  if (!messenger || !chat) return;
  try {
    await messenger.toGroup(chat.id, tr(chat.locale ?? config.defaultLocale, 'requests.msg.pool', { name: nameOf(r.requester_id), title: r.title, body: short(r.body, 300), url: link(r.id) }));
  } catch (e) {
    console.warn('[requests] could not post to the group', (e as Error).message);
  }
}

// ---------------------------------------------------------------- who may do what
const isAdmin = (u: User) => u.role === 'admin';

export function canSee(user: User, r: Row): boolean {
  return r.scope === 'pool' || isAdmin(user) || [r.requester_id, r.invitee_id, r.builder_id].includes(user.id);
}

function abilities(user: User, r: Row) {
  const mine = r.requester_id === user.id;
  const live = r.status === 'open' || r.status === 'taken';
  return {
    take: r.status === 'open' && (r.scope === 'pool' || r.invitee_id === user.id),
    decline: r.status === 'open' && r.scope === 'invite' && r.invitee_id === user.id,
    release: r.status === 'taken' && r.builder_id === user.id,
    deliver: (r.status === 'taken' && (r.builder_id === user.id || isAdmin(user))) || (r.status === 'open' && r.scope === 'pool'),
    invite: r.status === 'open' && (mine || isAdmin(user)),
    toPool: r.status === 'open' && r.scope === 'invite' && (mine || isAdmin(user)),
    edit: live && (mine || isAdmin(user)),
    close: live && (mine || isAdmin(user)),
    vote: live && r.scope === 'pool' && !mine && r.builder_id !== user.id,
  };
}

function load(user: User, id: number): Row {
  const r = get<Row>('SELECT * FROM app_requests WHERE id = ?', id);
  if (!r || !canSee(user, r)) throw new UserError('err.requests.notFound', { id });
  return r;
}

function shape(user: User, r: Row, locale: string) {
  const person = (id: string | null) => (id ? get<{ id: string; name: string; avatar: string | null }>('SELECT id, name, avatar FROM users WHERE id = ?', id) ?? null : null);
  const voters = all<{ id: string; name: string; avatar: string | null; note: string | null; at: number }>(
    'SELECT u.id, u.name, u.avatar, v.note, v.at FROM app_request_votes v JOIN users u ON u.id = v.user_id WHERE v.request_id = ? ORDER BY v.at', r.id);
  const app = r.app_slug ? get<App>('SELECT * FROM apps WHERE slug = ?', r.app_slug) : undefined;
  return {
    id: r.id, title: r.title, body: r.body, due: r.due, scope: r.scope, status: r.status,
    requester: person(r.requester_id), invitee: person(r.invitee_id), declinedBy: person(r.declined_by), builder: person(r.builder_id),
    app: app ? { slug: app.slug, name: localize(app, app.i18n, locale).name, url: appUrl(app.slug), icon: app.icon ? `${config.hubUrl}/icons/${app.icon}` : null } : null,
    closeReason: r.close_reason, via: r.via, agent: r.agent,
    voters, myVote: voters.some((v) => v.id === user.id),
    createdAt: r.created_at, updatedAt: r.updated_at, takenAt: r.taken_at, doneAt: r.done_at,
    can: abilities(user, r),
    url: link(r.id),
  };
}
export type RequestItem = ReturnType<typeof shape>;

// ---------------------------------------------------------------- reading
export function listRequests(user: User, locale: string, o: { status?: Status | 'all'; mine?: boolean; waiting?: boolean; query?: string } = {}) {
  const q = o.query?.trim().toLowerCase();
  const voted = new Set(all<{ request_id: number }>('SELECT request_id FROM app_request_votes WHERE user_id = ?', user.id).map((v) => v.request_id));
  const rows = all<Row>('SELECT * FROM app_requests ORDER BY updated_at DESC LIMIT 500')
    .filter((r) => canSee(user, r))
    .filter((r) => !o.status || o.status === 'all' || r.status === o.status)
    .filter((r) => !o.mine || [r.requester_id, r.invitee_id, r.builder_id].includes(user.id) || voted.has(r.id))
    // waiting for someone to take it: open in the pool, or an invitation to this person
    .filter((r) => !o.waiting || (r.status === 'open' && (r.scope === 'pool' || r.invitee_id === user.id)))
    .filter((r) => !q || `${r.title} ${r.body}`.toLowerCase().includes(q));
  return rows.map((r) => shape(user, r, locale));
}

export const getRequest = (user: User, id: number, locale: string) => shape(user, load(user, id), locale);

/** Open requests waiting for someone (in the pool, or invitations to this person). */
export function waitingCount(user: User): number {
  return all<Row>("SELECT * FROM app_requests WHERE status = 'open'").filter((r) => r.scope === 'pool' || r.invitee_id === user.id).length;
}

// ---------------------------------------------------------------- changing
function clean(input: { title?: string; body?: string; due?: string | null }) {
  const out: { title?: string; body?: string; due?: string | null } = {};
  if (input.title !== undefined) {
    out.title = input.title.trim();
    if (out.title.length < 2 || out.title.length > 80) throw new UserError('err.requests.title');
  }
  if (input.body !== undefined) {
    out.body = input.body.trim();
    if (out.body.length < 10 || out.body.length > 4000) throw new UserError('err.requests.body');
  }
  if (input.due !== undefined) {
    out.due = input.due?.trim() || null;
    if (out.due && !/^\d{4}-\d{2}-\d{2}$/.test(out.due)) throw new UserError('err.requests.due');
  }
  return out;
}

function invitable(user: User, id: string) {
  if (id === user.id) throw new UserError('err.requests.inviteSelf');
  if (!get('SELECT 1 FROM users WHERE id = ?', id)) throw new UserError('err.collab.unknownUser', { id });
  return id;
}

export async function createRequest(user: User, input: { title: string; body: string; due?: string | null; invite?: string | null; via?: 'web' | 'agent'; agent?: string }, locale: string) {
  const v = clean({ title: input.title, body: input.body, due: input.due ?? null });
  const recent = get<{ n: number }>('SELECT COUNT(*) AS n FROM app_requests WHERE requester_id = ? AND created_at > ?', user.id, now() - 3600_000)!.n;
  if (recent >= PER_HOUR) throw new UserError('err.requests.rateLimited', { n: PER_HOUR });
  const invitee = input.invite ? invitable(user, input.invite) : null;
  const t = now();
  const id = Number(run(
    `INSERT INTO app_requests (title, body, due, scope, status, requester_id, invitee_id, via, agent, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    v.title!, v.body!, v.due ?? null, invitee ? 'invite' : 'pool', user.id, invitee, input.via ?? 'web', input.via === 'agent' ? input.agent?.slice(0, 80) ?? 'Agent' : null, t, t,
  ).lastInsertRowid);
  const r = get<Row>('SELECT * FROM app_requests WHERE id = ?', id)!;
  if (invitee) void tell(invitee, (L) => tr(L, 'requests.msg.invited', { name: user.name, title: r.title, body: short(r.body, 300), url: link(id) }));
  else void announce(r);
  return shape(user, r, locale);
}

const touch = (id: number, set: string, ...params: (string | number | null)[]) =>
  run(`UPDATE app_requests SET ${set}, updated_at = ? WHERE id = ?`, ...params, now(), id);

export type Action =
  | { action: 'take' } | { action: 'decline'; reason?: string } | { action: 'release'; reason?: string }
  | { action: 'invite'; user: string } | { action: 'to_pool' } | { action: 'close'; reason?: string }
  | { action: 'edit'; title?: string; body?: string; due?: string | null } | { action: 'me_too'; note?: string } | { action: 'not_me' }
  | { action: 'deliver'; app: string };

/** One step on a request, by whoever may take it; tells the people it concerns. */
export async function actOn(user: User, id: number, a: Action, locale: string) {
  const r = load(user, id);
  const can = abilities(user, r);
  const deny = (): never => { throw new UserError('err.requests.notAllowed', { id }); };
  const reason = 'reason' in a ? a.reason?.trim().slice(0, 500) || null : null;
  const notes: string[] = [];
  switch (a.action) {
    case 'take':
      if (!can.take) deny();
      touch(id, "status = 'taken', builder_id = ?, taken_at = ?", user.id, now());
      if (r.requester_id !== user.id) void tell(r.requester_id, (L) => tr(L, 'requests.msg.taken', { name: user.name, title: r.title, url: link(id) }));
      break;
    case 'decline':
      if (!can.decline) deny();
      touch(id, 'invitee_id = NULL, declined_by = ?', user.id);
      void tell(r.requester_id, (L) => tr(L, 'requests.msg.declined', { name: user.name, title: r.title, reason: reason ?? '-', url: link(id) }));
      break;
    case 'release':
      if (!can.release) deny();
      // an invitation that is given back waits for the requester again; a pool request goes back to the pool
      touch(id, `status = 'open', builder_id = NULL, taken_at = NULL${r.scope === 'invite' ? ', invitee_id = NULL, declined_by = ?' : ''}`, ...(r.scope === 'invite' ? [user.id] : []));
      if (r.requester_id !== user.id) void tell(r.requester_id, (L) => tr(L, 'requests.msg.released', { name: user.name, title: r.title, reason: reason ?? '-', url: link(id) }));
      break;
    case 'invite': {
      if (!can.invite) deny();
      const who = invitable(user, a.user);
      touch(id, "scope = 'invite', invitee_id = ?, declined_by = NULL", who);
      void tell(who, (L) => tr(L, 'requests.msg.invited', { name: nameOf(r.requester_id), title: r.title, body: short(r.body, 300), url: link(id) }));
      break;
    }
    case 'to_pool':
      if (!can.toPool) deny();
      touch(id, "scope = 'pool', invitee_id = NULL");
      void announce({ ...r, scope: 'pool' });
      break;
    case 'close':
      if (!can.close) deny();
      touch(id, "status = 'closed', close_reason = ?", reason);
      for (const p of new Set([r.builder_id, r.invitee_id].filter((x): x is string => !!x && x !== user.id))) {
        void tell(p, (L) => tr(L, 'requests.msg.closed', { name: user.name, title: r.title, reason: reason ?? '-', url: link(id) }));
      }
      break;
    case 'edit': {
      if (!can.edit) deny();
      const v = clean(a);
      touch(id, 'title = COALESCE(?, title), body = COALESCE(?, body), due = CASE WHEN ? THEN ? ELSE due END',
        v.title ?? null, v.body ?? null, v.due !== undefined ? 1 : 0, v.due ?? null);
      break;
    }
    case 'me_too':
      if (!can.vote) deny();
      run(`INSERT INTO app_request_votes (request_id, user_id, note, at) VALUES (?, ?, ?, ?)
           ON CONFLICT(request_id, user_id) DO UPDATE SET note = excluded.note`, id, user.id, a.note?.trim().slice(0, 300) || null, now());
      break;
    case 'not_me':
      run('DELETE FROM app_request_votes WHERE request_id = ? AND user_id = ?', id, user.id);
      break;
    case 'deliver':
      notes.push(...deliver(user, r, a.app));
      break;
    default:
      throw new UserError('err.requests.badAction');
  }
  return { request: shape(user, get<Row>('SELECT * FROM app_requests WHERE id = ?', id)!, locale), notes };
}

/**
 * The request became this app: marks it done, makes the requester a collaborator, and tells them and everyone who
 * needed it. Returns notes for the builder (e.g. when the requester could not be added).
 */
function deliver(user: User, r: Row, slug: string): string[] {
  const can = abilities(user, r);
  if (!can.deliver) throw new UserError('err.requests.notAllowed', { id: r.id });
  const app = get<App>('SELECT * FROM apps WHERE slug = ?', slug.toLowerCase());
  if (!app || !canManageApp(app, user)) throw new UserError('err.notAppOwner', { slug });
  tx(() => run("UPDATE app_requests SET status = 'done', app_slug = ?, builder_id = COALESCE(builder_id, ?), taken_at = COALESCE(taken_at, ?), done_at = ?, updated_at = ? WHERE id = ?",
    app.slug, user.id, now(), now(), now(), r.id));
  const notes: string[] = [];
  const keepers = new Set(collaboratorsOf('app', app.slug).map((c) => c.id));
  if (!keepers.has(r.requester_id)) {
    if (canAdministerApp(app, user)) setCollaborators(user, 'app', app.slug, { add: [r.requester_id] });
    else notes.push(`ask the app's owner to add ${nameOf(r.requester_id)} as a collaborator (set_collaborators)`);
  }
  const url = appUrl(app.slug);
  const told = new Set<string>([user.id]);
  for (const id of [r.requester_id, ...all<{ user_id: string }>('SELECT user_id FROM app_request_votes WHERE request_id = ?', r.id).map((v) => v.user_id)]) {
    if (told.has(id)) continue;
    told.add(id);
    void tell(id, (L) => tr(L, id === r.requester_id ? 'requests.msg.doneRequester' : 'requests.msg.done', {
      name: user.name, title: r.title, app: localize(app, app.i18n, L).name, url, request: link(r.id),
    }));
  }
  return notes;
}

/** publish_app with request_id: the person publishing takes the request if it is still waiting, then delivers it. */
export async function deliverFromPublish(user: User, id: number, slug: string, locale: string) {
  const r = load(user, id);
  if (abilities(user, r).take) await actOn(user, id, { action: 'take' }, locale);
  return actOn(user, id, { action: 'deliver', app: slug }, locale);
}
