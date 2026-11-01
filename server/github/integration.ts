/**
 * GitHub as an integration of the hub (integration.ts): the company's GitHub App reads the organisation's activity;
 * each person links their account once so the hub knows who they are there. Brings the link, the webhook, the
 * contribution calendar for the home page and the github_activity tool.
 */
import { z } from 'zod';
import { config } from '../config.ts';
import { all, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import type { Integration } from '../integration.ts';
import { githubActivity } from './activity.ts';
import { githubEnabled } from './app.ts';
import { contributions } from './contributions.ts';
import { githubHook } from './hook.ts';
import { finishGitHubLink, githubAuthorizeUrl, githubConnectUrl, unlinkGitHub } from './link.ts';

export const github: Integration = {
  id: 'github',
  enabled: githubEnabled,
  connect: {
    available: () => githubEnabled() && !!config.github.clientId,
    authorize: (_user, state) => ({ url: githubAuthorizeUrl(state) }),
    finish: async (user, code) => { await finishGitHubLink(user, code); },
  },
  api(r) {
    r.get('/github/status', (c) => {
      const u = c.get('user');
      return c.json({ available: githubEnabled(), org: config.github.org, login: u.github_login ?? null, connectUrl: githubConnectUrl('/me') });
    });
    // the viewer's own contribution calendar (home module); never someone else's, since the hub reads every repository
    r.get('/github/contributions', async (c) => {
      const u = c.get('user');
      if (!githubEnabled()) throw new UserError('err.github.disabled');
      if (!u.github_login) return c.json({ linked: false, connectUrl: githubConnectUrl('/') });
      const weeks = Math.min(53, Math.max(4, Number(c.req.query('weeks') ?? 52) || 52));
      return c.json({ linked: true, ...(await contributions(u, weeks)) });
    });
    r.post('/github/disconnect', (c) => {
      unlinkGitHub(c.get('user'));
      return c.json({ ok: true });
    });
  },
  web(r) {
    r.route('/', githubHook);
  },
  tools({ server, user, guard, resolveColleagues }) {
    server.registerTool('github_activity', {
      description: `What someone did on GitHub (organisation ${config.github.org}) in a time window: commits they authored (with the branch or pull request when the work is not on the default branch), pull requests they opened or updated (open / merged / closed) and pull requests they reviewed. Use it to write a daily or weekly report, or to see what a colleague is working on. Default: the user, last 24 hours.`,
      inputSchema: {
        colleague: z.string().optional().describe('email, name or open_id; default: the user'),
        since: z.string().optional().describe('ISO date-time, e.g. 2026-10-19T09:00:00+09:00; default: 24 hours ago'),
        until: z.string().optional().describe('ISO date-time; default: now'),
      },
    }, guard(async (a: { colleague?: string; since?: string; until?: string }) => {
      const person = a.colleague ? all<User>('SELECT * FROM users WHERE id = ?', resolveColleagues([a.colleague])[0])[0] : user;
      const to = a.until ? Date.parse(a.until) : Date.now();
      const from = a.since ? Date.parse(a.since) : to - 86_400_000;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new UserError('err.github.badWindow');
      if (!person.github_login) return { linked: false, hint: person.id === user.id ? `Ask the user to link their GitHub account once: ${githubConnectUrl('/me')}` : `${person.name} has not linked a GitHub account in the hub yet.` };
      return githubActivity(person, from, to);
    }));
  },
};
