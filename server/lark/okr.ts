/**
 * Lark OKR, read with the viewer's own Lark access (Lark decides whose OKRs they may see).
 * Periods carry only names ("2026 年 10 - 12 月", "Oct - Dec, 2026"), so the date range is read from the name;
 * the pace card needs it to tell how much of the period has passed.
 *
 * The period list endpoint does not accept user tokens (Lark answers 99991668 "user access token not support"), so
 * the current period is found from the person's own OKR list, which carries each period's name. The app-identity
 * period list (scope okr:okr.period:readonly) is only an optional extra for list_okr_periods.
 */
import { config } from '../config.ts';
import type { User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { DENIED_CODES, LarkError, SCOPE_CODES } from './client.ts';
import { asUser } from './userToken.ts';
import { getTenantToken } from './auth.ts';
import { larkFetch } from './client.ts';

interface LarkPeriod { id: string; zh_name?: string; en_name?: string; status?: number }
interface LarkProgress { percent?: number; status?: number | string }
interface ProgressRef { id: string }
export interface LarkKr { id: string; content?: string; progress_rate?: LarkProgress; weight?: number; kr_weight?: number; progress_record_list?: ProgressRef[] }
interface AlignRef { id: string; owner?: { open_id?: string; user_id?: string } }
export interface LarkObjective { id: string; content?: string; progress_rate?: LarkProgress; weight?: number; kr_list?: LarkKr[]; aligned_objective_list?: AlignRef[]; aligning_objective_list?: AlignRef[]; progress_record_list?: ProgressRef[] }
export interface LarkOkr { id: string; name?: string; period_id?: string; objective_list?: LarkObjective[] }

async function call<T>(user: User, path: string): Promise<T> {
  try {
    return await asUser<T>(user, path);
  } catch (e) {
    if (e instanceof LarkError && SCOPE_CODES.has(e.code)) throw new UserError('err.lark.scopeMissing', { detail: e.message });
    if (e instanceof LarkError && DENIED_CODES.has(e.code)) throw new UserError('err.okr.denied');
    throw e;
  }
}

const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** First day of the start month and first day after the end month, at midnight in the company time zone. */
export function periodRange(name: string): { start: number; end: number } | null {
  const year = Number(name.match(/(20\d\d)/)?.[1]);
  if (!year) return null;
  let months: number[] = [];
  const q = name.match(/Q([1-4])/i);
  if (q) months = [(Number(q[1]) - 1) * 3 + 1, Number(q[1]) * 3];
  if (!months.length) {
    // "10 - 12 月", "10月-12月", "3 月": numbers that are months, not the year
    const zh = name.replace(/20\d\d\s*年?/, '').match(/\d{1,2}(?=\s*(月|-|–|~|至|到))/g);
    if (zh && /月/.test(name)) months = zh.map(Number).filter((m) => m >= 1 && m <= 12);
  }
  if (!months.length) {
    const lower = name.toLowerCase();
    months = EN_MONTHS.map((m, i) => (lower.match(new RegExp(`\\b${m}`)) ? i + 1 : 0)).filter(Boolean);
    // keep the written order: "Nov - Jan" is rare; sort is good enough for quarters/halves
  }
  if (!months.length) return null;
  const first = Math.min(...months);
  const last = Math.max(...months);
  return { start: zonedMidnight(year, first, 1), end: last === 12 ? zonedMidnight(year + 1, 1, 1) : zonedMidnight(year, last + 1, 1) };
}

/** Midnight of a calendar date in the company time zone, as epoch ms. */
function zonedMidnight(y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d);
  const shown = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hour: 'numeric', hourCycle: 'h23', day: 'numeric' }).formatToParts(new Date(guess));
  const hour = Number(shown.find((p) => p.type === 'hour')?.value ?? 0);
  const day = Number(shown.find((p) => p.type === 'day')?.value ?? d);
  // the zone is ahead of UTC when the UTC midnight already shows a later hour that day
  const offsetH = day === d ? hour : hour - 24;
  return guess - offsetH * 3600_000;
}

/** One person's OKRs, one entry per period (optionally only some periods), all pages. */
export async function okrList(user: User, target: string, locale: string, periodIds?: string[]): Promise<LarkOkr[]> {
  const lang = locale.startsWith('zh') ? 'zh_cn' : 'en_us';
  const periods = (periodIds ?? []).map((id) => `&period_ids=${encodeURIComponent(id)}`).join('');
  const out: LarkOkr[] = [];
  for (let offset = 0; offset < 100; offset += 10) {
    const r = await call<{ data: { okr_list?: LarkOkr[]; total?: number } }>(
      user, `/okr/v1/users/${encodeURIComponent(target)}/okrs?user_id_type=open_id&offset=${offset}&limit=10&lang=${lang}${periods}`);
    const page = r.data.okr_list ?? [];
    out.push(...page);
    if (page.length < 10 || out.length >= (r.data.total ?? 0)) break;
  }
  return out;
}

interface Element { type?: string; textRun?: { text?: string }; docsLink?: { title?: string; url?: string }; person?: { openId?: string } }
interface Block { type?: string; paragraph?: { elements?: Element[] } }

/** A progress update as plain text: paragraphs joined by line breaks, links by their titles, people as @name. */
function progressText(blocks: Block[], nameOf: (openId: string) => string | undefined): string {
  return blocks.map((b) => (b.paragraph?.elements ?? []).map((e) =>
    e.textRun?.text ?? e.docsLink?.title ?? e.docsLink?.url ?? (e.person?.openId ? `@${nameOf(e.person.openId) ?? ''}` : ''),
  ).join('')).filter((t) => t.trim()).join('\n').trim();
}

/** One progress update (written in Lark OKR on an objective or key result), read with the viewer's access. */
export async function progressRecord(user: User, id: string, nameOf: (openId: string) => string | undefined) {
  const r = await call<{ data: { progress_id: string; modify_time?: string; content?: { blocks?: Block[] } } }>(user, `/okr/v1/progress_records/${encodeURIComponent(id)}?user_id_type=open_id`);
  return { id: r.data.progress_id ?? id, at: Number(r.data.modify_time) || 0, text: progressText(r.data.content?.blocks ?? [], nameOf) };
}

export const periodOf = (o: LarkOkr) => ({ id: o.period_id ?? o.id, name: o.name ?? '', range: periodRange(o.name ?? '') });

/** OKR periods: the company's full list with the app-identity scope, otherwise the periods the person has OKRs in. */
export async function listPeriods(user: User, locale: string) {
  try {
    const r = await larkFetch<{ data: { items?: LarkPeriod[] } }>('/okr/v1/periods?page_size=100', { token: await getTenantToken() });
    return (r.data.items ?? []).map((p) => {
      const name = (locale.startsWith('zh') ? p.zh_name || p.en_name : p.en_name || p.zh_name) ?? p.id;
      return { id: p.id, name, range: periodRange(p.zh_name ?? '') ?? periodRange(p.en_name ?? '') };
    });
  } catch (e) {
    if (!(e instanceof LarkError)) throw e;
    const seen = new Map<string, ReturnType<typeof periodOf>>();
    for (const o of await okrList(user, user.id, locale)) seen.set(periodOf(o).id, periodOf(o));
    return [...seen.values()];
  }
}

/** The item whose period contains today, else the most recent one. */
export function current<T extends { range: { start: number; end: number } | null }>(items: T[]): T | undefined {
  const now = Date.now();
  return items.find((p) => p.range && p.range.start <= now && now < p.range.end)
    ?? [...items].sort((a, b) => (b.range?.start ?? 0) - (a.range?.start ?? 0))[0];
}

export const pct = (p?: LarkProgress) => (typeof p?.percent === 'number' && Number.isFinite(p.percent) ? Math.max(0, Math.min(100, p.percent)) / 100 : null);

/** Someone's OKRs for a period (default: the current one), with progress as 0–1 and how much of the period is gone. */
export async function userOkrs(user: User, opts: { userId?: string; periodId?: string; locale: string }) {
  const target = opts.userId ?? user.id;
  const entries = (await okrList(user, target, opts.locale, opts.periodId ? [opts.periodId] : undefined)).map((o) => ({ o, ...periodOf(o) }));
  const chosen = current(entries);
  const period = chosen ?? { id: opts.periodId ?? '', name: '', range: null };
  const objectives = (chosen?.o.objective_list ?? []).map((o) => {
    const krs = (o.kr_list ?? []).map((k) => ({ id: k.id, content: (k.content ?? '').trim(), progress: pct(k.progress_rate) ?? 0, weight: k.weight ?? k.kr_weight ?? 1 }));
    const weightSum = krs.reduce((a, k) => a + k.weight, 0);
    const fromKrs = krs.length && weightSum ? krs.reduce((a, k) => a + k.progress * k.weight, 0) / weightSum : 0;
    return { id: o.id, content: (o.content ?? '').trim(), progress: pct(o.progress_rate) ?? fromKrs, weight: o.weight ?? 1, krs: krs.map(({ weight: _w, ...k }) => k) };
  });
  const wSum = objectives.reduce((a, o) => a + o.weight, 0);
  const done = objectives.length && wSum ? objectives.reduce((a, o) => a + o.progress * o.weight, 0) / wSum : 0;
  const elapsed = period.range ? Math.max(0, Math.min(1, (Date.now() - period.range.start) / (period.range.end - period.range.start))) : null;
  return {
    period: { id: period.id, name: period.name, start: period.range?.start ?? null, end: period.range?.end ?? null },
    done: Math.round(done * 1000) / 1000,
    elapsed: elapsed === null ? null : Math.round(elapsed * 1000) / 1000,
    objectives: objectives.map(({ weight: _w, ...o }) => o),
    url: `https://${config.lark.domain === 'feishu.cn' ? 'okr.feishu.cn' : 'okr.larksuite.com'}`,
  };
}
