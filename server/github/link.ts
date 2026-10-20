/**
 * Linking a hub account to a GitHub account: the person signs in to GitHub through the hub's GitHub App (no extra
 * permissions are asked), the hub reads who they are and keeps only the login. Their commits and pull requests are
 * then read with the App's own access to the organisation.
 */
import { config } from '../config.ts';
import { run, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { asGitHubUser } from './app.ts';

export const CALLBACK = () => `${config.hubUrl}/auth/github/callback`;
export const githubConnectUrl = (returnPath: string) => `${config.hubUrl}/auth/github/connect?return=${encodeURIComponent(returnPath)}`;

export function githubAuthorizeUrl(state: string): string {
  const u = new URL(`${config.github.webBase}/login/oauth/authorize`);
  u.searchParams.set('client_id', config.github.clientId);
  u.searchParams.set('redirect_uri', CALLBACK());
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'false');
  return u.toString();
}

export async function finishGitHubLink(user: User, code: string): Promise<string> {
  const res = await fetch(`${config.github.webBase}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: config.github.clientId, client_secret: config.github.clientSecret, code, redirect_uri: CALLBACK() }),
  });
  const t = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!t.access_token) throw new Error(`GitHub sign-in failed: ${t.error_description ?? t.error ?? res.status}`);
  const me = await asGitHubUser<{ login: string; id: number }>(t.access_token, '/user');
  // the token was only needed to learn who this is; let it go right away
  await fetch(`${config.github.apiBase}/applications/${config.github.clientId}/token`, {
    method: 'DELETE',
    headers: { accept: 'application/vnd.github+json', authorization: `Basic ${Buffer.from(`${config.github.clientId}:${config.github.clientSecret}`).toString('base64')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: t.access_token }),
  }).catch(() => undefined);
  const taken = run('UPDATE users SET github_login = NULL, github_id = NULL WHERE github_id = ? AND id != ?', me.id, user.id);
  if (taken.changes) console.warn(`[github] ${me.login} moved to ${user.id}`);
  run('UPDATE users SET github_login = ?, github_id = ? WHERE id = ?', me.login, me.id, user.id);
  return me.login;
}

export function unlinkGitHub(user: User) {
  run('UPDATE users SET github_login = NULL, github_id = NULL WHERE id = ?', user.id);
}

export function requireLogin(person: Pick<User, 'name' | 'github_login'>): string {
  if (!person.github_login) throw new UserError('err.github.notLinked', { name: person.name, url: githubConnectUrl('/me') });
  return person.github_login;
}
