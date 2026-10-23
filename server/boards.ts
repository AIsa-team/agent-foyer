/**
 * Data boards (the 数据 page): dashboards made of the same modules as home pages. A board is company-wide (admins
 * edit it), belongs to one department (its leaders edit it; its members and admins see it), or is someone's own
 * (only they edit it; private unless they share it with colleagues, departments or the company). Numbers on any of
 * them are read with each viewer's own access, so sharing a board never shows anyone rows they could not read.
 */
import { all, get, now, run, type User } from './db.ts';
import { UserError } from './i18n/index.ts';
import { pick } from './library.ts';
import { canEditDepartment, parseLayout, userDepartments, type Dept, type Layout } from './homepage.ts';

interface Row { id: string; title_i18n: string; department_id: string | null; owner_id: string | null; audience: string | null; layout: string; sort: number; updated_at: number }
export type Share = { company?: boolean; people?: string[]; departments?: string[] };
export type Scope = 'me' | 'department' | 'company';

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

function canEdit(user: User, b: Pick<Row, 'department_id' | 'owner_id'>): boolean {
  if (b.owner_id) return b.owner_id === user.id;
  if (!b.department_id) return user.role === 'admin';
  const d = get<Dept>('SELECT * FROM departments WHERE id = ?', b.department_id);
  return !!d && canEditDepartment(user, d);
}

const shareOf = (b: Pick<Row, 'audience'>): Share => (b.audience ? JSON.parse(b.audience) as Share : {});

/** Whether someone's own board is shared with this person. */
function sharedWith(user: User, b: Row, mine: Set<string>): boolean {
  const a = shareOf(b);
  return !!a.company || !!a.people?.includes(user.id) || !!a.departments?.some((d) => mine.has(d));
}

/** Only ids of people and departments the hub knows are kept; the owner need not be listed. */
function cleanShare(a: Share, owner: string): Share {
  const people = [...new Set(a.people ?? [])].filter((id) => id !== owner && get('SELECT 1 FROM users WHERE id = ?', id));
  const departments = [...new Set(a.departments ?? [])].filter((id) => get('SELECT 1 FROM departments WHERE id = ?', id));
  return { ...(a.company ? { company: true } : {}), ...(people.length ? { people } : {}), ...(departments.length ? { departments } : {}) };
}

/**
 * Boards this person may see: company ones, their departments' ones (all of them for admins), their own, and
 * others' own boards shared with them. Nobody, admins included, sees someone's own board that is not shared with them.
 */
export function boardsFor(user: User, locale: string) {
  const mine = new Set(userDepartments(user, locale).map((d) => d.id));
  const nameOf = (id: string) => get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? id;
  return all<Row & { dept_name: string | null; dept_i18n: string | null }>(
    'SELECT b.*, d.name AS dept_name, d.name_i18n AS dept_i18n FROM boards b LEFT JOIN departments d ON d.id = b.department_id ORDER BY b.owner_id IS NOT NULL, b.department_id IS NOT NULL, b.sort, b.id')
    .filter((b) => b.owner_id ? b.owner_id === user.id || sharedWith(user, b, mine) : !b.department_id || mine.has(b.department_id) || user.role === 'admin')
    .map((b) => {
      const share = shareOf(b);
      return {
        id: b.id,
        title: pick(JSON.parse(b.title_i18n), locale),
        scope: (b.owner_id ? 'me' : b.department_id ? 'department' : 'company') as Scope,
        department: b.department_id ? { id: b.department_id, name: pick(b.dept_i18n ? JSON.parse(b.dept_i18n) : {}, locale) || b.dept_name || '' } : null,
        ...(b.owner_id ? {
          owner: { id: b.owner_id, name: nameOf(b.owner_id) },
          mine: b.owner_id === user.id,
          // whom it is shared with is the owner's business
          ...(b.owner_id === user.id ? { share: {
            company: !!share.company,
            people: (share.people ?? []).map((id) => ({ id, name: nameOf(id) })),
            departments: (share.departments ?? []).map((id) => ({ id, name: get<{ name: string }>('SELECT name FROM departments WHERE id = ?', id)?.name ?? id })),
          } } : {}),
        } : {}),
        layout: JSON.parse(b.layout) as Layout,
        canEdit: canEdit(user, b),
        updatedAt: b.updated_at,
      };
    });
}

export function saveBoard(user: User, input: { id: string; title: Record<string, string>; scope?: Scope; departmentId?: string; layout: unknown; sort?: number; share?: Share }) {
  if (!SLUG.test(input.id)) throw new UserError('err.board.badId', { id: input.id });
  const existing = get<Row>('SELECT * FROM boards WHERE id = ?', input.id);
  // an existing board keeps where it belongs; a new one goes where asked (a department when one is given)
  const scope: Scope = existing ? (existing.owner_id ? 'me' : existing.department_id ? 'department' : 'company') : input.scope ?? (input.departmentId ? 'department' : 'company');
  const target = {
    owner_id: scope === 'me' ? existing?.owner_id ?? user.id : null,
    department_id: scope === 'department' ? input.departmentId ?? existing?.department_id ?? null : null,
  };
  if (scope === 'department' && !target.department_id) throw new UserError('err.board.departmentRequired');
  if (existing && existing.owner_id && existing.owner_id !== user.id) throw new UserError('err.board.idTaken', { id: input.id });
  if (!canEdit(user, target) || (existing && !canEdit(user, existing))) throw new UserError(scope === 'department' ? 'err.board.notLeader' : 'err.board.adminOnly');
  if (input.share && scope !== 'me') throw new UserError('err.board.shareOwnOnly');
  const layout = parseLayout(input.layout);
  const share = scope === 'me' ? JSON.stringify(input.share ? cleanShare(input.share, target.owner_id!) : shareOf(existing ?? { audience: null })) : null;
  run(`INSERT INTO boards (id, title_i18n, department_id, owner_id, audience, layout, sort, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title_i18n = excluded.title_i18n, department_id = excluded.department_id, owner_id = excluded.owner_id,
         audience = excluded.audience, layout = excluded.layout, sort = excluded.sort, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    input.id, JSON.stringify(input.title), target.department_id, target.owner_id, share, JSON.stringify(layout), input.sort ?? existing?.sort ?? 0, user.id, now());
  return { saved: true, id: input.id, scope, ...(scope === 'me' ? { sharedWith: JSON.parse(share!) as Share } : {}) };
}

/** Whom someone's own board is shared with (its owner only); an empty share makes it private again. */
export function shareBoard(user: User, id: string, share: Share) {
  const b = get<Row>('SELECT * FROM boards WHERE id = ?', id);
  if (!b) throw new UserError('err.board.notFound', { id });
  if (!b.owner_id) throw new UserError('err.board.shareOwnOnly');
  if (b.owner_id !== user.id) throw new UserError('err.board.notFound', { id });
  const clean = cleanShare(share, b.owner_id);
  run('UPDATE boards SET audience = ?, updated_at = ? WHERE id = ?', JSON.stringify(clean), now(), id);
  return { id, sharedWith: clean };
}

export function deleteBoard(user: User, id: string) {
  const b = get<Row>('SELECT * FROM boards WHERE id = ?', id);
  if (!b || (b.owner_id && b.owner_id !== user.id)) throw new UserError('err.board.notFound', { id });
  if (!canEdit(user, b)) throw new UserError(b.department_id ? 'err.board.notLeader' : 'err.board.adminOnly');
  run('DELETE FROM boards WHERE id = ?', id);
  return { deleted: true };
}
