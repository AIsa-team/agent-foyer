/**
 * Source snapshots of an app, so whoever looks after it (owner, collaborators, admins) can get the code of the live
 * version on any machine and carry on from there. A container app keeps what it was built from; an app published as
 * a build (static) keeps the project folder its agent passes as source. Uploads that look like they hold secrets are
 * never kept.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import { config, paths } from '../config.ts';
import { signToken } from '../crypto.ts';
import type { App } from '../db.ts';
import { UserError } from '../i18n/index.ts';

const KEEP = 3;
const SCAN_BYTES = 512 * 1024;

const sourceDir = (slug: string) => path.join(paths.apps, slug, 'source');
export const sourceFile = (slug: string, version: number) => path.join(sourceDir(slug), `${version}.tgz`);

// files that hold secrets by their name, and secrets recognisable in text
const SECRET_NAMES = [/^\.env(\.(?!example$|sample$|template$)[\w.-]+)?$/, /\.pem$/, /\.p12$/, /\.pfx$/, /^id_(rsa|ed25519|ecdsa|dsa)$/, /^\.npmrc$/, /^\.netrc$/, /^credentials\.json$/, /^service-account.*\.json$/];
const SECRET_TEXT = [
  /-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{32,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

/** Paths in the tarball that look like secrets (by name, or by content in the first part of small text files). */
export async function findSecrets(file: string): Promise<string[]> {
  const found = new Set<string>();
  await tar.t({
    file,
    onReadEntry: (entry) => {
      const p = entry.path.replace(/^\.\//, '');
      if (entry.type !== 'File' && entry.type !== 'OldFile') return entry.resume();
      if (p.split('/').includes('node_modules')) return entry.resume();
      if (SECRET_NAMES.some((re) => re.test(path.posix.basename(p)))) found.add(p);
      if ((entry.size ?? 0) > SCAN_BYTES) return entry.resume();
      const chunks: Buffer[] = [];
      entry.on('data', (c: Buffer) => chunks.push(c));
      entry.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.includes('\u0000') && SECRET_TEXT.some((re) => re.test(text))) found.add(p);
      });
    },
  });
  return [...found].sort();
}

/** Rejects a source upload with secrets in it, naming the files. */
export async function checkSource(file: string) {
  const secrets = await findSecrets(file);
  if (secrets.length) throw new UserError('err.source.secrets', { files: secrets.slice(0, 10).join(', ') });
}

/** Keeps the tarball as the source of this version, and only the last few. */
export function keepSource(slug: string, version: number, file: string) {
  mkdirSync(sourceDir(slug), { recursive: true });
  copyFileSync(file, sourceFile(slug, version));
  const versions = sourceVersions(slug);
  for (const v of versions.slice(KEEP)) rmSync(sourceFile(slug, v), { force: true });
}

/** Versions with a kept source, newest first. */
export function sourceVersions(slug: string): number[] {
  if (!existsSync(sourceDir(slug))) return [];
  return readdirSync(sourceDir(slug)).map((f) => Number(f.match(/^(\d+)\.tgz$/)?.[1])).filter(Boolean).sort((a, b) => b - a);
}

/** A download command for the source of the live version (or the newest kept one if the live one has none). */
export function sourceDownload(app: App) {
  const versions = sourceVersions(app.slug);
  const version = versions.includes(app.current_release ?? 0) ? app.current_release! : versions[0];
  if (!version) throw new UserError(app.kind === 'container' ? 'err.source.noneContainer' : 'err.source.none', { slug: app.slug });
  const url = `${config.hubUrl}/apps-source/${app.slug}/v${version}.tgz?t=${signToken(`source:${app.slug}:${version}`, 15 * 60 * 1000)}`;
  return {
    slug: app.slug,
    version,
    live: version === app.current_release,
    download_url: url,
    command: `mkdir -p <FOLDER> && curl -fsSL "${url}" | tar -xz -C <FOLDER>`,
    command_windows_powershell: `$f = "$env:TEMP\\${app.slug}-src.tgz"; New-Item -ItemType Directory -Force "<FOLDER>" | Out-Null; curl.exe -fsSL "${url}" -o $f; tar.exe -xzf $f -C "<FOLDER>"; Remove-Item $f`,
    note: 'Replace <FOLDER> with an empty folder. The link works for 15 minutes. Secrets were never uploaded: set them again with set_app_env if needed.',
  };
}
