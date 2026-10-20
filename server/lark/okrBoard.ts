/**
 * The company OKR page: everyone's objectives for one period, how they align, and the team's pace. Read with the
 * viewer's own Lark access (people whose OKRs Lark does not show them are listed as hidden), cached for 10 minutes.
 * The company's objectives are those of the "company OKR owner": an admin can name them; otherwise it is whoever
 * the most objectives align to (usually the CEO).
 */
import { all, get, now, run, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { current, okrList, pct, periodOf, progressRecord, type LarkObjective } from './okr.ts';

interface Person { id: string; name: string; avatar: string | null }
interface Node {
  id: string; owner: Person; content: string; progress: number; krs: number;
  alignsTo: string[];   // objective ids this one supports
}

const cache = new Map<string, { at: number; value: Promise<Board> }>();
type Board = Awaited<ReturnType<typeof build>>;

export function companyOwner(): string | null {
  return get<{ value: string }>("SELECT value FROM settings WHERE key = 'okr.companyOwner'")?.value ?? null;
}

export function setCompanyOwner(user: User, ownerId: string | null) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  if (ownerId) {
    run(`INSERT INTO settings (key, value, updated_at) VALUES ('okr.companyOwner', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, ownerId, now());
  } else run("DELETE FROM settings WHERE key = 'okr.companyOwner'");
  cache.clear();
}

export function okrBoard(viewer: User, locale: string, periodId?: string, fresh = false): Promise<Board> {
  const key = `${viewer.id}\u0000${locale}\u0000${periodId ?? ''}`;
  const hit = cache.get(key);
  if (hit && !fresh && now() - hit.at < 600_000) return hit.value;
  const value = build(viewer, locale, periodId);
  cache.set(key, { at: now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

async function build(viewer: User, locale: string, periodId?: string) {
  const people = all<Person>('SELECT id, name, avatar FROM users ORDER BY name');
  // everyone's OKR lists (all periods), five at a time to stay well under Lark's rate limit
  const lists = new Map<string, Awaited<ReturnType<typeof okrList>> | 'hidden'>();
  const queue = [...people];
  await Promise.all(Array.from({ length: 5 }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        lists.set(p.id, await okrList(viewer, p.id, locale));
      } catch (e) {
        if (e instanceof UserError && e.key === 'err.lark.notConnected') throw e;
        lists.set(p.id, 'hidden');
      }
    }
  }));
  // periods seen across everyone; pick the requested one or the current one
  const periods = new Map<string, ReturnType<typeof periodOf>>();
  for (const l of lists.values()) if (l !== 'hidden') for (const o of l) periods.set(periodOf(o).id, periodOf(o));
  const allPeriods = [...periods.values()].sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0));
  const period = (periodId && periods.get(periodId)) || current(allPeriods) || null;

  const byId = new Map(people.map((p) => [p.id, { id: p.id, name: p.name, avatar: p.avatar }]));
  const nodes: Node[] = [];
  // progress updates written this period, on objectives and key results
  const progressRefs: { id: string; owner: Person; on: string }[] = [];
  const hidden: Person[] = [];
  const without: Person[] = [];
  for (const p of people) {
    const l = lists.get(p.id);
    if (l === 'hidden') { hidden.push(byId.get(p.id)!); continue; }
    const mine = period ? (l ?? []).filter((o) => periodOf(o).id === period.id) : [];
    const objectives: LarkObjective[] = mine.flatMap((o) => o.objective_list ?? []);
    if (!objectives.length) { without.push(byId.get(p.id)!); continue; }
    for (const o of objectives) {
      const krs = o.kr_list ?? [];
      const fromKrs = krs.length ? krs.reduce((a, k) => a + (pct(k.progress_rate) ?? 0), 0) / krs.length : 0;
      nodes.push({ id: o.id, owner: byId.get(p.id)!, content: (o.content ?? '').trim(), progress: pct(o.progress_rate) ?? fromKrs, krs: krs.length, alignsTo: (o.aligned_objective_list ?? []).map((a) => a.id) });
      for (const r of o.progress_record_list ?? []) progressRefs.push({ id: r.id, owner: byId.get(p.id)!, on: (o.content ?? '').trim() });
      for (const k of krs) for (const r of k.progress_record_list ?? []) progressRefs.push({ id: r.id, owner: byId.get(p.id)!, on: (k.content ?? '').trim() });
    }
  }
  // links can be recorded on either side
  const ids = new Set(nodes.map((n) => n.id));
  for (const p of people) {
    const l = lists.get(p.id);
    if (!l || l === 'hidden') continue;
    for (const o of l.flatMap((x) => x.objective_list ?? [])) {
      for (const child of o.aligning_objective_list ?? []) {
        const n = nodes.find((x) => x.id === child.id);
        if (n && ids.has(o.id) && !n.alignsTo.includes(o.id)) n.alignsTo.push(o.id);
      }
    }
  }
  for (const n of nodes) n.alignsTo = n.alignsTo.filter((x) => ids.has(x));

  // the company: the named owner, else whoever the most objectives align to
  const supporters = new Map<string, number>();
  for (const n of nodes) for (const target of n.alignsTo) {
    const owner = nodes.find((x) => x.id === target)?.owner.id;
    if (owner) supporters.set(owner, (supporters.get(owner) ?? 0) + 1);
  }
  const companyId = companyOwner() ?? [...supporters.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const company = nodes.filter((n) => n.owner.id === companyId);
  const elapsed = period?.range ? Math.max(0, Math.min(1, (now() - period.range.start) / (period.range.end - period.range.start))) : null;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const pace = [...new Set(nodes.map((n) => n.owner.id))].map((id) => {
    const mine = nodes.filter((n) => n.owner.id === id);
    return { person: byId.get(id)!, objectives: mine.length, done: Math.round(avg(mine.map((n) => n.progress)) * 1000) / 1000 };
  }).sort((a, b) => a.done - b.done);
  const recent = await recentProgress(viewer, progressRefs, (id) => byId.get(id)?.name);
  return {
    period: period ? { id: period.id, name: period.name, start: period.range?.start ?? null, end: period.range?.end ?? null } : null,
    periods: allPeriods.map((p) => ({ id: p.id, name: p.name })),
    elapsed,
    done: Math.round(avg(nodes.map((n) => n.progress)) * 1000) / 1000,
    company: companyId ? { owner: byId.get(companyId) ?? null, objectives: company.map((n) => n.id), named: !!companyOwner() } : null,
    nodes,
    unaligned: nodes.filter((n) => n.owner.id !== companyId && !n.alignsTo.length).map((n) => n.id),
    pace,
    people: { total: people.length, withOkrs: pace.length, without, hidden },
    progress: { total: progressRefs.length, people: new Set(progressRefs.map((r) => r.owner.id)).size, recent },
    checkedAt: now(),
  };
}

/** The newest progress updates (at most 20), reading at most 200 of them, five at a time. */
async function recentProgress(viewer: User, refs: { id: string; owner: Person; on: string }[], nameOf: (id: string) => string | undefined) {
  const queue = refs.slice(0, 200);
  const out: { id: string; at: number; text: string; owner: Person; on: string }[] = [];
  await Promise.all(Array.from({ length: 5 }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      try {
        const rec = await progressRecord(viewer, r.id, nameOf);
        if (rec.text) out.push({ ...rec, owner: r.owner, on: r.on.length > 80 ? r.on.slice(0, 80) + '…' : r.on });
      } catch {
        // one unreadable update does not hide the others
      }
    }
  }));
  return out.sort((a, b) => b.at - a.at).slice(0, 20).map((r) => ({ ...r, text: r.text.length > 400 ? r.text.slice(0, 400) + '…' : r.text }));
}
