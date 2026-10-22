/**
 * The 项目 page: Linear projects as the person sees them in Linear, and one project in detail (milestones, recent
 * updates, issues by state). People who agreed to write access also change issues (state, assignee, priority, due
 * date), comment, add issues and post project updates from it, as themselves; Linear decides what they may do.
 * Reads are kept for a minute or two per person so moving around the page stays quick; a change forgets them.
 */
import { type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { canWriteLinear, linearConnectUrl, linearQuery } from './link.ts';

type Health = 'onTrack' | 'atRisk' | 'offTrack';
interface Person { id?: string; name?: string; displayName?: string; avatarUrl?: string | null }
interface Update { id?: string; body?: string; health?: Health | null; createdAt?: string; url?: string; user?: Person | null }
interface ProjectNode {
  id: string; name: string; description?: string | null; url: string; icon?: string | null; color?: string | null;
  progress?: number | null; startDate?: string | null; targetDate?: string | null; updatedAt?: string;
  health?: Health | null; status?: { name: string; type: string } | null;
  lead?: Person | null; teams?: { nodes: { id: string; name: string; key: string }[] }; members?: { nodes: Person[] };
  projectMilestones?: { nodes: { id: string; name: string; targetDate?: string | null }[] };
  projectUpdates?: { nodes: Update[] };
}
interface IssueNode {
  id: string; identifier: string; title: string; url: string; priority?: number; priorityLabel?: string; dueDate?: string | null;
  estimate?: number | null; updatedAt?: string; completedAt?: string | null;
  state?: { id?: string; name: string; type: string } | null; assignee?: Person | null; projectMilestone?: { id: string } | null; team?: { id: string } | null;
}
interface TeamNode { id: string; name: string; key: string; states?: { nodes: { id: string; name: string; type: string; position: number }[] }; members?: { nodes: Person[] } }

const PROJECT_FIELDS = `
  id name description url icon color progress startDate targetDate updatedAt health
  status { name type }
  lead { id name displayName avatarUrl }
  teams { nodes { id name key } }
  members { nodes { id name displayName avatarUrl } }
  projectMilestones { nodes { id name targetDate } }`;

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
    members: (p.members?.nodes ?? []).map((m) => person(m)!),
    // dated milestones, for what is coming up
    milestoneDates: (p.projectMilestones?.nodes ?? []).filter((m) => m.targetDate).map((m) => ({ name: m.name, date: m.targetDate! })),
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
      editTeams?: { nodes: TeamNode[] };
      issues?: { nodes: IssueNode[]; pageInfo?: { hasNextPage: boolean } };
    }) | null }>(user, `
      query Project($id: String!) {
        project(id: $id) {
          ${PROJECT_FIELDS}
          projectUpdates(first: 5) { nodes { id body health createdAt url user { name displayName avatarUrl } } }
          projectMilestones { nodes { id name targetDate } }
          editTeams: teams { nodes { ${TEAM_OPTIONS} } }
          issues(first: 250) {
            nodes {
              id identifier title url priority priorityLabel dueDate estimate updatedAt completedAt
              state { id name type } assignee { id name displayName avatarUrl } projectMilestone { id } team { id }
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
      state: i.state ? { id: i.state.id ?? null, name: i.state.name, type: i.state.type } : null, assignee: person(i.assignee),
      assigneeId: i.assignee?.id ?? null, milestone: i.projectMilestone?.id ?? null, team: i.team?.id ?? null,
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
      // what the edit controls offer: each team's workflow states (in Linear's order) and members
      teamOptions: (p.editTeams?.nodes ?? []).map(teamOption),
      canWrite: canWriteLinear(user),
    };
  });
}
const STATE_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];
const TEAM_OPTIONS = 'id name key states { nodes { id name type position } } members { nodes { id name displayName avatarUrl } }';
/** A team's workflow states in Linear's order and its members, for the edit controls. */
function teamOption(t: TeamNode) {
  return {
    id: t.id, name: t.name, key: t.key,
    states: [...(t.states?.nodes ?? [])].sort((a, b) => STATE_ORDER.indexOf(a.type) - STATE_ORDER.indexOf(b.type) || a.position - b.position)
      .map((x) => ({ id: x.id, name: x.name, type: x.type })),
    members: (t.members?.nodes ?? []).map((m) => ({ id: m.id ?? '', ...person(m)! })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The person's own open issues across projects, nearest due first, with what is needed to tick one off. */
export function myIssues(user: User) {
  return cached(`${user.id}|mine`, 60_000, async () => {
    const r = await linearQuery<{ viewer: { assignedIssues: { nodes: (IssueNode & { project?: { id: string; name: string } | null; team?: TeamNode | null })[] } } }>(user, `
      {
        viewer {
          assignedIssues(first: 100, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
            nodes {
              id identifier title url priority dueDate
              state { id name type } project { id name }
              team { id states { nodes { id name type position } } }
            }
          }
        }
      }`);
    return {
      canWrite: canWriteLinear(user),
      issues: r.viewer.assignedIssues.nodes.map((i) => {
        const done = [...(i.team?.states?.nodes ?? [])].filter((x) => x.type === 'completed').sort((a, b) => a.position - b.position)[0];
        return {
          id: i.id, identifier: i.identifier, title: i.title, url: i.url, priority: i.priority ?? 0, dueDate: i.dueDate ?? null,
          state: i.state ? { name: i.state.name, type: i.state.type } : null, project: i.project ?? null, doneStateId: done?.id ?? null,
        };
      }).sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || (a.priority || 9) - (b.priority || 9)),
    };
  });
}

// ---------------------------------------------------------------- one issue, and changing things
const ISSUE_ID = /^[\w-]{1,64}$/;

/** An issue with its description and comments, for the side panel. */
export async function getIssue(user: User, id: string) {
  if (!ISSUE_ID.test(id)) throw new UserError('err.linear.noIssue');
  const r = await linearQuery<{ issue: (Omit<IssueNode, 'team'> & { team?: TeamNode | null; project?: { id: string; name: string } | null; description?: string | null; createdAt?: string; creator?: Person | null; comments?: { nodes: { id: string; body: string; createdAt: string; user?: Person | null }[] } }) | null }>(user, `
    query Issue($id: String!) {
      issue(id: $id) {
        id identifier title description url priority priorityLabel dueDate createdAt completedAt
        state { id name type } assignee { id name displayName avatarUrl } creator { name displayName avatarUrl } team { ${TEAM_OPTIONS} } projectMilestone { id } project { id name }
        comments(first: 50) { nodes { id body createdAt user { name displayName avatarUrl } } }
      }
    }`, { id }).catch((e: Error) => {
    if (/not found|Entity not found/i.test(e.message)) throw new UserError('err.linear.noIssue');
    throw e;
  });
  const i = r.issue;
  if (!i) throw new UserError('err.linear.noIssue');
  return {
    id: i.id, identifier: i.identifier, title: i.title, description: i.description ?? '', url: i.url,
    priority: i.priority ?? 0, dueDate: i.dueDate ?? null, createdAt: i.createdAt ?? null, creator: person(i.creator),
    state: i.state ? { id: i.state.id ?? null, name: i.state.name, type: i.state.type } : null,
    assignee: person(i.assignee), assigneeId: i.assignee?.id ?? null, team: i.team?.id ?? null, project: i.project ?? null,
    teamOptions: i.team ? [teamOption(i.team)] : [],
    comments: [...(i.comments?.nodes ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((c) => ({ id: c.id, body: c.body, at: c.createdAt, by: person(c.user) })),
    canWrite: canWriteLinear(user),
  };
}

/** A change as the person; without write access they are sent to agree to it once. */
async function change<T>(user: User, query: string, variables: Record<string, unknown>): Promise<T> {
  if (!canWriteLinear(user)) throw new UserError('err.linear.needsWrite', { url: linearConnectUrl('/projects') });
  try {
    return await linearQuery<T>(user, query, variables);
  } finally {
    forgetProjects(user);
  }
}
const ok = (r: { success?: boolean } | undefined) => {
  if (!r?.success) throw new UserError('err.linear.notChanged');
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function updateIssue(user: User, id: string, patch: { stateId?: string; assigneeId?: string | null; priority?: number; dueDate?: string | null }) {
  if (!ISSUE_ID.test(id)) throw new UserError('err.linear.noIssue');
  const input: Record<string, unknown> = {};
  if (patch.stateId !== undefined) input.stateId = patch.stateId;
  if (patch.assigneeId !== undefined) input.assigneeId = patch.assigneeId;
  if (patch.priority !== undefined) {
    if (![0, 1, 2, 3, 4].includes(patch.priority)) throw new UserError('err.linear.badValue');
    input.priority = patch.priority;
  }
  if (patch.dueDate !== undefined) {
    if (patch.dueDate !== null && !DAY.test(patch.dueDate)) throw new UserError('err.linear.badValue');
    input.dueDate = patch.dueDate;
  }
  if (!Object.keys(input).length) throw new UserError('err.linear.badValue');
  const r = await change<{ issueUpdate: { success: boolean } }>(user, 'mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id, input });
  ok(r.issueUpdate);
  return { ok: true };
}

export async function commentOnIssue(user: User, id: string, body: string) {
  if (!ISSUE_ID.test(id)) throw new UserError('err.linear.noIssue');
  const text = body.trim();
  if (!text || text.length > 10_000) throw new UserError('err.linear.badValue');
  const r = await change<{ commentCreate: { success: boolean } }>(user, 'mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId: id, body: text } });
  ok(r.commentCreate);
  return { ok: true };
}

export async function createIssue(user: User, projectId: string, input: { teamId: string; title: string; description?: string; assigneeId?: string | null; priority?: number; milestoneId?: string | null; dueDate?: string | null }) {
  if (!ISSUE_ID.test(projectId) || !ISSUE_ID.test(input.teamId)) throw new UserError('err.linear.badValue');
  const title = input.title.trim();
  if (!title || title.length > 255) throw new UserError('err.linear.badValue');
  if (input.dueDate && !DAY.test(input.dueDate)) throw new UserError('err.linear.badValue');
  const r = await change<{ issueCreate: { success: boolean; issue?: { id: string; identifier: string; url: string } } }>(user,
    'mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }', {
      input: {
        teamId: input.teamId, projectId, title,
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
        ...(input.priority !== undefined && [0, 1, 2, 3, 4].includes(input.priority) ? { priority: input.priority } : {}),
        ...(input.milestoneId ? { projectMilestoneId: input.milestoneId } : {}),
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
      },
    });
  ok(r.issueCreate);
  return r.issueCreate.issue ?? null;
}

const HEALTH = ['onTrack', 'atRisk', 'offTrack'];
export async function postProjectUpdate(user: User, projectId: string, input: { body: string; health: string }) {
  if (!ISSUE_ID.test(projectId) || !HEALTH.includes(input.health)) throw new UserError('err.linear.badValue');
  const body = input.body.trim();
  if (!body || body.length > 20_000) throw new UserError('err.linear.badValue');
  const r = await change<{ projectUpdateCreate: { success: boolean } }>(user,
    'mutation Post($input: ProjectUpdateCreateInput!) { projectUpdateCreate(input: $input) { success } }', { input: { projectId, body, health: input.health } });
  ok(r.projectUpdateCreate);
  return { ok: true };
}
