/**
 * Alert rules on Base data. Each rule is checked on a schedule with its owner's Lark access (the owner can read the
 * table; recipients are people the owner chose to tell). Firing rules show on the recipients' home pages.
 *
 * Lark messages are kept calm on purpose: a rule messages people only when its state differs from what they were last
 * told, at most once per cooldown (flapping inside the window is merged), never during quiet hours (held until
 * morning), one combined message per person per round, and anyone can opt out. While the hub-wide setting is
 * "admins", only hub admins get messages at all.
 */
import { z } from 'zod';
import { config } from '../config.ts';
import { all, get, now, run, type User } from '../db.ts';
import { tr, UserError } from '../i18n/index.ts';
import { pick } from '../library.ts';
import { hourIn, isQuietHour } from './quiet.ts';
import { messenger } from '../notify.ts';
import { getSource, query } from './sources.ts';
import { querySchema, toStat, type Query } from './query.ts';

export const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('above'), value: z.number().describe('fires when the value is above this') }),
  z.object({ type: z.literal('below'), value: z.number().describe('fires when the value is below this') }),
  z.object({
    type: z.literal('change'),
    direction: z.enum(['drop', 'rise', 'either']),
    ratio: z.number().positive().max(10).describe('e.g. 0.2 = fires when the latest bucket moved 20% or more against the previous one'),
  }),
]).describe('compared with the measured value: the total, or the latest date bucket when the query has `date`');
export type Condition = z.infer<typeof conditionSchema>;

interface RuleRow {
  id: number; title_i18n: string; source_id: string; query: string; condition: string; recipients: string; chat_id: string | null;
  every_minutes: number; owner_id: string; enabled: number; state: 'pending' | 'ok' | 'firing' | 'error'; last_value: number | null;
  last_detail: string | null; last_error: string | null; last_checked_at: number | null; state_since: number | null; created_at: number; updated_at: number;
  notified_state: 'ok' | 'firing' | null; notified_at: number | null; muted: string;
}

// ---------------------------------------------------------------- who may be messaged (hub-wide setting)
export type NotifyMode = 'admins' | 'everyone';
export function notifyMode(): NotifyMode {
  return get<{ value: string }>("SELECT value FROM settings WHERE key = 'alerts.notify'")?.value === 'everyone' ? 'everyone' : 'admins';
}
export function setNotifyMode(user: User, mode: NotifyMode) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  run(`INSERT INTO settings (key, value, updated_at) VALUES ('alerts.notify', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, mode, now());
}

const canEdit = (u: User, r: RuleRow) => u.role === 'admin' || r.owner_id === u.id;

function getRule(id: number): RuleRow {
  const r = get<RuleRow>('SELECT * FROM alert_rules WHERE id = ?', id);
  if (!r) throw new UserError('err.alert.notFound', { id });
  return r;
}

export function saveRule(user: User, input: {
  id?: number; title: Record<string, string>; source: string; query: Query; condition: Condition; recipients: string[]; chatId?: string; everyMinutes?: number; enabled?: boolean;
}) {
  getSource(input.source);
  querySchema.parse(input.query);
  conditionSchema.parse(input.condition);
  if (input.condition.type === 'change' && !input.query.date) throw new UserError('err.alert.changeNeedsDate');
  if (input.query.groupBy || input.query.series) throw new UserError('err.alert.noGroups');
  const every = Math.max(10, Math.min(24 * 60, input.everyMinutes ?? 60));
  const recipients = JSON.stringify([...new Set([user.id, ...input.recipients])]);
  if (input.id) {
    const r = getRule(input.id);
    if (!canEdit(user, r)) throw new UserError('err.alert.notOwner');
    run(`UPDATE alert_rules SET title_i18n = ?, source_id = ?, query = ?, condition = ?, recipients = ?, chat_id = ?, every_minutes = ?, enabled = ?,
         state = 'pending', last_checked_at = NULL, notified_state = NULL, notified_at = NULL, updated_at = ? WHERE id = ?`,
      JSON.stringify(input.title), input.source, JSON.stringify(input.query), JSON.stringify(input.condition), recipients, input.chatId ?? null, every,
      input.enabled === false ? 0 : 1, now(), input.id);
    return { id: input.id };
  }
  const res = run(`INSERT INTO alert_rules (title_i18n, source_id, query, condition, recipients, chat_id, every_minutes, owner_id, enabled, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    JSON.stringify(input.title), input.source, JSON.stringify(input.query), JSON.stringify(input.condition), recipients, input.chatId ?? null, every, user.id,
    input.enabled === false ? 0 : 1, now(), now());
  return { id: Number(res.lastInsertRowid) };
}

export function deleteRule(user: User, id: number) {
  const r = getRule(id);
  if (!canEdit(user, r)) throw new UserError('err.alert.notOwner');
  run('DELETE FROM alert_rules WHERE id = ?', id);
  return { deleted: true };
}

/** Rules this person owns or is told about. */
export function rulesFor(user: User, locale: string) {
  return all<RuleRow>('SELECT * FROM alert_rules ORDER BY state = \'firing\' DESC, updated_at DESC')
    .filter((r) => r.owner_id === user.id || (JSON.parse(r.recipients) as string[]).includes(user.id))
    .map((r) => ({ ...describe(r, locale), muted: (JSON.parse(r.muted) as string[]).includes(user.id), mine: r.owner_id === user.id }));
}

/**
 * "Stop messaging me". A recipient is taken off the rule; the owner (who stays responsible for it) keeps seeing it on
 * the home page but gets no messages until they turn it back on.
 */
export function muteRule(user: User, id: number, muted: boolean) {
  const r = getRule(id);
  const recipients = JSON.parse(r.recipients) as string[];
  if (r.owner_id !== user.id && !recipients.includes(user.id)) throw new UserError('err.alert.notFound', { id });
  const set = new Set(JSON.parse(r.muted) as string[]);
  if (muted) set.add(user.id);
  else set.delete(user.id);
  const nextRecipients = muted && r.owner_id !== user.id ? recipients.filter((x) => x !== user.id) : recipients;
  run('UPDATE alert_rules SET muted = ?, recipients = ? WHERE id = ?', JSON.stringify([...set]), JSON.stringify(nextRecipients), id);
  return { muted };
}

function describe(r: RuleRow, locale: string) {
  const owner = get<{ name: string }>('SELECT name FROM users WHERE id = ?', r.owner_id);
  const src = get<{ title_i18n: string; url: string }>('SELECT title_i18n, url FROM data_sources WHERE id = ?', r.source_id);
  return {
    id: r.id,
    title: pick(JSON.parse(r.title_i18n), locale),
    source: { id: r.source_id, title: src ? pick(JSON.parse(src.title_i18n), locale) : r.source_id, url: src?.url ?? null },
    condition: conditionText(JSON.parse(r.condition) as Condition, locale),
    state: r.enabled ? r.state : 'paused',
    value: r.last_value,
    detail: r.last_detail,
    error: r.last_error,
    checkedAt: r.last_checked_at,
    since: r.state_since,
    everyMinutes: r.every_minutes,
    owner: owner?.name ?? '',
    recipients: (JSON.parse(r.recipients) as string[]).length,
    chat: !!r.chat_id,
    query: JSON.parse(r.query) as Query,
    rawCondition: JSON.parse(r.condition) as Condition,
  };
}

const fmt = (n: number, locale: string) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);

function conditionText(c: Condition, locale: string): string {
  if (c.type === 'above') return tr(locale, 'alert.cond.above', { value: fmt(c.value, locale) });
  if (c.type === 'below') return tr(locale, 'alert.cond.below', { value: fmt(c.value, locale) });
  return tr(locale, `alert.cond.${c.direction}`, { pct: fmt(c.ratio * 100, locale) });
}

/** Fires or not, with the number shown to people. */
export function evaluate(c: Condition, stat: { value: number; delta?: number }): { firing: boolean; change?: number } {
  if (c.type === 'above') return { firing: stat.value > c.value };
  if (c.type === 'below') return { firing: stat.value < c.value };
  const d = stat.delta;
  if (d === undefined || !Number.isFinite(d)) return { firing: false };
  const firing = c.direction === 'drop' ? d <= -c.ratio : c.direction === 'rise' ? d >= c.ratio : Math.abs(d) >= c.ratio;
  return { firing, change: d };
}

/** Runs one rule now with its owner's access and records the result. Messages are sent by flushNotices. */
export async function checkRule(id: number) {
  const r = getRule(id);
  const owner = get<User>('SELECT * FROM users WHERE id = ?', r.owner_id);
  const at = now();
  try {
    if (!owner) throw new Error('owner gone');
    const result = await query(owner, r.source_id, JSON.parse(r.query) as Query, true);
    const stat = toStat(result);
    const { firing, change } = evaluate(JSON.parse(r.condition) as Condition, stat);
    const state = firing ? 'firing' : 'ok';
    run('UPDATE alert_rules SET state = ?, last_value = ?, last_detail = ?, last_error = NULL, last_checked_at = ?, state_since = ? WHERE id = ?',
      state, stat.value, change !== undefined ? JSON.stringify({ change }) : null, at, state !== r.state ? at : r.state_since ?? at, id);
    return { state, value: stat.value, change };
  } catch (e) {
    const message = e instanceof UserError ? e.localized(owner?.locale ?? config.defaultLocale) : (e as Error).message;
    run('UPDATE alert_rules SET state = \'error\', last_error = ?, last_checked_at = ?, state_since = CASE WHEN state = \'error\' THEN state_since ELSE ? END WHERE id = ?',
      message.slice(0, 500), at, at, id);
    return { state: 'error' as const, error: message };
  }
}

/** Rules whose state differs from what people were last told, and whose cooldown is over. */
function dueRules(at: number): RuleRow[] {
  const cooldown = config.alerts.cooldownMinutes * 60_000;
  return all<RuleRow>("SELECT * FROM alert_rules WHERE enabled = 1 AND state IN ('ok', 'firing')")
    .filter((r) => r.state !== (r.notified_state ?? 'ok') && (r.notified_at === null || at - r.notified_at >= cooldown));
}

/**
 * Sends what is due: one message per person covering all their due rules (and one per group chat). During quiet
 * hours nothing is sent; the next round after them picks it up.
 */
export async function flushNotices(at = now()): Promise<{ sent: number; held?: 'quiet' }> {
  const due = dueRules(at);
  if (!due.length) return { sent: 0 };
  if (isQuietHour(hourIn(config.timezone, at), config.alerts.quietHours)) return { sent: 0, held: 'quiet' };
  const mode = notifyMode();
  const admins = new Set(all<{ id: string }>("SELECT id FROM users WHERE role = 'admin'").map((u) => u.id));
  const perUser = new Map<string, RuleRow[]>();
  const perChat = new Map<string, RuleRow[]>();
  for (const r of due) {
    const muted = new Set(JSON.parse(r.muted) as string[]);
    for (const uid of JSON.parse(r.recipients) as string[]) {
      if (muted.has(uid) || (mode === 'admins' && !admins.has(uid))) continue;
      perUser.set(uid, [...(perUser.get(uid) ?? []), r]);
    }
    if (r.chat_id && mode === 'everyone') perChat.set(r.chat_id, [...(perChat.get(r.chat_id) ?? []), r]);
    // people are now considered told, even if all of them opted out or are filtered by the setting
    run('UPDATE alert_rules SET notified_state = ?, notified_at = ? WHERE id = ?', r.state, at, r.id);
  }
  // no chat tool connected: the alerts module on home pages is the only place people see it
  if (!messenger) return { sent: 0 };
  let sent = 0;
  const send = async (to: 'person' | 'group', id: string, rules: RuleRow[], locale: string) => {
    try {
      const text = noticeText(rules, locale);
      await (to === 'person' ? messenger!.toPerson(id, text) : messenger!.toGroup(id, text));
      sent++;
    } catch (e) {
      console.warn('[alerts] could not message', to, id, (e as Error).message);
    }
  };
  for (const [uid, rules] of perUser) {
    const u = get<{ locale: string | null }>('SELECT locale FROM users WHERE id = ?', uid);
    await send('person', uid, rules, u?.locale ?? config.defaultLocale);
  }
  for (const [chat, rules] of perChat) await send('group', chat, rules, config.defaultLocale);
  return { sent };
}

/** One rule: title, value and source. Several: a short list under one heading. */
function noticeText(rules: RuleRow[], locale: string): string {
  const block = (r: RuleRow, withLinks: boolean) => {
    const src = get<{ title_i18n: string; url: string }>('SELECT title_i18n, url FROM data_sources WHERE id = ?', r.source_id);
    const change = r.last_detail ? (JSON.parse(r.last_detail) as { change?: number }).change : undefined;
    const title = pick(JSON.parse(r.title_i18n), locale);
    return [
      tr(locale, r.state === 'firing' ? 'alert.msg.fire' : 'alert.msg.recover', { title }),
      tr(locale, 'alert.msg.value', { value: fmt(r.last_value ?? 0, locale), condition: conditionText(JSON.parse(r.condition) as Condition, locale) })
        + (change !== undefined ? ` · ${tr(locale, 'alert.msg.change', { pct: `${change > 0 ? '+' : ''}${fmt(change * 100, locale)}` })}` : ''),
      withLinks && src ? tr(locale, 'alert.msg.source', { source: pick(JSON.parse(src.title_i18n), locale), url: src.url }) : '',
    ].filter(Boolean).join('\n');
  };
  const parts = rules.length === 1
    ? [block(rules[0], true)]
    : [tr(locale, 'alert.msg.digest', { n: rules.length }), ...rules.map((r) => block(r, false))];
  return [...parts, tr(locale, 'alert.msg.hub', { url: config.hubUrl })].join('\n\n');
}

/** Checks due rules once a minute, one at a time. */
export function startAlertScheduler() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const due = all<{ id: number }>('SELECT id FROM alert_rules WHERE enabled = 1 AND (last_checked_at IS NULL OR last_checked_at + every_minutes * 60000 <= ?)', now());
      for (const { id } of due) await checkRule(id);
      await flushNotices();
    } catch (e) {
      console.error('[alerts]', e);
    } finally {
      busy = false;
    }
  };
  setTimeout(tick, 15_000);
  return setInterval(tick, 60_000);
}
