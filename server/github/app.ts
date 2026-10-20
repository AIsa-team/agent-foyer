/**
 * The hub's GitHub App: a JWT signed with the App's private key buys a short-lived installation token for the
 * organisation, which can read its repositories (contents and pull requests, read-only).
 */
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { UserError } from '../i18n/index.ts';

export const githubEnabled = () => !!(config.github.org && config.github.appId && config.github.privateKey);

function privateKey(): string {
  const v = config.github.privateKey;
  if (v.includes('BEGIN')) return v.replace(/\\n/g, '\n');
  const file = path.isAbsolute(v) ? v : path.join(config.dataDir, v);
  if (!existsSync(file)) throw new Error(`GitHub App private key not found at ${file}`);
  return readFileSync(file, 'utf8');
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function appJwt(): string {
  const at = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: at - 60, exp: at + 540, iss: config.github.appId })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey()).toString('base64url')}`;
}

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(token: string, p: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(p.startsWith('http') ? p : `${config.github.apiBase}${p}`, {
    ...init,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${token}`, 'user-agent': 'agent-hub', ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new GitHubError(res.status, `GitHub ${p.split('?')[0]}: ${res.status} ${body.message ?? ''}`.trim());
  return body;
}

let installation: { token: string; expiresAt: number } | undefined;

/** An installation token for the organisation, cached until shortly before it expires. */
async function installationToken(): Promise<string> {
  if (installation && installation.expiresAt > Date.now() + 120_000) return installation.token;
  const jwt = appJwt();
  let id: number;
  try {
    id = (await call<{ id: number }>(jwt, `/orgs/${encodeURIComponent(config.github.org)}/installation`)).id;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) throw new UserError('err.github.notInstalled', { org: config.github.org });
    throw e;
  }
  const t = await call<{ token: string; expires_at: string }>(jwt, `/app/installations/${id}/access_tokens`, { method: 'POST' });
  installation = { token: t.token, expiresAt: Date.parse(t.expires_at) };
  return t.token;
}

/** GET from the GitHub API as the organisation's installation. */
export async function gh<T>(p: string): Promise<T> {
  return call<T>(await installationToken(), p);
}

/** A call with someone's own user token (only used to learn who they are when they link their account). */
export const asGitHubUser = <T>(token: string, p: string) => call<T>(token, p);
