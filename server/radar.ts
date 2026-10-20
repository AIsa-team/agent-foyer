/**
 * The "Me" page profile: how far someone has come with the hub, on six axes, next to everyone else who has signed in.
 * Each axis is a plain count. Full scale is a fixed goal, or the colleague with the most once someone passes it (so a
 * hub with few people doesn't fill up at once); connections are out of the kinds this hub offers. The median is marked.
 */
import { config } from './config.ts';
import { all } from './db.ts';
import { githubEnabled } from './github/app.ts';

type Counts = Map<string, number>;
const counts = (sql: string, ...params: (string | number)[]): Counts =>
  new Map(all<{ id: string; n: number }>(sql, ...params).map((r) => [r.id, r.n]));

export interface Axis { key: string; value: number; max: number; top: number; median: number }

/** What full scale means before anyone goes further. */
const GOALS: Record<string, number> = { agents: 3, apps: 10, appUsers: 20, skills: 10, skillUsers: 20 };

/** The axes, and how many people have signed in (a median of one or two people says little). */
export function profileRadar(userId: string): { axes: Axis[]; people: number } {
  const people = all<{ id: string }>('SELECT id FROM users WHERE last_seen_at IS NOT NULL').map((r) => r.id);
  if (!people.includes(userId)) people.push(userId);
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  // which outside connections this hub offers; each one a person has made counts once
  const kinds = [
    config.lark.enabled && 'SELECT user_id AS id FROM lark_tokens',
    config.mailDrafts === 'google' && 'SELECT user_id AS id FROM google_tokens',
    githubEnabled() && 'SELECT id FROM users WHERE github_login IS NOT NULL',
  ].filter(Boolean) as string[];

  const axes: [string, Counts, number?][] = [
    ['agents', counts('SELECT user_id AS id, COUNT(*) AS n FROM agent_connections GROUP BY user_id')],
    ['apps', counts('SELECT owner_id AS id, COUNT(*) AS n FROM apps GROUP BY owner_id')],
    // colleagues who opened one of this person's apps in the last 30 days
    ['appUsers', counts(`SELECT a.owner_id AS id, COUNT(DISTINCT v.user_id) AS n FROM app_visits v JOIN apps a ON a.slug = v.app_slug
                         WHERE v.day >= ? AND v.user_id != a.owner_id GROUP BY a.owner_id`, since)],
    ['skills', counts('SELECT owner_id AS id, COUNT(*) AS n FROM skills GROUP BY owner_id')],
    // colleagues who installed one of this person's Skills
    ['skillUsers', counts(`SELECT s.owner_id AS id, COUNT(DISTINCT i.user_id) AS n FROM skill_installs i JOIN skills s ON s.slug = i.skill_slug
                           WHERE i.user_id != s.owner_id GROUP BY s.owner_id`)],
  ];
  if (kinds.length) {
    axes.push(['connections', counts(`SELECT id, COUNT(*) AS n FROM (${kinds.join(' UNION ALL ')}) GROUP BY id`), kinds.length]);
  }

  return { people: people.length, axes: axes.map(([key, by, ceiling]) => {
    const values = people.map((p) => by.get(p) ?? 0).sort((a, b) => a - b);
    const mid = values.length >> 1;
    const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    const top = values[values.length - 1];
    return { key, value: by.get(userId) ?? 0, max: ceiling ?? Math.max(GOALS[key], top), top, median };
  }) };
}
