import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appUrl, config, paths } from '../config.ts';
import { decrypt, encrypt, randomToken } from '../crypto.ts';
import { all, get, now, run, tx, type App, type User } from '../db.ts';
import { extractTarball, takeUpload } from '../uploads.ts';
import { canAccessApp, canManageApp } from './access.ts';
import { openFeedbackCount, usageBySlug } from './feedback.ts';
import { publicRequested } from './approvals.ts';
import * as docker from './docker.ts';
import { UserError, type Msg } from '../i18n/index.ts';
import { localize, mergeLocalized, missingLocales, parseLocalized, type LocalizedMap } from '../localized.ts';

export type Visibility = App['visibility'];
export const VISIBILITIES: Visibility[] = ['private', 'members', 'company', 'public'];

const RESERVED = new Set(['hub', 'www', 'api', 'admin', 'mail', 'auth', 'login', 'static', 'assets', 'mcp', 'oauth', 'app', 'apps', 'skill', 'skills', 'status', 'docs', 'test']);
export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export { UserError };

export const releaseDir = (slug: string, version: number) => path.join(paths.apps, slug, String(version));

export function getApp(slug: string): App | undefined {
  return get<App>('SELECT * FROM apps WHERE slug = ?', slug);
}

export function requireManageable(slug: string, user: User): App {
  const app = getApp(slug);
  if (!app) throw new UserError('err.appNotFound', { slug });
  if (!canManageApp(app, user)) throw new UserError('err.notAppOwner', { slug });
  return app;
}

export function slugAvailable(slug: string, user: User): { ok: boolean; reason?: Msg } {
  if (!SLUG_RE.test(slug)) return { ok: false, reason: { key: 'err.slug.format' } };
  if (slug.includes('--')) return { ok: false, reason: { key: 'err.slug.doubleHyphen' } };
  if (RESERVED.has(slug) || config.reservedSlugs.includes(slug)) return { ok: false, reason: { key: 'err.slug.reserved', params: { slug } } };
  const app = getApp(slug);
  if (app && !canManageApp(app, user)) return { ok: false, reason: { key: 'err.slug.taken', params: { slug } } };
  return { ok: true };
}

/** Finds the folder to serve for a static site: the given one, else a common build output, else the root. */
function detectStaticRoot(dir: string, hint?: string): string {
  const candidates = hint ? [hint] : ['dist', 'build', 'out', 'public', '.'];
  for (const c of candidates) {
    const abs = path.resolve(dir, c);
    if (!abs.startsWith(path.resolve(dir))) continue;
    if (existsSync(path.join(abs, 'index.html'))) return path.relative(dir, abs) || '.';
  }
  throw hint ? new UserError('err.static.noIndexAt', { dir: hint }) : new UserError('err.static.noIndex');
}

export function saveIcon(slug: string, icon: { svg?: string; pngBase64?: string }): string {
  let file: string;
  let data: Buffer;
  if (icon.svg) {
    if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(icon.svg)) throw new UserError('err.icon.notSvg');
    data = Buffer.from(icon.svg);
    file = `${slug}-${randomToken(4)}.svg`;
  } else if (icon.pngBase64) {
    data = Buffer.from(icon.pngBase64.replace(/^data:image\/png;base64,/, ''), 'base64');
    if (data.subarray(1, 4).toString() !== 'PNG') throw new UserError('err.icon.notPng');
    file = `${slug}-${randomToken(4)}.png`;
  } else throw new UserError('err.icon.missing');
  if (data.length > 256 * 1024) throw new UserError('err.icon.tooLarge');
  writeFileSync(path.join(paths.icons, file), data);
  return file;
}

export interface PublishInput {
  uploadId: string;
  slug: string;
  name?: string;
  description?: string;
  kind: 'static' | 'container';
  staticDir?: string;
  containerPort?: number;
  visibility?: Visibility;
  memberIds?: string[];
  iconSvg?: string;
  iconPngBase64?: string;
  /** Listing text per language, e.g. { "zh-CN": { name, description }, "en": { ... } } */
  localized?: LocalizedMap;
  /** optional: the Skill that goes with this app ('' removes the link) */
  relatedSkill?: string | null;
}

export interface PublishResult {
  slug: string;
  url: string;
  version: number;
  status: App['status'];
  visibility: Visibility;
  notes: Msg[];
}

/** Slugs with a publish in progress. Reserved synchronously so concurrent publishes cannot share a version. */
const busy = new Set<string>();

export async function publishApp(user: User, input: PublishInput): Promise<PublishResult> {
  const slug = input.slug.toLowerCase();
  const avail = slugAvailable(slug, user);
  if (!avail.ok) throw new UserError(avail.reason!.key, avail.reason!.params);
  if (busy.has(slug)) throw new UserError('err.app.busy', { slug });
  busy.add(slug);
  let handedOff = false;
  try {
    const existing = getApp(slug);
    const firstLocalized = Object.values(input.localized ?? {}).find((t) => t?.name?.trim());
    const baseName = input.name ?? firstLocalized?.name;
    const baseDescription = input.description ?? firstLocalized?.description;
    if (!existing && !baseName) throw new UserError('err.app.nameRequired');
    const i18n = mergeLocalized(existing?.i18n ?? null, input.localized);
    const file = takeUpload(input.uploadId, user.id, 'app');

    const version = (get<{ v: number | null }>('SELECT MAX(version) AS v FROM app_releases WHERE app_slug = ?', slug)?.v ?? 0) + 1;
    const dir = releaseDir(slug, version);
    rmSync(dir, { recursive: true, force: true });
    await extractTarball(file, dir);
    const notes: Msg[] = [];

    let root: string | null = null;
    if (input.kind === 'static') root = detectStaticRoot(dir, input.staticDir);

    const visibility = input.visibility ?? existing?.visibility ?? 'private';
    const icon = input.iconSvg || input.iconPngBase64 ? saveIcon(slug, { svg: input.iconSvg, pngBase64: input.iconPngBase64 }) : undefined;
    const port = input.containerPort ?? existing?.container_port ?? 3000;

    const releaseId = tx(() => {
      if (!existing) {
        run(
          `INSERT INTO apps (slug, name, description, icon, owner_id, kind, visibility, public_status, status, container_port, i18n, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'building', ?, ?, ?, ?)`,
          slug, baseName!, baseDescription ?? '', icon ?? null, user.id, input.kind, visibility,
          visibility === 'public' ? 'pending' : 'none', port, i18n, now(), now(),
        );
        if (input.memberIds) setMembers(slug, input.memberIds);
      } else {
        // kind and port change only once the new release is live, so a failed build leaves the old one serving
        run(
          'UPDATE apps SET name = COALESCE(?, name), description = COALESCE(?, description), icon = COALESCE(?, icon), i18n = ?, updated_at = ? WHERE slug = ?',
          input.name ?? null, input.description ?? null, icon ?? null, i18n, now(), slug,
        );
      }
      return Number(run(
        `INSERT INTO app_releases (app_slug, version, kind, status, root, created_by, created_at) VALUES (?, ?, ?, 'building', ?, ?, ?)`,
        slug, version, input.kind, root, user.id, now(),
      ).lastInsertRowid);
    });

    if (existing && input.visibility) setVisibility(user, slug, input.visibility, input.memberIds);
    else if (!existing && visibility === 'public') publicRequested(getApp(slug)!, user);
    if (input.relatedSkill !== undefined) linkSkill(user, slug, input.relatedSkill);

    const log = (s: string) => run('UPDATE app_releases SET log = substr(log || ?, -20000) WHERE id = ?', s, releaseId);
    const finish = (status: 'online' | 'failed', upstream?: string) => tx(() => {
      run('UPDATE app_releases SET status = ? WHERE id = ?', status, releaseId);
      if (status === 'online') {
        run("UPDATE app_releases SET status = 'superseded' WHERE app_slug = ? AND id != ? AND status = 'online'", slug, releaseId);
        run(
          "UPDATE apps SET status = 'online', kind = ?, container_port = ?, current_release = ?, upstream = ?, updated_at = ? WHERE slug = ?",
          input.kind, port, version, upstream ?? null, now(), slug,
        );
      } else if (!getApp(slug)?.current_release) {
        run("UPDATE apps SET status = 'failed', updated_at = ? WHERE slug = ?", now(), slug);
      }
    });

    if (input.kind === 'static') {
      finish('online');
      if (existing?.kind === 'container') await docker.removeContainer(slug);
      notes.push(root === '.' ? { key: 'note.staticRoot' } : { key: 'note.staticDir', params: { dir: root! } });
    } else {
      const job = (async () => {
        try {
          log(docker.ensureDockerfile(dir, port) + '\n');
          const image = await docker.buildImage(slug, version, dir, log);
          const candidate = await docker.startCandidate(slug, image, port, readEnv(slug), log);
          if (!(await docker.waitForHttp(candidate))) {
            log(`\nThe container started but did not answer HTTP on port ${port} within 60 s. Container logs:\n` + (await docker.candidateLogs(slug)));
            await docker.removeCandidate(slug);
            finish('failed');
            return;
          }
          if (!getApp(slug)) {
            // deleted while building
            await docker.removeCandidate(slug);
            return;
          }
          finish('online', await docker.promoteCandidate(slug, port, candidate));
          await docker.pruneImages(slug, version);
        } catch (e) {
          log('\n' + (e as Error).message);
          await docker.removeCandidate(slug);
          finish('failed');
        }
      })().finally(() => busy.delete(slug));
      handedOff = true;
      await Promise.race([job, new Promise((r) => setTimeout(r, 90_000))]);
    }

    const app = getApp(slug)!;
    const rel = get<{ status: string }>('SELECT status FROM app_releases WHERE id = ?', releaseId)!;
    if (rel.status === 'building') notes.push({ key: 'note.building' });
    if (rel.status === 'failed') notes.push({ key: app.current_release ? 'note.failedKeepsPrevious' : 'note.failed' });
    if (app.visibility === 'public' && app.public_status === 'pending') notes.push({ key: 'note.publicPending' });
    const missing = missingLocales(app.i18n);
    if (missing.length) notes.push({ key: 'note.missingTranslations', params: { locales: missing.join(', '), tool: 'update_app' } });
    return { slug, url: appUrl(slug), version, status: rel.status === 'online' ? 'online' : app.status, visibility: app.visibility, notes };
  } finally {
    if (!handedOff) busy.delete(slug);
  }
}

/** After a restart, nothing is building any more: mark interrupted releases as failed. */
export function reconcileInterruptedBuilds() {
  tx(() => {
    run("UPDATE app_releases SET status = 'failed', log = log || ? WHERE status = 'building'", '\nThe hub restarted and interrupted this build. Please publish again.');
    run("UPDATE apps SET status = 'failed' WHERE status = 'building' AND current_release IS NULL");
    run("UPDATE apps SET status = 'online' WHERE status = 'building' AND current_release IS NOT NULL");
  });
}

/**
 * Optional one-to-one link from an app to a Skill (e.g. the components site ↔ the Skill that teaches agents to use it).
 * Set by someone who can manage the app; the Skill must be listed, or theirs. null removes the link.
 */
export function linkSkill(user: User, slug: string, skillSlug: string | null) {
  const app = requireManageable(slug, user);
  if (skillSlug === null || skillSlug === '') {
    run('UPDATE apps SET skill_slug = NULL, updated_at = ? WHERE slug = ?', now(), slug);
    return;
  }
  const skill = get<{ slug: string; listed: number; owner_id: string }>('SELECT slug, listed, owner_id FROM skills WHERE slug = ?', skillSlug);
  if (!skill || (!skill.listed && skill.owner_id !== user.id && user.role !== 'admin')) throw new UserError('err.skill.notFound', { slug: skillSlug });
  const other = get<{ slug: string }>('SELECT slug FROM apps WHERE skill_slug = ? AND slug != ?', skillSlug, app.slug);
  if (other) throw new UserError('err.link.skillTaken', { skill: skillSlug, app: other.slug });
  run('UPDATE apps SET skill_slug = ?, updated_at = ? WHERE slug = ?', skillSlug, now(), slug);
}

export function setMembers(slug: string, memberIds: string[]) {
  run('DELETE FROM app_members WHERE app_slug = ?', slug);
  for (const id of new Set(memberIds)) {
    if (!get('SELECT 1 FROM users WHERE id = ?', id)) throw new UserError('err.app.memberNotFound', { id });
    run('INSERT INTO app_members (app_slug, user_id) VALUES (?, ?)', slug, id);
  }
}

export function setVisibility(user: User, slug: string, visibility: Visibility, memberIds?: string[]) {
  const app = requireManageable(slug, user);
  if (!VISIBILITIES.includes(visibility)) throw new UserError('err.app.visibilityInvalid', { values: VISIBILITIES.join(' / ') });
  tx(() => {
    let publicStatus = app.public_status;
    if (visibility === 'public') publicStatus = app.public_status === 'approved' || user.role === 'admin' ? 'approved' : 'pending';
    else publicStatus = 'none';
    run('UPDATE apps SET visibility = ?, public_status = ?, updated_at = ? WHERE slug = ?', visibility, publicStatus, now(), slug);
    if (memberIds) setMembers(slug, memberIds);
  });
  if (visibility === 'public' && app.public_status !== 'pending' && getApp(slug)!.public_status === 'pending') publicRequested(getApp(slug)!, user);
}

export function updateApp(user: User, slug: string, patch: {
  name?: string; description?: string; localized?: LocalizedMap; iconSvg?: string; iconPngBase64?: string; removeIcon?: boolean;
  relatedSkill?: string | null;
}) {
  const app = requireManageable(slug, user);
  if (patch.relatedSkill !== undefined) linkSkill(user, slug, patch.relatedSkill);
  const icon = patch.iconSvg || patch.iconPngBase64 ? saveIcon(slug, { svg: patch.iconSvg, pngBase64: patch.iconPngBase64 }) : undefined;
  const i18n = mergeLocalized(app.i18n, patch.localized);
  run(
    `UPDATE apps SET name = COALESCE(?, name), description = COALESCE(?, description), i18n = ?,
       icon = CASE WHEN ? THEN NULL ELSE COALESCE(?, icon) END, updated_at = ? WHERE slug = ?`,
    patch.name?.trim() || null, patch.description ?? null, i18n, patch.removeIcon ? 1 : 0, icon ?? null, now(), slug,
  );
  return { missingLanguages: missingLocales(i18n) };
}

function readEnv(slug: string): Record<string, string> {
  const enc = getApp(slug)?.env_enc;
  return enc ? (JSON.parse(decrypt(enc)) as Record<string, string>) : {};
}

/** Merges env vars; a null value deletes the key. Takes effect on next restart/publish. */
export function setEnv(user: User, slug: string, vars: Record<string, string | null>) {
  requireManageable(slug, user);
  const env = readEnv(slug);
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new UserError('err.app.envNameInvalid', { name: k });
    if (v === null) delete env[k];
    else env[k] = v;
  }
  run('UPDATE apps SET env_enc = ?, updated_at = ? WHERE slug = ?', encrypt(JSON.stringify(env)), now(), slug);
  return Object.keys(env);
}

export async function restartApp(user: User, slug: string) {
  const app = requireManageable(slug, user);
  if (app.kind !== 'container' || !app.current_release) throw new UserError('err.app.restartOnlyContainer');
  if (busy.has(slug)) throw new UserError('err.app.busy', { slug });
  const candidate = await docker.startCandidate(slug, `${docker.containerName(slug)}:v${app.current_release}`, app.container_port, readEnv(slug), () => {});
  if (!(await docker.waitForHttp(candidate))) {
    const logs = await docker.candidateLogs(slug);
    await docker.removeCandidate(slug);
    throw new UserError('err.app.restartFailed', { logs: logs.slice(-1500) });
  }
  const upstream = await docker.promoteCandidate(slug, app.container_port, candidate);
  run("UPDATE apps SET status = 'online', upstream = ?, updated_at = ? WHERE slug = ?", upstream, now(), slug);
}

export async function setRunning(user: User, slug: string, running: boolean) {
  const app = requireManageable(slug, user);
  if (app.kind === 'container') {
    if (running) {
      await docker.startContainer(slug);
      if (app.upstream) await docker.waitForHttp(app.upstream, 30_000);
    }
    else await docker.stopContainer(slug);
  }
  run('UPDATE apps SET status = ?, updated_at = ? WHERE slug = ?', running ? 'online' : 'stopped', now(), slug);
}

export async function deleteApp(user: User, slug: string) {
  requireManageable(slug, user);
  if (busy.has(slug)) throw new UserError('err.app.busy', { slug });
  busy.add(slug);
  try {
    // always clean docker: the app may have been a container in an earlier release
    await docker.removeContainer(slug);
    await docker.removeImages(slug);
    run('DELETE FROM apps WHERE slug = ?', slug);
    rmSync(path.join(paths.apps, slug), { recursive: true, force: true });
    // the persistent /data must not be inherited by whoever reuses this slug
    rmSync(path.join(paths.appData, slug), { recursive: true, force: true });
  } finally {
    busy.delete(slug);
  }
}

export function transferApp(user: User, slug: string, newOwnerId: string) {
  requireManageable(slug, user);
  if (!get('SELECT 1 FROM users WHERE id = ?', newOwnerId)) throw new UserError('err.app.transferUserNotFound');
  run('UPDATE apps SET owner_id = ?, updated_at = ? WHERE slug = ?', newOwnerId, now(), slug);
}

export async function appStatus(user: User, slug: string, locale: string) {
  const app = requireManageable(slug, user);
  const releases = all<{ version: number; status: string; log: string; created_at: number }>(
    'SELECT version, status, log, created_at FROM app_releases WHERE app_slug = ? ORDER BY version DESC LIMIT 5', slug,
  );
  const runtimeLogs = app.kind === 'container' && app.status === 'online' ? await docker.containerLogs(slug, 50) : undefined;
  return { app: serializeApp(app, user, locale), releases, runtimeLogs };
}

export function staticRoot(app: App): string | undefined {
  if (!app.current_release) return undefined;
  const rel = get<{ root: string | null }>('SELECT root FROM app_releases WHERE app_slug = ? AND version = ?', app.slug, app.current_release);
  if (!rel?.root) return undefined;
  const dir = path.resolve(releaseDir(app.slug, app.current_release), rel.root);
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : undefined;
}

function relatedSkill(skillSlug: string | null, locale: string) {
  if (!skillSlug) return null;
  const sk = get<{ slug: string; name: string; description: string; i18n: string | null; icon: string | null }>('SELECT slug, name, description, i18n, icon FROM skills WHERE slug = ?', skillSlug);
  return sk ? { slug: sk.slug, name: localize(sk, sk.i18n, locale).name, icon: sk.icon ? `${config.hubUrl}/icons/${sk.icon}` : null } : null;
}

/** App as shown to `viewer`, with name and description in `locale`. */
export function serializeApp(app: App, viewer: User, locale: string, usage?: Map<string, number>) {
  const owner = get<User>('SELECT id, name, avatar FROM users WHERE id = ?', app.owner_id);
  const manageable = canManageApp(app, viewer);
  const text = localize(app, app.i18n, locale);
  return {
    slug: app.slug,
    name: text.name,
    description: text.description,
    localized: manageable ? parseLocalized(app.i18n) : undefined,
    relatedSkill: relatedSkill(app.skill_slug, locale),
    icon: app.icon ? `${config.hubUrl}/icons/${app.icon}` : null,
    url: appUrl(app.slug),
    host: `${app.slug}.${config.appsDomain}`,
    kind: app.kind,
    visibility: app.visibility,
    publicStatus: app.public_status,
    status: app.status,
    version: app.current_release,
    owner: owner ? { id: owner.id, name: owner.name, avatar: owner.avatar } : null,
    canManage: manageable,
    canOpen: canAccessApp(app, viewer),
    members: manageable
      ? all<{ id: string; name: string; avatar: string | null }>('SELECT u.id, u.name, u.avatar FROM app_members m JOIN users u ON u.id = m.user_id WHERE m.app_slug = ?', app.slug)
      : undefined,
    envKeys: manageable ? Object.keys(readEnv(app.slug)) : undefined,
    updatedAt: app.updated_at,
    /** listed in the last 7 days */
    isNew: now() - app.created_at < 7 * 86_400_000,
    /** colleagues (not the owner) who opened it in the last 30 days */
    usage30: usage?.get(app.slug) ?? usageBySlug().get(app.slug) ?? 0,
    openFeedback: manageable ? openFeedbackCount(app.slug) : undefined,
  };
}

export function listAppsFor(user: User, locale: string) {
  const usage = usageBySlug();
  return all<App>('SELECT * FROM apps ORDER BY updated_at DESC')
    .filter((a) => canAccessApp(a, user) || canManageApp(a, user))
    .map((a) => serializeApp(a, user, locale, usage));
}
