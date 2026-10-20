/**
 * GitHub's webhook for the hub's App. Pushes to any branch are kept for 90 days, so a report also covers work that
 * has no pull request yet (GitHub's commit search only sees default branches). Pull request and review events only
 * refresh what the hub has cached for that person. Every delivery is signed with the shared secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { config } from '../config.ts';
import { now, run } from '../db.ts';
import { forgetActivity } from './activity.ts';

const KEEP = 90 * 86_400_000;

export function validSignature(body: string, header: string | undefined): boolean {
  if (!config.github.webhookSecret || !header?.startsWith('sha256=')) return false;
  const want = Buffer.from('sha256=' + createHmac('sha256', config.github.webhookSecret).update(body).digest('hex'));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

interface PushCommit { id: string; message: string; timestamp: string; url: string; author?: { email?: string; username?: string } }
interface Push { ref: string; deleted?: boolean; repository: { full_name: string; owner: { login?: string; name?: string } }; commits?: PushCommit[] }

const inOrg = (owner: { login?: string; name?: string }) => (owner.login ?? owner.name ?? '').toLowerCase() === config.github.org.toLowerCase();

/** Stores the pushed commits; returns how many were new. */
export function recordPush(p: Push): number {
  if (p.deleted || !p.ref?.startsWith('refs/heads/') || !inOrg(p.repository.owner)) return 0;
  const branch = p.ref.slice('refs/heads/'.length);
  let added = 0;
  for (const c of p.commits ?? []) {
    const login = c.author?.username?.toLowerCase() ?? null;
    const at = Date.parse(c.timestamp);
    if (!Number.isFinite(at)) continue;
    const r = run(`INSERT OR IGNORE INTO github_commits (repo, sha, branch, author_login, author_email, message, url, at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      p.repository.full_name, c.id, branch, login, c.author?.email ?? null, c.message.split('\n')[0].slice(0, 200), c.url, at);
    added += Number(r.changes);
    if (login) forgetActivity(login);
  }
  return added;
}

let pruned = 0;
function prune() {
  if (now() - pruned < 3600_000) return;
  pruned = now();
  run('DELETE FROM github_commits WHERE at < ?', now() - KEEP);
}

export const githubHook = new Hono();

githubHook.post('/hooks/github', async (c) => {
  if (!config.github.webhookSecret) return c.notFound();
  const body = await c.req.text();
  if (!validSignature(body, c.req.header('x-hub-signature-256'))) return c.json({ error: 'bad signature' }, 401);
  const event = c.req.header('x-github-event') ?? '';
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ error: 'bad body' }, 400);
  }
  if (event === 'push') {
    prune();
    return c.json({ ok: true, stored: recordPush(payload as unknown as Push) });
  }
  if (event === 'pull_request' || event === 'pull_request_review') {
    const who = [(payload.pull_request as { user?: { login?: string } } | undefined)?.user?.login, (payload.review as { user?: { login?: string } } | undefined)?.user?.login, (payload.sender as { login?: string } | undefined)?.login];
    for (const l of who) if (l) forgetActivity(l.toLowerCase());
  }
  return c.json({ ok: true });
});
