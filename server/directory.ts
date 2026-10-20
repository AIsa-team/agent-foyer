/**
 * The organisation page and the hub-wide search. Both only use what the hub already shows to every signed-in
 * colleague (the synced Lark directory, apps they can open, Skills, the resources page, boards they can see).
 */
import { all, get, type User } from './db.ts';
import { pick } from './library.ts';
import * as apps from './apps/service.ts';
import * as skills from './skills/service.ts';
import * as lib from './library.ts';
import { boardsFor } from './boards.ts';

interface DeptRow { id: string; name: string; name_i18n: string | null; parent_id: string | null; leader_ids: string | null }

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
  if (!q) return { apps: [], skills: [], resources: [], people: [], boards: [] };
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
    boards: lim(boardsFor(user, locale).filter((b) => has(q, b.title, b.department?.name, ...allTexts(get<{ title_i18n: string }>('SELECT title_i18n FROM boards WHERE id = ?', b.id)?.title_i18n ?? null))).map((b) => ({ id: b.id, title: b.title, department: b.department?.name ?? null }))),
  };
}
