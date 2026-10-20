/**
 * Feedback on apps and Skills. Colleagues tell the owner what is wrong or missing: on the hub page, with the button
 * inside an app, or through their own agent. The owner's agent reads it over MCP, fixes things and marks each item
 * done or declined, and the person who asked is told.
 */
import { config } from './config.ts';
import { all, get, now, run, type App, type Skill, type User } from './db.ts';
import { tr, UserError } from './i18n/index.ts';
import { localize } from './localized.ts';
import { messenger } from './notify.ts';
import { canAccessApp, canManageApp } from './apps/access.ts';
import { canManageSkill } from './skills/service.ts';
import { collaboratingOn, keepers } from './collab.ts';

export type Kind = 'app' | 'skill';
export type Status = 'open' | 'done' | 'declined';
export type Via = 'web' | 'app' | 'agent';
interface Row {
  id: number; kind: Kind; slug: string; user_id: string; body: string; context: string | null; via: Via; agent: string | null;
  status: Status; reply: string | null; created_at: number; resolved_at: number | null; resolved_by: string | null;
}

const PER_HOUR = 20;

/** What feedback is about, seen the same way whether it is an app or a Skill. */
interface Target {
  kind: Kind; slug: string; ownerId: string; link: string;
  name: (locale: string) => string;
  canSend: (user: User) => boolean;
  canManage: (user: User) => boolean;
}

function target(kind: Kind, slug: string): Target {
  if (kind === 'app') {
    const app = get<App>('SELECT * FROM apps WHERE slug = ?', slug);
    if (!app) throw new UserError('err.appNotFound', { slug });
    return {
      kind, slug, ownerId: app.owner_id, link: `${config.hubUrl}/apps/${slug}#feedback`,
      name: (L) => localize(app, app.i18n, L).name,
      canSend: (u) => canAccessApp(app, u),
      canManage: (u) => canManageApp(app, u),
    };
  }
  const skill = get<Skill>('SELECT * FROM skills WHERE slug = ?', slug);
  if (!skill) throw new UserError('err.skill.notFound', { slug });
  const manage = (u: User) => canManageSkill(skill, u);
  return {
    kind, slug, ownerId: skill.owner_id, link: `${config.hubUrl}/skills/${slug}#feedback`,
    name: (L) => localize(skill, skill.i18n, L).name,
    // listed Skills are for everyone; a hidden one only for people who already installed it
    canSend: (u) => !!skill.listed || manage(u) || !!get('SELECT 1 FROM skill_installs WHERE skill_slug = ? AND user_id = ?', slug, u.id),
    canManage: manage,
  };
}

function shape(r: Row) {
  const who = (id: string | null) => (id ? get<{ id: string; name: string; avatar: string | null }>('SELECT id, name, avatar FROM users WHERE id = ?', id) ?? null : null);
  return {
    id: r.id, kind: r.kind, slug: r.slug, body: r.body, context: r.context, via: r.via, agent: r.agent, status: r.status, reply: r.reply,
    at: r.created_at, resolvedAt: r.resolved_at, author: who(r.user_id), resolvedBy: who(r.resolved_by),
  };
}
export type FeedbackItem = ReturnType<typeof shape>;

async function tell(userId: string, text: (locale: string) => string) {
  if (!messenger) return;
  const locale = get<{ locale: string | null }>('SELECT locale FROM users WHERE id = ?', userId)?.locale ?? config.defaultLocale;
  try {
    await messenger.toPerson(userId, text(locale));
  } catch (e) {
    console.warn('[feedback] could not message', userId, (e as Error).message);
  }
}

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

export async function addFeedback(user: User, kind: Kind, slug: string, input: { body: string; context?: string; via?: Via; agent?: string }) {
  const t = target(kind, slug);
  if (!t.canSend(user)) throw new UserError(kind === 'app' ? 'err.appNotFound' : 'err.skill.notFound', { slug });
  const text = input.body.trim();
  if (text.length < 2 || text.length > 2000) throw new UserError('err.feedback.length');
  const recent = get<{ n: number }>('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND created_at > ?', user.id, now() - 3600_000)!.n;
  if (recent >= PER_HOUR) throw new UserError('err.feedback.rateLimited', { n: PER_HOUR });
  const context = input.context?.trim().slice(0, 4000) || null;
  const via = input.via ?? 'web';
  const agent = via === 'agent' ? input.agent?.trim().slice(0, 80) || 'Agent' : null;
  const id = Number(run('INSERT INTO feedback (kind, slug, user_id, body, context, via, agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    kind, slug, user.id, text, context, via, agent, now()).lastInsertRowid);
  // everyone who looks after it hears about it; owners trying it on their own things too, so the whole loop can be tested
  for (const id of keepers(kind, slug)) {
    void tell(id, (L) => tr(L, agent ? 'feedback.msg.newVia' : 'feedback.msg.new', { target: t.name(L), name: user.name, agent: agent ?? '', body: short(text, 600), url: t.link }));
  }
  return shape(get<Row>('SELECT * FROM feedback WHERE id = ?', id)!);
}

/** Owners see everything said about it; everyone else sees what they said themselves. */
export function feedbackFor(user: User, kind: Kind, slug: string) {
  const t = target(kind, slug);
  const rows = t.canManage(user)
    ? all<Row>("SELECT * FROM feedback WHERE kind = ? AND slug = ? ORDER BY status = 'open' DESC, created_at DESC LIMIT 200", kind, slug)
    : all<Row>('SELECT * FROM feedback WHERE kind = ? AND slug = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50', kind, slug, user.id);
  return rows.map(shape);
}

/** Feedback on what this person owns (everything, one kind, or one app or Skill), newest first. */
export function feedbackToHandle(user: User, opts: { kind?: Kind; slug?: string; status?: Status | 'all' }) {
  const owned: [Kind, string][] = [];
  if (opts.slug) {
    const kinds: Kind[] = opts.kind ? [opts.kind] : ['app', 'skill'];
    for (const k of kinds) {
      try {
        if (target(k, opts.slug).canManage(user)) owned.push([k, opts.slug]);
      } catch { /* no such app or Skill of this kind */ }
    }
    if (!owned.length) throw new UserError('err.feedback.notOwner', { slug: opts.slug });
  } else {
    const admin = user.role === 'admin';
    for (const k of ['app', 'skill'] as const) {
      if (opts.kind && opts.kind !== k) continue;
      const mine = collaboratingOn(k, user.id);
      for (const r of all<{ slug: string; owner_id: string }>(`SELECT slug, owner_id FROM ${k === 'app' ? 'apps' : 'skills'}`)) {
        if (admin || r.owner_id === user.id || mine.has(r.slug)) owned.push([k, r.slug]);
      }
    }
  }
  if (!owned.length) return [];
  const status = opts.status ?? 'open';
  const which = owned.map(() => '(kind = ? AND slug = ?)').join(' OR ');
  return all<Row>(
    `SELECT * FROM feedback WHERE (${which}) ${status === 'all' ? '' : 'AND status = ?'} ORDER BY created_at DESC LIMIT 200`,
    ...owned.flat(), ...(status === 'all' ? [] : [status]),
  ).map(shape);
}

export function openFeedbackCount(kind: Kind, slug: string): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM feedback WHERE kind = ? AND slug = ? AND status = 'open'", kind, slug)!.n;
}

export async function resolveFeedback(user: User, id: number, status: Status, reply?: string) {
  const row = get<Row>('SELECT * FROM feedback WHERE id = ?', id);
  if (!row) throw new UserError('err.feedback.notFound', { id });
  const t = target(row.kind, row.slug);
  if (!t.canManage(user)) throw new UserError('err.feedback.notOwner', { slug: row.slug });
  const answer = reply?.trim().slice(0, 2000) || null;
  if (status === 'open') run('UPDATE feedback SET status = ?, reply = ?, resolved_at = NULL, resolved_by = NULL WHERE id = ?', status, answer, id);
  else run('UPDATE feedback SET status = ?, reply = ?, resolved_at = ?, resolved_by = ? WHERE id = ?', status, answer, now(), user.id, id);
  if (status !== 'open' && row.status === 'open') {
    void tell(row.user_id, (L) => tr(L, status === 'done' ? 'feedback.msg.done' : 'feedback.msg.declined', {
      target: t.name(L), body: short(row.body, 80), reply: answer ?? '', url: t.link,
    }).trim());
  }
  return shape(get<Row>('SELECT * FROM feedback WHERE id = ?', id)!);
}
