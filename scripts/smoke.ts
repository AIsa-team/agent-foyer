/**
 * End-to-end smoke test against a running hub in dev-login mode:
 * OAuth (DCR + PKCE) → MCP tools → upload → publish static app → app subdomain login & access rules → skills.
 * Usage: node scripts/smoke.ts [hubUrl]
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HUB = process.argv[2] ?? 'http://localhost:8080';
const hubPort = new URL(HUB).port;
let failed = 0;
const check = (ok: unknown, label: string) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed++;
};

class Jar {
  cookies = new Map<string, string>();
  store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }
  header() {
    return [...this.cookies].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function devLogin(userId: string): Promise<Jar> {
  const jar = new Jar();
  const res = await fetch(`${HUB}/auth/dev-login`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ user: userId, return: '/' }),
  });
  jar.store(res);
  return jar;
}

async function connectAgent(jar: Jar, name: string): Promise<string> {
  const redirect = 'http://localhost:33418/callback';
  const reg = await (await fetch(`${HUB}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }),
  })).json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });
  const consent = await fetch(`${HUB}/oauth/authorize?${q}`, { headers: { cookie: jar.header() } });
  const consentHtml = await consent.text();
  check(consent.status === 200 && consentHtml.includes(name), `consent page shows ${name}`);
  const csrf = /name="csrf" value="([^"]+)"/.exec(consentHtml)![1];
  const forged = await fetch(`${HUB}/oauth/authorize?${q}`, {
    method: 'POST', redirect: 'manual', headers: { cookie: jar.header() }, body: new URLSearchParams({ decision: 'allow' }),
  });
  check(forged.status === 403, 'consent without CSRF token rejected');
  const allow = await fetch(`${HUB}/oauth/authorize?${q}`, {
    method: 'POST', redirect: 'manual', headers: { cookie: jar.header() }, body: new URLSearchParams({ decision: 'allow', csrf }),
  });
  const code = new URL(allow.headers.get('location')!).searchParams.get('code')!;
  const tok = await (await fetch(`${HUB}/oauth/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: reg.client_id, code, redirect_uri: redirect, code_verifier: verifier }),
  })).json() as { access_token: string; refresh_token: string };
  check(tok.access_token?.startsWith('hub_at_'), 'token exchange with PKCE');
  const refreshed = await (await fetch(`${HUB}/oauth/token`, {
    method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: reg.client_id, refresh_token: tok.refresh_token }),
  })).json() as { access_token: string };
  check(refreshed.access_token?.startsWith('hub_at_'), 'refresh token rotation');
  return refreshed.access_token;
}

let rpcId = 0;
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${HUB}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json() as { result: { content: { text: string }[]; isError?: boolean } };
  const text = body.result.content[0].text;
  if (body.result.isError) return { error: text };
  return JSON.parse(text);
}

async function upload(token: string, purpose: 'app' | 'skill', folder: string) {
  const up = await tool(token, 'create_upload', { purpose });
  const cmd = (up.command as string).replace('<FOLDER>', folder);
  execFileSync('sh', ['-c', cmd]);
  return up.upload_id as string;
}

/** Request to an app subdomain. fetch() drops a custom Host header, so use node:http directly. */
function appFetch(slug: string, p: string, jar?: Jar, extra: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: hubPort, path: p, headers: { ...extra, host: `${slug}.apps.localhost:${hubPort}`, cookie: jar?.header() ?? '' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const x of [v ?? []].flat()) headers.append(k, x);
        resolve(new Response(res.statusCode === 304 ? null : Buffer.concat(chunks), { status: res.statusCode, headers }));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Follows the hub → app login handoff as a browser would. */
async function loginToApp(slug: string, hubJar: Jar): Promise<{ jar: Jar; status: number }> {
  const appJar = new Jar();
  const first = await appFetch(slug, '/');
  const toHub = first.headers.get('location')!;
  const hubRes = await fetch(toHub, { redirect: 'manual', headers: { cookie: hubJar.header() } });
  if (hubRes.status !== 302) return { jar: appJar, status: hubRes.status };
  const cb = new URL(hubRes.headers.get('location')!);
  const cbRes = await appFetch(slug, cb.pathname + cb.search);
  appJar.store(cbRes);
  return { jar: appJar, status: cbRes.status };
}

/** The hub's "no access" page for an app, as a visitor with the given Accept-Language sees it. */
async function loginToAppStatusPage(slug: string, hubJar: Jar, lang: string) {
  return fetch(`${HUB}/auth/app?app=${slug}&return=%2F`, { redirect: 'manual', headers: { cookie: hubJar.header(), 'accept-language': lang } });
}

// ---------------------------------------------------------------
const alex = await devLogin('ou_dev_alex');
const alice = await devLogin('ou_dev_alice');
const me = await (await fetch(`${HUB}/api/me`, { headers: { cookie: alex.header() } })).json() as { user: { role: string } };
check(me.user.role === 'admin', 'first user is admin');

const token = await connectAgent(alex, 'Claude Code');
const who = await tool(token, 'whoami');
check(who.user?.name === 'Alex', 'MCP whoami');

const evil = await fetch(`${HUB}/oauth/register`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'x', redirect_uris: ['x:</script><script>alert(1)</script>'] }),
});
check(evil.status === 400, 'markup in redirect_uri rejected');
const tabRedirect = await fetch(`${HUB}/auth/dev-login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ user: 'ou_dev_alex', return: '/\t/evil.com' }) });
check(tabRedirect.headers.get('location') === '/', 'tab-smuggled return path neutralised');

const site = mkdtempSync(path.join(tmpdir(), 'site-'));
mkdirSync(path.join(site, 'dist/assets'), { recursive: true });
writeFileSync(path.join(site, 'dist/index.html'), '<!doctype html><title>Demo</title><h1>hello hub</h1>');
writeFileSync(path.join(site, 'dist/assets/app.js'), 'console.log(1)');
writeFileSync(path.join(site, 'package.json'), '{}');

check((await tool(token, 'check_slug', { slug: 'hub' })).ok === false, 'reserved slug rejected');
const pub = await tool(token, 'publish_app', {
  upload_id: await upload(token, 'app', site), slug: 'demo', kind: 'static', name: '演示应用', description: '冒烟测试',
  visibility: 'members', members: ['alice@example.com'],
  icon_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" rx="2"/></svg>',
});
check(pub.status === 'online' && pub.url?.includes('demo.apps.localhost'), `publish static app → ${pub.url}`);

const anon = await appFetch('demo', '/');
check(anon.status === 302 && anon.headers.get('location')?.includes('/auth/app?app=demo'), 'anonymous visitor sent to hub login');

const aliceApp = await loginToApp('demo', alice);
check(aliceApp.status === 302, 'member alice gets app session');
const page = await appFetch('demo', '/some/spa/route', aliceApp.jar);
check(page.status === 200 && (await page.text()).includes('hello hub'), 'SPA fallback serves index.html');
{
  const etag = page.headers.get('etag') ?? '';
  const again = await appFetch('demo', '/anything', aliceApp.jar, { 'if-none-match': etag });
  check(page.headers.get('cache-control') === 'private, no-cache' && etag !== '' && again.status === 304, 'app files revalidate (ETag → 304) and stay out of shared caches');
}
const meRes = await (await appFetch('demo', '/__hub/me', aliceApp.jar)).json() as { name: string };
check(meRes.name === '林小雨', '/__hub/me returns the visitor');
check((await appFetch('demo', '/../../hub.db', aliceApp.jar)).status !== 200, 'path traversal blocked');
check((await appFetch('demo', '/%ZZ', aliceApp.jar)).status === 400, 'malformed path → 400');
const badCookie = new Jar();
badCookie.cookies.set('a', '%');
check((await appFetch('demo', '/', badCookie)).status === 302 && (await fetch(`${HUB}/healthz`)).ok, 'malformed cookie does not crash the hub');

const bob = await devLogin('ou_dev_bob');
check((await loginToApp('demo', bob)).status === 403, 'non-member bob is denied');

await tool(token, 'set_app_access', { slug: 'demo', visibility: 'private' });
check((await appFetch('demo', '/', aliceApp.jar)).status === 403, 'revoking access applies immediately to existing sessions');

// Skills
const skillDir = mkdtempSync(path.join(tmpdir(), 'skill-'));
writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: team-ppt\ndescription: 用公司模板做 PPT\n---\n# Team PPT\n');
const s1 = await tool(token, 'publish_skill', { upload_id: await upload(token, 'skill', skillDir), display_name: 'Team PPT' });
check(s1.version === 1, 'publish skill v1');
const aliceToken = await connectAgent(alice, 'Codex');
const inst = await tool(aliceToken, 'install_skill', { slug: 'team-ppt' });
const dest = mkdtempSync(path.join(tmpdir(), 'installed-'));
execFileSync('sh', ['-c', `curl -fsSL '${inst.download_url}' | tar -xz -C ${dest}`]);
check(execFileSync('cat', [path.join(dest, '.hub-skill.json')]).toString().includes('"version": 1'), 'install skill via download link');
const s2 = await tool(token, 'publish_skill', { upload_id: await upload(token, 'skill', skillDir), notes: 'v2' });
check(s2.version === 2, 'republish → v2');
const upd = await tool(aliceToken, 'check_skill_updates', { installed: [{ slug: 'team-ppt', version: 1 }] });
check(upd.updates?.[0]?.latest === 2, 'update detected for alice');
const other = await tool(aliceToken, 'publish_skill', { upload_id: await upload(aliceToken, 'skill', skillDir) });
check(typeof other.error === 'string', 'alice cannot overwrite alex\'s skill');

// i18n: API errors follow the UI locale header; MCP errors follow the locale saved for the user
const errIn = async (locale: string) => ((await (await fetch(`${HUB}/api/apps/nope`, { headers: { cookie: alex.header(), 'x-hub-locale': locale } })).json()) as { error: string }).error;
check((await errIn('zh-CN')).includes('不存在') && (await errIn('en')).includes('does not exist'), 'API errors follow the UI language');
await fetch(`${HUB}/api/me/locale`, { method: 'POST', headers: { cookie: alex.header(), 'content-type': 'application/json' }, body: '{"locale":"zh-CN"}' });
check(String((await tool(token, 'check_slug', { slug: 'hub' })).reason).includes('保留'), 'MCP replies in the language the user picked (zh-CN)');
await fetch(`${HUB}/api/me/locale`, { method: 'POST', headers: { cookie: alex.header(), 'content-type': 'application/json' }, body: '{"locale":"en"}' });
check(String((await tool(token, 'check_slug', { slug: 'hub' })).reason).includes('reserved'), 'MCP replies in the language the user picked (en)');
const deniedZh = await (await loginToAppStatusPage('demo', bob, 'zh-CN')).text();
check(deniedZh.includes('你还不能打开') && deniedZh.includes('lang="zh-CN"'), 'server pages follow Accept-Language');

// per-language listing text: agents pass every hub language; the UI shows the viewer's
const appsIn = async (locale: string) => ((await (await fetch(`${HUB}/api/apps`, { headers: { cookie: alex.header(), 'x-hub-locale': locale } })).json()) as { apps: { slug: string; name: string; description: string }[] }).apps;
const appUpd = await tool(token, 'update_app', { slug: 'demo', localized: { 'zh-CN': { name: '演示应用', description: '冒烟测试' }, en: { name: 'Demo app', description: 'Smoke test' } } });
check(Array.isArray(appUpd.missingLanguages) && appUpd.missingLanguages.length === 0, 'update_app accepts every hub language');
check((await appsIn('en')).find((a) => a.slug === 'demo')?.name === 'Demo app' && (await appsIn('zh-CN')).find((a) => a.slug === 'demo')?.name === '演示应用', 'app listing follows the viewer language');
check(typeof (await tool(token, 'update_app', { slug: 'demo', localized: { fr: { name: 'x' } } })).error === 'string', 'unsupported language rejected');
const skillUpd = await tool(token, 'update_skill', { slug: 'team-ppt', localized: { 'zh-CN': { name: '团队 PPT 模板' }, en: { name: 'Team slides' } } });
check(skillUpd.missingLanguages?.length === 2, 'update_skill reports languages still missing a description');
const skillsEn = ((await (await fetch(`${HUB}/api/skills`, { headers: { cookie: alex.header(), 'x-hub-locale': 'en' } })).json()) as { skills: { slug: string; name: string }[] }).skills;
check(skillsEn.find((x) => x.slug === 'team-ppt')?.name === 'Team slides', 'skill market name follows the viewer language');

// skill icons and the optional app ↔ Skill link
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
await tool(token, 'update_skill', { slug: 'team-ppt', icon_svg: ICON });
await tool(token, 'update_app', { slug: 'demo', related_skill: 'team-ppt' });
const skillView = ((await (await fetch(`${HUB}/api/skills`, { headers: { cookie: alex.header() } })).json()) as { skills: { slug: string; icon: string | null; relatedApp: { slug: string } | null }[] }).skills.find((x) => x.slug === 'team-ppt');
check(!!skillView?.icon && skillView.relatedApp?.slug === 'demo', 'skill icon + link visible from the Skill side');
const appView = ((await (await fetch(`${HUB}/api/apps/demo`, { headers: { cookie: alex.header() } })).json()) as { app: { relatedSkill: { slug: string } | null } }).app;
check(appView.relatedSkill?.slug === 'team-ppt', 'link visible from the app side');
check(typeof (await tool(aliceToken, 'update_skill', { slug: 'team-ppt', related_app: 'demo' })).error === 'string', 'non-owner cannot relink');
await tool(token, 'update_app', { slug: 'demo', related_skill: '' });
const unlinked = ((await (await fetch(`${HUB}/api/apps/demo`, { headers: { cookie: alex.header() } })).json()) as { app: { relatedSkill: unknown } }).app;
check(unlinked.relatedSkill === null, 'link removed');

// resources page: admins curate it (here through MCP), everyone reads it in their language
await tool(token, 'set_culture', { mission: { 'zh-CN': '一把钥匙', en: 'One key' } });
const libEn = await (await fetch(`${HUB}/api/library`, { headers: { cookie: alice.header(), 'x-hub-locale': 'en' } })).json() as { culture: { mission: string } };
check(libEn.culture.mission === 'One key', 'resources page shows culture in the viewer language');
check(typeof (await tool(aliceToken, 'set_culture', { mission: { en: 'hijack' } })).error === 'string', 'non-admin cannot edit the resources page');

const profile = await (await fetch(`${HUB}/api/profile`, { headers: { cookie: alex.header() } })).json() as { agents: { name: string }[] };
check(profile.agents.some((a) => a.name === 'Claude Code'), 'connected agent listed in profile');

if (process.argv.includes('--docker')) {
  const proj = mkdtempSync(path.join(tmpdir(), 'svc-'));
  writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'svc', scripts: { start: 'node server.js' } }));
  writeFileSync(path.join(proj, 'server.js'), `require('http').createServer((q, r) => r.end(JSON.stringify({ user: decodeURIComponent(q.headers['x-hub-user-name'] || ''), key: process.env.SECRET_KEY || null, spoof: q.headers['x-hub-evil'] || null }))).listen(process.env.PORT, '0.0.0.0')`);
  const c = await tool(token, 'publish_app', { upload_id: await upload(token, 'app', proj), slug: 'svc-test', kind: 'container', name: '容器测试', visibility: 'company' });
  check(c.status === 'online', `publish container app (${c.status}) ${c.notes?.join(' ') ?? c.error ?? ''}`);
  await tool(token, 'set_app_env', { slug: 'svc-test', vars: { SECRET_KEY: 'abc' } });
  const bobApp = await loginToApp('svc-test', bob);
  const out = await (await appFetch('svc-test', '/', bobApp.jar)).json() as { user: string; key: string };
  check(out.user === '周明' && out.key === 'abc', 'container gets user identity headers and env vars');
  const broken = mkdtempSync(path.join(tmpdir(), 'broken-'));
  writeFileSync(path.join(broken, 'package.json'), JSON.stringify({ scripts: { start: 'node -e "process.exit(1)"' } }));
  const b = await tool(token, 'publish_app', { upload_id: await upload(token, 'app', broken), slug: 'svc-test', kind: 'container' });
  const still = await (await appFetch('svc-test', '/', bobApp.jar)).json() as { key: string };
  check(b.status === 'online' && b.notes.join('').includes('previous version is still live') && still.key === 'abc', 'failed republish keeps previous version serving');
  await tool(token, 'delete_app', { slug: 'svc-test', confirm_slug: 'svc-test' });
  check(execFileSync('docker', ['ps', '-aq', '-f', 'name=hub-app-svc-test']).toString().trim() === '', 'delete removes container');
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
