/**
 * Files in Lark's Drive and wiki, as the person: reading one (e.g. an HTML page someone uploaded to the wiki, which Lark
 * shows as a web page) and putting one there (in their own space, a folder, or under a wiki page). Only upload and
 * download are asked for, never managing or deleting files. Files pass through the hub without being kept.
 */
import { readFileSync, rmSync } from 'node:fs';
import { config } from '../config.ts';
import { get, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { signToken, verifyToken } from '../crypto.ts';
import { DENIED_CODES, LarkError, SCOPE_CODES } from './client.ts';
import { larkLink, parseDocRef } from './docs.ts';
import { peekUpload, takeUpload } from '../uploads.ts';
import { asUser, userAccessToken } from './userToken.ts';
import type { FileRef } from './messages.ts';

/** Downloading files from Drive and the wiki; asked for the first time an agent reads one. */
export const DRIVE_READ_SCOPE = 'drive:file:readonly';
/** Uploading files, and finding the person's own Drive folder to put them in; asked for the first time an agent uploads one. */
export const DRIVE_WRITE_SCOPES = ['drive:file', 'drive:drive.metadata:readonly'];

const MAX_UPLOAD = 20 * 1024 * 1024;
const MAX_TEXT = 512 * 1024;
const LINK_MS = 10 * 60_000;
const TEXT_TYPES = new Set(['html', 'htm', 'md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'xml', 'svg', 'yaml', 'yml', 'css', 'js']);

const connectUrl = (write: boolean, wiki = false) => `${config.hubUrl}/auth/lark/connect?return=%2Fme&${write ? 'upload=1' : 'drive=1'}${wiki ? '&wiki=1' : ''}`;

/** Lark's refusals as messages the person can act on: a missing scope comes with the link that asks for it. */
function refusal(e: unknown, write: boolean, wiki = false) {
  if (e instanceof LarkError && SCOPE_CODES.has(e.code)) return new UserError(write ? 'err.files.uploadScope' : 'err.files.readScope', { url: connectUrl(write, wiki), detail: e.message });
  if (e instanceof LarkError && DENIED_CODES.has(e.code)) return new UserError('err.docs.denied');
  return e;
}

const call = <T>(user: User, path: string, init: RequestInit | undefined, wiki = false) =>
  asUser<T>(user, path, init).catch((e) => { throw refusal(e, true, wiki); });

const extOf = (name: string) => (name.includes('.') ? name.toLowerCase().split('.').pop()! : '');
const nameFrom = (disposition: string | null) => {
  const m = disposition?.match(/filename\*=UTF-8''([^;]+)/i) ?? disposition?.match(/filename="?([^";]+)"?/i);
  try { return m ? decodeURIComponent(m[1]) : ''; } catch { return m?.[1] ?? ''; }
};

/** Fetches a file from Drive as the person; Lark answers JSON only when it refuses. */
async function download(userId: string, token: string): Promise<Response> {
  const res = await fetch(`${config.lark.apiBase}/drive/v1/files/${encodeURIComponent(token)}/download`, {
    headers: { authorization: `Bearer ${await userAccessToken({ id: userId })}` }, signal: AbortSignal.timeout(120_000),
  });
  if (res.ok && !(res.headers.get('content-type') ?? '').includes('application/json')) return res;
  const body = await res.json().catch(() => ({})) as { code?: number; msg?: string };
  throw new LarkError('/drive/v1/files/download', body.code ?? res.status, body.msg ?? `HTTP ${res.status}`);
}

/**
 * A file behind a Drive or wiki link: small text files (an HTML page, Markdown, CSV…) come back as text, anything else
 * as a download link valid 10 minutes. `name` is the wiki page's title when there is one.
 */
export async function readFile(user: User, token: string, name: string, url: string) {
  const res = await download(user.id, token).catch((e) => { throw refusal(e, false); });
  const file = name || nameFrom(res.headers.get('content-disposition')) || token;
  const bytes = Number(res.headers.get('content-length') ?? 0) || undefined;
  const type = res.headers.get('content-type') ?? '';
  const link = downloadLink(user, token, file);
  if ((TEXT_TYPES.has(extOf(file)) || /^text\/|json|xml/.test(type)) && (bytes ?? 0) <= MAX_TEXT) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length <= MAX_TEXT) return { title: file, url, file: { name: file, bytes: buf.length }, text: buf.toString('utf8'), download: link };
    return { title: file, url, file: { name: file, bytes: buf.length }, download: link, note: 'Too large to show as text: download it from the link (valid 10 minutes).' };
  }
  await res.body?.cancel();
  return { title: file, url, file: { name: file, ...(bytes ? { bytes } : {}) }, download: link, note: 'Download it from the link (valid 10 minutes), e.g. with curl -fsSLo <name> <link>.' };
}

// ---- a short-lived link that streams the file from Lark as the person, without keeping it ----
const linkPayload = (userId: string, token: string) => `drivefile:${userId}:${token}`;
function downloadLink(user: User, token: string, name: string) {
  const q = new URLSearchParams({ u: user.id, name, t: signToken(linkPayload(user.id, token), LINK_MS) });
  return `${config.hubUrl}/lark-drive-file/${encodeURIComponent(token)}?${q}`;
}

export async function fetchDriveFile(token: string, q: URLSearchParams): Promise<Response> {
  const userId = q.get('u') ?? '';
  if (!verifyToken(linkPayload(userId, token), q.get('t') ?? '')) return new Response('link expired, read the file again for a new one', { status: 403 });
  if (!get('SELECT 1 FROM users WHERE id = ?', userId)) return new Response('not found', { status: 404 });
  try {
    const res = await download(userId, token);
    const name = q.get('name') || nameFrom(res.headers.get('content-disposition')) || token;
    const headers = new Headers({
      'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    const length = res.headers.get('content-length');
    if (length) headers.set('content-length', length);
    return new Response(res.body, { headers });
  } catch (e) {
    return new Response(`Lark did not hand out this file: ${(e as Error).message}`, { status: 502 });
  }
}

// ---- putting a file into Drive or the wiki ----
interface WikiNode { node_token: string; space_id: string; obj_type: string }

/**
 * Uploads a file as the person: into a Drive folder, under a wiki page (uploaded to their own space first, then moved
 * there, where it takes the page's sharing), or into their own space. Returns its link.
 */
export async function uploadFile(user: User, file: FileRef, parent?: string) {
  const ref = parent?.trim() ? parseDocRef(parent) : null;
  if (ref && ref.kind !== 'wiki' && ref.kind !== 'folder') throw new UserError('err.files.badParent');
  const wiki = ref?.kind === 'wiki';
  const name = file.name.trim().replace(/[\\/]/g, '_').slice(0, 250) || 'file';
  const size = peekUpload(file.upload_id, user.id, 'file');
  if (size > MAX_UPLOAD) throw new UserError('err.files.tooBig', { mb: MAX_UPLOAD / 1024 / 1024 });
  // everything that can be refused is checked before the file goes up
  const under = wiki ? (await call<{ data: { node: WikiNode } }>(user, `/wiki/v2/spaces/get_node?token=${encodeURIComponent(ref.token)}`, undefined, true)).data.node : null;
  const folder = ref?.kind === 'folder' ? ref.token
    : (await call<{ data: { token: string } }>(user, '/drive/explorer/v2/root_folder/meta', undefined, wiki)).data.token;

  const path = takeUpload(file.upload_id, user.id, 'file');
  let token: string;
  try {
    const bytes = readFileSync(path);
    const form = new FormData();
    form.set('file_name', name);
    form.set('parent_type', 'explorer');
    form.set('parent_node', folder);
    form.set('size', String(bytes.length));
    form.set('file', new Blob([bytes]), name);
    token = (await call<{ data: { file_token: string } }>(user, '/drive/v1/files/upload_all', { method: 'POST', body: form }, wiki)).data.file_token;
  } finally {
    rmSync(path, { force: true });
  }
  if (!under) return { name, url: larkLink('file', token), place: ref ? 'folder' : 'my space' };

  // into the wiki: Lark moves it there, sometimes only after a moment
  const moved = (await call<{ data: { wiki_token?: string; task_id?: string } }>(user, `/wiki/v2/spaces/${under.space_id}/nodes/move_docs_to_wiki`, {
    method: 'POST', body: JSON.stringify({ parent_wiki_token: under.node_token, obj_type: 'file', obj_token: token }),
  }, true)).data;
  let node = moved.wiki_token;
  for (let i = 0; !node && moved.task_id && i < 10; i++) {
    await new Promise((ok) => setTimeout(ok, 1000));
    const r = (await call<{ data: { task: { move_result?: { node?: { node_token: string }; status: number; status_msg?: string }[] } } }>(user,
      `/wiki/v2/tasks/${encodeURIComponent(moved.task_id)}?task_type=move`, undefined, true)).data.task.move_result?.[0];
    if (r?.status === 0) node = r.node?.node_token;
    if (r?.status === -1) return { name, url: larkLink('file', token), place: 'my space', note: `Uploaded to the user's own space, but Lark did not move it under the wiki page: ${r.status_msg ?? 'failed'}.` };
  }
  if (!node) return { name, url: larkLink('file', token), place: 'my space', note: 'Uploaded; Lark is still moving it under the wiki page. It shows up there in a moment.' };
  return { name, url: larkLink('wiki', node), place: 'wiki' };
}
