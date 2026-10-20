/**
 * Feedback on apps and who uses them. Colleagues tell an app's owner what is wrong or missing; the owner's agent
 * reads it over MCP, fixes the app and marks it done, and the person who asked is told. Visits are counted per
 * person per day, so owners and colleagues can see whether an app is used.
 */
import { config } from '../config.ts';
import { all, get, now, run, type App, type User } from '../db.ts';
import { tr, UserError } from '../i18n/index.ts';
import { localize } from '../localized.ts';
import { messenger } from '../notify.ts';
import { canAccessApp, canManageApp } from './access.ts';

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

// ---------------------------------------------------------------- visits
const seen = new Set<string>();
/** Called by the gateway for every signed-in request; one row per app, person and day. */
export function recordVisit(slug: string, userId: string) {
  const key = `${today()}|${slug}|${userId}`;
  if (seen.has(key)) return;
  if (seen.size > 50_000) seen.clear();
  seen.add(key);
  run('INSERT OR IGNORE INTO app_visits (app_slug, user_id, day) VALUES (?, ?, ?)', slug, userId, today());
}

/** People who opened each app in the last 30 days (owners not counted). */
export function usageBySlug(): Map<string, number> {
  const rows = all<{ app_slug: string; n: number }>(
    `SELECT v.app_slug, COUNT(DISTINCT v.user_id) AS n FROM app_visits v JOIN apps a ON a.slug = v.app_slug
     WHERE v.day >= ? AND v.user_id != a.owner_id GROUP BY v.app_slug`, daysAgo(30));
  return new Map(rows.map((r) => [r.app_slug, r.n]));
}

/** For the app's owner: people per day over the last 30 days, and everyone who has opened it. */
export function usageDetail(app: App) {
  const from = daysAgo(29);
  const perDay = new Map(all<{ day: string; n: number }>(
    'SELECT day, COUNT(*) AS n FROM app_visits WHERE app_slug = ? AND day >= ? AND user_id != ? GROUP BY day', app.slug, from, app.owner_id,
  ).map((r) => [r.day, r.n]));
  const days = Array.from({ length: 30 }, (_, i) => daysAgo(29 - i)).map((day) => ({ day, people: perDay.get(day) ?? 0 }));
  const total = get<{ n: number }>('SELECT COUNT(DISTINCT user_id) AS n FROM app_visits WHERE app_slug = ? AND user_id != ?', app.slug, app.owner_id)!.n;
  return { days, last30: usageBySlug().get(app.slug) ?? 0, total };
}

// ---------------------------------------------------------------- feedback
type Status = 'open' | 'done' | 'declined';
interface Row { id: number; app_slug: string; user_id: string; body: string; status: Status; reply: string | null; created_at: number; resolved_at: number | null; resolved_by: string | null }

const PER_HOUR = 20;

function appOrThrow(slug: string): App {
  const app = get<App>('SELECT * FROM apps WHERE slug = ?', slug);
  if (!app) throw new UserError('err.appNotFound', { slug });
  return app;
}

function shape(r: Row) {
  const who = (id: string | null) => (id ? get<{ id: string; name: string; avatar: string | null }>('SELECT id, name, avatar FROM users WHERE id = ?', id) ?? null : null);
  return { id: r.id, app: r.app_slug, body: r.body, status: r.status, reply: r.reply, at: r.created_at, resolvedAt: r.resolved_at, author: who(r.user_id), resolvedBy: who(r.resolved_by) };
}

const appLink = (slug: string) => `${config.hubUrl}/apps/${slug}#feedback`;

async function tell(userId: string, text: (locale: string) => string) {
  if (!messenger) return;
  const locale = get<{ locale: string | null }>('SELECT locale FROM users WHERE id = ?', userId)?.locale ?? config.defaultLocale;
  try {
    await messenger.toPerson(userId, text(locale));
  } catch (e) {
    console.warn('[feedback] could not message', userId, (e as Error).message);
  }
}

export async function addFeedback(user: User, slug: string, body: string) {
  const app = appOrThrow(slug);
  if (!canAccessApp(app, user)) throw new UserError('err.appNotFound', { slug });
  const text = body.trim();
  if (text.length < 2 || text.length > 2000) throw new UserError('err.feedback.length');
  const recent = get<{ n: number }>('SELECT COUNT(*) AS n FROM app_feedback WHERE user_id = ? AND created_at > ?', user.id, now() - 3600_000)!.n;
  if (recent >= PER_HOUR) throw new UserError('err.feedback.rateLimited', { n: PER_HOUR });
  const id = Number(run('INSERT INTO app_feedback (app_slug, user_id, body, created_at) VALUES (?, ?, ?, ?)', slug, user.id, text, now()).lastInsertRowid);
  if (app.owner_id !== user.id) {
    void tell(app.owner_id, (L) => tr(L, 'feedback.msg.new', { app: localize(app, app.i18n, L).name, name: user.name, body: text, url: appLink(slug) }));
  }
  return shape(get<Row>('SELECT * FROM app_feedback WHERE id = ?', id)!);
}

/** The app's managers see everything said about it; everyone else sees what they said themselves. */
export function feedbackFor(user: User, slug: string) {
  const app = appOrThrow(slug);
  const rows = canManageApp(app, user)
    ? all<Row>("SELECT * FROM app_feedback WHERE app_slug = ? ORDER BY status = 'open' DESC, created_at DESC LIMIT 200", slug)
    : all<Row>('SELECT * FROM app_feedback WHERE app_slug = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50', slug, user.id);
  return rows.map(shape);
}

/** Feedback on the apps this person can manage (all of them, or one), newest first. */
export function feedbackToHandle(user: User, opts: { slug?: string; status?: Status | 'all' }) {
  const apps = (opts.slug ? [appOrThrow(opts.slug)] : all<App>('SELECT * FROM apps')).filter((a) => canManageApp(a, user));
  if (opts.slug && !apps.length) throw new UserError('err.notAppOwner', { slug: opts.slug ?? '' });
  if (!apps.length) return [];
  const status = opts.status ?? 'open';
  const marks = apps.map(() => '?').join(',');
  return all<Row>(
    `SELECT * FROM app_feedback WHERE app_slug IN (${marks}) ${status === 'all' ? '' : 'AND status = ?'} ORDER BY created_at DESC LIMIT 200`,
    ...apps.map((a) => a.slug), ...(status === 'all' ? [] : [status]),
  ).map(shape);
}

export function openFeedbackCount(slug: string): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM app_feedback WHERE app_slug = ? AND status = 'open'", slug)!.n;
}

export async function resolveFeedback(user: User, id: number, status: Status, reply?: string) {
  const row = get<Row>('SELECT * FROM app_feedback WHERE id = ?', id);
  if (!row) throw new UserError('err.feedback.notFound', { id });
  const app = appOrThrow(row.app_slug);
  if (!canManageApp(app, user)) throw new UserError('err.notAppOwner', { slug: app.slug });
  const answer = reply?.trim().slice(0, 2000) || null;
  if (status === 'open') run('UPDATE app_feedback SET status = ?, reply = ?, resolved_at = NULL, resolved_by = NULL WHERE id = ?', status, answer, id);
  else run('UPDATE app_feedback SET status = ?, reply = ?, resolved_at = ?, resolved_by = ? WHERE id = ?', status, answer, now(), user.id, id);
  if (status !== 'open' && row.status === 'open' && row.user_id !== user.id) {
    void tell(row.user_id, (L) => tr(L, status === 'done' ? 'feedback.msg.done' : 'feedback.msg.declined', {
      app: localize(app, app.i18n, L).name, body: row.body.length > 80 ? row.body.slice(0, 80) + '…' : row.body, reply: answer ?? '', url: appLink(app.slug),
    }).trim());
  }
  return shape(get<Row>('SELECT * FROM app_feedback WHERE id = ?', id)!);
}
