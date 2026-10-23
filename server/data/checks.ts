/**
 * Data checks ("异常项"): rules, usually written by an agent after talking the business rules through with the team,
 * that find records in a Base table needing a fix: contradictions, missing values, stale rows, duplicates, and the
 * same thing written several ways. Each check runs with its creator's Lark access; every issue is assigned to the
 * people in the record's owner field, who see it on the issues page and on their home page.
 *
 * Who sees what: an issue's owners always see it (it is their record); the full list shows issues from tables the
 * viewer can open in Lark (checked with their own Lark access), so nobody sees rows they could not see in Lark.
 */
import { z } from 'zod';
import { config } from '../config.ts';
import { all, get, now, run, tx, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { pick } from '../library.ts';
import { canReadSource, getSource, loadTable, type Row } from './sources.ts';
import { isDateField, people, plainNumber, plainText, plainValues, timeOf, type Field } from './fields.ts';

// ---------------------------------------------------------------- rule format (also the MCP schema)
const conditionSchema = z.object({
  field: z.string(),
  op: z.enum([
    'empty', 'notEmpty', 'is', 'isNot', 'in', 'notIn', 'contains', 'notContains',
    'gt', 'gte', 'lt', 'lte', 'olderThanDays', 'newerThanDays',
    'beforeField', 'afterField', 'sameAsField', 'differentFromField',
  ]).describe('is/isNot/in/notIn/contains compare the cell as text (options by name, checkbox as "true"/"false", dates as YYYY-MM-DD); gt/lt compare numbers, or dates with a YYYY-MM-DD or "today" value; olderThanDays/newerThanDays: date field vs today; *Field ops compare with `other`'),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  other: z.string().optional().describe('the other field for beforeField / afterField / sameAsField / differentFromField'),
});
type Cond = z.infer<typeof conditionSchema>;

export const specSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rows'),
    all: z.array(conditionSchema).min(1).max(10).describe('a record is an issue when all of these hold…'),
    any: z.array(conditionSchema).max(10).optional().describe('…and (if given) at least one of these'),
  }).describe('row by row, e.g. status "paid" but no payment date'),
  z.object({ kind: z.literal('duplicates'), fields: z.array(z.string()).min(1).max(4) })
    .describe('records sharing the same values in these fields (compared ignoring case, spaces and full/half width)'),
  z.object({ kind: z.literal('variants'), field: z.string() })
    .describe('the same value written differently ("Tether" / "tether " / "ＴＥＴＨＥＲ"); records using the less common spelling are issues'),
]);
export type Spec = z.infer<typeof specSchema>;

export const LEVELS = ['error', 'verify', 'style'] as const;
export type Level = (typeof LEVELS)[number];

interface CheckRow {
  id: number; title_i18n: string; hint_i18n: string | null; source_id: string; level: Level; team_i18n: string | null; spec: string;
  owner_field: string | null; label_fields: string; owner_id: string; enabled: number; last_run_at: number | null; last_error: string | null;
  created_at: number; updated_at: number;
}
interface IssueRow { check_id: number; record_id: string; label: string; detail: string; owners: string; url: string | null; first_seen: number; last_seen: number }

// ---------------------------------------------------------------- evaluating records
const DAY = 86_400_000;
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function dateValue(raw: string | number | boolean, at = Date.now()): number | null {
  if (typeof raw === 'number') return raw;
  if (raw === 'today') return at;
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** A cell's text and, for dates and numbers, a comparable number. Text holding ISO dates counts as a date. */
function cell(rec: Record<string, unknown>, f: Field) {
  const vals = plainValues(rec[f.name]).filter((x) => x !== '' && x !== null);
  const text = plainText(rec[f.name], f).trim();
  const time = timeOf(rec[f.name]);
  const isTime = isDateField(f) || (typeof vals[0] === 'string' && time !== null);
  return { empty: vals.length === 0, text, texts: vals.map((x) => String(x).trim()), num: isTime ? time : plainNumber(rec[f.name]), time, isTime };
}

function holds(c: Cond, rec: Record<string, unknown>, fields: Map<string, Field>, at: number): boolean {
  const f = fields.get(c.field)!;
  const v = cell(rec, f);
  const want = c.value;
  const asTexts = Array.isArray(want) ? want.map(String) : want === undefined ? [] : [String(want)];
  switch (c.op) {
    case 'empty': return v.empty;
    case 'notEmpty': return !v.empty;
    case 'is': return !v.empty && (v.texts.some((t) => t === asTexts[0]) || v.text === asTexts[0]);
    case 'isNot': return !(v.texts.some((t) => t === asTexts[0]) || v.text === asTexts[0]);
    case 'in': return v.texts.some((t) => asTexts.includes(t));
    case 'notIn': return !v.texts.some((t) => asTexts.includes(t));
    case 'contains': return v.text.includes(asTexts[0] ?? '');
    case 'notContains': return !v.text.includes(asTexts[0] ?? '');
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const asDate = isDateField(f) || v.isTime || want === 'today' || /^\d{4}-\d{2}-\d{2}$/.test(String(want));
      const other = asDate ? dateValue(want as string | number, at) : Number(want);
      if (asDate && v.time !== null && other !== null) return c.op === 'gt' ? v.time > other : c.op === 'gte' ? v.time >= other : c.op === 'lt' ? v.time < other : v.time <= other;
      if (v.num === null || other === null || !Number.isFinite(other)) return false;
      return c.op === 'gt' ? v.num > other : c.op === 'gte' ? v.num >= other : c.op === 'lt' ? v.num < other : v.num <= other;
    }
    case 'olderThanDays': return v.time !== null && at - v.time > Number(want) * DAY;
    case 'newerThanDays': return v.time !== null && at - v.time <= Number(want) * DAY;
    case 'beforeField': case 'afterField': case 'sameAsField': case 'differentFromField': {
      const o = cell(rec, fields.get(c.other!)!);
      if (c.op === 'sameAsField') return !v.empty && !o.empty && norm(v.text) === norm(o.text);
      if (c.op === 'differentFromField') return !v.empty && !o.empty && norm(v.text) !== norm(o.text);
      if (v.time === null || o.time === null) return false;
      return c.op === 'beforeField' ? v.time < o.time : v.time > o.time;
    }
  }
}

/** Fields a check reads, for validation and to fetch only what is needed. */
function fieldsOf(spec: Spec, ownerField: string | null, labels: string[]): string[] {
  const used = spec.kind === 'rows'
    ? [...spec.all, ...(spec.any ?? [])].flatMap((c) => [c.field, ...(c.other ? [c.other] : [])])
    : spec.kind === 'duplicates' ? spec.fields : [spec.field];
  return [...new Set([...used, ...labels, ...(ownerField ? [ownerField] : [])])];
}

interface Found { recordId: string; url?: string; label: string; detail: Record<string, string>; owners: { id: string; name: string }[] }
type Resolve = (name: string) => { id: string; name: string } | null;

/** Owners from a person field, or names in a text / option field matched to colleagues (unmatched names kept as text). */
function ownersOf(v: unknown, resolve?: Resolve): { id: string; name: string }[] {
  const ppl = people(v);
  if (ppl.length) return ppl;
  return plainValues(v).filter((x): x is string => typeof x === 'string' && !!x.trim())
    .flatMap((x) => x.split(/[,，、]/)).map((x) => x.trim()).filter(Boolean)
    .map((name) => resolve?.(name) ?? { id: `?${name}`, name });
}

export function findIssues(spec: Spec, records: Row[], fields: Map<string, Field>, o: { ownerField: string | null; labels: string[]; at?: number; resolve?: Resolve }): Found[] {
  const at = o.at ?? Date.now();
  const shown = (rec: Record<string, unknown>, names: string[]) => Object.fromEntries(names.map((n) => [n, plainText(rec[n], fields.get(n))]));
  const make = (r: Row, names: string[], extra: Record<string, string> = {}): Found => ({
    recordId: r.id,
    url: r.url,
    label: o.labels.map((n) => plainText(r.fields[n], fields.get(n))).filter(Boolean).join(' · ') || r.id,
    detail: { ...shown(r.fields, names), ...extra },
    owners: o.ownerField ? ownersOf(r.fields[o.ownerField], o.resolve) : [],
  });
  if (spec.kind === 'rows') {
    const names = [...new Set([...spec.all, ...(spec.any ?? [])].flatMap((c) => [c.field, ...(c.other ? [c.other] : [])]))];
    return records
      .filter((r) => spec.all.every((c) => holds(c, r.fields, fields, at)) && (!spec.any?.length || spec.any.some((c) => holds(c, r.fields, fields, at))))
      .map((r) => make(r, names));
  }
  if (spec.kind === 'duplicates') {
    const groups = new Map<string, typeof records>();
    for (const r of records) {
      const key = spec.fields.map((n) => norm(plainText(r.fields[n], fields.get(n)))).join('\u0000');
      if (!key.replace(/\u0000/g, '')) continue;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups.values()].filter((g) => g.length > 1).flatMap((g) => g.map((r) => make(r, spec.fields, { '×': String(g.length) })));
  }
  // variants: per normalised value, the most common spelling is the reference
  const byKey = new Map<string, Map<string, typeof records>>();
  for (const r of records) {
    const raw = plainText(r.fields[spec.field], fields.get(spec.field));
    if (!raw.trim()) continue;
    const k = norm(raw);
    const spellings = byKey.get(k) ?? new Map();
    spellings.set(raw, [...(spellings.get(raw) ?? []), r]);
    byKey.set(k, spellings);
  }
  const out: Found[] = [];
  for (const spellings of byKey.values()) {
    if (spellings.size < 2) continue;
    const [main] = [...spellings.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    for (const [raw, recs] of spellings) if (raw !== main) for (const r of recs) out.push(make(r, [spec.field], { '→': main }));
  }
  return out;
}

// ---------------------------------------------------------------- saving and running
function getCheck(id: number): CheckRow {
  const c = get<CheckRow>('SELECT * FROM data_checks WHERE id = ?', id);
  if (!c) throw new UserError('err.check.notFound', { id });
  return c;
}
const canEdit = (u: User, c: CheckRow) => u.role === 'admin' || c.owner_id === u.id;

export async function saveCheck(user: User, input: {
  id?: number; title: Record<string, string>; hint?: Record<string, string>; source: string; level: Level; team?: Record<string, string>;
  spec: Spec; ownerField?: string; labelFields: string[]; enabled?: boolean;
}) {
  const src = getSource(input.source);
  const spec = specSchema.parse(input.spec);
  if (input.id && !canEdit(user, getCheck(input.id))) throw new UserError('err.check.notOwner');
  // every field must exist; reading them also proves the creator can open the table
  const fields = new Map((await loadTable(user, src)).fields.map((f) => [f.name, f]));
  for (const n of fieldsOf(spec, input.ownerField ?? null, input.labelFields)) {
    if (!fields.has(n)) throw new UserError('err.data.noField', { field: n, role: 'check', fields: [...fields.keys()].join(', ') });
  }
  const values = [JSON.stringify(input.title), input.hint ? JSON.stringify(input.hint) : null, input.source, input.level, input.team ? JSON.stringify(input.team) : null,
    JSON.stringify(spec), input.ownerField ?? null, JSON.stringify(input.labelFields), input.enabled === false ? 0 : 1, now()];
  let id = input.id;
  if (id) {
    run(`UPDATE data_checks SET title_i18n = ?, hint_i18n = ?, source_id = ?, level = ?, team_i18n = ?, spec = ?, owner_field = ?, label_fields = ?, enabled = ?, updated_at = ?
         WHERE id = ?`, ...values, id);
  } else {
    id = Number(run(`INSERT INTO data_checks (title_i18n, hint_i18n, source_id, level, team_i18n, spec, owner_field, label_fields, enabled, updated_at, owner_id, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...values, user.id, now()).lastInsertRowid);
  }
  return { id, ...(await runCheck(id)) };
}

export function deleteCheck(user: User, id: number) {
  if (!canEdit(user, getCheck(id))) throw new UserError('err.check.notOwner');
  run('DELETE FROM data_checks WHERE id = ?', id);
  return { deleted: true };
}

/** Runs one check with its creator's Lark access and replaces its issues. */
export async function runCheck(id: number) {
  const c = getCheck(id);
  const owner = get<User>('SELECT * FROM users WHERE id = ?', c.owner_id);
  const at = now();
  try {
    if (!owner) throw new Error('owner gone');
    const src = getSource(c.source_id);
    const spec = JSON.parse(c.spec) as Spec;
    const labels = JSON.parse(c.label_fields) as string[];
    const table = await loadTable(owner, src, true);
    const fields = new Map(table.fields.map((f) => [f.name, f]));
    const wanted = fieldsOf(spec, c.owner_field, labels);
    const missing = wanted.find((n) => !fields.has(n));
    if (missing) throw new UserError('err.data.noField', { field: missing, role: 'check', fields: [...fields.keys()].join(', ') });
    // issues are remembered per record, so rows from an app need an _id
    if (table.rows.some((r) => !r.id)) throw new UserError('err.check.needsIds');
    const records = table.rows;
    const found = findIssues(spec, records, fields, { ownerField: c.owner_field, labels, at, resolve: colleagueByName() });
    tx(() => {
      const keep = new Set(found.map((f) => f.recordId));
      for (const old of all<{ record_id: string }>('SELECT record_id FROM data_issues WHERE check_id = ?', id)) {
        if (!keep.has(old.record_id)) run('DELETE FROM data_issues WHERE check_id = ? AND record_id = ?', id, old.record_id);
      }
      for (const f of found) {
        run(`INSERT INTO data_issues (check_id, record_id, label, detail, owners, url, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(check_id, record_id) DO UPDATE SET label = excluded.label, detail = excluded.detail, owners = excluded.owners, url = excluded.url, last_seen = excluded.last_seen`,
          id, f.recordId, f.label.slice(0, 200), JSON.stringify(f.detail), JSON.stringify(f.owners), f.url ?? null, at, at);
      }
      // exceptions for records that are fine now are no longer needed
      run('DELETE FROM data_exceptions WHERE check_id = ? AND record_id NOT IN (SELECT record_id FROM data_issues WHERE check_id = ?)', id, id);
      run('UPDATE data_checks SET last_run_at = ?, last_error = NULL WHERE id = ?', at, id);
    });
    return { issues: found.length, records: records.length, sample: found.slice(0, 5).map((f) => ({ label: f.label, detail: f.detail, owners: f.owners.map((p) => p.name) })) };
  } catch (e) {
    const message = e instanceof UserError ? e.localized(owner?.locale ?? config.defaultLocale) : (e as Error).message;
    run('UPDATE data_checks SET last_run_at = ?, last_error = ? WHERE id = ?', at, message.slice(0, 500), id);
    return { error: message };
  }
}

/** Matches a name written in a table ("Cynthia", "Liz") to a colleague: name, English name or email name. */
function colleagueByName(): Resolve {
  const users = all<{ id: string; name: string; en_name: string | null; email: string | null }>('SELECT id, name, en_name, email FROM users');
  const index = new Map<string, { id: string; name: string }>();
  for (const u of users) {
    for (const k of [u.name, u.en_name, u.email, u.email?.split('@')[0]]) {
      const key = k?.trim().toLowerCase();
      if (key && !index.has(key)) index.set(key, { id: u.id, name: u.name });
    }
  }
  return (name) => index.get(name.trim().toLowerCase()) ?? null;
}

let running: Promise<{ at: number; ms: number }> | null = null;

/** Runs every enabled check, one after another (shared by the schedule and the "check again" button). */
export function runAll(): Promise<{ at: number; ms: number }> {
  running ??= (async () => {
    const at = now();
    try {
      for (const { id } of all<{ id: number }>('SELECT id FROM data_checks WHERE enabled = 1 ORDER BY id')) await runCheck(id);
    } finally {
      const result = { at, ms: now() - at };
      run(`INSERT INTO settings (key, value, updated_at) VALUES ('checks.lastRun', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, JSON.stringify(result), now());
      running = null;
    }
    return { at, ms: now() - at };
  })();
  return running;
}

export function lastRun(): { at: number; ms: number } | null {
  const v = get<{ value: string }>("SELECT value FROM settings WHERE key = 'checks.lastRun'")?.value;
  return v ? (JSON.parse(v) as { at: number; ms: number }) : null;
}

export function startCheckScheduler() {
  const every = Math.max(1, Number(process.env.CHECKS_EVERY_HOURS ?? 6)) * 3600_000;
  const tick = () => {
    const last = lastRun();
    if (!last || now() - last.at >= every) runAll().catch((e) => console.error('[checks]', e));
  };
  setTimeout(tick, 30_000);
  return setInterval(tick, 10 * 60_000);
}

// ---------------------------------------------------------------- who may see which issues
/** Where to fix a record: the link the app gave, else the record inside the Lark Base, else the source itself. */
function recordUrl(src: { kind: string; url: string }, issue: { record_id: string; url: string | null }) {
  if (issue.url) return issue.url;
  if (src.kind !== 'base') return src.url;
  return `${src.url}${src.url.includes('?') ? '&' : '?'}record=${encodeURIComponent(issue.record_id)}`;
}

/** The issues page: what the viewer may see, grouped by check, plus counts by person and level. */
export async function issuesFor(user: User, locale: string) {
  const checks = all<CheckRow>('SELECT * FROM data_checks ORDER BY id');
  const readable = new Map<string, boolean>();
  for (const sid of new Set(checks.map((c) => c.source_id))) readable.set(sid, await canReadSource(user, getSource(sid)));
  const exceptions = new Map(all<{ check_id: number; record_id: string; reason: string | null; by_name: string; at: number }>(
    'SELECT e.*, u.name AS by_name FROM data_exceptions e JOIN users u ON u.id = e.by_user').map((e) => [`${e.check_id}\u0000${e.record_id}`, e]));
  const avatars = new Map(all<{ id: string; avatar: string | null }>('SELECT id, avatar FROM users').map((u) => [u.id, u.avatar]));
  const out = checks.map((c) => {
    const src = getSource(c.source_id);
    const rows = all<IssueRow>('SELECT * FROM data_issues WHERE check_id = ? ORDER BY first_seen, label', c.id)
      .map((i) => {
        const owners = JSON.parse(i.owners) as { id: string; name: string }[];
        const ex = exceptions.get(`${c.id}\u0000${i.record_id}`);
        return {
          record: i.record_id, label: i.label, detail: JSON.parse(i.detail) as Record<string, string>, since: i.first_seen,
          owners: owners.map((o) => ({ ...o, avatar: avatars.get(o.id) ?? null })), url: recordUrl(src, i),
          mine: owners.some((o) => o.id === user.id),
          exception: ex ? { reason: ex.reason, by: ex.by_name, at: ex.at } : null,
        };
      })
      .filter((r) => r.mine || readable.get(c.source_id) || c.owner_id === user.id);
    return {
      id: c.id, title: pick(JSON.parse(c.title_i18n), locale), hint: c.hint_i18n ? pick(JSON.parse(c.hint_i18n), locale) : '',
      team: c.team_i18n ? pick(JSON.parse(c.team_i18n), locale) : '', level: c.level, source: { id: src.id, title: pick(JSON.parse(src.title_i18n), locale) },
      error: c.last_error, lastRun: c.last_run_at, canEdit: canEdit(user, c), rows,
    };
  }).filter((c) => c.rows.length || c.canEdit || c.error);
  const open = out.flatMap((c) => c.rows.filter((r) => !r.exception).map((r) => ({ ...r, level: c.level })));
  const people = new Map<string, { id: string; name: string; avatar: string | null; count: number; errors: number }>();
  for (const r of open) {
    for (const o of r.owners.length ? r.owners : [{ id: '', name: '', avatar: null }]) {
      // names that matched nobody on the hub are still grouped by name
      const p = people.get(o.id) ?? { ...o, count: 0, errors: 0 };
      p.count++;
      if (r.level === 'error') p.errors++;
      people.set(o.id, p);
    }
  }
  return {
    checks: out,
    counts: {
      mine: open.filter((r) => r.mine).length,
      all: open.length,
      exceptions: out.reduce((n, c) => n + c.rows.filter((r) => r.exception).length, 0),
      byLevel: Object.fromEntries(LEVELS.map((l) => [l, open.filter((r) => r.level === l).length])) as Record<Level, number>,
    },
    people: [...people.values()].sort((a, b) => b.count - a.count),
    lastRun: (() => {
      const full = lastRun();
      const single = Math.max(0, ...checks.map((c) => c.last_run_at ?? 0));
      return single > (full?.at ?? 0) ? { at: single, ms: full?.ms ?? 0 } : full;
    })(),
  };
}

/** "Confirmed exception": the record is right as it is. Its owners, the check's creator and admins may decide. */
export function setException(user: User, checkId: number, recordId: string, on: boolean, reason?: string) {
  const c = getCheck(checkId);
  const issue = get<IssueRow>('SELECT * FROM data_issues WHERE check_id = ? AND record_id = ?', checkId, recordId);
  if (!issue) throw new UserError('err.check.issueGone');
  const owners = JSON.parse(issue.owners) as { id: string }[];
  if (!(canEdit(user, c) || owners.some((o) => o.id === user.id))) throw new UserError('err.check.notOwner');
  if (on) {
    run(`INSERT INTO data_exceptions (check_id, record_id, reason, by_user, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(check_id, record_id) DO UPDATE SET reason = excluded.reason, by_user = excluded.by_user, at = excluded.at`,
      checkId, recordId, reason?.slice(0, 300) ?? null, user.id, now());
  } else run('DELETE FROM data_exceptions WHERE check_id = ? AND record_id = ?', checkId, recordId);
  return { exception: on };
}

export function listChecks(locale: string) {
  return all<CheckRow & { owner_name: string; n: number }>(
    `SELECT c.*, u.name AS owner_name, (SELECT COUNT(*) FROM data_issues i WHERE i.check_id = c.id) AS n
     FROM data_checks c JOIN users u ON u.id = c.owner_id ORDER BY c.id`)
    .map((c) => ({
      id: c.id, title: pick(JSON.parse(c.title_i18n), locale), level: c.level, source: c.source_id, spec: JSON.parse(c.spec) as Spec,
      ownerField: c.owner_field, labelFields: JSON.parse(c.label_fields) as string[], enabled: !!c.enabled, issues: c.n,
      lastRun: c.last_run_at, error: c.last_error, createdBy: c.owner_name,
    }));
}
