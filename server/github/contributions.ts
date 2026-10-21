/**
 * Someone's contribution calendar in the organisation, as GitHub counts it on their profile (commits to default
 * branches, pull requests opened, reviews): one count per day for the last weeks, the totals, the repositories they
 * committed to most and their streaks. One GraphQL call with the hub's GitHub App, cached for half an hour.
 */
import { config } from '../config.ts';
import type { User } from '../db.ts';
import { gh, ghGraphql } from './app.ts';
import { requireLogin } from './link.ts';

const DAY = 86_400_000;
const TTL = 30 * 60_000;
const cache = new Map<string, { at: number; value: Promise<Contributions> }>();
let orgId: string | undefined;

export type Contributions = Awaited<ReturnType<typeof read>>;

/** Drops what is cached for someone, when GitHub tells the hub they pushed or touched a pull request. */
export function forgetContributions(login: string) {
  for (const k of cache.keys()) if (k.startsWith(login.toLowerCase() + '|')) cache.delete(k);
}

export function contributions(person: User, weeks = 52): Promise<Contributions> {
  const login = requireLogin(person);
  const key = `${login.toLowerCase()}|${weeks}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = read(login, weeks);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

interface Collection {
  totalCommitContributions: number; totalPullRequestContributions: number; totalPullRequestReviewContributions: number;
  contributionCalendar: { totalContributions: number; weeks: { contributionDays: { date: string; contributionCount: number }[] }[] };
  commitContributionsByRepository: { repository: { nameWithOwner: string; url: string }; contributions: { totalCount: number } }[];
}

const QUERY = `query($login: String!, $org: ID!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(organizationID: $org, from: $from, to: $to) {
      totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
      commitContributionsByRepository(maxRepositories: 3) { repository { nameWithOwner url } contributions { totalCount } }
    }
  }
}`;

async function read(login: string, weeks: number) {
  orgId ??= (await gh<{ node_id: string }>(`/orgs/${encodeURIComponent(config.github.org)}`)).node_id;
  const to = Date.now();
  const from = to - (weeks * 7 - 1) * DAY;
  const r = await ghGraphql<{ user: { contributionsCollection: Collection } | null }>(QUERY, {
    login, org: orgId, from: new Date(from).toISOString(), to: new Date(to).toISOString(),
  });
  const c = r.user?.contributionsCollection;
  const days = (c?.contributionCalendar.weeks ?? []).flatMap((w) => w.contributionDays).map((d) => ({ date: d.date, value: d.contributionCount }));
  // streaks: consecutive days with something; today not done yet does not break the current one
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.value > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].value > 0) current++;
    else if (i === days.length - 1) continue;
    else break;
  }
  return {
    login,
    profile: `${config.github.webBase}/${login}`,
    from: days[0]?.date ?? new Date(from).toISOString().slice(0, 10),
    to: days.at(-1)?.date ?? new Date(to).toISOString().slice(0, 10),
    days,
    total: c?.contributionCalendar.totalContributions ?? 0,
    commits: c?.totalCommitContributions ?? 0,
    pullRequests: c?.totalPullRequestContributions ?? 0,
    reviews: c?.totalPullRequestReviewContributions ?? 0,
    activeDays: days.filter((d) => d.value > 0).length,
    streak: { current, longest },
    repos: (c?.commitContributionsByRepository ?? []).map((x) => ({ name: x.repository.nameWithOwner.split('/')[1] ?? x.repository.nameWithOwner, url: x.repository.url, commits: x.contributions.totalCount })),
  };
}
