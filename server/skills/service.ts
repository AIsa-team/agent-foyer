import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import { config, paths } from '../config.ts';
import { signToken } from '../crypto.ts';
import { all, get, now, run, tx, type Skill, type User } from '../db.ts';
import { UserError, type Msg } from '../i18n/index.ts';
import { localize, mergeLocalized, missingLocales, parseLocalized, type LocalizedMap } from '../localized.ts';
import { linkSkill, saveIcon } from '../apps/service.ts';
import { canAccessApp } from '../apps/access.ts';
import { appUrl } from '../config.ts';
import type { App } from '../db.ts';
import { extractTarball, takeUpload } from '../uploads.ts';
import { collaboratingOn, collaboratorsOf, isCollaborator } from '../collab.ts';

/** Publish versions, change the listing, handle feedback: the owner, collaborators and admins. */
export const canManageSkill = (s: Skill, user: User) => s.owner_id === user.id || user.role === 'admin' || isCollaborator('skill', s.slug, user.id);

const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const skillFile = (slug: string, version: number) => path.join(paths.skills, slug, `v${version}.tgz`);

/** Reads `name` and `description` from SKILL.md YAML frontmatter (simple key: value lines). */
function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const out: Record<string, string> = {};
  if (!m) return out;
  let key = '';
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      out[key] = kv[2].replace(/^["']|["']$/g, '').trim();
    } else if (key && /^\s+/.test(line)) {
      out[key] = (out[key] + ' ' + line.trim()).trim();
    }
  }
  if (out.description === '>' || out.description === '|') out.description = '';
  return out;
}

function findSkillRoot(dir: string): string {
  if (existsSync(path.join(dir, 'SKILL.md'))) return dir;
  const entries = readdirSync(dir).filter((e) => !e.startsWith('.') && e !== '__MACOSX');
  if (entries.length === 1 && statSync(path.join(dir, entries[0])).isDirectory() && existsSync(path.join(dir, entries[0], 'SKILL.md'))) {
    return path.join(dir, entries[0]);
  }
  throw new UserError('err.skill.noSkillMd');
}

const publishing = new Set<string>();

export async function publishSkill(user: User, input: {
  uploadId: string; displayName?: string; description?: string; notes?: string; localized?: LocalizedMap;
  iconSvg?: string; iconPngBase64?: string; relatedApp?: string | null;
}) {
  const file = takeUpload(input.uploadId, user.id, 'skill');
  const tmp = mkdtempSync(path.join(paths.uploads, 'skill-'));
  let lockedSlug: string | undefined;
  try {
    await extractTarball(file, tmp);
    const root = findSkillRoot(tmp);
    const fm = parseFrontmatter(readFileSync(path.join(root, 'SKILL.md'), 'utf8'));
    const slug = (fm.name ?? '').toLowerCase();
    if (!SKILL_SLUG_RE.test(slug)) throw new UserError('err.skill.badName');
    if (publishing.has(slug)) throw new UserError('err.skill.busy', { slug });
    publishing.add(slug);
    lockedSlug = slug;
    const existing = get<Skill>('SELECT * FROM skills WHERE slug = ?', slug);
    if (existing && !canManageSkill(existing, user)) throw new UserError('err.skill.ownedByOther', { slug });
    const version = (existing?.latest_version ?? 0) + 1;

    writeFileSync(path.join(root, '.hub-skill.json'), JSON.stringify({ slug, version, hub: config.hubUrl }, null, 2));
    mkdirSync(path.join(paths.skills, slug), { recursive: true });
    const files = readdirSync(root).filter((e) => e !== '__MACOSX');
    await tar.c({ gzip: true, file: skillFile(slug, version), cwd: root, portable: true }, files);
    const size = statSync(skillFile(slug, version)).size;

    const i18n = mergeLocalized(existing?.i18n ?? null, input.localized);
    tx(() => {
      if (existing) {
        run('UPDATE skills SET latest_version = ?, description = COALESCE(?, description), name = COALESCE(?, name), i18n = ?, updated_at = ? WHERE slug = ?',
          version, input.description ?? fm.description ?? null, input.displayName ?? null, i18n, now(), slug);
      } else {
        run('INSERT INTO skills (slug, name, description, owner_id, latest_version, i18n, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          slug, input.displayName ?? slug, input.description ?? fm.description ?? '', user.id, version, i18n, now(), now());
      }
      run('INSERT INTO skill_versions (skill_slug, version, size, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', slug, version, size, input.notes ?? '', user.id, now());
      // the publisher already has this version locally
      recordInstall(user.id, slug, version);
    });
    if (input.iconSvg || input.iconPngBase64) setSkillIcon(slug, saveIcon(slug, { svg: input.iconSvg, pngBase64: input.iconPngBase64 }));
    if (input.relatedApp !== undefined) setRelatedApp(user, slug, input.relatedApp);
    const missing = missingLocales(i18n);
    const notes: Msg[] = missing.length ? [{ key: 'note.missingTranslations', params: { locales: missing.join(', '), tool: 'update_skill' } }] : [];
    return { slug, version, notes };
  } finally {
    if (lockedSlug) publishing.delete(lockedSlug);
    rmSync(tmp, { recursive: true, force: true });
  }
}

function recordInstall(userId: string, slug: string, version: number) {
  run(
    `INSERT INTO skill_installs (skill_slug, user_id, version, installed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(skill_slug, user_id) DO UPDATE SET version = excluded.version, installed_at = excluded.installed_at`,
    slug, userId, version, now(),
  );
}

/** Where agents read Skills from, relative to the home folder. */
const SKILL_DIRS: [string, string][] = [['Claude Code', '.claude/skills'], ['Codex', '.codex/skills']];

export function installInstructions(user: User, slug: string) {
  const skill = get<Skill>('SELECT * FROM skills WHERE slug = ?', slug);
  if (!skill || (!skill.listed && !canManageSkill(skill, user))) throw new UserError('err.skill.notFound', { slug });
  const v = skill.latest_version;
  const url = `${config.hubUrl}/skills/${slug}/v${v}.tgz?t=${signToken(`skill:${slug}:${v}`, 15 * 60 * 1000)}`;
  recordInstall(user.id, slug, v);
  return {
    slug,
    name: skill.name,
    version: v,
    download_url: url,
    install: [
      'Run the command for the agent you are (it replaces any older copy). Other agents: the same with their documented skills folder.',
      '',
      ...SKILL_DIRS.flatMap(([agent, dir]) => [
        `${agent} — macOS / Linux / Git Bash:`,
        `DIR=~/${dir}/${slug}; rm -rf "$DIR" && mkdir -p "$DIR" && curl -fsSL "${url}" | tar -xz -C "$DIR"`,
        `${agent} — Windows PowerShell (tar.exe and curl.exe ship with Windows 10+):`,
        `$d = "$env:USERPROFILE\\${dir.replace('/', '\\')}\\${slug}"; $f = "$env:TEMP\\${slug}.tgz"; Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $d | Out-Null; curl.exe -fsSL "${url}" -o $f; tar.exe -xzf $f -C $d; Remove-Item $f`,
        '',
      ]),
      'The folder contains .hub-skill.json with the installed version; pass it to check_skill_updates later.',
    ].join('\n'),
  };
}

/** A Skill version's files (path → contents), read from its archive once and kept: versions never change. */
const contents = new Map<string, Map<string, Buffer>>();
export async function skillContents(slug: string, version: number): Promise<Map<string, Buffer>> {
  const key = `${slug}@${version}`;
  const hit = contents.get(key);
  if (hit) return hit;
  const files = new Map<string, Buffer>();
  await tar.t({
    file: skillFile(slug, version),
    onReadEntry: (entry) => {
      const name = entry.path.replace(/^\.\//, '');
      if (entry.type !== 'File' || name === '.hub-skill.json') return entry.resume();
      const parts: Buffer[] = [];
      entry.on('data', (d: Buffer) => parts.push(d));
      entry.on('end', () => files.set(name, Buffer.concat(parts)));
    },
  });
  if (contents.size > 50) contents.delete(contents.keys().next().value!);
  contents.set(key, files);
  return files;
}

const TEXT_LIMIT = 200_000;

/**
 * A Skill read rather than installed, for agents that cannot install Skills (hosted agents, scheduled tasks): its
 * SKILL.md and the list of its other files, or one of those files. Always the latest version. `ref` is the Skill's
 * name in the market (slug) or its display name.
 */
export async function readSkill(user: User, locale: string, ref: string, file?: string) {
  const want = ref.trim().toLowerCase();
  const visible = listSkills(user, locale);
  const s = visible.find((x) => x.slug === want) ?? visible.find((x) => x.name.trim().toLowerCase() === want);
  if (!s) throw new UserError('err.skill.notFound', { slug: ref });
  const files = await skillContents(s.slug, s.version);
  const text = (b: Buffer) => {
    const t = b.toString('utf8');
    return t.includes('�') || t.includes('\u0000') ? null : t;
  };
  if (file) {
    const name = file.replace(/^\.?\//, '');
    const b = files.get(name);
    if (!b) throw new UserError('err.skill.noFile', { file, slug: s.slug });
    const t = text(b);
    if (t === null) throw new UserError('err.skill.binaryFile', { file: name });
    if (b.length > TEXT_LIMIT) throw new UserError('err.skill.fileTooBig', { file: name });
    return { slug: s.slug, version: s.version, file: name, content: t };
  }
  const md = files.get('SKILL.md');
  return {
    slug: s.slug, name: s.name, version: s.version, description: s.description,
    instructions: md ? md.toString('utf8') : '',
    files: [...files.entries()].filter(([n]) => n !== 'SKILL.md').map(([n, b]) => ({ path: n, size: b.length, text: text(b) !== null })),
  };
}

export function checkUpdates(user: User, installed: { slug: string; version: number }[]) {
  const updates: { slug: string; name: string; installed: number; latest: number }[] = [];
  for (const i of installed) {
    const s = get<Skill>('SELECT * FROM skills WHERE slug = ?', i.slug);
    if (!s) continue;
    recordInstall(user.id, s.slug, i.version);
    if (s.latest_version > i.version) updates.push({ slug: s.slug, name: s.name, installed: i.version, latest: s.latest_version });
  }
  return updates;
}

export function requireManageableSkill(user: User, slug: string): Skill {
  const s = get<Skill>('SELECT * FROM skills WHERE slug = ?', slug);
  if (!s) throw new UserError('err.skill.notFound', { slug });
  if (!canManageSkill(s, user)) throw new UserError('err.skill.ownerOnly');
  return s;
}

const setSkillIcon = (slug: string, file: string | null) => run('UPDATE skills SET icon = ?, updated_at = ? WHERE slug = ?', file, now(), slug);

/** Links this Skill to an app (you must be able to manage the app), or unlinks it (null). */
function setRelatedApp(user: User, slug: string, appSlug: string | null) {
  if (appSlug === null || appSlug === '') {
    run('UPDATE apps SET skill_slug = NULL WHERE skill_slug = ?', slug);
    return;
  }
  run('UPDATE apps SET skill_slug = NULL WHERE skill_slug = ? AND slug != ?', slug, appSlug);
  linkSkill(user, appSlug, slug);
}

export function updateSkill(user: User, slug: string, patch: {
  name?: string; description?: string; listed?: boolean; localized?: LocalizedMap;
  iconSvg?: string; iconPngBase64?: string; removeIcon?: boolean; relatedApp?: string | null;
}) {
  const skill = requireManageableSkill(user, slug);
  if (patch.iconSvg || patch.iconPngBase64) setSkillIcon(slug, saveIcon(slug, { svg: patch.iconSvg, pngBase64: patch.iconPngBase64 }));
  else if (patch.removeIcon) setSkillIcon(slug, null);
  if (patch.relatedApp !== undefined) setRelatedApp(user, slug, patch.relatedApp);
  const i18n = mergeLocalized(skill.i18n, patch.localized);
  run('UPDATE skills SET name = COALESCE(?, name), description = COALESCE(?, description), listed = COALESCE(?, listed), i18n = ?, updated_at = ? WHERE slug = ?',
    patch.name?.trim() || null, patch.description ?? null, patch.listed === undefined ? null : Number(patch.listed), i18n, now(), slug);
  return { missingLanguages: missingLocales(i18n) };
}

export function deleteSkill(user: User, slug: string) {
  const s = requireManageableSkill(user, slug);
  if (s.owner_id !== user.id && user.role !== 'admin') throw new UserError('err.collab.ownerOnlyDelete');
  run('DELETE FROM skills WHERE slug = ?', slug);
  rmSync(path.join(paths.skills, slug), { recursive: true, force: true });
}

/** Skills as shown to `viewer`, with market name and description in `locale`. */
export function listSkills(viewer: User, locale: string) {
  const rows = all<Skill & { owner_name: string; owner_avatar: string | null; installs: number; my_version: number | null }>(
    `SELECT s.*, u.name AS owner_name, u.avatar AS owner_avatar,
       (SELECT COUNT(*) FROM skill_installs i WHERE i.skill_slug = s.slug) AS installs,
       (SELECT version FROM skill_installs i WHERE i.skill_slug = s.slug AND i.user_id = ?) AS my_version
     FROM skills s JOIN users u ON u.id = s.owner_id
     WHERE s.listed = 1 OR s.owner_id = ? OR s.slug IN (SELECT slug FROM collaborators WHERE kind = 'skill' AND user_id = ?) ORDER BY s.updated_at DESC`,
    viewer.id, viewer.id, viewer.id,
  );
  const mine = collaboratingOn('skill', viewer.id);
  return rows.map((s) => ({
    slug: s.slug,
    ...localize(s, s.i18n, locale),
    icon: s.icon ? `${config.hubUrl}/icons/${s.icon}` : null,
    relatedApp: relatedApp(viewer, s.slug, locale),
    localized: s.owner_id === viewer.id || viewer.role === 'admin' || mine.has(s.slug) ? parseLocalized(s.i18n) : undefined,
    version: s.latest_version,
    listed: !!s.listed,
    owner: { id: s.owner_id, name: s.owner_name, avatar: s.owner_avatar },
    installs: s.installs,
    myVersion: s.my_version,
    hasUpdate: s.my_version !== null && s.my_version < s.latest_version,
    canManage: s.owner_id === viewer.id || viewer.role === 'admin' || mine.has(s.slug),
    /** may delete it, choose collaborators and hand it over */
    canAdminister: s.owner_id === viewer.id || viewer.role === 'admin',
    myRole: s.owner_id === viewer.id ? 'owner' as const : mine.has(s.slug) ? 'collaborator' as const : null,
    collaborators: collaboratorsOf('skill', s.slug).filter((c) => c.role === 'collaborator'),
    updatedAt: s.updated_at,
  }));
}

function relatedApp(viewer: User, skillSlug: string, locale: string) {
  const app = get<App>('SELECT * FROM apps WHERE skill_slug = ?', skillSlug);
  if (!app) return null;
  return { slug: app.slug, name: localize(app, app.i18n, locale).name, url: appUrl(app.slug), canOpen: canAccessApp(app, viewer), icon: app.icon ? `${config.hubUrl}/icons/${app.icon}` : null };
}

export function skillVersions(slug: string) {
  return all<{ version: number; size: number; notes: string; created_at: number }>(
    'SELECT version, size, notes, created_at FROM skill_versions WHERE skill_slug = ? ORDER BY version DESC', slug,
  );
}
