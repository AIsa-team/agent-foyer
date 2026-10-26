/**
 * Admin CLI for the hub operator: publish an app or a Skill from a folder on the server, as a given user.
 * Runs inside the hub container (it uses the same database and publishing code as the MCP tools):
 *
 *   docker exec agent-foyer node scripts/admin.ts publish-app /tmp/site --owner you@example.com --slug brand \
 *     --kind static --visibility company --localized '{"zh-CN":{"name":"…","description":"…"},"en":{…}}' [--icon icon.svg]
 *   docker exec agent-foyer node scripts/admin.ts publish-skill /tmp/skill --owner you@example.com --localized '{…}' [--notes "…"] [--icon i.svg] [--related-app slug]
 * publish-app also takes [--related-skill slug].
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as tar from 'tar';
import { get, run, type User } from '../server/db.ts';
import { createUpload, uploadFile } from '../server/uploads.ts';
import { publishApp, type Visibility } from '../server/apps/service.ts';
import { publishSkill } from '../server/skills/service.ts';
import { tr, UserError } from '../server/i18n/index.ts';

const [command, dir, ...rest] = process.argv.slice(2);
const { values: opt } = parseArgs({
  args: rest,
  options: {
    owner: { type: 'string' },
    slug: { type: 'string' },
    kind: { type: 'string', default: 'static' },
    visibility: { type: 'string', default: 'company' },
    localized: { type: 'string' },
    icon: { type: 'string' },
    'static-dir': { type: 'string' },
    notes: { type: 'string' },
    'related-skill': { type: 'string' },
    'related-app': { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!command || !dir || !['publish-app', 'publish-skill'].includes(command)) fail('usage: admin.ts publish-app|publish-skill <dir> --owner <email|open_id> [...]');
const owner = get<User>('SELECT * FROM users WHERE id = ? OR lower(email) = lower(?)', opt.owner ?? '', opt.owner ?? '');
if (!owner) fail(`no user ${opt.owner}`);
const localized = opt.localized ? JSON.parse(opt.localized) : undefined;

/** Packs the folder into an upload exactly as an agent's curl upload would. */
async function uploadFolder(purpose: 'app' | 'skill'): Promise<string> {
  const up = createUpload(owner!.id, purpose);
  await tar.c({ gzip: true, file: uploadFile(up.id), cwd: dir, portable: true }, ['.']);
  run("UPDATE uploads SET status = 'received' WHERE id = ?", up.id);
  return up.id;
}

try {
  if (command === 'publish-app') {
    if (!opt.slug) fail('--slug is required');
    const icon = opt.icon ? readFileSync(opt.icon) : undefined;
    const result = await publishApp(owner, {
      uploadId: await uploadFolder('app'),
      slug: opt.slug,
      kind: opt.kind as 'static' | 'container',
      visibility: opt.visibility as Visibility,
      localized,
      staticDir: opt['static-dir'],
      iconSvg: icon && opt.icon!.endsWith('.svg') ? icon.toString('utf8') : undefined,
      iconPngBase64: icon && opt.icon!.endsWith('.png') ? icon.toString('base64') : undefined,
      relatedSkill: opt['related-skill'],
    });
    console.log(JSON.stringify({ ...result, notes: result.notes.map((m) => tr('en', m.key, m.params)) }, null, 2));
  } else {
    const icon = opt.icon ? readFileSync(opt.icon) : undefined;
    const result = await publishSkill(owner, {
      uploadId: await uploadFolder('skill'), localized, notes: opt.notes, relatedApp: opt['related-app'],
      iconSvg: icon && opt.icon!.endsWith('.svg') ? icon.toString('utf8') : undefined,
      iconPngBase64: icon && opt.icon!.endsWith('.png') ? icon.toString('base64') : undefined,
    });
    console.log(JSON.stringify({ ...result, notes: result.notes.map((m) => tr('en', m.key, m.params)) }, null, 2));
  }
  process.exit(0);
} catch (e) {
  fail(e instanceof UserError ? e.localized('en') : String(e));
}
