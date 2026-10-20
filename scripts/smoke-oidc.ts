/**
 * End-to-end check of sign-in with a generic OpenID Connect provider (a fake one here) and of the hub without Lark:
 * PKCE login, the email-domain allowlist, unverified emails, Lark features switched off, data apps still working.
 * Starts its own hub with a throwaway data dir:  node scripts/smoke-oidc.ts
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const KEEP = process.argv.includes('--keep');
const IDP_PORT = 18961;
const HUB_PORT = 18960;
const HUB = `http://localhost:${HUB_PORT}`;
const IDP = `http://localhost:${IDP_PORT}`;
let failures = 0;
function check(ok: unknown, label: string) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------- fake OpenID provider
const PEOPLE: Record<string, Record<string, unknown>> = {
  dana: { sub: 'idp|dana', name: 'Dana Smith', email: 'Dana@Example.com', email_verified: true, picture: 'https://example.com/dana.png' },
  erin: { sub: 'idp|erin', given_name: 'Erin', family_name: 'Lee', email: 'erin@example.com', email_verified: true },
  mallory: { sub: 'idp|mallory', name: 'Mallory', email: 'mallory@elsewhere.net', email_verified: true },
  sneaky: { sub: 'idp|sneaky', name: 'Sneaky', email: 'boss@example.com', email_verified: false },
};
/** who the next /authorize signs in as */
let signInAs = 'dana';
const codes = new Map<string, { who: string; challenge: string; redirect: string }>();
const idp = { authorizeParams: new URLSearchParams(), tokenAuth: '' };

const idpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', IDP);
  const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (url.pathname === '/.well-known/openid-configuration') {
    return json(200, { issuer: IDP, authorization_endpoint: `${IDP}/authorize`, token_endpoint: `${IDP}/token`, userinfo_endpoint: `${IDP}/userinfo` });
  }
  if (url.pathname === '/authorize') {
    idp.authorizeParams = url.searchParams;
    const code = `code-${signInAs}-${codes.size}`;
    codes.set(code, { who: signInAs, challenge: url.searchParams.get('code_challenge') ?? '', redirect: url.searchParams.get('redirect_uri') ?? '' });
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    return res.writeHead(302, { location: back.toString() }).end();
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    idp.tokenAuth = req.headers.authorization ?? '';
    const c = codes.get(form.get('code') ?? '');
    codes.delete(form.get('code') ?? '');
    const pkceOk = c && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === c.challenge;
    if (!c || !pkceOk || form.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant' });
    return json(200, { access_token: `at-${c.who}`, token_type: 'Bearer', expires_in: 3600 });
  }
  if (url.pathname === '/userinfo') {
    const who = (req.headers.authorization ?? '').replace('Bearer at-', '');
    return PEOPLE[who] ? json(200, PEOPLE[who]) : json(401, { error: 'invalid_token' });
  }
  json(404, { error: 'not found' });
});

// ---------------------------------------------------------------- helpers
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

/** Signs in the way a browser does: hub → provider → hub callback. Returns the jar and the callback response. */
async function signIn(who: string, ret = '/') {
  signInAs = who;
  const jar = new Jar();
  const start = await fetch(`${HUB}/auth/login?return=${encodeURIComponent(ret)}`, { redirect: 'manual' });
  jar.store(start);
  const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
  const callback = await fetch(authorize.headers.get('location')!, { redirect: 'manual', headers: { cookie: jar.header() } });
  jar.store(callback);
  return { jar, start, callback };
}

const api = async (jar: Jar, method: string, p: string, b?: unknown) => {
  const res = await fetch(`${HUB}/api${p}`, { method, headers: { cookie: jar.header(), 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

let rpc = 0;
async function mcp(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${HUB}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params }),
  });
  return (await res.json() as { result: Record<string, unknown> }).result;
}
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await mcp(token, 'tools/call', { name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
}

// ---------------------------------------------------------------- run
const dataDir = mkdtempSync(path.join(tmpdir(), 'hub-oidc-smoke-'));
const env = {
  ...process.env, PORT: String(HUB_PORT), HUB_URL: HUB, DATA_DIR: dataDir, HUB_SECRET: 'smoke', DEFAULT_LOCALE: 'en', ALERT_QUIET_HOURS: 'off',
  LARK_APP_ID: '', DEV_LOGIN: '', OIDC_ISSUER: IDP, OIDC_CLIENT_ID: 'hub-client', OIDC_CLIENT_SECRET: 's3cret', OIDC_NAME: 'Acme SSO',
  OIDC_ALLOWED_DOMAINS: 'example.com', HUB_ADMINS: 'boss@example.com',
};
await new Promise<void>((ok) => idpServer.listen(IDP_PORT, ok));
const hub = spawn(process.execPath, ['server/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let hubLog = '';
hub.stdout.on('data', (d) => (hubLog += d));
hub.stderr.on('data', (d) => (hubLog += d));
for (let i = 0; i < 50; i++) {
  if ((await fetch(`${HUB}/healthz`).catch(() => null))?.ok) break;
  await new Promise((r) => setTimeout(r, 200));
}

try {
  // sign-in
  const dana = await signIn('dana', '/apps');
  check(dana.start.status === 302 && dana.start.headers.get('location')?.startsWith(`${IDP}/authorize`), 'login goes to the OpenID provider');
  check(idp.authorizeParams.get('code_challenge_method') === 'S256' && idp.authorizeParams.get('scope') === 'openid profile email' && idp.authorizeParams.get('hd') === 'example.com',
    'with PKCE, the standard scopes and the Google domain hint');
  check(idp.tokenAuth === 'Basic ' + Buffer.from('hub-client:s3cret').toString('base64'), 'the code is exchanged with client credentials (HTTP Basic)');
  check(dana.callback.status === 302 && dana.callback.headers.get('location') === '/apps', 'callback signs in and returns to the page asked for');
  const me = await api(dana.jar, 'GET', '/me');
  const user = me.body.user as { id: string; name: string; email: string; avatar: string; role: string };
  const hubInfo = me.body.hub as { login: string; features: { lark: boolean; messages: boolean } };
  check(user.id === 'idp|dana' && user.name === 'Dana Smith' && user.email === 'dana@example.com' && user.avatar === 'https://example.com/dana.png', 'the person comes from userinfo (email lower-cased)');
  check(user.role === 'admin', 'the first person to sign in is an admin');
  check(hubInfo.login === 'Acme SSO' && hubInfo.features.lark === false && hubInfo.features.messages === false, '/me says: signed in with "Acme SSO", no Lark, no messages');

  const erin = await signIn('erin');
  const erinMe = (await api(erin.jar, 'GET', '/me')).body.user as { name: string; role: string };
  check(erinMe.name === 'Erin Lee' && erinMe.role === 'member', 'a name from given/family name; later people are members');

  const mallory = await signIn('mallory');
  check(mallory.callback.status === 400 && (await mallory.callback.text()).includes('mallory@elsewhere.net'), 'an email outside OIDC_ALLOWED_DOMAINS cannot sign in');
  check((await api(mallory.jar, 'GET', '/me')).status === 401, 'and gets no session');

  const sneaky = await signIn('sneaky');
  check(sneaky.callback.status === 400, 'an unverified email cannot pass the domain allowlist');

  // a replayed code or a forged state is refused
  signInAs = 'dana';
  const s1 = await fetch(`${HUB}/auth/login`, { redirect: 'manual' });
  const forged = new URL((await fetch(s1.headers.get('location')!, { redirect: 'manual' })).headers.get('location')!);
  forged.searchParams.set('state', 'forged');
  const j1 = new Jar();
  j1.store(s1);
  check((await fetch(forged, { redirect: 'manual', headers: { cookie: j1.header() } })).status === 400, 'a callback with the wrong state is refused');

  // Lark features are off
  const tok = (await api(dana.jar, 'POST', '/tokens', { name: 'test' })).body.token as string;
  const tools = ((await mcp(tok, 'tools/list')).tools as { name: string }[]).map((x) => x.name);
  check(!['inspect_base', 'lark_data_status', 'get_okrs', 'get_company_okrs', 'list_okr_periods', 'set_app_lark'].some((n) => tools.includes(n)), 'no Lark tools are offered to agents');
  check(['publish_app', 'save_data_source', 'inspect_app_data', 'save_check', 'save_alert_rule'].every((n) => tools.includes(n)), 'the core and data-app tools are');
  const init = await mcp(tok, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }) as { instructions: string };
  check(!/inspect_base|get_okrs|Lark OKR|set_app_lark/.test(init.instructions) && init.instructions.includes('Data apps: company data'), 'agent instructions leave Lark out');
  const viaUrl = await tool(tok, 'save_data_source', { id: 'sheet', title: { en: 'Sheet', 'zh-CN': '表' }, url: 'https://x.larksuite.com/base/app?table=tbl' });
  check(String(viaUrl.error).includes('not connected to Lark'), 'a Lark Base data source is refused');
  for (const p of ['/lark/status', '/okr', '/okr/board']) {
    const r = await api(dana.jar, 'GET', p);
    check(r.status === 400 && r.body.code === 'err.lark.disabled', `GET /api${p} says Lark is off`);
  }
  const okrHome = await tool(tok, 'preview_homepage', { scope: 'me', layout: { modules: [{ type: 'okr' }] } });
  check(String(okrHome.error).includes('not connected to Lark'), 'an OKR module cannot be put on a home page');
  check((await fetch(`${HUB}/auth/lark/connect`, { redirect: 'manual', headers: { cookie: dana.jar.header() } })).status === 400, '"connect Lark data" explains there is no Lark');

  // data apps, checks and alerts work without Lark
  const rowsDir = mkdtempSync(path.join(tmpdir(), 'hub-rows-'));
  writeFileSync(path.join(rowsDir, 'index.html'), '<h1>metrics</h1>');
  writeFileSync(path.join(rowsDir, 'rows.json'), JSON.stringify({
    rows: Array.from({ length: 12 }, (_, i) => ({ _id: `r${i}`, plan: i % 3 ? 'free' : 'paid', paid_usd: i % 3 ? 0 : 9, owner: 'erin@example.com' })),
  }));
  execFileSync(process.execPath, ['scripts/admin.ts', 'publish-app', rowsDir, '--owner', 'dana@example.com', '--slug', 'metrics', '--visibility', 'company',
    '--localized', JSON.stringify({ 'zh-CN': { name: '指标', description: '指标' }, en: { name: 'Metrics', description: 'Metrics' } })], { env, stdio: 'pipe' });
  rmSync(rowsDir, { recursive: true, force: true });
  check((await tool(tok, 'save_data_source', { id: 'plans', title: { en: 'Plans', 'zh-CN': '套餐' }, app: 'metrics', path: '/rows.json' })).saved, 'a data app is registered as a data source');
  const q = await tool(tok, 'query_data', { source: 'plans', query: { measure: { op: 'count' }, groupBy: 'plan' } });
  check(JSON.stringify(q.rows).includes('paid') && q.rows.length === 2, 'and queried');
  const chk = await tool(tok, 'save_check', {
    title: { en: 'Still on the free plan', 'zh-CN': '还在免费套餐' }, source: 'plans', level: 'verify',
    spec: { kind: 'rows', all: [{ field: 'plan', op: 'is', value: 'free' }] }, owner_field: 'owner', label_fields: ['plan'],
  });
  check(chk.issues === 8 && chk.sample?.[0]?.owners?.[0] === 'Erin Lee', 'a data check runs on it and assigns rows by email');
  const rule = await tool(tok, 'save_alert_rule', { title: { en: 'Rows', 'zh-CN': '行数' }, source: 'plans', query: { measure: { op: 'count' } }, condition: { type: 'above', value: 5 }, recipients: ['erin@example.com'] });
  check(typeof rule.id === 'number' && !rule.note, 'an alert rule saves (no admins-only note: nothing is messaged)');
  const fired = await tool(tok, 'check_alert_rule', { id: rule.id });
  check(fired.state === 'firing' && fired.messages?.sent === 0, 'it fires and sends no messages');
  const erinAlerts = await api(erin.jar, 'GET', '/alerts');
  check((erinAlerts.body.alerts as { state: string }[])[0]?.state === 'firing', 'the recipient sees it on their home page');
  check((await api(dana.jar, 'GET', '/admin')).status === 200 && ((await api(dana.jar, 'GET', '/home')).body.larkLinks as unknown[]).length === 0, 'admin and home pages load without Lark parts');
  const org = await api(erin.jar, 'GET', '/org');
  check((org.body.people as { name: string }[]).some((p) => p.name === 'Dana Smith') && (org.body.departments as unknown[]).length === 0, 'the org page lists people who signed in');
} catch (e) {
  failures++;
  console.error(e);
} finally {
  hub.kill();
  idpServer.close();
  if (!KEEP) rmSync(dataDir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} check(s) failed\n--- hub log ---\n${hubLog}`);
  process.exit(1);
}
console.log('\nall checks passed');
