/**
 * Data boards (the 数据 page): shared dashboards made of the same modules as home pages. A board is company-wide
 * (admins edit it) or belongs to one department (its leaders edit it; its members and admins see it). Numbers on
 * them are still read with each viewer's own Lark access, so a board never shows anyone rows they cannot open.
 */
import { all, get, now, run, type User } from './db.ts';
import { UserError } from './i18n/index.ts';
import { pick } from './library.ts';
import { canEditDepartment, parseLayout, userDepartments, type Dept, type Layout } from './homepage.ts';

interface Row { id: string; title_i18n: string; department_id: string | null; layout: string; sort: number; updated_at: number }

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

function canEdit(user: User, departmentId: string | null): boolean {
  if (!departmentId) return user.role === 'admin';
  const d = get<Dept>('SELECT * FROM departments WHERE id = ?', departmentId);
  return !!d && canEditDepartment(user, d);
}

/** Boards this person may see: company ones, their departments' ones, and all of them for admins. */
export function boardsFor(user: User, locale: string) {
  const mine = new Set(userDepartments(user, locale).map((d) => d.id));
  return all<Row & { dept_name: string | null; dept_i18n: string | null }>(
    'SELECT b.*, d.name AS dept_name, d.name_i18n AS dept_i18n FROM boards b LEFT JOIN departments d ON d.id = b.department_id ORDER BY b.department_id IS NOT NULL, b.sort, b.id')
    .filter((b) => !b.department_id || mine.has(b.department_id) || user.role === 'admin')
    .map((b) => ({
      id: b.id,
      title: pick(JSON.parse(b.title_i18n), locale),
      department: b.department_id ? { id: b.department_id, name: pick(b.dept_i18n ? JSON.parse(b.dept_i18n) : {}, locale) || b.dept_name || '' } : null,
      layout: JSON.parse(b.layout) as Layout,
      canEdit: canEdit(user, b.department_id),
      updatedAt: b.updated_at,
    }));
}

export function saveBoard(user: User, input: { id: string; title: Record<string, string>; departmentId?: string; layout: unknown; sort?: number }) {
  if (!SLUG.test(input.id)) throw new UserError('err.board.badId', { id: input.id });
  const existing = get<Row>('SELECT * FROM boards WHERE id = ?', input.id);
  const dept = input.departmentId ?? existing?.department_id ?? null;
  if (!canEdit(user, dept) || (existing && !canEdit(user, existing.department_id))) throw new UserError(dept ? 'err.board.notLeader' : 'err.adminOnly');
  const layout = parseLayout(input.layout);
  run(`INSERT INTO boards (id, title_i18n, department_id, layout, sort, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title_i18n = excluded.title_i18n, department_id = excluded.department_id, layout = excluded.layout,
         sort = excluded.sort, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    input.id, JSON.stringify(input.title), dept, JSON.stringify(layout), input.sort ?? existing?.sort ?? 0, user.id, now());
  return { saved: true, id: input.id };
}

export function deleteBoard(user: User, id: string) {
  const b = get<Row>('SELECT * FROM boards WHERE id = ?', id);
  if (!b) throw new UserError('err.board.notFound', { id });
  if (!canEdit(user, b.department_id)) throw new UserError(b.department_id ? 'err.board.notLeader' : 'err.adminOnly');
  run('DELETE FROM boards WHERE id = ?', id);
  return { deleted: true };
}
