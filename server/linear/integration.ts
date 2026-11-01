/**
 * Linear as an integration of the hub (integration.ts): each person links their own Linear account for the 项目 page
 * (projects, issues, updates), read and changed as them. Agents reach Linear through its own MCP server (services/).
 */
import type { Integration } from '../integration.ts';
import { body } from '../http.ts';
import { finishLinearLink, linearAuthorizeUrl, linearEnabled, linearStatus, unlinkLinear } from './link.ts';
import { commentOnIssue, createIssue, forgetProjects, getIssue, getProject, listProjects, myIssues, postProjectUpdate, updateIssue } from './projects.ts';

export const linear: Integration = {
  id: 'linear',
  enabled: linearEnabled,
  connect: {
    available: linearEnabled,
    authorize: (_user, state) => ({ url: linearAuthorizeUrl(state) }),
    finish: async (user, code) => {
      await finishLinearLink(user, code);
      // what was read with the earlier connection (e.g. read only) goes
      forgetProjects(user);
    },
    // signing in to Linear and reading what is asked can take a while
    minutes: 30,
    denied: 'return',
  },
  api(r) {
    r.get('/linear/status', (c) => c.json(linearStatus(c.get('user'))));
    r.post('/linear/disconnect', (c) => {
      unlinkLinear(c.get('user'));
      forgetProjects(c.get('user'));
      return c.json({ ok: true });
    });
    r.get('/projects', async (c) => {
      const u = c.get('user');
      const status = linearStatus(u);
      if (!status.available || !status.connected) return c.json({ status, projects: [] });
      return c.json({ status, projects: await listProjects(u) });
    });
    r.get('/projects/my-issues', async (c) => c.json(await myIssues(c.get('user'))));
    r.get('/projects/:id', async (c) => c.json(await getProject(c.get('user'), c.req.param('id'))));
    r.post('/projects/:id/issues', async (c) => {
      const b = await body<{ teamId: string; title: string; description?: string; assigneeId?: string | null; priority?: number; milestoneId?: string | null; dueDate?: string | null }>(c);
      return c.json(await createIssue(c.get('user'), c.req.param('id'), { ...b, teamId: String(b.teamId ?? ''), title: String(b.title ?? '') }));
    });
    r.post('/projects/:id/updates', async (c) => {
      const b = await body<{ body: string; health: string }>(c);
      return c.json(await postProjectUpdate(c.get('user'), c.req.param('id'), { body: String(b.body ?? ''), health: String(b.health ?? '') }));
    });
    r.get('/linear/issues/:id', async (c) => c.json(await getIssue(c.get('user'), c.req.param('id'))));
    r.patch('/linear/issues/:id', async (c) => c.json(await updateIssue(c.get('user'), c.req.param('id'), await body<{ stateId?: string; assigneeId?: string | null; priority?: number; dueDate?: string | null }>(c))));
    r.post('/linear/issues/:id/comments', async (c) => {
      const b = await body<{ body: string }>(c);
      return c.json(await commentOnIssue(c.get('user'), c.req.param('id'), String(b.body ?? '')));
    });
  },
};
