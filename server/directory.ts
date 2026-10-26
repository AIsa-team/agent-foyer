/**
 * The company directory (people and departments, kept in step with where the company keeps them), the organisation
 * page and the hub-wide search. The page and the search only use what the hub already shows to every signed-in
 * colleague (the synced directory, apps they can open, Skills, the resources page, boards they can see).
 */
import { all, get, now, run, type User } from './db.ts';
import { upsertUser, type Identity } from './auth/users.ts';
import { channels } from './channels.ts';
import { pick } from './library.ts';
import * as apps from './apps/service.ts';
import * as skills from './skills/service.ts';
import * as lib from './library.ts';
import { boardsFor } from './boards.ts';
import { listRequests } from './requests.ts';
import { canEditDepartment } from './homepage.ts';
import { UserError } from './i18n/index.ts';

interface DeptRow { id: string; name: string; name_i18n: string | null; parent_id: string | null; leader_ids: string | null }

// ---------------------------------------------------------------- the directory, from a channel
/** People and departments as the company's platform has them; `members` lists each department's people in full. */
export interface DirectorySnapshot {
  departments: { id: string; name: string; i18n?: Record<string, string>; parentId?: string | null; leaderIds: string[] }[];
  people: Identity[];
  members: { departmentId: string; userIds: string[] }[];
}
/** Where the directory comes from (a channel, e.g. Lark's contacts). */
export interface DirectoryProvider { name: string; read(): Promise<DirectorySnapshot> }

export const directoryProvider = (): DirectoryProvider | null => channels.find((c) => c.directory)?.directory ?? null;

/**
 * Brings people and departments in step with the provider, so colleagues can be picked (as app members, recipients…)
 * before they ever sign in. Membership is replaced per department the provider listed, so moves are picked up.
 * Returns how many people it saw (0 without a provider).
 */
export async function syncDirectory(): Promise<number> {
  const provider = directoryProvider();
  if (!provider) return 0;
  const d = await provider.read();
  // one write at a time (upsertUser runs its own transaction)
  for (const dep of d.departments) {
    run(`INSERT INTO departments (id, name, name_i18n, parent_id, leader_ids, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_i18n = excluded.name_i18n, parent_id = excluded.parent_id,
           leader_ids = excluded.leader_ids, updated_at = excluded.updated_at`,
      dep.id, dep.name, dep.i18n && Object.keys(dep.i18n).length ? JSON.stringify(dep.i18n) : null, dep.parentId ?? null, JSON.stringify(dep.leaderIds), now());
  }
  for (const p of d.people) upsertUser(p, false);
  for (const m of d.members) {
    run('DELETE FROM user_departments WHERE department_id = ?', m.departmentId);
    for (const id of m.userIds) run('INSERT OR IGNORE INTO user_departments (user_id, department_id) VALUES (?, ?)', id, m.departmentId);
  }
  return d.people.length;
}

// ---------------------------------------------------------------- the organisation page
/**
 * One department's page: who is in it (leaders first), where it sits, the home page its members get, its boards, and
 * what its members made that the viewer may open. Leaders and admins also learn they can change the home page and boards.
 */
export function departmentPage(viewer: User, id: string, locale: string) {
  const d = get<DeptRow>('SELECT * FROM departments WHERE id = ?', id);
  if (!d) throw new UserError('err.home.departmentNotFound', { id });
  const nameOf = (x: DeptRow) => pick(x.name_i18n ? JSON.parse(x.name_i18n) : {}, locale) || x.name;
  const person = (uid: string) => {
    const u = get<{ id: string; name: string; en_name: string | null; email: string | null; avatar: string | null; last_seen_at: number | null }>('SELECT id, name, en_name, email, avatar, last_seen_at FROM users WHERE id = ?', uid);
    return u ? { id: u.id, name: u.name, enName: u.en_name, email: u.email, avatar: u.avatar, joined: u.last_seen_at !== null } : null;
  };
  const leaders = (d.leader_ids ? (JSON.parse(d.leader_ids) as string[]) : []);
  const memberIds = all<{ user_id: string }>('SELECT user_id FROM user_departments WHERE department_id = ?', id).map((r) => r.user_id);
  const ordered = [...leaders.filter((x) => memberIds.includes(x) || get('SELECT 1 FROM users WHERE id = ?', x)), ...memberIds.filter((x) => !leaders.includes(x))];
  const parent = d.parent_id ? get<DeptRow>('SELECT * FROM departments WHERE id = ?', d.parent_id) : undefined;
  const children = all<DeptRow>('SELECT * FROM departments WHERE parent_id = ? ORDER BY name', id);
  const home = get<{ layout: string; updated_at: number }>("SELECT layout, updated_at FROM homepages WHERE scope = 'department' AND owner_id = ?", id);
  const homeModules = home ? (JSON.parse(home.layout) as { modules: { type: string; title?: Record<string, string> }[] }).modules : [];
  const team = new Set(memberIds);
  return {
    department: {
      id: d.id, name: nameOf(d),
      parent: parent ? { id: parent.id, name: nameOf(parent) } : null,
      children: children.map((c) => ({ id: c.id, name: nameOf(c), members: get<{ n: number }>('SELECT COUNT(*) AS n FROM user_departments WHERE department_id = ?', c.id)!.n })),
      leaders,
    },
    people: ordered.map(person).filter((p): p is NonNullable<ReturnType<typeof person>> => !!p),
    canEdit: canEditDepartment(viewer, { id: d.id, name: d.name, name_i18n: d.name_i18n, leader_ids: d.leader_ids }),
    home: home ? { updatedAt: home.updated_at, modules: homeModules.map((m) => ({ type: m.type, title: m.title ? pick(m.title, locale) || null : null })) } : null,
    boards: boardsFor(viewer, locale).filter((b) => b.department?.id === id).map((b) => ({ id: b.id, title: b.title, modules: b.layout.modules.length, updatedAt: b.updatedAt })),
    apps: apps.listAppsFor(viewer, locale).filter((a) => a.owner && team.has(a.owner.id)).slice(0, 12),
    skills: skills.listSkills(viewer, locale).filter((s) => s.listed && team.has(s.owner.id)).slice(0, 12),
  };
}


export function organisation(locale: string) {
  const depts = all<DeptRow>('SELECT * FROM departments ORDER BY name');
  const members = all<{ user_id: string; department_id: string }>('SELECT * FROM user_departments');
  const people = all<{ id: string; name: string; en_name: string | null; email: string | null; avatar: string | null; role: string; last_seen_at: number | null }>(
    'SELECT id, name, en_name, email, avatar, role, last_seen_at FROM users ORDER BY name');
  const ids = new Set(depts.map((d) => d.id));
  return {
    departments: depts.map((d) => ({
      id: d.id,
      name: pick(d.name_i18n ? JSON.parse(d.name_i18n) : {}, locale) || d.name,
      // a parent outside the synced range counts as top level
      parent: d.parent_id && ids.has(d.parent_id) ? d.parent_id : null,
      leaders: (d.leader_ids ? (JSON.parse(d.leader_ids) as string[]) : []),
      members: members.filter((m) => m.department_id === d.id).map((m) => m.user_id),
    })),
    people: people.map((p) => ({ id: p.id, name: p.name, enName: p.en_name, email: p.email, avatar: p.avatar, joined: p.last_seen_at !== null })),
  };
}

const has = (q: string, ...texts: (string | null | undefined)[]) => texts.some((t) => (t ?? '').toLowerCase().includes(q));

/** Every language's text in a stored i18n JSON, so a search in Chinese finds things while the UI is in English. */
function allTexts(json: string | null): string[] {
  if (!json) return [];
  try {
    return Object.values(JSON.parse(json) as Record<string, unknown>).flatMap((v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).map(String) : []));
  } catch {
    return [];
  }
}

export function search(user: User, raw: string, locale: string) {
  const q = raw.trim().toLowerCase();
  if (!q) return { apps: [], skills: [], resources: [], people: [], boards: [], requests: [] };
  const lim = <T>(xs: T[]) => xs.slice(0, 6);
  const library = lib.library(locale);
  return {
    apps: lim(apps.listAppsFor(user, locale).filter((a) => a.canOpen && has(q, a.name, a.description, a.slug, ...allTexts(get<{ i18n: string | null }>('SELECT i18n FROM apps WHERE slug = ?', a.slug)?.i18n ?? null)))
      .map((a) => ({ slug: a.slug, name: a.name, description: a.description, icon: a.icon, url: a.url }))),
    skills: lim(skills.listSkills(user, locale).filter((s) => s.listed && has(q, s.name, s.description, s.slug, ...allTexts(get<{ i18n: string | null }>('SELECT i18n FROM skills WHERE slug = ?', s.slug)?.i18n ?? null)))
      .map((s) => ({ slug: s.slug, name: s.name, description: s.description, icon: s.icon }))),
    resources: lim(library.sections.flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.name }))))
      .filter((r) => has(q, r.title, r.description, r.group)).map((r) => ({ id: r.id, title: r.title, group: r.group, url: r.url }))),
    people: lim(all<{ id: string; name: string; en_name: string | null; email: string | null; avatar: string | null }>('SELECT id, name, en_name, email, avatar FROM users')
      .filter((p) => has(q, p.name, p.en_name, p.email)).map((p) => ({ id: p.id, name: p.name, email: p.email, avatar: p.avatar }))),
    // ones still in play first, then live and closed ones
    requests: lim(listRequests(user, locale, { status: 'all', query: q }).sort((a, b) => Number(['done', 'closed'].includes(a.status)) - Number(['done', 'closed'].includes(b.status)))
      .map((r) => ({ id: r.id, title: r.title, status: r.status, scope: r.scope, invited: !!r.invitee, requester: r.requester?.name ?? '' }))),
    boards: lim(boardsFor(user, locale).filter((b) => has(q, b.title, b.department?.name, ...allTexts(get<{ title_i18n: string }>('SELECT title_i18n FROM boards WHERE id = ?', b.id)?.title_i18n ?? null))).map((b) => ({ id: b.id, title: b.title, department: b.department?.name ?? null }))),
  };
}
