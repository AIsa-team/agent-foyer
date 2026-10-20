/**
 * End-to-end check of the Lark data features against a fake Lark: connecting Lark data (OAuth with refresh),
 * Base inspection through a wiki link, data sources, aggregations, home modules, permissions and alert messages.
 * Starts its own hub with a throwaway data dir:  node scripts/smoke-data.ts
 */
import { spawn } from 'node:child_process';
import { createHash, createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const KEEP = process.argv.includes('--keep');
const LARK_PORT = 18931;
const HUB_PORT = 18930;
const HUB = `http://localhost:${HUB_PORT}`;
let failures = 0;
function check(ok: unknown, label: string) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------- fake Lark
const DAY = 86_400_000;
const NOW = Date.now();
const CHANNELS = ['API', 'Skills', '企业'];
/** 700 orders over the last 120 days: forces two pages of 500. */
const ORDERS = Array.from({ length: 700 }, (_, i) => ({
  Name: [{ type: 'text', text: `Order ${i}` }],
  Channel: CHANNELS[i % 3],
  Amount: (i % 10) + 1,
  Date: NOW - Math.floor(120 * ((i * 7919) % 700 / 700) ** 1.6) * DAY,
  Owner: [{ id: 'ou_dev_alice', name: '林小雨' }],
  Tags: i % 2 ? ['new', 'vip'] : ['new'],
  Score: { type: 2, value: [i % 5] },
}));
const FIELDS = [
  { field_id: 'f1', field_name: 'Name', type: 1, ui_type: 'Text' },
  { field_id: 'f2', field_name: 'Channel', type: 3, ui_type: 'SingleSelect' },
  { field_id: 'f3', field_name: 'Amount', type: 2, ui_type: 'Number' },
  { field_id: 'f4', field_name: 'Date', type: 5, ui_type: 'DateTime' },
  { field_id: 'f5', field_name: 'Owner', type: 11, ui_type: 'User' },
  { field_id: 'f6', field_name: 'Tags', type: 4, ui_type: 'MultiSelect' },
  { field_id: 'f7', field_name: 'Score', type: 20, ui_type: 'Formula' },
];
// a project table with planted problems for the data checks
const ALICE = [{ id: 'ou_dev_alice', name: '林小雨' }];
const BOB = [{ id: 'ou_dev_bob', name: '周明' }];
const PROJECT_FIELDS = [
  { field_id: 'p1', field_name: '项目名称', type: 1, ui_type: 'Text' },
  { field_id: 'p2', field_name: '客户', type: 1, ui_type: 'Text' },
  { field_id: 'p3', field_name: '状态', type: 3, ui_type: 'SingleSelect' },
  { field_id: 'p4', field_name: '签约日期', type: 5, ui_type: 'DateTime' },
  { field_id: 'p5', field_name: '打款日期', type: 5, ui_type: 'DateTime' },
  { field_id: 'p6', field_name: '负责人', type: 11, ui_type: 'User' },
  { field_id: 'p7', field_name: '修改时间', type: 1002, ui_type: 'ModifiedTime' },
  { field_id: 'p8', field_name: '跟进人', type: 4, ui_type: 'MultiSelect' },     // names as options, not a person field
  { field_id: 'p9', field_name: '提交时间', type: 1, ui_type: 'Text' },           // a date written as text (synced from elsewhere)
];
const PROJECTS = [
  { id: 'recP1', f: { 项目名称: [{ type: 'text', text: '春季投放' }], 客户: 'Tether', 状态: '已打款', 签约日期: NOW - 40 * DAY, 负责人: ALICE, 修改时间: NOW - DAY, 跟进人: ['alice'], 提交时间: new Date(NOW - 40 * DAY).toISOString() } },           // paid, no payment date
  { id: 'recP2', f: { 项目名称: [{ type: 'text', text: '夏季投放' }], 客户: 'Tether', 状态: '已打款', 签约日期: NOW - 10 * DAY, 打款日期: NOW - 20 * DAY, 负责人: BOB, 修改时间: NOW - DAY } }, // paid before signing
  { id: 'recP3', f: { 项目名称: [{ type: 'text', text: 'AI 大会' }], 客户: 'Tether', 状态: '已完成', 签约日期: NOW - 30 * DAY, 负责人: ALICE, 修改时间: NOW - DAY } },
  { id: 'recP4', f: { 项目名称: [{ type: 'text', text: 'ai 大会 ' }], 客户: 'tether ', 状态: '已完成', 签约日期: NOW - 30 * DAY, 负责人: BOB, 修改时间: NOW - DAY } },  // duplicate name, odd spelling
  { id: 'recP5', f: { 项目名称: [{ type: 'text', text: '秋季投放' }], 客户: 'Circle', 状态: '进行中', 签约日期: NOW - 60 * DAY, 负责人: ALICE, 修改时间: NOW - 30 * DAY } },  // stale
  { id: 'recP6', f: { 项目名称: [{ type: 'text', text: '冬季投放' }], 客户: 'Circle', 状态: '进行中', 签约日期: NOW - 5 * DAY, 修改时间: NOW - 2 * DAY } },
];

// the hub's GitHub App key; the fake GitHub checks the App's JWT against it
const ghKeys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

const lark = {
  access: new Set<string>(),
  refresh: new Set<string>(),
  refreshes: 0,
  messages: [] as { type: string; id: string; text: string }[],
  scopesAsked: '',
  drafts: [] as string[],
  gmail: [] as string[],
  googleEmail: 'alex@example.com',
  googleScope: '',
  ghQueries: [] as string[],
  searchCalls: 0,
  hideApi: false,
  denyOrders: false,
  rejectOnce: false,
  advanced: false,
  writeTokens: new Set<string>(),
  docsTokens: new Set<string>(),
  doc: new Map<string, DocBlock>(),
  fixP1: false,
  created: [] as { table: string; fields: Record<string, unknown>; by: string }[],
  updated: [] as { record: string; fields: Record<string, unknown> }[],
};
let serial = 0;

// the daily report: one docx per day under a wiki page, each section a table whose rows start with @someone
interface DocBlock { block_id: string; block_type: number; parent_id: string; children?: string[]; [k: string]: unknown }
function dailyDoc() {
  const doc = new Map<string, DocBlock>();
  let n = 0;
  const add = (b: Omit<DocBlock, 'block_id'>, id = `b${++n}`) => (doc.set(id, { block_id: id, ...b } as DocBlock), id);
  const text = (parent: string, ...elements: unknown[]) => add({ block_type: 2, parent_id: parent, text: { elements } });
  const run = (content: string) => ({ text_run: { content } });
  const at = (id: string) => ({ mention_user: { user_id: id } });
  const table = (parent: string, rows: unknown[][][]) => {
    const id = add({ block_type: 31, parent_id: parent, children: [] });
    const cells: string[] = [];
    for (const row of rows) for (const cell of row) {
      const c = add({ block_type: 32, parent_id: id, children: [] });
      doc.get(c)!.children = cell.length ? cell.map((lineEls) => text(c, ...(lineEls as unknown[]))) : [text(c)];
      cells.push(c);
    }
    Object.assign(doc.get(id)!, { children: cells, table: { cells, property: { row_size: rows.length, column_size: rows[0].length } } });
    return id;
  };
  const head = (cols: string[]) => cols.map((c) => [[run(c)]]);
  const root = 'doxDaily';
  const kids = [
    add({ block_type: 3, parent_id: root, heading1: { elements: [run('二、项目进展')] } }),
    add({ block_type: 4, parent_id: root, heading2: { elements: [run('社媒资源层 '), at('ou_dev_alice')] } }),
    table(root, [head(['负责人', '昨天完成', '今天计划', '卡点和需要谁']),
      [[[at('ou_dev_alex')]], [[run('旧的内容')]], [], []],
      [[[at('ou_dev_alice')]], [[run('招募 47 位创作者')], [run('完善 SOP')]], [[run('继续建联')]], []]]),
    add({ block_type: 3, parent_id: root, heading1: { elements: [run('三、日常工作')] } }),
    table(root, [head(['负责人', '昨天完成', '今天计划', '卡点和需要谁']), [[[at('ou_dev_alex')]], [], [], []], [[[at('ou_dev_bob')]], [], [], []]]),
  ];
  doc.set(root, { block_id: root, block_type: 1, parent_id: '', children: kids });
  return doc;
}

function issue(expiresIn: number) {
  const a = `u-${++serial}`;
  const r = `r-${serial}`;
  lark.access.add(a);
  lark.refresh.add(r);
  if (lark.scopesAsked.split(' ').includes('bitable:app')) lark.writeTokens.add(a);
  if (lark.scopesAsked.split(' ').includes('docx:document')) lark.docsTokens.add(a);
  return { code: 0, access_token: a, expires_in: expiresIn, refresh_token: r, refresh_token_expires_in: 2_592_000, token_type: 'Bearer', scope: lark.scopesAsked };
}

const larkServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${LARK_PORT}`);
  const p = url.pathname.replace('/open-apis', '');
  const raw = await new Promise<string>((ok) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => ok(b));
  });
  const send = (o: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  // a fake GitHub: App JWT → installation token, user sign-in, search and pull request commits
  if (p.startsWith('/gh/')) {
    const gp = p.slice(3);
    const auth = req.headers.authorization ?? '';
    if (gp === '/orgs/acme/installation' || gp === '/app/installations/7/access_tokens') {
      const [h, b, sig] = auth.replace('Bearer ', '').split('.');
      const ok = !!sig && createVerify('RSA-SHA256').update(`${h}.${b}`).verify(ghKeys.publicKey, Buffer.from(sig, 'base64url'));
      if (!ok) return send({ message: 'Bad credentials' }, 401);
      return gp.startsWith('/orgs') ? send({ id: 7 }) : send({ token: 'ghs_install', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (gp === '/login/oauth/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'gh-code');
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (gp === '/login/oauth/access_token') return send(JSON.parse(raw).code === 'gh-code' ? { access_token: 'gho_user' } : { error: 'bad_verification_code' });
    if (gp === '/user') return auth === 'Bearer gho_user' ? send({ login: 'alex-gh', id: 42 }) : send({ message: 'Bad credentials' }, 401);
    if (gp.startsWith('/applications/')) { res.writeHead(204); return res.end(); }
    if (auth !== 'Bearer ghs_install') return send({ message: 'Bad credentials' }, 401);
    const iso = (ms: number) => new Date(ms).toISOString();
    if (gp === '/search/commits') {
      const q = url.searchParams.get('q') ?? '';
      lark.ghQueries.push(q);
      return send({ total_count: 1, items: q.includes('author:alex-gh') ? [
        { sha: 'aaaaaaa1111', html_url: 'https://github.com/acme/hub/commit/aaaaaaa', repository: { full_name: 'acme/hub' }, commit: { message: 'fix: gateway keeps the session\n\nlonger text', author: { date: iso(NOW - 3600_000) } } },
      ] : [] });
    }
    if (gp === '/search/issues') {
      const q = url.searchParams.get('q') ?? '';
      lark.ghQueries.push(q);
      if (q.includes('reviewed-by:alex-gh')) return send({ items: [{ number: 9, title: 'Billing export', html_url: 'https://github.com/acme/billing/pull/9', state: 'open', created_at: iso(NOW - 2 * DAY), updated_at: iso(NOW - 7200_000), repository_url: 'https://api.github.com/repos/acme/billing', pull_request: { merged_at: null } }] });
      return send({ items: q.includes('author:alex-gh') ? [
        { number: 12, title: 'Daily report tools', html_url: 'https://github.com/acme/hub/pull/12', state: 'open', created_at: iso(NOW - DAY), updated_at: iso(NOW - 1800_000), repository_url: 'https://api.github.com/repos/acme/hub', pull_request: { merged_at: null } },
        { number: 11, title: 'GitHub link', html_url: 'https://github.com/acme/hub/pull/11', state: 'closed', created_at: iso(NOW - 3 * DAY), updated_at: iso(NOW - 5 * 3600_000), repository_url: 'https://api.github.com/repos/acme/hub', pull_request: { merged_at: iso(NOW - 5 * 3600_000) } },
      ] : [] });
    }
    if (gp === '/repos/acme/hub/pulls/12/commits') return send([
      { sha: 'bbbbbbb2222', html_url: 'https://github.com/acme/hub/commit/bbbbbbb', author: { login: 'alex-gh' }, commit: { message: 'feat: read the daily report', author: { date: iso(NOW - 2 * 3600_000) } } },
      { sha: 'ccccccc3333', html_url: 'https://github.com/acme/hub/commit/ccccccc', author: { login: 'someone-else' }, commit: { message: 'chore: their commit', author: { date: iso(NOW - 2 * 3600_000) } } },
      { sha: 'ddddddd4444', html_url: 'https://github.com/acme/hub/commit/ddddddd', author: { login: 'alex-gh' }, commit: { message: 'old work', author: { date: iso(NOW - 4 * DAY) } } },
    ]);
    if (gp === '/repos/acme/hub/pulls/11/commits') return send([]);
    return send({ message: 'Not Found' }, 404);
  }
  // a fake Google: OAuth (code + PKCE), userinfo and Gmail drafts
  if (p === '/google/auth') {
    lark.googleScope = url.searchParams.get('scope') ?? '';
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('code', 'gcode-' + (url.searchParams.get('code_challenge') ?? ''));
    back.searchParams.set('state', url.searchParams.get('state')!);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (p === '/google/token') {
    const f = new URLSearchParams(raw);
    const challenge = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
    if (f.get('grant_type') === 'authorization_code' && f.get('code') !== 'gcode-' + challenge) return send({ error: 'invalid_grant' }, 400);
    return send({ access_token: 'g-at', expires_in: 3600, refresh_token: 'g-rt', scope: lark.googleScope, token_type: 'Bearer' });
  }
  if (p === '/google/userinfo') return send({ sub: 'g1', email: lark.googleEmail, email_verified: true });
  if (p === '/gmail/v1/users/me/drafts' && req.method === 'POST') {
    if (req.headers.authorization !== 'Bearer g-at') return send({ error: { message: 'unauthorized' } }, 401);
    lark.gmail.push(Buffer.from((JSON.parse(raw) as { message: { raw: string } }).message.raw, 'base64url').toString('utf8'));
    return send({ id: `r-${lark.gmail.length}`, message: { id: `m-${lark.gmail.length}` } });
  }
  const body = raw ? JSON.parse(raw) : {};
  const bearer = (req.headers.authorization ?? '').replace('Bearer ', '');
  const userOk = () => lark.access.has(bearer);

  if (p === '/authen/v1/authorize') {
    lark.scopesAsked = url.searchParams.get('scope') ?? '';
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('code', 'code-' + serial);
    back.searchParams.set('state', url.searchParams.get('state')!);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (p === '/authen/v2/oauth/token') {
    // the first token is short-lived on purpose: the hub must refresh it before use, once
    if (body.grant_type === 'authorization_code') return send(issue(60));
    if (body.grant_type === 'refresh_token') {
      if (!lark.refresh.delete(body.refresh_token)) return send({ code: 20037, error: 'invalid_grant', error_description: 'refresh token used' });
      lark.refreshes++;
      return send(issue(7200));
    }
  }
  if (p === '/authen/v1/user_info') return userOk() ? send({ code: 0, data: { open_id: 'ou_dev_alex', name: 'Alex' } }) : send({ code: 99991668, msg: 'bad token' });
  if (p === '/auth/v3/tenant_access_token/internal') return send({ code: 0, tenant_access_token: 't-app', expire: 7200 });
  if (p === '/im/v1/messages') {
    if (bearer !== 't-app') return send({ code: 99991663, msg: 'bad tenant token' });
    lark.messages.push({ type: url.searchParams.get('receive_id_type')!, id: body.receive_id, text: JSON.parse(body.content).text });
    return send({ code: 0, data: {} });
  }
  if (p === '/okr/v1/periods') {
    return bearer === 't-app'
      ? send({ code: 99991672, msg: 'Access denied. One of the following scopes is required: [okr:okr.period:readonly, okr:okr:readonly, okr:okr]' })
      : send({ code: 99991668, msg: 'user access token not support' });
  }
  // everything below reads documents as the user
  if (!userOk()) return send({ code: 99991668, msg: 'invalid user token' });
  if (lark.rejectOnce) {
    lark.rejectOnce = false;
    return send({ code: 99991668, msg: 'invalid user token (once)' });
  }
  if (p === '/mail/v1/user_mailboxes/me/profile') return send({ code: 0, data: { primary_email_address: 'alex@example.com' } });
  if (p === '/mail/v1/user_mailboxes/me/drafts' && req.method === 'POST') {
    lark.drafts.push(Buffer.from((JSON.parse(raw) as { raw: string }).raw, 'base64url').toString('utf8'));
    return send({ code: 0, data: { draft_id: `draft${lark.drafts.length}` } });
  }
  const progress = p.match(/^\/okr\/v1\/progress_records\/([^/]+)$/);
  if (progress) {
    const texts: Record<string, { at: number; blocks: unknown[] }> = {
      pr1: { at: NOW - 3 * DAY, blocks: [{ type: 'paragraph', paragraph: { elements: [{ type: 'textRun', textRun: { text: '调用量本周破 1.3 亿，' } }, { type: 'person', person: { openId: 'ou_dev_alice' } }, { type: 'textRun', textRun: { text: ' 在跟进' } }] } }] },
      pr2: { at: NOW - DAY, blocks: [{ type: 'paragraph', paragraph: { elements: [{ type: 'textRun', textRun: { text: '新签 12 家' } }] } }] },
      pr3: { at: NOW - 2 * DAY, blocks: [{ type: 'paragraph', paragraph: { elements: [{ type: 'docsLink', docsLink: { title: '渠道周报', url: 'https://x.larksuite.com/docx/1' } }] } }] },
    };
    const t = texts[progress[1]];
    return t ? send({ code: 0, data: { progress_id: progress[1], modify_time: String(t.at), content: { blocks: t.blocks } } }) : send({ code: 1001002, msg: 'No permission.' });
  }
  const okrUser = p.match(/^\/okr\/v1\/users\/([^/]+)\/okrs$/);
  if (okrUser) {
    if (okrUser[1] === 'ou_dev_bob') return send({ code: 1001002, msg: 'No permission.' });
    const q = Math.floor(new Date(NOW).getMonth() / 3);
    const y = new Date(NOW).getFullYear();
    const lastQ = (q + 3) % 4;
    const entries = [
      { id: 'okr-last', period_id: 'p-last', name: `${q ? y : y - 1} 年 ${lastQ * 3 + 1} - ${lastQ * 3 + 3} 月`, objective_list: [{ id: 'o0', content: '上季度目标', progress_rate: { percent: 100 }, kr_list: [] }] },
      { id: 'okr-now', period_id: 'p-now', name: `${y} 年 ${q * 3 + 1} - ${q * 3 + 3} 月`, objective_list: [
        { id: 'o1', content: '让 Acme 成为 Agent 默认的资源入口', progress_rate: { percent: 62 }, progress_record_list: [{ id: 'pr1' }], kr_list: [
          { id: 'k1', content: '月调用量 2 亿次', progress_rate: { percent: 65 } },
          { id: 'k2', content: '上架 60 个官方 Skill', progress_rate: { percent: 72 } },
        ] },
        // no objective progress: the hub averages the key results
        { id: 'o2', content: '新增 400 家企业客户', kr_list: [
          { id: 'k3', content: '出海电商渠道 150 家', progress_rate: { percent: 30 }, progress_record_list: [{ id: 'pr2' }] },
          { id: 'k4', content: '内容团队 100 家', progress_rate: { percent: 10 } },
        ] },
      ] },
    ];
    // Alice's objective supports Alex's first company objective
    const alice = [{ id: 'okr-alice', period_id: 'p-now', name: entries[1].name, objective_list: [
      { id: 'a1', content: '出海电商渠道做到 150 家', progress_rate: { percent: 40 }, aligned_objective_list: [{ id: 'o1', owner: { open_id: 'ou_dev_alex' } }], kr_list: [], progress_record_list: [{ id: 'pr3' }] },
    ] }];
    const mine = okrUser[1] === 'ou_dev_alice' ? alice : entries;
    const only = url.searchParams.getAll('period_ids');
    const list = only.length ? mine.filter((e) => only.includes(e.period_id)) : mine;
    return send({ code: 0, data: { okr_list: list, total: list.length } });
  }
  if (p === '/wiki/v2/spaces/get_node' && url.searchParams.get('token') === 'wikDaily') {
    return send({ code: 0, data: { node: { space_id: 'sp1', node_token: 'wikDaily', title: '团队日会', obj_type: 'docx', obj_token: 'doxFolder' } } });
  }
  if (p === '/wiki/v2/spaces/sp1/nodes' && url.searchParams.get('parent_node_token') === 'wikDaily') {
    // two pages, the report wanted is on the second
    return url.searchParams.get('page_token') === 'p2'
      ? send({ code: 0, data: { items: [{ node_token: 'wik1020', obj_token: 'doxDaily', obj_type: 'docx', title: '团队工作日报 1020', space_id: 'sp1' }], has_more: false } })
      : send({ code: 0, data: { items: [{ node_token: 'wik1019', obj_token: 'doxOld', obj_type: 'docx', title: '团队工作日报 1019', space_id: 'sp1' }], has_more: true, page_token: 'p2' } });
  }
  const docPath = p.match(/^\/docx\/v1\/documents\/doxDaily\/blocks(?:\/(\w+))?(\/children(?:\/batch_delete)?)?$/);
  if (docPath) {
    if (!userOk()) return send({ code: 99991668, msg: 'bad token' });
    if (!lark.doc.size) lark.doc = dailyDoc();
    const [, id, sub] = docPath;
    if (!id) {
      const all = [...lark.doc.values()];
      const start = Number(url.searchParams.get('page_token') || 0);
      const size = 5;
      return send({ code: 0, data: { items: all.slice(start, start + size), has_more: start + size < all.length, page_token: String(start + size) } });
    }
    const block = lark.doc.get(id);
    if (!block) return send({ code: 1770002, msg: 'not found' });
    if (!sub) return send({ code: 0, data: { block } });
    if (!lark.docsTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [docx:document]' });
    if (sub === '/children' && req.method === 'POST') {
      const ids = (body.children as { block_type: number; text: unknown }[]).map((c, i) => {
        const nid = `n${++serial}_${i}`;
        lark.doc.set(nid, { block_id: nid, parent_id: id, block_type: c.block_type, text: c.text });
        return nid;
      });
      block.children!.splice(body.index ?? block.children!.length, 0, ...ids);
      return send({ code: 0, data: { children: ids.map((i) => lark.doc.get(i)) } });
    }
    if (sub === '/children/batch_delete' && req.method === 'DELETE') {
      for (const gone of block.children!.splice(body.start_index, body.end_index - body.start_index)) lark.doc.delete(gone);
      return send({ code: 0, data: {} });
    }
  }
  if (p === '/wiki/v2/spaces/get_node') {
    return url.searchParams.get('token') === 'wikOrders'
      ? send({ code: 0, data: { node: { obj_type: 'bitable', obj_token: 'appOrders' } } })
      : send({ code: 0, data: { node: { obj_type: 'docx', obj_token: 'doxX' } } });
  }
  if (p.startsWith('/bitable/v1/apps/appSecret') || (lark.denyOrders && p.startsWith('/bitable/v1/apps/appOrders'))) return send({ code: 1254302, msg: 'Permission denied.' });
  const write = p.match(/^\/bitable\/v1\/apps\/appOrders\/tables\/(tbl\w+)\/records(?:\/(\w+))?$/);
  if (write && write[2] !== 'search' && (req.method === 'POST' || req.method === 'PUT')) {
    if (!lark.writeTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. You do not have permission to perform the requested operation on the resource. Please request user re-authorization and try again. required one of these privileges under the user identity: [bitable:app]' });
    if (req.method === 'POST') {
      lark.created.push({ table: write[1], fields: body.fields, by: bearer });
      return send({ code: 0, data: { record: { record_id: 'recNew' + lark.created.length, fields: body.fields } } });
    }
    lark.updated.push({ record: write[2], fields: body.fields });
    return send({ code: 0, data: { record: { record_id: write[2], fields: body.fields } } });
  }
  if (p === '/bitable/v1/apps/appOrders') return send({ code: 0, data: { app: { app_token: 'appOrders', name: 'Orders', is_advanced: lark.advanced } } });
  if (p === '/bitable/v1/apps/appOrders/tables') return send({ code: 0, data: { items: [{ table_id: 'tblOrders', name: '订单' }, { table_id: 'tblProjects', name: '项目' }], has_more: false } });
  if (p === '/bitable/v1/apps/appOrders/tables/tblProjects/fields') return send({ code: 0, data: { items: PROJECT_FIELDS, has_more: false } });
  if (p === '/bitable/v1/apps/appOrders/tables/tblProjects/records/search') {
    const rows = PROJECTS.map((r) => (r.id === 'recP1' && lark.fixP1 ? { ...r, f: { ...r.f, 打款日期: NOW - 35 * DAY } } : r));
    return send({ code: 0, data: { items: rows.map((r) => ({ record_id: r.id, fields: Object.fromEntries(Object.entries(r.f).filter(([k]) => !body.field_names?.length || body.field_names.includes(k))) })), has_more: false, total: rows.length } });
  }
  if (p === '/bitable/v1/apps/appOrders/tables/tblOrders/fields') return send({ code: 0, data: { items: FIELDS, has_more: false } });
  if (p === '/bitable/v1/apps/appOrders/tables/tblOrders/records/search') {
    lark.searchCalls++;
    let rows = lark.hideApi ? ORDERS.filter((r) => r.Channel !== 'API') : ORDERS;
    for (const c of body.filter?.conditions ?? []) {
      if (c.operator === 'is') rows = rows.filter((r) => String((r as Record<string, unknown>)[c.field_name]) === c.value[0]);
    }
    const size = Number(url.searchParams.get('page_size') ?? 20);
    const start = Number(url.searchParams.get('page_token') || 0);
    const page = rows.slice(start, start + size).map((r) => ({
      record_id: 'rec' + start,
      fields: Object.fromEntries(Object.entries(r).filter(([k]) => !body.field_names?.length || body.field_names.includes(k))),
    }));
    const more = start + size < rows.length;
    return send({ code: 0, data: { items: page, has_more: more, page_token: more ? String(start + size) : '', total: rows.length } });
  }
  send({ code: 1001001, msg: `fake lark: no route ${req.method} ${p}` });
});

// ---------------------------------------------------------------- hub client helpers
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

async function login(userId: string) {
  const jar = new Jar();
  jar.store(await fetch(`${HUB}/auth/dev-login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ user: userId, return: '/' }) }));
  const tok = await (await fetch(`${HUB}/api/tokens`, { method: 'POST', headers: { cookie: jar.header(), 'content-type': 'application/json' }, body: '{"name":"test"}' })).json() as { token: string };
  return { jar, token: tok.token };
}

/** Runs the "connect Lark data" flow in a browser-like way, returning the final response. */
async function connect(jar: Jar, extra = '') {
  const start = await fetch(`${HUB}/auth/lark/connect?return=/me${extra}`, { redirect: 'manual', headers: { cookie: jar.header() } });
  jar.store(start);
  const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
  const callback = await fetch(authorize.headers.get('location')!, { redirect: 'manual', headers: { cookie: jar.header() } });
  jar.store(callback);
  return { start, callback };
}

/** Request to an app subdomain (fetch() drops a custom Host header, so node:http). */
function appFetch(slug: string, p: string, jar?: Jar, extra: Record<string, string> = {}, method = 'GET', body?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: HUB_PORT, path: p, method, headers: { ...extra, host: `${slug}.apps.localhost:${HUB_PORT}`, cookie: jar?.header() ?? '' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const x of [v ?? []].flat()) headers.append(k, x);
        resolve(new Response(res.statusCode === 304 ? null : Buffer.concat(chunks), { status: res.statusCode, headers }));
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Signs in to an app the way a browser does: app → hub → one-time code → app cookie. */
async function loginToApp(slug: string, hubJar: Jar): Promise<Jar> {
  const appJar = new Jar();
  const first = await appFetch(slug, '/');
  const hubRes = await fetch(first.headers.get('location')!, { redirect: 'manual', headers: { cookie: hubJar.header() } });
  const cb = new URL(hubRes.headers.get('location')!);
  appJar.store(await appFetch(slug, cb.pathname + cb.search));
  return appJar;
}

const api = async (jar: Jar, method: string, p: string, b?: unknown) => {
  const res = await fetch(`${HUB}/api${p}`, { method, headers: { cookie: jar.header(), 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

let rpc = 0;
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${HUB}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const b = await res.json() as { result: { content: { text: string }[]; isError?: boolean } };
  const text = b.result.content[0].text;
  return b.result.isError ? { error: text } : JSON.parse(text);
}

// ---------------------------------------------------------------- run
const dataDir = mkdtempSync(path.join(tmpdir(), 'hub-data-smoke-'));
await new Promise<void>((ok) => larkServer.listen(LARK_PORT, ok));
const hub = spawn(process.execPath, ['server/index.ts'], {
  env: {
    ...process.env, PORT: String(HUB_PORT), HUB_URL: HUB, DATA_DIR: dataDir, HUB_SECRET: 'smoke', DEV_LOGIN: '1', DEFAULT_LOCALE: 'en',
    ALERT_QUIET_HOURS: 'off', LARK_APP_ID: 'cli_smoke', LARK_APP_SECRET: 'secret', LARK_API_BASE: `http://localhost:${LARK_PORT}/open-apis`, LARK_ACCOUNTS_BASE: `http://localhost:${LARK_PORT}/open-apis`,
    GOOGLE_CLIENT_ID: 'g-client', GOOGLE_CLIENT_SECRET: 'g-secret', GOOGLE_AUTH_URL: `http://localhost:${LARK_PORT}/google/auth`, GOOGLE_TOKEN_URL: `http://localhost:${LARK_PORT}/google/token`,
    GOOGLE_USERINFO_URL: `http://localhost:${LARK_PORT}/google/userinfo`, GOOGLE_GMAIL_BASE: `http://localhost:${LARK_PORT}`,
    GITHUB_ORG: 'acme', GITHUB_APP_ID: '123', GITHUB_CLIENT_ID: 'Iv1.gh', GITHUB_CLIENT_SECRET: 'gh-secret', GITHUB_APP_PRIVATE_KEY: ghKeys.privateKey, GITHUB_WEBHOOK_SECRET: 'hook-secret',
    GITHUB_API_BASE: `http://localhost:${LARK_PORT}/gh`, GITHUB_WEB_BASE: `http://localhost:${LARK_PORT}/gh`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hubLog = '';
hub.stdout.on('data', (d) => (hubLog += d));
hub.stderr.on('data', (d) => (hubLog += d));
for (let i = 0; i < 50; i++) {
  if ((await fetch(`${HUB}/healthz`).catch(() => null))?.ok) break;
  await new Promise((r) => setTimeout(r, 200));
}

try {
  const alex = await login('ou_dev_alex');
  const alice = await login('ou_dev_alice');
  const bob = await login('ou_dev_bob');

  // connect
  let st = await api(alex.jar, 'GET', '/lark/status');
  check(st.body.connected === false && st.body.available === true, 'not connected before approving');
  const notYet = await tool(alex.token, 'inspect_base', { url: 'https://x.larksuite.com/wiki/wikOrders?table=tblOrders' });
  check(String(notYet.error).includes('/auth/lark/connect'), 'tools answer with the connect link until Lark data is connected');
  const flow = await connect(alex.jar);
  check(lark.scopesAsked.includes('offline_access') && lark.scopesAsked.includes('bitable:app:readonly'), 'connect asks Lark for offline_access + Base read scopes');
  check(flow.callback.status === 302 && flow.callback.headers.get('location') === '/me', 'connect callback returns to the hub');
  st = await api(alex.jar, 'GET', '/lark/status');
  check(st.body.connected === true, 'Alex is connected');
  const wrong = await connect(alice.jar);
  check(wrong.callback.status === 400 && (await api(alice.jar, 'GET', '/lark/status')).body.connected === false, 'approving with another Lark account is refused');

  // inspect through a wiki link (and the access token is refreshed on first use)
  const ins = await tool(alex.token, 'inspect_base', { url: 'https://x.larksuite.com/wiki/wikOrders?table=tblOrders' });
  check(ins.table === 'tblOrders' && ins.fields?.length === 7 && ins.sample?.length === 5, 'inspect_base resolves the wiki node and shows fields + sample');
  check(ins.sample?.[0]?.Name === 'Order 0' && ins.sample?.[0]?.Owner === '林小雨' && /^\d{4}-\d{2}-\d{2}$/.test(ins.sample?.[0]?.Date ?? ''), 'cells come out as plain text, people by name, dates as days');
  check(lark.refreshes === 1, 'short-lived user token was refreshed once');
  check((await tool(alex.token, 'inspect_base', { url: 'https://x.larksuite.com/wiki/wikDoc' })).error, 'a wiki page that is not a Base is rejected');

  // data sources
  check((await tool(alex.token, 'save_data_source', { id: 'secret', title: { 'zh-CN': '机密', en: 'Secret' }, url: 'https://x.larksuite.com/base/appSecret?table=tblX' })).error?.includes('cannot open'), 'a table the person cannot open in Lark is refused');
  const saved = await tool(alex.token, 'save_data_source', { id: 'orders', title: { 'zh-CN': '订单', en: 'Orders' }, url: 'https://x.larksuite.com/wiki/wikOrders?table=tblOrders' });
  check(saved.saved === true, 'save_data_source');
  check((await tool(bob.token, 'list_data_sources')).sources?.[0]?.id === 'orders', 'everyone sees the registry');
  check((await tool(bob.token, 'delete_data_source', { id: 'orders' })).error, 'only the owner can delete a data source');

  // queries
  const byChannel = await tool(alex.token, 'query_data', { source: 'orders', query: { measure: { op: 'count' }, groupBy: 'Channel' } });
  check(byChannel.records === 700 && byChannel.rows?.length === 3 && byChannel.value === 700, 'count by channel reads both pages (700 rows)');
  const sum = await tool(alex.token, 'query_data', { source: 'orders', query: { measure: { op: 'sum', field: 'Amount' } } });
  check(sum.value === ORDERS.reduce((a, o) => a + o.Amount, 0), 'sum of a number field');
  const tags = await tool(alex.token, 'query_data', { source: 'orders', query: { measure: { op: 'count' }, groupBy: 'Tags' } });
  check(tags.rows?.find((r: { key: string }) => r.key === 'new')?.value === 700 && tags.rows?.find((r: { key: string }) => r.key === 'vip')?.value === 350, 'multi-select counts once per option');
  const formula = await tool(alex.token, 'query_data', { source: 'orders', query: { measure: { op: 'max', field: 'Score' } } });
  check(formula.value === 4, 'formula values are unwrapped');
  const monthly = await tool(alex.token, 'query_data', { source: 'orders', query: { measure: { op: 'count' }, date: { field: 'Date', bucket: 'month', last: 3 } } });
  check(monthly.buckets?.length === 3 && monthly.stat?.trend?.length === 3 && typeof monthly.stat?.value === 'number', 'monthly buckets with trend for KPI tiles');
  const filtered = await tool(alex.token, 'query_data', { source: 'orders', query: { measure: { op: 'count' }, where: [{ field: 'Channel', op: 'is', value: 'API' }] } });
  check(filtered.value === 234, 'where filters are passed to Lark');
  check((await tool(alex.token, 'query_data', { source: 'orders', query: { measure: { op: 'sum', field: 'Nope' } } })).error?.includes('Fields:'), 'unknown field names list the real ones');
  const done = await tool(alex.token, 'query_data', { source: 'orders', query: { measure: { op: 'count' }, date: { field: 'Date', bucket: 'month', last: 3, complete: true } } });
  check(done.buckets?.length === 3 && !done.buckets.includes(monthly.buckets.at(-1)) && done.buckets.at(-1) === monthly.buckets.at(-2), 'complete: true ends with the last finished month');

  // home page modules
  const layout = { modules: [
    { type: 'chart', kind: 'bar', title: { 'zh-CN': '渠道', en: 'Channels' }, source: { data: 'orders', query: { measure: { op: 'count' }, groupBy: 'Channel' } } },
    { type: 'stats', items: [{ label: { 'zh-CN': '本月订单', en: 'Orders this month' }, source: { data: 'orders', query: { measure: { op: 'count' }, date: { field: 'Date', bucket: 'month', last: 2 } } } }] },
    { type: 'alerts' },
  ] };
  check((await tool(alex.token, 'save_homepage', { scope: 'me', layout })).saved === true, 'home page with Base charts, KPI and alerts module');
  check((await tool(alex.token, 'preview_homepage', { scope: 'me', layout: { modules: [{ type: 'chart', kind: 'gantt', source: { data: 'orders', query: { measure: { op: 'count' } } } }] } })).error?.includes('gantt'), 'chart kinds that cannot take Base data are rejected');
  const chart = await api(alex.jar, 'POST', '/data/module', { source: 'orders', kind: 'bar', query: layout.modules[0].source!.query });
  const cfg = chart.body.value as { categories: string[]; series: { values: number[] }[] };
  check(chart.status === 200 && cfg.categories.length === 3 && cfg.series[0].values.reduce((a, b) => a + b, 0) === 700, 'home chart data comes back as a bar chart config');
  const stat = await api(alex.jar, 'POST', '/data/module', { source: 'orders', kind: 'stat', query: { measure: { op: 'count' }, date: { field: 'Date', bucket: 'month', last: 2 } } });
  check(Array.isArray((stat.body.value as { trend: number[] }).trend), 'KPI tile gets value + trend');
  const bobView = await api(bob.jar, 'POST', '/data/module', { source: 'orders', kind: 'bar', query: { measure: { op: 'count' } } });
  check(bobView.status === 400 && bobView.body.code === 'err.lark.notConnected', 'someone without Lark data connected gets the connect prompt, not Alex\'s numbers');

  // alerts: for now only hub admins (Alex) get Lark messages
  const rule = await tool(alex.token, 'save_alert_rule', {
    title: { 'zh-CN': '订单总数', en: 'Total orders' }, source: 'orders', query: { measure: { op: 'count' } },
    condition: { type: 'above', value: 500 }, recipients: ['alice@example.com'], every_minutes: 60,
  });
  check(typeof rule.id === 'number' && String(rule.note).includes('admins'), 'save_alert_rule says messages only go to admins for now');
  check((await tool(alex.token, 'save_alert_rule', { title: { en: 'x' }, source: 'orders', query: { measure: { op: 'count' } }, condition: { type: 'change', direction: 'drop', ratio: 0.2 } })).error, 'a change condition without date buckets is rejected');
  const fired = await tool(alex.token, 'check_alert_rule', { id: rule.id });
  check(fired.state === 'firing' && fired.messages?.sent === 1, 'rule fires above the threshold');
  check(lark.messages.length === 1 && lark.messages[0].id === 'ou_dev_alex' && lark.messages[0].text.includes('Total orders'), 'only the admin is messaged; Alice (not an admin) is not');
  const again = await tool(alex.token, 'check_alert_rule', { id: rule.id });
  check(again.messages?.sent === 0 && lark.messages.length === 1, 'no repeat message while it keeps firing');
  const aliceAlerts = await api(alice.jar, 'GET', '/alerts');
  const bobAlerts = await api(bob.jar, 'GET', '/alerts');
  check((aliceAlerts.body.alerts as { state: string }[])[0]?.state === 'firing' && (bobAlerts.body.alerts as unknown[]).length === 0, 'recipients still see the alert on their home page; others do not');
  await tool(alex.token, 'save_alert_rule', { id: rule.id, title: { 'zh-CN': '订单总数', en: 'Total orders' }, source: 'orders', query: { measure: { op: 'count' } }, condition: { type: 'above', value: 5000 }, recipients: ['alice@example.com'] });
  const calm = await tool(alex.token, 'check_alert_rule', { id: rule.id });
  check(calm.state === 'ok' && calm.messages?.sent === 0, 'edited rule re-evaluates quietly');
  check((await tool(alice.token, 'delete_alert_rule', { id: rule.id })).error, 'recipients cannot delete the rule');

  // admins can widen it: then recipients and groups are messaged too
  check((await api(alice.jar, 'POST', '/admin/alerts', { notify: 'everyone' })).status === 400, 'only admins change who gets messages');
  check((await api(alex.jar, 'POST', '/admin/alerts', { notify: 'everyone' })).status === 200, 'admin switches messages to everyone on the rule');
  const ruleB = await tool(alex.token, 'save_alert_rule', {
    title: { 'zh-CN': '企业订单', en: 'Enterprise orders' }, source: 'orders', query: { measure: { op: 'count' }, where: [{ field: 'Channel', op: 'is', value: '企业' }] },
    condition: { type: 'above', value: 100 }, recipients: ['alice@example.com'], chat_id: 'oc_team',
  });
  lark.messages = [];
  await tool(alex.token, 'check_alert_rule', { id: ruleB.id });
  check(lark.messages.map((m) => m.id).sort().join() === 'oc_team,ou_dev_alex,ou_dev_alice', 'with "everyone": owner, recipient and the group chat');

  // several rules due at once: one combined message per person
  const ruleC = await tool(alex.token, 'save_alert_rule', { title: { 'zh-CN': 'Skills 订单', en: 'Skills orders' }, source: 'orders', query: { measure: { op: 'count' }, where: [{ field: 'Channel', op: 'is', value: 'Skills' }] }, condition: { type: 'above', value: 100 } });
  const ruleD = await tool(alex.token, 'save_alert_rule', { title: { 'zh-CN': 'API 订单', en: 'API orders' }, source: 'orders', query: { measure: { op: 'count' }, where: [{ field: 'Channel', op: 'is', value: 'API' }] }, condition: { type: 'above', value: 100 } });
  lark.messages = [];
  await tool(alex.token, 'check_alert_rule', { id: ruleC.id, notify: false });
  await tool(alex.token, 'check_alert_rule', { id: ruleD.id });
  check(lark.messages.length === 1 && lark.messages[0].text.includes('(2)') && lark.messages[0].text.includes('Skills orders') && lark.messages[0].text.includes('API orders'), 'two rules firing together arrive as one message');

  // flapping inside the cooldown is merged: back to normal and firing again sends nothing new
  lark.messages = [];
  lark.hideApi = true;
  const down = await tool(alex.token, 'check_alert_rule', { id: ruleD.id });
  check(down.state === 'ok' && down.messages?.sent === 0, 'recovery within the cooldown is held back');
  lark.hideApi = false;
  const up = await tool(alex.token, 'check_alert_rule', { id: ruleD.id });
  check(up.state === 'firing' && up.messages?.sent === 0 && lark.messages.length === 0, 'flapping back to firing sends nothing (people were already told)');

  // opting out
  await api(alice.jar, 'POST', `/alerts/${ruleB.id}/mute`, { muted: true });
  check(!((await api(alice.jar, 'GET', '/alerts')).body.alerts as { id: number }[]).some((a) => a.id === ruleB.id), 'a recipient who opts out leaves the rule');
  await api(alex.jar, 'POST', `/alerts/${ruleD.id}/mute`, { muted: true });
  check(((await api(alex.jar, 'GET', '/alerts')).body.alerts as { id: number; muted: boolean }[]).find((a) => a.id === ruleD.id)?.muted === true, 'the owner can pause their own messages and still sees the rule');
  await api(alex.jar, 'POST', '/admin/alerts', { notify: 'admins' });

  // quiet hours (pure rule, 22-9 wraps midnight)
  const { isQuietHour } = await import('../server/data/quiet.ts');
  check(isQuietHour(23, '22-9') && isQuietHour(8, '22-9') && !isQuietHour(9, '22-9') && !isQuietHour(14, '22-9') && !isQuietHour(23, 'off'), 'quiet hours 22:00–09:00');

  // a table someone cannot open: the home card links to it so Lark can offer "request access"
  // (a source nobody has read yet, so no remembered access: Lark's answer applies at once)
  await tool(alex.token, 'save_data_source', { id: 'orders-copy', title: { en: 'Orders copy' }, url: 'https://x.larksuite.com/wiki/wikOrders?table=tblOrders' });
  lark.denyOrders = true;
  const denied = await api(alex.jar, 'POST', '/data/module', { source: 'orders-copy', kind: 'bar', query: { measure: { op: 'max', field: 'Amount' }, groupBy: 'Channel' } });
  check(denied.body.code === 'err.data.deniedSource' && String((denied.body.params as { url: string }).url).includes('wikOrders'), 'no access: the home card gets the table link to request access');
  lark.denyOrders = false;

  // a token Lark rejects once is refreshed and the call retried, instead of dropping the connection
  const before = lark.refreshes;
  lark.rejectOnce = true;
  const retried = await tool(alex.token, 'get_okrs', {});
  check(retried.objectives?.length === 2 && lark.refreshes === before + 1 && (await api(alex.jar, 'GET', '/lark/status')).body.connected === true, 'a rejected token is refreshed and retried; the connection stays');

  // data checks ("异常项")
  check((await tool(alex.token, 'save_data_source', { id: 'projects', title: { 'zh-CN': '项目表', en: 'Projects' }, url: 'https://x.larksuite.com/base/appOrders?table=tblProjects' })).saved, 'register the project table');
  const common = { source: 'projects', owner_field: '负责人', label_fields: ['项目名称', '客户'] };
  const c1 = await tool(alex.token, 'save_check', { ...common, title: { 'zh-CN': '已打款但没有打款日期', en: 'Paid but no payment date' }, level: 'error', team: { 'zh-CN': '财务', en: 'Finance' },
    spec: { kind: 'rows', all: [{ field: '状态', op: 'is', value: '已打款' }, { field: '打款日期', op: 'empty' }] } });
  check(c1.issues === 1 && c1.sample?.[0]?.label === '春季投放 · Tether' && c1.sample?.[0]?.owners?.[0] === '林小雨', 'rows check: paid but no payment date (1, owner Alice)');
  const c2 = await tool(alex.token, 'save_check', { ...common, title: { 'zh-CN': '打款早于签约', en: 'Paid before signing' }, level: 'error',
    spec: { kind: 'rows', all: [{ field: '打款日期', op: 'beforeField', other: '签约日期' }] } });
  check(c2.issues === 1 && c2.sample?.[0]?.owners?.[0] === '周明', 'cross-field check: payment date before signing date');
  const c3 = await tool(alex.token, 'save_check', { ...common, title: { 'zh-CN': '项目名称重复', en: 'Duplicate projects' }, level: 'verify', spec: { kind: 'duplicates', fields: ['项目名称'] } });
  check(c3.issues === 2, 'duplicates ignore case and spaces ("AI 大会" / "ai 大会 ")');
  const c4 = await tool(alex.token, 'save_check', { ...common, title: { 'zh-CN': '客户写法不统一', en: 'Client spelled differently' }, level: 'style', spec: { kind: 'variants', field: '客户' } });
  check(c4.issues === 1 && c4.sample?.[0]?.detail?.['→'] === 'Tether', 'variants: the odd spelling is flagged, with the usual one');
  const c5 = await tool(alex.token, 'save_check', { ...common, title: { 'zh-CN': '进行中但很久没更新', en: 'In progress, untouched' }, level: 'verify',
    spec: { kind: 'rows', all: [{ field: '状态', op: 'is', value: '进行中' }, { field: '修改时间', op: 'olderThanDays', value: 14 }] } });
  check(c5.issues === 1, 'stale rows: in progress and untouched for 14 days');
  check((await tool(alex.token, 'save_check', { ...common, title: { en: 'x' }, level: 'error', spec: { kind: 'rows', all: [{ field: '不存在', op: 'empty' }] } })).error?.includes('Fields:'), 'a check on a missing field is refused with the real field names');
  const byText = await tool(alex.token, 'query_data', { source: 'projects', query: { measure: { op: 'count' }, date: { field: '提交时间', bucket: 'month' } } });
  check(byText.records === 6 && byText.value === 1 && byText.buckets?.length === 1, 'a text field holding ISO dates works as a date');
  const named = await tool(alex.token, 'save_check', { source: 'projects', owner_field: '跟进人', label_fields: ['项目名称'], title: { 'zh-CN': '跟进人测试', en: 'Owner by name' }, level: 'verify',
    spec: { kind: 'rows', all: [{ field: '提交时间', op: 'olderThanDays', value: 30 }] } });
  check(named.issues === 1 && named.sample?.[0]?.owners?.[0] === '林小雨', 'owners written as names (here an email name in an option) are matched to colleagues; text dates work in checks');
  await tool(alex.token, 'delete_check', { id: named.id });
  check((await tool(alex.token, 'list_checks')).checks?.length === 5, 'list_checks');

  const alexView = await api(alex.jar, 'GET', '/issues');
  const counts = (v: typeof alexView) => v.body.counts as { mine: number; all: number; exceptions: number; byLevel: Record<string, number> };
  check(counts(alexView).all === 6 && counts(alexView).mine === 0 && counts(alexView).byLevel.error === 2, 'Alex (can open the table) sees all 6 issues, none assigned to him');
  const aliceView = await api(alice.jar, 'GET', '/issues');
  check(counts(aliceView).mine === 3 && counts(aliceView).all === 3, 'Alice (no Lark data connected) sees only her own 3 issues');
  const people = alexView.body.people as { name: string; count: number; errors: number }[];
  check(people[0]?.name === '林小雨' && people[0]?.count === 3 && people[0]?.errors === 1, 'counted by owner, with errors');
  check((await api(bob.jar, 'POST', '/issues/exception', { check: c1.id, record: 'recP1', on: true })).status === 400, 'someone else cannot dismiss Alice\'s issue');
  check((await api(alice.jar, 'POST', '/issues/exception', { check: c1.id, record: 'recP1', on: true, reason: '客户已线下付清' })).status === 200, 'the owner marks her issue as a confirmed exception');
  const afterEx = await api(alice.jar, 'GET', '/issues');
  check(counts(afterEx).mine === 2 && counts(afterEx).exceptions === 1, 'exceptions leave the list and are counted separately');
  await tool(alex.token, 'run_checks', { id: c1.id });
  check(counts(await api(alice.jar, 'GET', '/issues')).exceptions === 1, 'an exception survives the next run');
  lark.fixP1 = true;
  await api(alex.jar, 'POST', '/issues/run', {});
  check(counts(await api(alice.jar, 'GET', '/issues')).exceptions === 0 && (await tool(alex.token, 'list_checks')).checks[0].issues === 0, 'once the record is fixed, the issue (and its exception) are gone');
  check((await tool(alex.token, 'preview_homepage', { scope: 'me', layout: { modules: [{ type: 'issues', width: 'half' }] } })).previewUrl, 'home module "issues assigned to me"');
  check((await tool(alice.token, 'delete_check', { id: c2.id })).error, 'only the creator deletes a check');

  // apps using Lark as the person using them
  const { execFileSync } = await import('node:child_process');
  const appDir = mkdtempSync(path.join(tmpdir(), 'hub-invoice-'));
  (await import('node:fs')).writeFileSync(path.join(appDir, 'index.html'), '<!doctype html><title>invoice</title><script src="/__hub/sdk.js"></script>');
  execFileSync(process.execPath, ['scripts/admin.ts', 'publish-app', appDir, '--owner', 'alex@example.com', '--slug', 'invoice', '--visibility', 'company', '--localized', JSON.stringify({ 'zh-CN': { name: '开票助手', description: '申请开票' }, en: { name: 'Invoice helper', description: 'Request invoices' } })], { env: { ...process.env, DATA_DIR: dataDir, HUB_SECRET: 'smoke', DEV_LOGIN: '1', HUB_URL: HUB, LARK_APP_ID: 'cli_smoke', LARK_API_BASE: `http://localhost:${LARK_PORT}/open-apis` }, stdio: 'pipe' });
  const decl = await tool(alex.token, 'set_app_lark', { slug: 'invoice', lark: {
    tables: [{ name: 'projects', url: 'https://x.larksuite.com/base/appOrders?table=tblProjects', access: 'read' }, { name: 'requests', url: 'https://x.larksuite.com/base/appOrders?table=tblOrders', access: 'write' }],
    notify: { people: ['bob@example.com'], chats: [{ name: 'finance', id: 'oc_finance' }] },
  } });
  check(decl.declared?.tables?.length === 2 && String(decl.sdk).endsWith('/__hub/sdk.js'), 'set_app_lark declares tables and recipients');
  check((await tool(alice.token, 'set_app_lark', { slug: 'invoice', lark: { tables: [] } })).error, 'only the app owner declares its Lark access');
  const app = await loginToApp('invoice', alex.jar);
  check((await appFetch('invoice', '/__hub/sdk.js', app)).status === 200, 'the SDK is served on the app domain');
  const first = await appFetch('invoice', '/__hub/lark/tables/projects/records', app);
  const beforeBody = await first.json() as { error: string; consentUrl: string };
  check(first.status === 403 && beforeBody.error === 'consent_required' && beforeBody.consentUrl.includes('/auth/app-lark?app=invoice'), 'before agreeing, calls answer consent_required with the consent link');
  const page = await (await fetch(beforeBody.consentUrl, { headers: { cookie: alex.jar.header() } })).text();
  check(page.includes('projects') && page.includes('requests') && page.includes('oc_finance') === false && page.includes('finance'), 'the consent page lists the tables and recipients');
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1];
  check((await fetch(`${HUB}/auth/app-lark`, { method: 'POST', redirect: 'manual', headers: { cookie: alex.jar.header() }, body: new URLSearchParams({ app: 'invoice', return: '/', decision: 'allow' }) })).status === 403, 'consent without its token is refused');
  const allow = await fetch(`${HUB}/auth/app-lark`, { method: 'POST', redirect: 'manual', headers: { cookie: alex.jar.header() }, body: new URLSearchParams({ app: 'invoice', return: '/', decision: 'allow', csrf }) });
  const goLoc = allow.headers.get('location') ?? '';
  const loc = (await fetch(`${HUB}${goLoc}`, { redirect: 'manual', headers: { cookie: alex.jar.header() } })).headers.get('location') ?? '';
  check(goLoc.startsWith('/auth/app-lark/go') && loc.startsWith('/auth/lark/connect') && loc.includes('write=1'), 'a writable table sends the person to grant Lark write access');
  // follow the connect flow (asks for bitable:app), then back to the app
  const startW = await fetch(`${HUB}${loc}`, { redirect: 'manual', headers: { cookie: alex.jar.header() } });
  alex.jar.store(startW);
  const authW = await fetch(startW.headers.get('location')!, { redirect: 'manual' });
  check(lark.scopesAsked.includes('bitable:app') && lark.scopesAsked.includes('bitable:app:readonly'), 'write access is asked for only now');
  const cbW = await fetch(authW.headers.get('location')!, { redirect: 'manual', headers: { cookie: alex.jar.header() } });
  alex.jar.store(cbW);
  const go = await fetch(`${HUB}${cbW.headers.get('location')}`, { redirect: 'manual', headers: { cookie: alex.jar.header() } });
  check(go.headers.get('location') === 'http://invoice.apps.localhost:18930/', 'and back to the app');
  const listed = await (await appFetch('invoice', '/__hub/lark/tables/projects/records', app)).json() as { records: { id: string; text: Record<string, string> }[] };
  check(listed.records?.length === 6 && listed.records[0].text['项目名称'] === '春季投放', 'the app reads a declared table as the person');
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => appFetch('invoice', path, app, { 'content-type': 'application/json', ...extra }, 'POST', JSON.stringify(body));
  check((await post('/__hub/lark/tables/projects/records', { fields: { 项目名称: 'x' } })).status === 400, 'read-only tables cannot be written');
  const added = await (await post('/__hub/lark/tables/requests/records', { fields: { Name: '开票申请', Amount: 12000 } })).json() as { id: string };
  check(added.id === 'recNew1' && lark.created[0]?.fields.Amount === 12000, 'the app adds a record to a writable table');
  check((await appFetch('invoice', '/__hub/lark/tables/requests/records/recNew1', app, { 'content-type': 'application/json' }, 'PATCH', JSON.stringify({ fields: { Status: '已开票' } }))).status === 200 && lark.updated[0]?.record === 'recNew1', 'and updates it');
  check((await post('/__hub/lark/tables/secret/records', { fields: {} })).status === 400, 'undeclared tables are refused');
  check((await post('/__hub/lark/tables/requests/records', { fields: {} }, { origin: 'https://evil.example' })).status === 403, 'cross-site writes are refused');
  lark.messages = [];
  const told = await (await post('/__hub/notify', { to: ['bob@example.com', 'finance'], text: '有一张新的开票申请', link: 'https://invoice.example/req/1' })).json() as { sent: number };
  check(told.sent === 2 && lark.messages.map((m) => m.id).sort().join() === 'oc_finance,ou_dev_bob' && lark.messages[0].text.includes('Alex'), 'notify reaches declared people and groups, naming who sent it');
  check((await post('/__hub/notify', { to: ['alice@example.com'], text: 'hi' })).status === 400, 'undeclared recipients are refused');
  // a container app's server: the ticket from the gateway, no cookie
  // same secret and database as the hub under test, so tickets made here are the ones the gateway would pass on
  Object.assign(process.env, { HUB_SECRET: 'smoke', DATA_DIR: dataDir, DEV_LOGIN: '1', HUB_URL: HUB, LARK_APP_ID: 'cli_smoke' });
  const { issueTicket } = await import('../server/apps/larkApi.ts');
  const viaServer = await appFetch('invoice', '/__hub/lark/tables/projects/records', undefined, { 'x-hub-ticket': issueTicket('invoice', 'ou_dev_alex') });
  check(viaServer.status === 200 && ((await viaServer.json()) as { records: unknown[] }).records.length === 6, 'a container app server reads with the ticket it was given (no cookie)');
  check((await appFetch('invoice', '/__hub/lark/tables/projects/records', undefined, { 'x-hub-ticket': issueTicket('other-app', 'ou_dev_alex') })).status === 401, 'a ticket for another app is refused');
  const forged = await appFetch('invoice', '/__hub/lark/tables/projects/records', undefined, { 'x-hub-ticket': 'bad.ticket' });
  check(forged.status === 401, 'a forged server ticket is refused');
  const appInfo = await api(alex.jar, 'GET', '/apps/invoice');
  check((appInfo.body.lark as { consented: boolean }).consented === true, 'the app page shows the person agreed');
  await api(alex.jar, 'DELETE', '/apps/invoice/lark-consent', {});
  check((await appFetch('invoice', '/__hub/lark/tables/projects/records', app)).status === 403, 'after taking it back, the app must ask again');

  // mail drafts: declared, agreed to, and saved in the person's own mailbox (never sent)
  check((await post('/__hub/lark/mail/drafts', { to: ['a@b.com'], subject: 's', text: 't' })).status === 403, 'mail drafts need consent first');
  await tool(alex.token, 'set_app_lark', { slug: 'invoice', lark: {
    tables: [{ name: 'projects', url: 'https://x.larksuite.com/base/appOrders?table=tblProjects', access: 'read' }], mail_drafts: true,
  } });
  const mailPage = await (await fetch(`${HUB}/auth/app-lark?app=invoice&return=/`, { headers: { cookie: alex.jar.header() } })).text();
  check(mailPage.includes('draft') || mailPage.includes('草稿'), 'the consent page says the app saves mail drafts');
  const mailCsrf = /name="csrf" value="([^"]+)"/.exec(mailPage)![1];
  const mailAllow = await fetch(`${HUB}/auth/app-lark`, { method: 'POST', redirect: 'manual', headers: { cookie: alex.jar.header() }, body: new URLSearchParams({ app: 'invoice', return: '/', decision: 'allow', csrf: mailCsrf }) });
  // after "Allow", the go step sends the person to connect Google (Gmail), which comes back to it and on to the app
  const follow = async (path: string) => {
    const r = await fetch(path.startsWith('http') ? path : `${HUB}${path}`, { redirect: 'manual', headers: { cookie: alex.jar.header() } });
    alex.jar.store(r);
    return r.headers.get('location') ?? '';
  };
  const toGoogle = await follow(mailAllow.headers.get('location') ?? '');
  check(toGoogle.includes('/auth/google/connect'), 'mail drafts in Gmail send the person to connect Google');
  lark.googleEmail = 'alex@personal.example';
  const wrongBack = await follow(await follow(await follow(toGoogle)));
  check(wrongBack === '' && (await api(alex.jar, 'GET', '/google/status')).body.connected === false, 'a Google account on another domain is refused');
  lark.googleEmail = 'alex@example.com';
  const authG = await follow(toGoogle);
  check(lark.googleScope.includes('https://www.googleapis.com/auth/gmail.compose') && authG.includes('access_type=offline'), 'it asks Google for gmail.compose with offline access');
  const backToGo = await follow(await follow(authG));
  check(backToGo.startsWith('/auth/app-lark/go') && (await follow(backToGo)) === 'http://invoice.apps.localhost:18930/', 'and comes back to the app');
  const gs = (await api(alex.jar, 'GET', '/google/status')).body;
  check(gs.connected === true && gs.email === 'alex@example.com', 'the Me page shows the connected Google account');
  const drafted = await post('/__hub/lark/mail/drafts', { to: ['client@example.com'], cc: ['林小雨'], subject: '合作确认函', html: '<p>感谢您的支持</p>' });
  const draftBody = await drafted.json() as { saved: boolean; draftId: string; url: string };
  const eml = lark.gmail[0] ?? '';
  check(drafted.status === 200 && draftBody.saved && draftBody.draftId === 'r-1' && draftBody.url.includes('mail.google.com'), 'the app saves a draft in Gmail, with a link to it');
  check(eml.includes('From: alex@example.com\r\n') && eml.includes('To: client@example.com') && eml.includes('Cc: alice@example.com') && eml.includes('Subject: =?UTF-8?B?')
    && Buffer.from(eml.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString('utf8').includes('感谢您的支持'),
    'as EML (CRLF) from the Google account, colleagues by name turned into their email, non-ASCII encoded');
  check((await post('/__hub/lark/mail/drafts', { to: ['nobody-here'], subject: 's', text: 't' })).status === 400, 'unknown recipients are refused');
  rmSync(appDir, { recursive: true, force: true });

  // data boards, organisation, search
  const boardLayout = { modules: [{ type: 'chart', kind: 'bar', title: { 'zh-CN': '各渠道订单', en: 'Orders by channel' }, source: { data: 'orders', query: { measure: { op: 'count' }, groupBy: 'Channel' } } }, { type: 'issues', width: 'half' }] };
  check((await tool(alice.token, 'save_board', { id: 'company-sales', title: { 'zh-CN': '销售', en: 'Sales' }, layout: boardLayout })).error, 'only admins build company boards');
  const saved2 = await tool(alex.token, 'save_board', { id: 'company-sales', title: { 'zh-CN': '销售周报', en: 'Sales weekly' }, layout: boardLayout });
  check(saved2.saved && String(saved2.url).endsWith('/data?board=company-sales'), 'an admin saves a company board');
  check((await tool(alex.token, 'save_board', { id: 'bad', title: { en: 'x' }, layout: { modules: [{ type: 'chart', kind: 'gantt', source: { data: 'orders', query: { measure: { op: 'count' } } } }] } })).error, 'boards are validated like home pages');
  const seen = await api(alice.jar, 'GET', '/boards');
  check((seen.body.boards as { id: string; canEdit: boolean }[]).some((b) => b.id === 'company-sales' && !b.canEdit), 'everyone sees company boards, without editing them');
  const org = await api(alice.jar, 'GET', '/org');
  check((org.body.people as { name: string }[]).some((p) => p.name === '周明'), 'the organisation page lists colleagues');
  const found = await api(alice.jar, 'GET', '/search?q=' + encodeURIComponent('开票'));
  check((found.body.apps as { slug: string }[]).some((x) => x.slug === 'invoice'), 'search finds apps');
  const foundPeople = await api(alice.jar, 'GET', '/search?q=' + encodeURIComponent('周'));
  check((foundPeople.body.people as { name: string }[]).some((p) => p.name === '周明') && (await api(alice.jar, 'GET', '/search?q=' + encodeURIComponent('销售'))).body.boards instanceof Array, 'search finds people and boards');
  check(((await api(alice.jar, 'GET', '/search?q=' + encodeURIComponent('销售'))).body.boards as { id: string }[]).some((b) => b.id === 'company-sales'), 'search finds data boards');

  // data apps: rows served by a hub app (here a static JSON file, as a Metabase / database wrapper would serve them)
  const publish = (dir: string, slug: string, visibility: string) => execFileSync(process.execPath, ['scripts/admin.ts', 'publish-app', dir, '--owner', 'alex@example.com', '--slug', slug, '--visibility', visibility,
    '--localized', JSON.stringify({ 'zh-CN': { name: slug, description: slug }, en: { name: slug, description: slug } })],
    { env: { ...process.env, DATA_DIR: dataDir, HUB_SECRET: 'smoke', DEV_LOGIN: '1', HUB_URL: HUB, LARK_APP_ID: 'cli_smoke', LARK_API_BASE: `http://localhost:${LARK_PORT}/open-apis` }, stdio: 'pipe' });
  const fsm = await import('node:fs');
  const rowsDir = mkdtempSync(path.join(tmpdir(), 'hub-rows-'));
  const signups = Array.from({ length: 40 }, (_, i) => ({
    _id: `u${i}`, _url: `https://metabase.example/question/169?id=u${i}`,
    country: ['BR', 'US', 'JP'][i % 3], paid_usd: i % 4 === 0 ? 5 : 0, plan: i % 4 === 0 ? 'paid' : 'free',
    registered_at: new Date(NOW - (i % 20) * DAY).toISOString(), owner: i % 2 ? 'alice' : '周明',
  }));
  fsm.writeFileSync(path.join(rowsDir, 'rows.json'), JSON.stringify({ rows: signups }));
  fsm.writeFileSync(path.join(rowsDir, 'noids.json'), JSON.stringify([{ a: 1 }, { a: 2 }]));
  fsm.writeFileSync(path.join(rowsDir, 'bad.json'), JSON.stringify({ hello: 'world' }));
  fsm.writeFileSync(path.join(rowsDir, 'index.html'), 'rows');
  publish(rowsDir, 'metrics', 'company');
  publish(rowsDir, 'secret-metrics', 'private');
  const insp = await tool(alex.token, 'inspect_app_data', { app: 'metrics', path: '/rows.json' });
  const types = Object.fromEntries((insp.fields ?? []).map((f: { name: string; type: string }) => [f.name, f.type]));
  check(insp.rows === 40 && insp.withIds === 40 && types.registered_at === 'DateTime' && types.paid_usd === 'Number' && types.country === 'Text', 'inspect_app_data infers fields (dates, numbers, text) and counts ids');
  check((await tool(alex.token, 'save_data_source', { id: 'bad-app', title: { en: 'x' }, app: 'metrics', path: '/bad.json' })).error?.includes('rows'), 'an app that does not serve rows is refused with the expected shape');
  check((await tool(alex.token, 'save_data_source', { id: 'signups', title: { 'zh-CN': '注册（Metabase）', en: 'Sign-ups (Metabase)' }, app: 'metrics', path: '/rows.json' })).saved, 'save_data_source with app + path');
  const byCountry = await tool(alex.token, 'query_data', { source: 'signups', query: { measure: { op: 'count' }, groupBy: 'country' } });
  const paidSum = await tool(alex.token, 'query_data', { source: 'signups', query: { measure: { op: 'sum', field: 'paid_usd' }, where: [{ field: 'plan', op: 'is', value: 'paid' }] } });
  const weekly = await tool(alex.token, 'query_data', { source: 'signups', query: { measure: { op: 'count' }, date: { field: 'registered_at', bucket: 'week', last: 4 } } });
  check(byCountry.rows?.length === 3 && byCountry.value === 40 && paidSum.value === 50 && weekly.buckets?.length === 4, 'queries work on app rows: groups, sums with filters, weekly buckets');
  const aliceChart = await api(alice.jar, 'POST', '/data/module', { source: 'signups', kind: 'bar', query: { measure: { op: 'count' }, groupBy: 'country' } });
  check(aliceChart.status === 200, 'colleagues who can open the app see its data (no Lark connection needed)');
  await tool(alex.token, 'save_data_source', { id: 'secret-signups', title: { en: 'Secret' }, app: 'secret-metrics', path: '/rows.json' });
  const hiddenChart = await api(alice.jar, 'POST', '/data/module', { source: 'secret-signups', kind: 'bar', query: { measure: { op: 'count' }, groupBy: 'country' } });
  check(hiddenChart.status === 400 && hiddenChart.body.code === 'err.data.deniedSource' && String((hiddenChart.body.params as { url: string }).url).endsWith('/apps/secret-metrics'), 'a private app\'s data stays private');

  // the fireflies on the home page: today's new apps the viewer can open, and how many people used the hub
  const pulseAlex = (await api(alex.jar, 'GET', '/home')).body.pulse as { people: number; events: { kind: string; url: string; who: string }[] };
  const pulseBob = (await api(bob.jar, 'GET', '/home')).body.pulse as { people: number; events: { kind: string; url: string }[] };
  check(pulseAlex.events.some((e) => e.url === '/apps/secret-metrics' && e.kind === 'appNew' && e.who === 'Alex') && pulseAlex.events.some((e) => e.url === '/apps/invoice'), "today's new apps show on the owner's home");
  check(!pulseBob.events.some((e) => e.url === '/apps/secret-metrics') && pulseBob.events.some((e) => e.url === '/apps/invoice'), 'a private app is not announced to colleagues who cannot open it');
  check(pulseAlex.people >= 3 && (pulseAlex as unknown as { who: { name: string }[] }).who.some((p) => p.name === '林小雨'), 'and who used the hub today');
  const appCheck = await tool(alex.token, 'save_check', { source: 'signups', title: { 'zh-CN': '付费但金额为 0', en: 'Paid with no amount' }, level: 'error', owner_field: 'owner', label_fields: ['country'],
    spec: { kind: 'rows', all: [{ field: 'plan', op: 'is', value: 'free' }, { field: 'registered_at', op: 'olderThanDays', value: 15 }] } });
  check(appCheck.issues > 0 && appCheck.sample?.some((x: { owners: string[] }) => x.owners[0] === '林小雨'), 'data checks run on app rows and assign owners by name');
  const aliceIssues = await api(alice.jar, 'GET', '/issues');
  const appRow = (aliceIssues.body.checks as { id: number; rows: { url: string }[] }[]).find((c) => c.id === appCheck.id)?.rows[0];
  check(appRow?.url.startsWith('https://metabase.example/question/169'), 'issues link back to the row in its own system (_url)');
  check((await tool(alex.token, 'save_data_source', { id: 'noids', title: { en: 'x' }, app: 'metrics', path: '/noids.json' })).saved
    && (await tool(alex.token, 'save_check', { source: 'noids', title: { en: 'x' }, level: 'error', label_fields: ['a'], spec: { kind: 'rows', all: [{ field: 'a', op: 'gt', value: 0 }] } })).error?.includes('_id'), 'checks on rows without _id explain what is missing');
  const appAlert = await tool(alex.token, 'save_alert_rule', { title: { en: 'Free sign-ups' }, source: 'signups', query: { measure: { op: 'count' }, where: [{ field: 'plan', op: 'is', value: 'free' }] }, condition: { type: 'above', value: 10 } });
  check((await tool(alex.token, 'check_alert_rule', { id: appAlert.id, notify: false })).state === 'firing', 'metric alerts work on app rows');
  rmSync(rowsDir, { recursive: true, force: true });

  // company OKR page
  const board = await api(alex.jar, 'GET', '/okr/board');
  const b = board.body as { nodes: { id: string; alignsTo: string[] }[]; company: { owner: { name: string }; objectives: string[] }; unaligned: string[]; pace: { person: { name: string }; done: number }[]; people: { hidden: { name: string }[] }; period: { id: string } };
  check(board.status === 200 && b.period?.id === 'p-now' && b.nodes.length === 3, 'the OKR page gathers everyone\'s objectives for the current period');
  check(b.company?.owner?.name === 'Alex' && b.company.objectives.join() === 'o1,o2', 'company objectives: whoever the most objectives align to');
  check(b.nodes.find((n) => n.id === 'a1')?.alignsTo.join() === 'o1' && b.unaligned.length === 0, 'Alice\'s objective hangs under the company objective it supports');
  check(b.people.hidden.some((p) => p.name === '周明') && b.pace.length === 2, 'people whose OKRs Lark hides are listed as hidden; pace per person');
  const prog = (board.body as { progress: { total: number; people: number; recent: { text: string; owner: { name: string }; on: string }[] } }).progress;
  check(prog.total === 3 && prog.people === 2, 'the OKR board counts progress updates and who wrote them');
  check(prog.recent.map((r) => r.text).join('|') === '新签 12 家|渠道周报|调用量本周破 1.3 亿，@林小雨 在跟进' && prog.recent[0].on === '出海电商渠道 150 家' && prog.recent[0].owner.name === 'Alex',
    'recent progress, newest first, as text (links by title, people as @name) with what it was written on');
  check((await api(alice.jar, 'POST', '/admin/okr-owner', { owner: 'ou_dev_alice' })).status === 400, 'only admins choose whose OKRs are the company\'s');
  await api(alex.jar, 'POST', '/admin/okr-owner', { owner: 'ou_dev_alice' });
  const b2 = (await api(alex.jar, 'GET', '/okr/board')).body as typeof b;
  check(b2.company.objectives.join() === 'a1' && b2.unaligned.length === 2, 'an admin can name the company OKR owner');
  await api(alex.jar, 'POST', '/admin/okr-owner', { owner: null });
  check((await tool(alex.token, 'get_company_okrs', {})).nodes?.length === 3, 'get_company_okrs for agents');

  // OKR
  check(lark.scopesAsked.includes('okr:okr:readonly'), 'connect also asks for OKR read access');
  const okr = await tool(alex.token, 'get_okrs', {});
  check(okr.period?.id === 'p-now' && okr.objectives?.length === 2 && typeof okr.elapsed === 'number' && okr.elapsed > 0 && okr.elapsed < 1, 'get_okrs picks the current period from its name and says how much has passed');
  check(okr.objectives?.[0]?.progress === 0.62 && okr.objectives?.[1]?.progress === 0.2 && okr.done === 0.41, 'objective progress from Lark, or averaged from its key results');
  check((await tool(alex.token, 'get_okrs', { colleague: 'bob@example.com' })).error?.includes('OKR'), 'OKRs Lark does not let you see are refused');
  check((await tool(alex.token, 'list_okr_periods')).periods?.length === 2 && (await api(alex.jar, 'GET', '/lark/status')).body.connected === true, 'list_okr_periods falls back to the periods in the person\'s OKRs (the period API takes no user tokens) and keeps the connection');
  const okrApi = await api(alex.jar, 'GET', '/okr');
  check(okrApi.status === 200 && (okrApi.body.objectives as unknown[]).length === 2, 'home OKR module data');
  check((await api(bob.jar, 'GET', '/okr')).body.code === 'err.lark.notConnected', 'OKR card asks people to connect first');
  check((await tool(alex.token, 'preview_homepage', { scope: 'company', layout: { modules: [{ type: 'okr', width: 'half' }] } })).previewUrl, 'an okr module fits a company-wide layout');

  // disconnect
  await api(alex.jar, 'POST', '/lark/disconnect', {});
  check((await api(alex.jar, 'GET', '/lark/status')).body.connected === false, 'disconnect forgets the tokens');

  // feedback on apps and who uses them
  const aliceInvoice = await loginToApp('invoice', alice.jar);
  await appFetch('invoice', '/', aliceInvoice);
  const appList = (await api(alice.jar, 'GET', '/apps')).body.apps as { slug: string; usage30: number; isNew: boolean }[];
  check(appList.find((x) => x.slug === 'invoice')?.usage30 === 1 && appList.find((x) => x.slug === 'invoice')?.isNew, 'app cards count colleagues who opened it (not the owner) and mark new apps');
  lark.messages = [];
  const fb = await api(alice.jar, 'POST', '/apps/invoice/feedback', { body: '开票类型里缺少“专票”' });
  check(fb.status === 200 && fb.body.status === 'open', 'a colleague leaves feedback on an app');
  await new Promise((r) => setTimeout(r, 300));
  check(lark.messages.length === 1 && lark.messages[0].id === 'ou_dev_alex' && lark.messages[0].text.includes('专票'), 'the owner is messaged');
  check((await api(alice.jar, 'POST', '/apps/invoice/feedback', { body: 'x' })).status === 400, 'feedback that is too short is refused');
  const bobFb = await api(bob.jar, 'GET', '/apps/invoice');
  check((bobFb.body.feedback as unknown[]).length === 0 && bobFb.body.usage === null, "others see neither someone else's feedback nor usage details");
  const ownerView = await api(alex.jar, 'GET', '/apps/invoice');
  check((ownerView.body.feedback as { body: string }[])[0]?.body.includes('专票') && (ownerView.body.usage as { last30: number }).last30 === 1 && (ownerView.body.app as { openFeedback: number }).openFeedback === 1,
    'the owner sees all feedback, usage per day and the open count');
  const todo = await tool(alex.token, 'list_app_feedback', {});
  check(todo.items?.length === 1 && todo.items[0].author.name === '林小雨', "the owner's agent lists open feedback on their apps");
  check(String((await tool(alice.token, 'resolve_app_feedback', { id: todo.items[0].id, status: 'done' })).error).length > 0, 'only the owner can resolve it');
  lark.messages = [];
  const resolved = await tool(alex.token, 'resolve_app_feedback', { id: todo.items[0].id, status: 'done', reply: '加上了' });
  await new Promise((r) => setTimeout(r, 300));
  check(resolved.status === 'done' && lark.messages.length === 1 && lark.messages[0].id === 'ou_dev_alice' && lark.messages[0].text.includes('加上了'), 'resolving it tells the colleague, with the reply');
  check((await tool(alex.token, 'list_app_feedback', {})).items.length === 0, 'and it leaves the open list');

  // asking to open an app to everyone messages the admins; their decision messages the owner
  lark.messages = [];
  const pubDir = mkdtempSync(path.join(tmpdir(), 'hub-pub-'));
  (await import('node:fs')).writeFileSync(path.join(pubDir, 'index.html'), '<h1>open</h1>');
  execFileSync(process.execPath, ['scripts/admin.ts', 'publish-app', pubDir, '--owner', 'alice@example.com', '--slug', 'open-demo', '--visibility', 'company',
    '--localized', JSON.stringify({ 'zh-CN': { name: '公开演示', description: '演示' }, en: { name: 'Open demo', description: 'Demo' } })],
    { env: { ...process.env, DATA_DIR: dataDir, HUB_SECRET: 'smoke', DEV_LOGIN: '1', HUB_URL: HUB, LARK_APP_ID: 'cli_smoke', LARK_API_BASE: `http://localhost:${LARK_PORT}/open-apis` }, stdio: 'pipe' });
  rmSync(pubDir, { recursive: true, force: true });
  check((await tool(alice.token, 'set_app_access', { slug: 'open-demo', visibility: 'public' })).publicStatus === 'pending', 'the owner asks to open it to everyone');
  await new Promise((r) => setTimeout(r, 300));
  check(lark.messages.length === 1 && lark.messages[0].id === 'ou_dev_alex' && lark.messages[0].text.includes('/admin'), 'a public request messages the admins with a link to approve');
  lark.messages = [];
  check((await api(alex.jar, 'POST', '/admin/apps/open-demo/public', { approve: true })).status === 200, 'the admin approves it');
  await new Promise((r) => setTimeout(r, 300));
  check(lark.messages.length === 1 && lark.messages[0].id === 'ou_dev_alice', 'and the owner is told');

  // GitHub: link the account once, then agents read commits, pull requests and reviews through the hub
  const notLinked = await tool(alex.token, 'github_activity', {});
  check(notLinked.linked === false && String(notLinked.hint).includes('/auth/github/connect'), 'before linking, github_activity says how to link GitHub');
  const ghStart = await fetch(`${HUB}/auth/github/connect?return=/me`, { redirect: 'manual', headers: { cookie: alex.jar.header() } });
  alex.jar.store(ghStart);
  const ghAuth = await fetch(ghStart.headers.get('location')!, { redirect: 'manual' });
  const ghBack = await fetch(ghAuth.headers.get('location')!, { redirect: 'manual', headers: { cookie: alex.jar.header() } });
  check(ghBack.status === 302 && ghBack.headers.get('location') === '/me', 'linking GitHub returns to the Me page');
  const ghStatus = (await api(alex.jar, 'GET', '/github/status')).body;
  check(ghStatus.available === true && ghStatus.login === 'alex-gh' && ghStatus.org === 'acme', 'the Me page shows the linked GitHub username');
  const act = await tool(alex.token, 'github_activity', {});
  check(act.login === 'alex-gh' && act.commits?.map((c: { sha: string }) => c.sha).join() === 'aaaaaaa,bbbbbbb', "commits: the person's own, on the default branch and inside their pull request, within the window");
  check(act.commits[0].message === 'fix: gateway keeps the session' && act.commits[1].pr === 12, 'with the first line of the message, and the pull request for branch work');
  check(act.pullRequests?.map((p: { number: number; state: string }) => `${p.number}:${p.state}`).join() === '12:open,11:merged' && act.reviewed?.[0]?.number === 9, 'pull requests opened (open / merged) and reviewed');
  check(lark.ghQueries.some((q) => q.startsWith('org:acme author:alex-gh author-date:')), 'searches stay inside the organisation');
  const aliceGh = await tool(alex.token, 'github_activity', { colleague: '林小雨' });
  check(aliceGh.linked === false, "a colleague who has not linked GitHub is reported as such");
  check(String((await tool(alex.token, 'github_activity', { since: '2026-10-20T10:00:00Z', until: '2026-10-19T10:00:00Z' })).error).length > 0, 'a backwards window is refused');

  // GitHub pushes to the hub: branch work without a pull request is counted too
  const push = (body: unknown, secret = 'hook-secret', event = 'push') => {
    const raw = JSON.stringify(body);
    const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
    return fetch(`${HUB}/hooks/github`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sig } });
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const pushBody = (owner: string, ref: string) => ({
    ref, repository: { full_name: `${owner}/hub`, owner: { login: owner } },
    commits: [
      { id: 'eeeeeee5555', message: 'wip: daily report writer\n\nmore', timestamp: iso(NOW - 3 * 3600_000), url: 'https://github.com/acme/hub/commit/eeeeeee', author: { email: 'alex@x.test', username: 'Alex-GH' } },
      { id: 'aaaaaaa1111', message: 'fix: gateway keeps the session', timestamp: iso(NOW - 3600_000), url: 'https://github.com/acme/hub/commit/aaaaaaa', author: { username: 'alex-gh' } },
      { id: 'fffffff6666', message: 'someone else', timestamp: iso(NOW - 3600_000), url: 'https://github.com/acme/hub/commit/fffffff', author: { username: 'other' } },
    ],
  });
  check((await push(pushBody('acme', 'refs/heads/feature/report'), 'wrong')).status === 401, 'a webhook delivery with a bad signature is refused');
  check((await (await push(pushBody('elsewhere', 'refs/heads/x'))).json()).stored === 0, 'pushes from repositories outside the organisation are ignored');
  check((await (await push({ zen: 'hi' }, 'hook-secret', 'ping')).json()).ok === true, 'the ping GitHub sends on setup is accepted');
  check((await (await push(pushBody('acme', 'refs/heads/feature/report'))).json()).stored === 3, 'a push stores its commits');
  check((await (await push(pushBody('acme', 'refs/heads/feature/report'))).json()).stored === 0, 'a redelivered push is not counted twice');
  const act2 = await tool(alex.token, 'github_activity', {});
  check(act2.commits?.map((c: { sha: string }) => c.sha).join() === 'aaaaaaa,bbbbbbb,eeeeeee', 'pushed branch commits join the search results, without duplicates');
  check(act2.commits.find((c: { sha: string }) => c.sha === 'eeeeeee')?.branch === 'feature/report' && act2.commits[2].message === 'wip: daily report writer', 'with their branch and first line');

  // the daily report: find the day's doc under a wiki page, read the tables, fill in one's own rows as oneself
  await connect(alex.jar);
  await connect(alice.jar);
  check(String((await tool(alex.token, 'get_daily_report', {})).error).includes('set_daily_report'), 'before an admin sets it up, the daily report says how');
  check(String((await tool(bob.token, 'set_daily_report', { folder_url: 'https://x.larksuite.com/wiki/wikDaily', title: '团队工作日报 {MM}{DD}' })).error).length > 0, 'only admins say where the daily report is');
  const daily = await tool(alex.token, 'set_daily_report', { folder_url: 'https://x.larksuite.com/wiki/wikDaily', title: '团队工作日报 {MM}{DD}' });
  check(daily.folderTitle === '团队日会' && daily.space === 'sp1', 'an admin points the hub at the wiki page the reports live under');
  const report = await tool(alex.token, 'get_daily_report', { date: '2026-10-20' });
  check(report.title === '团队工作日报 1020' && report.url === 'https://x.larksuite.com/wiki/wik1020' && report.sections?.map((x: { name: string }) => x.name).join() === '社媒资源层,日常工作', "the day's report is found (on the second page) and its tables named by their headings");
  check(report.sections[0].columns.join() === '昨天完成,今天计划,卡点和需要谁' && report.sections[0].rows[1].person === '林小雨' && report.sections[0].rows[1].cells[0] === '招募 47 位创作者\n完善 SOP', 'each row is a person, with the text of each cell (read across pages of blocks)');
  check(report.mine?.length === 2 && report.mine[0].cells[0] === '旧的内容', "the asking person's own rows");
  check(JSON.stringify(report.notFilledYet) === '["周明"]', 'and who has not filled theirs in yet');
  check(String((await tool(alex.token, 'get_daily_report', { date: '2026-10-21' })).error).includes('团队工作日报 1021'), 'a day without a report says which title it looked for');
  const fillArgs = { date: '2026-10-20', rows: [{ section: '社媒', cells: ['写完日报工具\n修好网关', '接 GitHub webhook', null] }, { section: '日常工作', cells: ['', '评审 PR', ''] }] };
  check(String((await tool(alex.token, 'fill_daily_report', fillArgs)).error).includes('docs=1'), 'writing first asks the person to let the hub edit Lark documents');
  await connect(alex.jar, '&docs=1');
  check(lark.scopesAsked.split(' ').includes('docx:document') && lark.scopesAsked.split(' ').includes('docx:document:readonly'), 'that connection asks for document editing on top of reading');
  const filled = await tool(alex.token, 'fill_daily_report', fillArgs);
  check(filled.written?.map((w: { section: string; columns: string[] }) => `${w.section}:${w.columns.join('/')}`).join() === '社媒资源层:昨天完成/今天计划,日常工作:今天计划', 'only the columns given are written, in the sections named');
  const after = await tool(alex.token, 'get_daily_report', { date: '2026-10-20' });
  check(after.mine[0].cells.join('|') === '写完日报工具\n修好网关|接 GitHub webhook|' && after.mine[1].cells.join('|') === '|评审 PR|', 'the cells now hold the new text, one line per paragraph');
  check(after.sections[0].rows[1].cells[0] === '招募 47 位创作者\n完善 SOP', "colleagues' rows are untouched");
  check(String((await tool(alex.token, 'fill_daily_report', { date: '2026-10-20', rows: [{ section: '财务', cells: ['x'] }] })).error).includes('社媒资源层'), 'an unknown section lists the ones there are');
  check(String((await tool(alice.token, 'fill_daily_report', { date: '2026-10-20', rows: [{ section: '日常工作', cells: ['x'] }] })).error).length > 0, 'nobody writes into a table without a row of their own');

  // an admin pins a Lark shortcut under the sidebar navigation
  await api(alex.jar, 'POST', '/lark-links', { name: '审批', url: 'https://applink.larksuite.com/approval', icon: '✅' });
  const link = ((await api(alex.jar, 'GET', '/admin')).body.larkLinks as { id: number; name: string }[]).find((l) => l.name === '审批')!;
  check(((await api(alice.jar, 'GET', '/me')).body.sidebarLinks as unknown[]).length === 0, 'shortcuts are not in the sidebar until an admin puts them there');
  check((await api(alice.jar, 'POST', `/lark-links/${link.id}/sidebar`, { on: true })).status === 400, 'only admins pin shortcuts');
  await api(alex.jar, 'POST', `/lark-links/${link.id}/sidebar`, { on: true });
  check(((await api(alice.jar, 'GET', '/me')).body.sidebarLinks as { name: string }[])[0]?.name === '审批', 'a pinned shortcut shows in everyone\'s sidebar');

  if (KEEP) {
    // leave a demo running for screenshots: Alex connected with a full home page and a firing alert
    await connect(alex.jar);
    await tool(alex.token, 'save_alert_rule', {
      title: { 'zh-CN': 'API 订单数', en: 'API orders' }, source: 'orders', query: { measure: { op: 'count' }, where: [{ field: 'Channel', op: 'is', value: 'API' }] },
      condition: { type: 'below', value: 300 }, recipients: [],
    });
    const rules = await tool(alex.token, 'list_alert_rules');
    for (const r of rules.rules) await tool(alex.token, 'check_alert_rule', { id: r.id, notify: false });
    await api(alex.jar, 'POST', `/alerts/${rules.rules[0].id}/mute`, { muted: false });
    await tool(alex.token, 'save_homepage', { scope: 'me', layout: { modules: [
      { type: 'stats', items: [
        { label: { 'zh-CN': '本月订单', en: 'Orders this month' }, period: { 'zh-CN': '上月', en: 'last month' }, source: { data: 'orders', query: { measure: { op: 'count' }, date: { field: 'Date', bucket: 'month', last: 6, complete: true } } } },
        { label: { 'zh-CN': '本月金额', en: 'Amount this month' }, period: { 'zh-CN': '上月', en: 'last month' }, source: { data: 'orders', query: { measure: { op: 'sum', field: 'Amount' }, date: { field: 'Date', bucket: 'month', last: 6, complete: true } } } },
        { label: { 'zh-CN': '全部订单', en: 'All orders' }, source: { data: 'orders', query: { measure: { op: 'count' } } } },
      ] },
      { type: 'chart', kind: 'line', width: 'half', title: { 'zh-CN': '每周订单', en: 'Orders per week' }, source: { data: 'orders', query: { measure: { op: 'count' }, date: { field: 'Date', bucket: 'week', last: 12, complete: true } } } },
      { type: 'chart', kind: 'donut', width: 'half', title: { 'zh-CN': '渠道构成', en: 'By channel' }, source: { data: 'orders', query: { measure: { op: 'sum', field: 'Amount' }, groupBy: 'Channel' } } },
      { type: 'okr', width: 'half' },
      { type: 'issues', width: 'half' },
      { type: 'alerts', width: 'half', showOk: true },
      { type: 'chart', kind: 'bar', width: 'half', title: { 'zh-CN': '各渠道订单', en: 'Orders by channel' }, source: { data: 'orders', query: { measure: { op: 'count' }, groupBy: 'Channel' } } },
    ] } });
    lark.fixP1 = false;
    await tool(alex.token, 'run_checks', {});
    await tool(alice.token, 'save_homepage', { scope: 'me', layout: { modules: [
      { type: 'issues', width: 'half' },
      { type: 'alerts', width: 'half' },
    ] } });
    console.log(`\nkept running: hub ${HUB}  (Ctrl-C to stop)`);
    await new Promise(() => {});
  }
} finally {
  hub.kill();
  larkServer.close();
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} check(s) failed\n--- hub log ---\n${hubLog.slice(-3000)}`);
  process.exit(1);
}
console.log('\nall data checks passed');
