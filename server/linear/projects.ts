/**
 * The 项目 page: Linear projects as the person sees them in Linear, and one project in detail (milestones, recent
 * updates, issues by state). Read only; results are kept for a minute or two per person so moving around the page
 * stays quick.
 */
import { type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { linearQuery } from './link.ts';

type Health = 'onTrack' | 'atRisk' | 'offTrack';
interface Person { id?: string; name?: string; displayName?: string; avatarUrl?: string | null }
interface Update { id?: string; body?: string; health?: Health | null; createdAt?: string; url?: string; user?: Person | null }
interface ProjectNode {
  id: string; name: string; description?: string | null; url: string; icon?: string | null; color?: string | null;
  progress?: number | null; startDate?: string | null; targetDate?: string | null; updatedAt?: string;
  health?: Health | null; status?: { name: string; type: string } | null;
  lead?: Person | null; teams?: { nodes: { id: string; name: string; key: string }[] }; members?: { nodes: { id: string }[] };
  projectUpdates?: { nodes: Update[] };
}
interface IssueNode {
  id: string; identifier: string; title: string; url: string; priority?: number; priorityLabel?: string; dueDate?: string | null;
  estimate?: number | null; updatedAt?: string; completedAt?: string | null;
  state?: { name: string; type: string } | null; assignee?: Person | null; projectMilestone?: { id: string } | null;
}

const PROJECT_FIELDS = `
  id name description url icon color progress startDate targetDate updatedAt health
  status { name type }
  lead { id name displayName avatarUrl }
  teams { nodes { id name key } }
  members { nodes { id } }`;

const person = (p?: Person | null) => (p ? { name: p.displayName || p.name || '', avatar: p.avatarUrl ?? null } : null);
const update = (u?: Update) => (u ? { body: (u.body ?? '').trim(), health: u.health ?? null, at: u.createdAt ?? null, by: person(u.user), url: u.url ?? null } : null);

/** Who the person is in Linear and the projects their issues are in, to tell which projects are theirs. */
interface Viewer { id: string; issueProjects: Set<string> }

function shapeProject(p: ProjectNode, me?: Viewer) {
  return {
    // theirs: they lead it, are a member, or have issues in it
    mine: !!me && (p.lead?.id === me.id || !!p.members?.nodes.some((m) => m.id === me.id) || me.issueProjects.has(p.id)),
    id: p.id, name: p.name, description: p.description ?? '', url: p.url, color: p.color ?? null,
    progress: typeof p.progress === 'number' ? p.progress : null,
    startDate: p.startDate ?? null, targetDate: p.targetDate ?? null, updatedAt: p.updatedAt ?? null,
    status: p.status ? { name: p.status.name, type: p.status.type } : null,
    // the health the last update gave; Linear leaves it empty when nobody has written one
    health: p.health ?? p.projectUpdates?.nodes[0]?.health ?? null,
    lead: person(p.lead),
    teams: (p.teams?.nodes ?? []).map((t) => t.name),
    lastUpdate: update(p.projectUpdates?.nodes[0]),
  };
}

// started first, then planned, then the rest; inside each, the nearest target date first
const STATUS_ORDER = ['started', 'paused', 'planned', 'backlog', 'completed', 'canceled'];
const rank = (t?: string) => (STATUS_ORDER.indexOf(t ?? '') + 1 || STATUS_ORDER.length + 1);

const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  for (const [k, v] of cache) if (Date.now() - v.at > 10 * 60_000) cache.delete(k);
  return value;
}
export const forgetProjects = (user: User) => { for (const k of cache.keys()) if (k.startsWith(`${user.id}|`)) cache.delete(k); };

/** Every project the person can see in Linear (archived ones left out). */
export function listProjects(user: User) {
  return cached(`${user.id}|list`, 2 * 60_000, async () => {
    const v = await linearQuery<{ viewer: { id: string; assignedIssues: { nodes: { project: { id: string } | null }[] } } }>(user,
      '{ viewer { id assignedIssues(first: 250) { nodes { project { id } } } } }');
    const me: Viewer = { id: v.viewer.id, issueProjects: new Set(v.viewer.assignedIssues.nodes.flatMap((i) => (i.project ? [i.project.id] : []))) };
    const out: ProjectNode[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r: { projects: { nodes: ProjectNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await linearQuery(user, `
        query Projects($after: String) {
          projects(first: 50, after: $after) {
            nodes { ${PROJECT_FIELDS} projectUpdates(first: 1) { nodes { body health createdAt user { name displayName avatarUrl } } } }
            pageInfo { hasNextPage endCursor }
          }
        }`, { after });
      out.push(...r.projects.nodes);
      if (!r.projects.pageInfo.hasNextPage || !r.projects.pageInfo.endCursor) break;
      after = r.projects.pageInfo.endCursor;
    }
    return out.map((p) => shapeProject(p, me)).sort((a, b) => rank(a.status?.type) - rank(b.status?.type)
      || (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999') || a.name.localeCompare(b.name));
  });
}

/** One project: what the list shows, plus its milestones, recent updates and issues. */
export function getProject(user: User, id: string) {
  if (!/^[\w-]{1,64}$/.test(id)) throw new UserError('err.linear.noProject');
  return cached(`${user.id}|p|${id}`, 60_000, async () => {
    const r = await linearQuery<{ project: (ProjectNode & {
      projectMilestones?: { nodes: { id: string; name: string; targetDate?: string | null }[] };
      issues?: { nodes: IssueNode[]; pageInfo?: { hasNextPage: boolean } };
    }) | null }>(user, `
      query Project($id: String!) {
        project(id: $id) {
          ${PROJECT_FIELDS}
          projectUpdates(first: 5) { nodes { id body health createdAt url user { name displayName avatarUrl } } }
          projectMilestones { nodes { id name targetDate } }
          issues(first: 250) {
            nodes {
              id identifier title url priority priorityLabel dueDate estimate updatedAt completedAt
              state { name type } assignee { name displayName avatarUrl } projectMilestone { id }
            }
            pageInfo { hasNextPage }
          }
        }
      }`, { id }).catch((e: Error) => {
      if (/not found|Entity not found/i.test(e.message)) throw new UserError('err.linear.noProject');
      throw e;
    });
    if (!r.project) throw new UserError('err.linear.noProject');
    const p = r.project;
    const issues = (p.issues?.nodes ?? []).map((i) => ({
      id: i.id, identifier: i.identifier, title: i.title, url: i.url,
      priority: i.priority ?? 0, priorityLabel: i.priorityLabel ?? '', dueDate: i.dueDate ?? null, estimate: i.estimate ?? null,
      updatedAt: i.updatedAt ?? null, completedAt: i.completedAt ?? null,
      state: i.state ? { name: i.state.name, type: i.state.type } : null, assignee: person(i.assignee), milestone: i.projectMilestone?.id ?? null,
    }));
    const done = (i: (typeof issues)[number]) => i.state?.type === 'completed';
    const counted = (i: (typeof issues)[number]) => i.state?.type !== 'canceled';
    return {
      ...shapeProject(p),
      updates: (p.projectUpdates?.nodes ?? []).map((u) => update(u)!),
      milestones: (p.projectMilestones?.nodes ?? []).map((m) => {
        const mine = issues.filter((i) => i.milestone === m.id && counted(i));
        return { id: m.id, name: m.name, targetDate: m.targetDate ?? null, issues: mine.length, done: mine.filter(done).length };
      }).sort((a, b) => (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999')),
      issues,
      issueCounts: { total: issues.filter(counted).length, done: issues.filter(done).length },
      moreIssues: !!p.issues?.pageInfo?.hasNextPage,
    };
  });
}
