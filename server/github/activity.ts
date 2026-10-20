/**
 * What someone did on GitHub in a time window, across the organisation's repositories: commits they authored
 * (default branches, and inside their pull requests for work on other branches), pull requests they opened or
 * updated, and pull requests they reviewed. Read with the hub's GitHub App, cached for five minutes. When GitHub
 * pushes to the hub (hook.ts), commits on branches without a pull request are included as well.
 */
import { config } from '../config.ts';
import { all, type User } from '../db.ts';
import { gh } from './app.ts';
import { requireLogin } from './link.ts';

interface SearchCommit { sha: string; html_url: string; repository: { full_name: string }; commit: { message: string; author: { date: string } } }
interface SearchIssue { number: number; title: string; html_url: string; state: string; created_at: string; updated_at: string; repository_url: string; pull_request?: { merged_at: string | null } }
interface PrCommit { sha: string; html_url: string; author: { login: string } | null; commit: { message: string; author: { date: string } } }

const firstLine = (m: string) => m.split('\n')[0].slice(0, 200);
const repoOf = (url: string) => url.split('/repos/')[1] ?? url;
const cache = new Map<string, { at: number; value: Promise<Activity> }>();
export type Activity = Awaited<ReturnType<typeof read>>;

/** Drops what is cached for someone, when GitHub tells the hub they pushed or touched a pull request. */
export function forgetActivity(login: string) {
  for (const k of cache.keys()) if (k.startsWith(login.toLowerCase() + '|')) cache.delete(k);
}

/** Commits GitHub pushed to the hub for this person in the window. */
function pushedCommits(login: string, from: number, to: number) {
  return all<{ repo: string; sha: string; branch: string; message: string; url: string; at: number }>(
    'SELECT repo, sha, branch, message, url, at FROM github_commits WHERE author_login = ? AND at BETWEEN ? AND ? ORDER BY at DESC LIMIT 300',
    login.toLowerCase(), from, to);
}

export function githubActivity(person: User, from: number, to: number): Promise<Activity> {
  const login = requireLogin(person);
  const key = `${login.toLowerCase()}|${Math.floor(from / 60_000)}|${Math.floor(to / 60_000)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.value;
  const value = read(login, from, to);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  for (const [k, v] of cache) if (Date.now() - v.at > 300_000) cache.delete(k);
  return value;
}

async function read(login: string, from: number, to: number) {
  const org = config.github.org;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 19) + 'Z';
  const range = `${day(from)}..${day(to)}`;
  const q = (s: string) => encodeURIComponent(s);
  const [direct, authored, reviewed] = await Promise.all([
    gh<{ items: SearchCommit[]; total_count: number }>(`/search/commits?q=${q(`org:${org} author:${login} author-date:${range}`)}&sort=author-date&order=desc&per_page=100`),
    gh<{ items: SearchIssue[] }>(`/search/issues?q=${q(`org:${org} type:pr author:${login} updated:${range}`)}&sort=updated&order=desc&per_page=50`),
    gh<{ items: SearchIssue[] }>(`/search/issues?q=${q(`org:${org} type:pr reviewed-by:${login} -author:${login} updated:${range}`)}&sort=updated&order=desc&per_page=30`),
  ]);
  const inWindow = (iso: string) => { const t = Date.parse(iso); return t >= from && t <= to; };
  const commits = new Map<string, { repo: string; sha: string; message: string; url: string; at: string; branch?: string; pr?: number }>();
  for (const c of direct.items) commits.set(c.sha, { repo: c.repository.full_name, sha: c.sha.slice(0, 7), message: firstLine(c.commit.message), url: c.html_url, at: c.commit.author.date });
  // work on feature branches only shows up inside the pull request
  for (const pr of authored.items.slice(0, 15)) {
    const repo = repoOf(pr.repository_url);
    const list = await gh<PrCommit[]>(`/repos/${repo}/pulls/${pr.number}/commits?per_page=100`).catch(() => []);
    for (const c of list) {
      if (c.author?.login?.toLowerCase() !== login.toLowerCase() || !inWindow(c.commit.author.date) || commits.has(c.sha)) continue;
      commits.set(c.sha, { repo, sha: c.sha.slice(0, 7), message: firstLine(c.commit.message), url: c.html_url, at: c.commit.author.date, pr: pr.number });
    }
  }
  // pushed to the hub: every branch, including work without a pull request
  for (const c of pushedCommits(login, from, to)) {
    const known = commits.get(c.sha);
    if (known) known.branch ??= c.branch;
    else commits.set(c.sha, { repo: c.repo, sha: c.sha.slice(0, 7), message: c.message, url: c.url, at: new Date(c.at).toISOString(), branch: c.branch });
  }
  const prShape = (p: SearchIssue) => ({
    repo: repoOf(p.repository_url), number: p.number, title: p.title, url: p.html_url,
    state: p.pull_request?.merged_at ? 'merged' : p.state, createdAt: p.created_at, updatedAt: p.updated_at, mergedAt: p.pull_request?.merged_at ?? null,
  });
  return {
    login,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    commits: [...commits.values()].sort((a, b) => b.at.localeCompare(a.at)),
    pullRequests: authored.items.map(prShape),
    reviewed: reviewed.items.map(prShape),
  };
}
