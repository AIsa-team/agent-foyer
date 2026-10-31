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
/** Waits (up to 5 s) for something done in the background, e.g. a message on its way, instead of a fixed pause. */
async function until(ok: () => unknown) {
  for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 100));
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
  { field_id: 'f2', field_name: 'Channel', type: 3, ui_type: 'SingleSelect', property: { options: CHANNELS.map((name) => ({ name })) } },
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
  appInfo: false,
  /** calls to the fake Metabase's own MCP server: the tool, its arguments and the key it came with */
  mbMcp: [] as { tool: string; args: unknown; key: string }[],
  /** the fake dashboard 100: when it last changed there, and the changes made since */
  mbDash: { changedAt: '2026-01-01T00:00:00Z', extraCard: false, dropDetail: false },
  /** calls the fake AIsa got: path, key and body */
  aiCalls: [] as { path: string; auth: string; body: string; cookie: boolean; ua: string }[],
  /** SQL the fake Metabase was asked to run */
  mbSql: [] as string[],
  calendarTokens: new Set<string>(),
  /** the fake company directory: where "Bea" works (moves between syncs) */
  beaIn: 'od-east',
  searchTokens: new Set<string>(),
  searches: [] as Record<string, unknown>[],
  calendarQueries: [] as { start: number; end: number }[],
  /** extra events for the demo, at real times */
  calendarExtra: [] as Record<string, unknown>[],
  access: new Set<string>(),
  refresh: new Set<string>(),
  refreshes: 0,
  messages: [] as { type: string; id: string; text: string; as?: 'bot' | 'user'; msgType?: string }[],
  /** the bot's interactive cards, and what each was updated to */
  cards: [] as { id: string; to: string; card: string; updates: string[] }[],
  sendTokens: new Set<string>(),
  fileTokens: new Set<string>(),
  readTokens: new Set<string>(),
  twinTokens: new Set<string>(),
  // messages the AI twin finds through search (id → where, who, when, what)
  inbox: new Map<string, { id: string; chat: string; from: string; at: number; text: string; bot?: boolean; mentions?: string[]; parent?: string }>(),
  // records of Bases created during the run, per app/table
  records: new Map<string, Map<string, Record<string, unknown>>>(),
  messageReads: [] as { chat: string; size: number }[],
  uploads: [] as { name: string; key: string; as: 'bot' | 'user'; bytes: string; image?: boolean }[],
  scopesAsked: '',
  drafts: [] as string[],
  gmail: [] as string[],
  googleEmail: 'alex@example.com',
  googleScope: '',
  ghQueries: [] as string[],
  mbRuns: 0,
  searchCalls: 0,
  hideApi: false,
  denyOrders: false,
  rejectOnce: false,
  advanced: false,
  writeTokens: new Set<string>(),
  docsTokens: new Set<string>(),
  driveReadTokens: new Set<string>(),
  driveWriteTokens: new Set<string>(),
  driveFiles: new Map<string, { name: string; folder: string; bytes: string; wiki?: string }>([
    ['boxHtml', { name: 'site.html', folder: 'fldOther', bytes: '<html><body><h1>官网建议</h1></body></html>' }],
    ['boxPdf', { name: '合同.pdf', folder: 'fldOther', bytes: '%PDF-1.7 binary' }],
  ]),
  wikiMoves: new Map<string, string>(),
  wikiTokens: new Set<string>(),
  sheetsTokens: new Set<string>(),
  sheetCols: 4,
  sheetReadOnly: false,
  sheet: [['客户', '产品', '金额', '状态'], ['Northwind', 'API 套餐', '12000', '已签'], ['Lumen', 'Skills', '3000', '谈判中'], [], ['Atlas', 'API 套餐', '8000', '已签']] as unknown[][],
  made: new Map<string, { title: string; folder?: string; blocks: { block_id: string; block_type: number; children?: string[] }[]; top?: string[]; calls: number }>(),
  doc: new Map<string, DocBlock>(),
  fixP1: false,
  created: [] as { table: string; fields: Record<string, unknown>; by: string }[],
  updated: [] as { record: string; fields: Record<string, unknown> }[],
  bases: new Map<string, { name: string; tables: { id: string; name: string; fields: { field_name: string; type: number }[] }[] }>(),
  addedFields: [] as { app: string; table: string; field: string }[],
  perms: [] as { token: string; type: string; public?: string; member?: string }[],
};
let serial = 0;
const linear = { tokens: new Set<string>(), writeTokens: new Set<string>(), refreshes: 0, expiresIn: 86399, revoked: false, scope: '', lastToken: '', changes: [] as { op: string; variables: Record<string, unknown> }[] };

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
  if (lark.scopesAsked.split(' ').includes('docx:document') && lark.scopesAsked.split(' ').includes('docx:document:create')) lark.docsTokens.add(a);
  if (lark.scopesAsked.split(' ').includes('wiki:wiki')) lark.wikiTokens.add(a);
  if (lark.scopesAsked.split(' ').includes('sheets:spreadsheet')) lark.sheetsTokens.add(a);
  if (lark.scopesAsked.split(' ').includes('calendar:calendar:readonly')) lark.calendarTokens.add(a);
  if (lark.scopesAsked.split(' ').includes('search:docs:read')) lark.searchTokens.add(a);
  if (lark.scopesAsked.split(' ').includes('search:message')) lark.twinTokens.add(a);
  if (['drive:file:readonly', 'drive:file'].some((s) => lark.scopesAsked.split(' ').includes(s))) lark.driveReadTokens.add(a);
  if (['drive:file', 'drive:drive.metadata:readonly'].every((s) => lark.scopesAsked.split(' ').includes(s))) lark.driveWriteTokens.add(a);
  if (['im:message', 'im:message.send_as_user'].every((s) => lark.scopesAsked.split(' ').includes(s))) lark.sendTokens.add(a);
  if (lark.scopesAsked.split(' ').includes('im:resource')) lark.fileTokens.add(a);
  if (['im:message:readonly', 'im:message.p2p_msg:get_as_user', 'im:message.group_msg:get_as_user', 'im:chat:read'].every((s) => lark.scopesAsked.split(' ').includes(s))) lark.readTokens.add(a);
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
  // a fake Metabase dashboard's questions: one row per day with several value columns, numbers, a table, a funnel, categories
const MB_CARDS: Record<string, { name: string; display: string; meta: { name: string; base_type: string }[]; rows: () => Record<string, unknown>[] }> = {
  401: { name: '每日收入', display: 'line', meta: [{ name: 'date', base_type: 'type/Date' }, { name: 'payg_usd', base_type: 'type/Decimal' }, { name: 'builder_usd', base_type: 'type/Decimal' }, { name: 'success_rate', base_type: 'type/Decimal' }],
    // Metabase's export names a currency column as displayed
    rows: () => Array.from({ length: 20 }, (_, i) => ({ date: new Date(NOW - (19 - i) * DAY).toISOString().slice(0, 10), 'payg_usd ($)': 100 + i, builder_usd: 10, success_rate: 0.9 })) },
  408: { name: '每日 API 调用', display: 'bar', meta: [{ name: 'date', base_type: 'type/Date' }, { name: 'api_name', base_type: 'type/Text' }, { name: 'calls', base_type: 'type/Integer' }],
    rows: () => [0, 1].flatMap((d) => ['search', 'scrape'].map((api, j) => ({ date: new Date(NOW - d * DAY).toISOString().slice(0, 10), api_name: api, calls: 10 * (j + 1) }))) },
  402: { name: '本周 PAYG', display: 'scalar', meta: [{ name: 'payg_week', base_type: 'type/Decimal' }], rows: () => [{ payg_week: 700 }] },
  403: { name: '本周 Team', display: 'scalar', meta: [{ name: 'team_week', base_type: 'type/Decimal' }], rows: () => [{ team_week: 50 }] },
  404: { name: '消费 Top', display: 'table', meta: [{ name: 'email', base_type: 'type/Text' }, { name: 'amount', base_type: 'type/Decimal' }], rows: () => [{ email: 'a@x.com', amount: 9 }, { email: 'b@x.com', amount: 5 }] },
  405: { name: '激活漏斗', display: 'funnel', meta: [{ name: 'stage', base_type: 'type/Text' }, { name: 'users', base_type: 'type/Integer' }], rows: () => [{ stage: '注册', users: 100 }, { stage: '激活', users: 40 }, { stage: '付费', users: 8 }] },
  406: { name: '充值间隔', display: 'bar', meta: [{ name: 'bucket', base_type: 'type/Text' }, { name: 'orders', base_type: 'type/Integer' }, { name: 'registrations', base_type: 'type/Integer' }],
    rows: () => [{ bucket: 'b. 1-7 天', orders: 3, registrations: 5 }, { bucket: 'a. 当天', orders: 9, registrations: 12 }] },
};
// a fake Metabase: keys mb_good (an ordinary group) and mb_admin (the admin group); two questions
  // a fake Linear: OAuth (authorize, code and refresh grants) and the GraphQL queries the 项目 page sends
  if (p.startsWith('/linear/')) {
    const lp = p.slice(7);
    if (lp === '/oauth/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'lin-code');
      back.searchParams.set('state', url.searchParams.get('state')!);
      linear.scope = url.searchParams.get('scope') ?? '';
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (lp === '/oauth/token') {
      const f = new URLSearchParams(raw);
      if (f.get('client_secret') !== 'lin-secret') return send({ error: 'invalid_client' }, 401);
      if (f.get('grant_type') === 'authorization_code' && f.get('code') === 'lin-code') {
        const a = `lin-a${++serial}`;
        linear.tokens.add(a);
        const write = linear.scope.split(',').includes('write');
        if (write) linear.writeTokens.add(a);
        return send({ access_token: a, refresh_token: `lin-r${serial}`, expires_in: linear.expiresIn, token_type: 'Bearer', scope: write ? 'read write' : 'read' });
      }
      if (f.get('grant_type') === 'refresh_token' && /^lin-r\d+$/.test(f.get('refresh_token') ?? '') && !linear.revoked) {
        linear.refreshes++;
        const a = `lin-a${++serial}`;
        linear.tokens.add(a);
        linear.writeTokens.add(a);
        return send({ access_token: a, refresh_token: `lin-r${serial}`, expires_in: 86399, token_type: 'Bearer', scope: 'read write' });
      }
      return send({ error: 'invalid_grant' }, 400);
    }
    if (lp === '/graphql') {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!linear.tokens.has(token) || linear.revoked) return send({ errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] }, 401);
      linear.lastToken = token;
      const { query, variables } = JSON.parse(raw) as { query: string; variables?: { after?: string; id?: string } };
      const TEAM = { id: 't1', name: 'Engineering', key: 'ENG',
        states: { nodes: [{ id: 's-done', name: 'Done', type: 'completed', position: 3 }, { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 }, { id: 's-doing', name: 'In Progress', type: 'started', position: 2 }, { id: 's-back', name: 'Backlog', type: 'backlog', position: 0 }] },
        members: { nodes: [{ id: 'lin-u2', name: 'Bo' }, { id: 'lin-u1', name: 'Alex L' }] } };
      if (query.includes('assignedIssues') && query.includes('identifier')) {
        return send({ data: { viewer: { assignedIssues: { nodes: [
          { id: 'i3', identifier: 'ENG-3', title: '没日期的', url: 'u', priority: 3, dueDate: null, state: { id: 's-todo', name: 'Todo', type: 'unstarted' }, project: { id: 'p1', name: '中台 v2' }, team: TEAM },
          { id: 'i2', identifier: 'ENG-2', title: '任务 2', url: 'u', priority: 2, dueDate: '2026-01-05', state: { id: 's-doing', name: 'In Progress', type: 'started' }, project: { id: 'p1', name: '中台 v2' }, team: TEAM },
        ] } } } });
      }
      if (query.includes('assignedIssues')) return send({ data: { viewer: { id: 'lin-u1', assignedIssues: { nodes: [{ project: { id: 'p1' } }, { project: null }] } } } });
      if (query.includes('viewer')) return send({ data: { viewer: { id: 'lin-u1', name: 'Alex L', organization: { name: 'Acme' } } } });
      const proj = (id: string, name: string, type: string, statusName: string, extra: Record<string, unknown> = {}) => ({
        id, name, description: `${name} desc`, url: `https://linear.app/acme/project/${id}`, icon: null, color: '#5e6ad2', progress: 0.5, startDate: '2026-10-01', targetDate: '2026-11-30',
        updatedAt: '2026-10-21T10:00:00Z', health: null, status: { name: statusName, type }, lead: { id: 'u1', name: 'Alex', displayName: 'alex', avatarUrl: null },
        teams: { nodes: [{ id: 't1', name: 'Engineering', key: 'ENG' }] }, members: { nodes: [{ id: 'lin-u9', name: 'Cai' }] },
        projectMilestones: { nodes: [{ id: 'mx', name: '内测', targetDate: '2026-11-10' }, { id: 'my', name: '未定', targetDate: null }] }, projectUpdates: { nodes: [] }, ...extra,
      });
      if (query.includes('projects(')) {
        // two pages, so paging is exercised
        return variables?.after === 'c1'
          ? send({ data: { projects: { nodes: [proj('p3', '官网改版', 'completed', 'Completed', { progress: 1 }), proj('p4', '暂停的', 'canceled', 'Canceled')], pageInfo: { hasNextPage: false, endCursor: null } } } })
          : send({ data: { projects: { nodes: [
            proj('p2', '计费系统', 'planned', 'Planned', { targetDate: '2026-12-15', members: { nodes: [{ id: 'lin-u1', name: 'Alex L', displayName: 'alex' }, { id: 'lin-u2', name: 'Bo' }] } }),
            proj('p1', '中台 v2', 'started', 'In Progress', { health: 'atRisk', projectUpdates: { nodes: [{ body: '接口延期一周', health: 'atRisk', createdAt: '2026-10-20T08:00:00Z', user: { name: 'Alex' } }] } }),
          ], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } });
      }
      // changes: only with write access, recorded for the checks
      const op = ['issueUpdate', 'commentCreate', 'issueCreate', 'projectUpdateCreate'].find((m) => query.includes(`${m}(`));
      if (op) {
        if (!linear.writeTokens.has(token)) return send({ errors: [{ message: 'Invalid scope: `write` required', extensions: { code: 'FORBIDDEN' } }] });
        linear.changes.push({ op, variables: variables as Record<string, unknown> });
        return send({ data: { [op]: { success: true, ...(op === 'issueCreate' ? { issue: { id: 'i9', identifier: 'ENG-9', url: 'https://linear.app/acme/issue/ENG-9' } } : {}) } } });
      }
      if (query.includes('issue(id')) {
        if (variables?.id !== 'i2') return send({ errors: [{ message: 'Entity not found: Issue' }] });
        return send({ data: { issue: {
          id: 'i2', identifier: 'ENG-2', title: '任务 2', description: '要做的事\n第二行', url: 'https://linear.app/acme/issue/ENG-2', priority: 2, priorityLabel: 'High', dueDate: '2026-11-01',
          createdAt: '2026-10-10T10:00:00Z', completedAt: null, state: { id: 's-doing', name: 'In Progress', type: 'started' }, assignee: { id: 'lin-u1', name: 'Alex L' },
          creator: { name: 'Bo' }, team: TEAM, projectMilestone: { id: 'm1' }, project: { id: 'p1', name: '中台 v2' },
          comments: { nodes: [{ id: 'c2', body: '第二条', createdAt: '2026-10-12T10:00:00Z', user: { name: 'Bo' } }, { id: 'c1', body: '第一条', createdAt: '2026-10-11T10:00:00Z', user: { name: 'Alex L' } }] },
        } } });
      }
      if (query.includes('project(id')) {
        if (!['p1', 'p2'].includes(variables?.id ?? '')) return send({ errors: [{ message: 'Entity not found: Project' }] });
        const issue = (n: number, type: string, extra: Record<string, unknown> = {}) => ({
          id: `i${n}`, identifier: `ENG-${n}`, title: `任务 ${n}`, url: `https://linear.app/acme/issue/ENG-${n}`, priority: n % 4, priorityLabel: 'High', dueDate: null, estimate: 1,
          updatedAt: '2026-10-21T10:00:00Z', completedAt: type === 'completed' ? '2026-10-20T10:00:00Z' : null,
          state: { id: ({ completed: 's-done', started: 's-doing', unstarted: 's-todo', triage: 's-back', backlog: 's-back', canceled: 's-done' } as Record<string, string>)[type], name: type, type },
          assignee: { id: 'lin-u1', name: 'Alex', displayName: 'alex', avatarUrl: null }, team: { id: 't1' },
          projectMilestone: null, ...extra,
        });
        return send({ data: { project: {
          ...proj('p1', '中台 v2', 'started', 'In Progress', { health: 'atRisk' }),
          projectUpdates: { nodes: [{ id: 'u1', body: '接口延期一周\n其余正常', health: 'atRisk', createdAt: '2026-10-20T08:00:00Z', url: 'x', user: { name: 'Alex', displayName: 'alex', avatarUrl: null } }] },
          projectMilestones: { nodes: [{ id: 'm2', name: 'Beta', targetDate: '2026-11-15' }, { id: 'm1', name: 'Alpha', targetDate: '2026-10-31' }] },
          issues: { nodes: [issue(1, 'completed', { projectMilestone: { id: 'm1' } }), issue(2, 'started', { projectMilestone: { id: 'm1' } }), issue(3, 'unstarted', { projectMilestone: { id: 'm2' } }), issue(4, 'canceled', { projectMilestone: { id: 'm2' } }), issue(5, 'triage')], pageInfo: { hasNextPage: false } },
          editTeams: { nodes: [{ id: 't1', name: 'Engineering', key: 'ENG',
            states: { nodes: [{ id: 's-done', name: 'Done', type: 'completed', position: 3 }, { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 }, { id: 's-doing', name: 'In Progress', type: 'started', position: 2 }, { id: 's-back', name: 'Backlog', type: 'backlog', position: 0 }] },
            members: { nodes: [{ id: 'lin-u2', name: 'Bo' }, { id: 'lin-u1', name: 'Alex L' }] } }] },
        } } });
      }
      return send({ errors: [{ message: 'unexpected query' }] });
    }
  }
  if (p.startsWith('/mb/')) {
    const mp = p.slice(3);
    const key = req.headers['x-api-key'];
    if (key !== 'mb_good' && key !== 'mb_admin') return send({ message: 'Unauthenticated' }, 401);
    // Metabase's built-in MCP server (stateless JSON answers), taking the API key like the rest of its API
    if (mp === '/api/metabase-mcp') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      const m = JSON.parse(raw) as { id?: number; method: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } };
      if (m.id === undefined) { res.writeHead(202); return res.end(); }
      const reply = (result: unknown) => send({ jsonrpc: '2.0', id: m.id, result });
      if (m.method === 'initialize') return reply({ protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'metabase', version: '0.1.0' } });
      if (m.method === 'tools/list') return reply({ tools: [
        { name: 'search', description: 'Search questions, dashboards and tables', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
        { name: 'execute_sql', description: 'Run SQL on a database', inputSchema: { type: 'object', properties: { database_id: { type: 'number' }, sql: { type: 'string' } } } },
        { name: 'question_write', description: 'Create or change a saved question', inputSchema: { type: 'object', properties: {} } },
      ] });
      if (m.method === 'tools/call') {
        lark.mbMcp.push({ tool: m.params!.name!, args: m.params!.arguments, key: String(key) });
        return reply({ content: [{ type: 'text', text: `${m.params!.name} ok` }] });
      }
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
    }
    if (mp === '/api/user/current') return send({ common_name: key === 'mb_admin' ? 'Admin' : 'AIsa Hub', is_superuser: key === 'mb_admin' });
    // read-only SQL as an unsaved question: the result depends on the table it reads
    if (mp === '/api/database') return send({ data: [{ id: 2, name: 'prod (read only)', engine: 'mysql' }] });
    if (mp === '/api/dataset' || mp === '/api/dataset/json') {
      const query = mp === '/api/dataset' ? JSON.parse(raw) : JSON.parse(new URLSearchParams(raw).get('query') ?? '{}');
      const sql = String(query.native?.query ?? '');
      lark.mbSql.push(sql);
      const tables: Record<string, Record<string, unknown>[]> = {
        orders: [{ customer: 'c1', amount: 10 }, { customer: 'C2 ', amount: 5 }, { customer: 'c3', amount: 1 }],
        tiers: [{ customer: 'c1', tier: 'A' }, { customer: 'c2', tier: 'B' }],
        signups: [{ day: '2026-10-01', n: 3 }, { day: '2026-10-02', n: 4 }],
        big: Array.from({ length: 2500 }, (_, i) => ({ k: i })),
      };
      const name = Object.keys(tables).find((t) => new RegExp(`from\\s+${t}\\b`, 'i').test(sql));
      if (!name) return send({ status: 'failed', error: 'Table not found' });
      const all = tables[name];
      if (mp === '/api/dataset/json') return send(all);
      const shown = all.slice(0, 2000);
      const cols = Object.keys(all[0]).map((c) => ({ name: c, base_type: typeof all[0][c] === 'number' ? 'type/Integer' : 'type/Text' }));
      return send({ status: 'completed', row_count: shown.length, data: { cols, rows: shown.map((r) => cols.map((c) => r[c.name])) } });
    }
    if (mp === '/api/card') return send([
      { id: 232, name: '每日新增用户', collection: { name: '运营' }, display: 'line' },
      { id: 309, name: '每日收入拆分', collection: { name: '运营' }, display: 'line' },
      { id: 5, name: 'Old one', archived: true },
    ]);
    // /api/card/:id → the question; /query → its result as cols + rows (what the hub reads, cached there); /query/json → the export
    const card = mp.match(/^\/api\/card\/(\d+)(\/query(\/json)?)?$/);
    const asQuery = (meta: { name: string; base_type: string; effective_type?: string }[], rows: Record<string, unknown>[], rowCount = rows.length) =>
      send({ status: 'completed', row_count: rowCount, data: { cols: meta, rows: rows.map((r) => meta.map((m) => r[m.name] ?? r[`${m.name} ($)`] ?? null)) } });
    if (card && card[1] === '232') {
      const meta = [{ name: 'reg_date', base_type: 'type/Text', effective_type: 'type/Date' }, { name: 'real_users', base_type: 'type/BigInteger' }];
      if (!card[2]) return send({ id: 232, name: '每日新增用户', description: '每日有效注册，排除 bot 和内部账号；上海时间归日。', result_metadata: meta });
      lark.mbRuns++;
      // MB_ROWS_FILE: real-looking rows for screenshots of a --keep demo
      const rows = process.env.MB_ROWS_FILE ? JSON.parse((await import('node:fs')).readFileSync(process.env.MB_ROWS_FILE, 'utf8')) as Record<string, unknown>[]
        : Array.from({ length: 10 }, (_, i) => ({ reg_date: new Date(NOW - (9 - i) * DAY).toISOString().slice(0, 10), real_users: 10 + i }));
      return card[3] ? send(rows) : asQuery(meta, rows);
    }
    if (card && card[1] === '309') {
      const meta = [{ name: 'date', base_type: 'type/Date' }, { name: 'payg_usd', base_type: 'type/Decimal' }];
      return !card[2] ? send({ id: 309, name: '每日收入拆分', result_metadata: meta }) : card[3] ? send([{ date: '2026-10-20', payg_usd: 100 }]) : asQuery(meta, [{ date: '2026-10-20', payg_usd: 100 }]);
    }
    const fake = card && MB_CARDS[card[1]];
    if (fake) {
      if (!card[2]) return send({ id: Number(card[1]), name: fake.name, display: fake.display, result_metadata: fake.meta });
      if (card[3]) return send(fake.rows());
      // 401 says it reached the query endpoint's row limit, so the hub falls back to the export
      return asQuery(fake.meta, fake.rows(), card[1] === '401' ? 2000 : undefined);
    }
    if (mp === '/api/dashboard') return send([{ id: 100, name: '每日运营', collection: { name: '运营' } }, { id: 7, name: 'Old', archived: true }]);
    if (mp === '/api/dashboard/100') {
      const dc = (tab: number, row: number, col: number, size: number, id?: number, vs: Record<string, unknown> = {}) =>
        ({ dashboard_tab_id: tab, row, col, size_x: size, visualization_settings: id ? {} : vs, card: id ? { id, name: id === 232 ? '每日新增用户' : MB_CARDS[String(id)]?.name ?? 'gone', display: id === 232 ? 'bar' : MB_CARDS[String(id)]?.display ?? 'line', visualization_settings: vs, updated_at: '2026-01-01T00:00:00Z' } : null });
      const changes = [...(lark.mbDash.extraCard ? [dc(1, 6, 0, 24, 405)] : [])];
      return send({ name: '每日运营', updated_at: lark.mbDash.changedAt, tabs: [{ id: 1, name: '基础' }, ...(lark.mbDash.dropDetail ? [] : [{ id: 2, name: '明细' }]), { id: 3, name: '空的' }], dashcards: [...changes, 
        dc(1, 0, 0, 24, undefined, { text: '## 口径\n**上海时间**，[说明](https://example.com/doc)' }),
        dc(1, 1, 0, 24, 401, { 'graph.dimensions': ['date'], 'graph.metrics': ['payg_usd', 'builder_usd', 'success_rate'], series_settings: { payg_usd: { title: 'PAYG 收入' } } }),
        dc(1, 2, 0, 24, undefined, { text: '**本周销售**' }),
        dc(1, 3, 0, 12, 402), dc(1, 3, 12, 12, 403),
        dc(1, 4, 0, 12, 406, { 'stackable.stack_type': 'stacked', 'graph.y_axis.title_text': '订单（未扣退款）', column_settings: { '["name","orders"]': { number_style: 'currency', currency: 'USD' } } }),
        dc(1, 4, 12, 12, 232, { 'graph.dimensions': ['reg_date'], 'graph.metrics': ['real_users'] }),
        dc(1, 5, 0, 24, 408),
        ...(lark.mbDash.dropDetail ? [] : [dc(2, 0, 0, 24, 404), dc(2, 1, 0, 12, 405), dc(2, 1, 12, 12, 407)]),
        dc(3, 0, 0, 24, undefined, { text: 'only text' }),
      ] });
    }
    return send({ message: 'Not found' }, 404);
  }
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
    if (gp === '/orgs/acme') return send({ node_id: 'O_acme' });
    // the contribution calendar: the last 3 days busy, the day before empty, every third day before that
    if (gp === '/graphql') {
      const v = JSON.parse(raw).variables as { login: string; org: string; from: string; to: string };
      if (v.login !== 'alex-gh' || v.org !== 'O_acme') return send({ data: { user: null } });
      const days: { date: string; contributionCount: number }[] = [];
      const last = Date.parse(v.to.slice(0, 10));
      for (let t = Date.parse(v.from.slice(0, 10)), i = 0; t <= last; t += DAY, i++) {
        const back = Math.round((last - t) / DAY);
        days.push({ date: iso(t).slice(0, 10), contributionCount: back < 3 ? 2 : back === 3 ? 0 : i % 3 === 0 ? 1 : 0 });
      }
      const total = days.reduce((s, d) => s + d.contributionCount, 0);
      const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, w) => ({ contributionDays: days.slice(w * 7, w * 7 + 7) }));
      return send({ data: { user: { contributionsCollection: {
        totalCommitContributions: total - 3, totalPullRequestContributions: 2, totalPullRequestReviewContributions: 1,
        contributionCalendar: { totalContributions: total, weeks },
        commitContributionsByRepository: [{ repository: { nameWithOwner: 'acme/hub', url: 'https://github.com/acme/hub' }, contributions: { totalCount: total - 5 } }],
      } } } });
    }
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
  // file uploads are multipart, not JSON
  const body = (req.headers['content-type'] ?? '').startsWith('multipart/') ? {} : raw ? JSON.parse(raw) : {};
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
  if (p === '/im/v1/chats') return bearer === 't-app' ? send({ code: 0, data: { items: [{ chat_id: 'oc_dev', name: '开发群' }, { chat_id: 'oc_finance', name: '财务' }], has_more: false } }) : send({ code: 99991663, msg: 'bad tenant token' });
  // the AI twin: searching the person's messages (ids only, newest first), and single messages and chats by id
  if (p === '/search/v2/message' && req.method === 'POST') {
    if (!lark.twinTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [search:message]' });
    const start = Number(body.start_time ?? 0) * 1000;
    const end = body.end_time ? Number(body.end_time) * 1000 + 999 : Infinity;
    const hits = [...lark.inbox.values()].filter((m) => m.at >= start && m.at <= end
      && (!body.chat_type || (body.chat_type === 'p2p_chat') === m.chat.startsWith('oc_p2p'))
      && (body.from_type !== 'user' || !m.bot)
      && (!body.from_ids?.length || body.from_ids.includes(m.from))
      && (!body.chat_ids?.length || body.chat_ids.includes(m.chat)))
      .sort((x, y) => y.at - x.at).map((m) => m.id);
    const from = Number(url.searchParams.get('page_token') || 0);
    return send({ code: 0, data: { items: hits.slice(from, from + 20), has_more: from + 20 < hits.length, page_token: String(from + 20) } });
  }
  const oneMessage = p.match(/^\/im\/v1\/messages\/(om_t\w+)$/);
  if (oneMessage && req.method === 'GET') {
    if (!lark.readTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [im:message:readonly]' });
    const m = lark.inbox.get(oneMessage[1]);
    if (!m) return send({ code: 230011, msg: 'message not found' });
    return send({ code: 0, data: { items: [{
      message_id: m.id, msg_type: 'text', create_time: String(m.at), chat_id: m.chat, sender: { id: m.from, id_type: 'open_id', sender_type: m.bot ? 'app' : 'user' },
      body: { content: JSON.stringify({ text: m.text }) }, ...(m.parent ? { parent_id: m.parent } : {}), ...(m.mentions ? { mentions: m.mentions.map((id, i) => ({ key: `@_user_${i + 1}`, id, name: id })) } : {}),
    }] } });
  }
  const oneChat = p.match(/^\/im\/v1\/chats\/(oc_\w+)$/);
  if (oneChat && req.method === 'GET') {
    const direct = oneChat[1].startsWith('oc_p2p');
    return send({ code: 0, data: { name: direct ? '' : `群 ${oneChat[1].slice(3)}`, chat_mode: direct ? 'p2p' : 'group' } });
  }
  // reading as the person, who allowed it: their direct chat with Bob, a group, and a file Bob sent
  const readScope = () => send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [im:message.p2p_msg:get_as_user]' });
  if (p === '/im/v1/chats/search' && req.method === 'GET') {
    if (!lark.readTokens.has(bearer)) return readScope();
    const q = url.searchParams.get('query') ?? '';
    return send({ code: 0, data: { items: [{ chat_id: 'oc_dev', name: '开发群' }, { chat_id: 'oc_finance', name: '财务' }].filter((c) => c.name.includes(q)), has_more: false } });
  }
  if (p === '/im/v1/chat_p2p/batch_query' && req.method === 'POST') {
    if (!lark.readTokens.has(bearer)) return readScope();
    return send({ code: 0, data: { p2p_chats: (body.chatter_ids as string[]).includes('ou_dev_bob') ? [{ chat_id: 'oc_p2p_bob', chatter_id: 'ou_dev_bob' }] : [] } });
  }
  if (p === '/im/v1/messages' && req.method === 'GET') {
    if (!lark.readTokens.has(bearer)) return readScope();
    const chat = url.searchParams.get('container_id')!;
    const size = Number(url.searchParams.get('page_size'));
    lark.messageReads.push({ chat, size });
    const msg = (id: string, at: number, type: string, content: object, extra = {}) =>
      ({ message_id: id, msg_type: type, create_time: String(at), sender: { id: 'ou_dev_bob', id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify(content) }, ...extra });
    const items = chat === 'oc_p2p_bob'
      ? [msg('om_3', 1_790_000_300_000, 'file', { file_key: 'file_c1', file_name: '合同.pdf' }), msg('om_2', 1_790_000_200_000, 'text', { text: '@_user_1 周三见' }, { mentions: [{ key: '@_user_1', name: 'Alex' }] }),
        msg('om_1', 1_790_000_100_000, 'text', { text: '报价单收到了' })]
      : [1, 2, 3, 4, 5].map((i) => msg(`og_${i}`, 1_790_000_000_000 - i * 1000, 'text', { text: `群消息 ${i}` }));
    if (url.searchParams.get('sort_type') === 'ByCreateTimeAsc') items.reverse();
    return send({ code: 0, data: { items: items.slice(0, size), has_more: false } });
  }
  if (p === '/im/v1/messages/om_3/resources/file_c1' && req.method === 'GET') {
    if (!lark.readTokens.has(bearer)) return readScope();
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''%E5%90%88%E5%90%8C.pdf" });
    return res.end('CONTRACT');
  }
  // a file to send in a chat: as the person, who allowed uploading files
  if (p === '/im/v1/files' && req.method === 'POST') {
    if (!userOk()) return send({ code: 99991663, msg: 'bad token' });
    if (!lark.fileTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [im:resource]' });
    const field = (name: string) => raw.match(new RegExp(`name="${name}"(?:; filename="[^"]*")?\\r\\n(?:Content-Type: [^\\r]*\\r\\n)?\\r\\n([^\\r]*)`))?.[1] ?? '';
    const key = `file_v3_${lark.uploads.length + 1}`;
    lark.uploads.push({ name: field('file_name'), key, as: 'user', bytes: field('file') });
    return send({ code: 0, data: { file_key: key } });
  }
  // a picture to show in a chat (same permission); Lark refuses what is not a picture
  if (p === '/im/v1/images' && req.method === 'POST') {
    if (!userOk()) return send({ code: 99991663, msg: 'bad token' });
    if (!lark.fileTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [im:resource]' });
    const bytes = raw.match(/name="image"; filename="([^"]*)"\r\n(?:Content-Type: [^\r]*\r\n)?\r\n([^\r]*)/);
    if (!raw.includes('name="image_type"\r\n\r\nmessage') || !bytes || !bytes[2].startsWith('PNG')) return send({ code: 234011, msg: 'Can\'t recognize image format.' });
    const key = `img_v3_${lark.uploads.length + 1}`;
    lark.uploads.push({ name: bytes[1], key, as: 'user', bytes: bytes[2], image: true });
    return send({ code: 0, data: { image_key: key } });
  }
  if (p === '/im/v1/messages' && body.msg_type === 'interactive') {
    if (bearer !== 't-app') return send({ code: 99991663, msg: 'cards come from the bot' });
    const id = `om_card_${lark.cards.length + 1}`;
    lark.cards.push({ id, to: body.receive_id, card: body.content, updates: [] });
    return send({ code: 0, data: { message_id: id } });
  }
  const cardPatch = p.match(/^\/im\/v1\/messages\/(om_card_\d+)$/);
  if (cardPatch && req.method === 'PATCH') {
    const c = lark.cards.find((x) => x.id === cardPatch[1]);
    if (bearer !== 't-app' || !c) return send({ code: 230001, msg: 'no such card' });
    c.updates.push(body.content);
    return send({ code: 0, data: {} });
  }
  if (p === '/im/v1/messages') {
    // the bot, or a person who allowed the hub to send as them
    if (bearer !== 't-app' && !userOk()) return send({ code: 99991663, msg: 'bad tenant token' });
    if (bearer !== 't-app' && !lark.sendTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [im:message.send_as_user]' });
    const content = JSON.parse(body.content);
    lark.messages.push({ type: url.searchParams.get('receive_id_type')!, id: body.receive_id, text: content.file_key ? `[file:${content.file_key}]` : content.image_key ? `[image:${content.image_key}]` : body.msg_type === 'post' ? JSON.stringify(content) : content.text, as: bearer === 't-app' ? 'bot' : 'user', msgType: body.msg_type });
    return send({ code: 0, data: {} });
  }
  if (p.startsWith('/sheets/')) {
    if (!lark.sheetsTokens.has(bearer)) return send({ code: 99991679, msg: 'required one of these privileges under the user identity: [sheets:spreadsheet]' });
    if (lark.sheetReadOnly && req.method !== 'GET') return send({ code: 1254302, msg: 'Permission denied.' });
    if (p === '/sheets/v3/spreadsheets/shtDeals/sheets/query') return send({ code: 0, data: { sheets: [{ sheet_id: 'S1', title: 'Deals', grid_properties: { row_count: lark.sheet.length, column_count: lark.sheetCols } }] } });
    const range = (r: string) => { const m = decodeURIComponent(r).match(/^S1!A(\d+):[A-Z]+(\d+)$/)!; return [Number(m[1]), Number(m[2])]; };
    const v = p.match(/^\/sheets\/v2\/spreadsheets\/shtDeals\/values\/(.+)$/);
    if (v && req.method === 'GET') { const [a, b] = range(v[1]); return send({ code: 0, data: { valueRange: { values: lark.sheet.slice(a - 1, b) } } }); }
    if (p === '/sheets/v2/spreadsheets/shtDeals/values_append') { lark.sheet.push(body.valueRange.values[0]); return send({ code: 0, data: { updates: { updatedRange: `S1!A${lark.sheet.length}:D${lark.sheet.length}` } } }); }
    if (p === '/sheets/v2/spreadsheets/shtDeals/dimension_range') { lark.sheetCols += body.dimension.length; return send({ code: 0, data: {} }); }
    if (p === '/sheets/v2/spreadsheets/shtDeals/values' && req.method === 'PUT') {
      const m = decodeURIComponent(body.valueRange.range).match(/^S1!([A-Z]+)(\d+):[A-Z]+\d+$/)!;
      const col = m[1].charCodeAt(0) - 65;
      const row = (lark.sheet[Number(m[2]) - 1] ??= []);
      (body.valueRange.values[0] as unknown[]).forEach((v, i) => { row[col + i] = v; });
      return send({ code: 0, data: {} });
    }
    return send({ code: 1, msg: 'unknown sheets call ' + p });
  }
  if (p === '/application/v6/applications') {
    if (bearer !== 't-app') return send({ code: 99991663, msg: 'bad tenant token' });
    if (!lark.appInfo) return send({ code: 99991672, msg: 'Access denied. One of the following scopes is required: [admin:app.info:readonly]' });
    const all = [
      { app_id: 'cli_approval', app_name: 'App 1', status: 1, pc_default_ability: 'gadget', avatar_url: 'https://pan16.larksuitecdn.com/static-resource/v1/v2_6a3c492f-bace-4c54-a931-40161e8eef9h', i18n: [{ i18n_key: 'zh_cn', name: '审批', description: '发起和处理审批' }, { i18n_key: 'en_us', name: 'Approval', description: 'Request approvals' }] },
      { app_id: 'cli_wiki', app_name: 'Handbook', status: 1, pc_default_ability: 'web_app', avatar_url: 'https://pan16.larksuitecdn.com/static-resource/v1/48571196-2ea9-4a61-9255-40c0bd8472fh' },
      { app_id: 'cli_old', app_name: 'Old', status: 0, pc_default_ability: 'web_app' },
      { app_id: 'cli_nothing', app_name: 'Nothing to open', status: 1 },
      { app_id: 'cli_smoke', app_name: 'Hub', status: 1, pc_default_ability: 'web_app' },
    ];
    // two pages, to follow page_token
    const second = url.searchParams.get('page_token') === 'p2';
    return send({ code: 0, data: second ? { app_list: all.slice(3), has_more: false } : { app_list: all.slice(0, 3), has_more: true, page_token: 'p2' } });
  }
  if (p === '/okr/v1/periods') {
    return bearer === 't-app'
      ? send({ code: 99991672, msg: 'Access denied. One of the following scopes is required: [okr:okr.period:readonly, okr:okr:readonly, okr:okr]' })
      : send({ code: 99991668, msg: 'user access token not support' });
  }
  // everything below reads documents as the user
  // a fake AIsa: OpenAI-compatible models at /aisa/v1, data APIs at /aisa/apis/v1, key sk-good
  if (p.startsWith('/aisa/')) {
    const auth = String(req.headers.authorization ?? '');
    lark.aiCalls.push({ path: p + url.search, auth, body: raw, cookie: !!req.headers.cookie, ua: String(req.headers['user-agent'] ?? '') });
    if (auth !== 'Bearer sk-good') return send({ error: { message: 'invalid key' } }, 401);
    if (p === '/aisa/v1/models') return send({ data: [{ id: 'gpt-x' }, { id: 'claude-y' }] });
    if (p === '/aisa/v1/chat/completions' && req.method === 'POST') {
      const b = JSON.parse(raw) as { model: string; stream?: boolean };
      if (b.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ model: b.model, choices: [{ delta: { content: '你' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ model: b.model, choices: [{ delta: { content: '好' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      return send({ model: b.model, choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 11, completion_tokens: 3 } });
    }
    if (p === '/aisa/apis/v1/twitter/user/info') return send({ data: { userName: url.searchParams.get('userName'), followers: 4200 } });
    return send({ error: 'not found' }, 404);
  }
  // the company directory (contact range: one department tree plus one person granted on their own)
  if (p.startsWith('/contact/v3/') && bearer === 't-app') {
    const person = (id: string, name: string) => ({ open_id: id, name, enterprise_email: `${id}@acme.example` });
    if (p === '/contact/v3/scopes') return send({ code: 0, data: { department_ids: ['od-sales'], user_ids: ['ou_solo'], has_more: false } });
    if (p === '/contact/v3/departments/od-sales') return send({ code: 0, data: { department: { open_department_id: 'od-sales', name: '销售', i18n_name: { en_us: 'Sales' }, leader_user_id: 'ou_lead' } } });
    if (p === '/contact/v3/departments/od-sales/children') return send({ code: 0, data: { items: [{ open_department_id: 'od-east', name: '华东', parent_department_id: 'od-sales' }], has_more: false } });
    if (p === '/contact/v3/users/find_by_department') {
      const dep = url.searchParams.get('department_id');
      const items = dep === 'od-sales' ? [person('ou_lead', 'Lee'), ...(lark.beaIn === 'od-sales' ? [person('ou_bea', 'Bea')] : [])] : lark.beaIn === 'od-east' ? [person('ou_bea', 'Bea')] : [];
      return send({ code: 0, data: { items, has_more: false } });
    }
    if (p === '/contact/v3/users/ou_solo') return send({ code: 0, data: { user: person('ou_solo', 'Solo') } });
  }
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
  // searching documents and wiki pages: needs the search scope; pages of page_size
  if (p === '/search/v2/doc_wiki/search' && req.method === 'POST') {
    if (!lark.searchTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [search:docs:read]' });
    lark.searches.push(body);
    const all = [
      { title_highlighted: '团队工作<h>日报</h> 1023', summary_highlighted: '昨天完成…', entity_type: 'WIKI', result_meta: { doc_types: 'WIKI', url: 'https://acme.larksuite.com/wiki/wikDaily1023', owner_name: 'Alex L', update_time: 1792750000, edit_user_name: 'Bo' } },
      { title_highlighted: '<h>日报</h>模板', summary_highlighted: '', entity_type: 'DOC', result_meta: { doc_types: 'DOCX', url: 'https://acme.larksuite.com/docx/doxTemplate', owner_name: 'Alex L', update_time: 1792700000 } },
      { title_highlighted: '用户与市场洞察', summary_highlighted: '本周<h>用户</h>访谈', entity_type: 'WIKI', result_meta: { doc_types: 'WIKI', url: 'https://acme.larksuite.com/wiki/wikInsight', owner_name: 'Bo', update_time: 1792600000 } },
    ].filter((u) => u.title_highlighted.replace(/<\/?h>/g, '').includes(String(body.query)) || (!body.doc_filter?.only_title && !body.wiki_filter?.only_title && u.summary_highlighted.replace(/<\/?h>/g, '').includes(String(body.query))));
    const from = Number(body.page_token ?? 0), size = Number(body.page_size ?? 20);
    const units = all.slice(from, from + size);
    return send({ code: 0, data: { total: all.length, has_more: from + size < all.length, ...(from + size < all.length ? { page_token: String(from + size) } : {}), res_units: units } });
  }
  // the person's own calendar: needs the calendar scope; events are placed from the start of the range asked for
  if (p === '/calendar/v4/calendars/primary' && req.method === 'POST') {
    if (!lark.calendarTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [calendar:calendar:readonly]' });
    return send({ code: 0, data: { calendars: [{ calendar: { calendar_id: 'cal_alex@group.calendar', type: 'primary', role: 'owner' }, user_id: 'ou_dev_alex' }] } });
  }
  if (p === '/calendar/v4/calendars/cal_alex%40group.calendar/events/instance_view' || p === '/calendar/v4/calendars/cal_alex@group.calendar/events/instance_view') {
    if (!lark.calendarTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [calendar:calendar:readonly]' });
    const s0 = Number(url.searchParams.get('start_time')), e0 = Number(url.searchParams.get('end_time'));
    lark.calendarQueries.push({ start: s0, end: e0 });
    const at = (h: number) => ({ timestamp: String(s0 + h * 3600), timezone: 'UTC' });
    const day = new Date(s0 * 1000).toISOString().slice(0, 10);
    return send({ code: 0, data: { items: [
      { event_id: 'e-all', summary: '团建', start_time: { date: day }, end_time: { date: day }, status: 'confirmed' },
      { event_id: 'e-week_1', summary: '周会', start_time: at(9), end_time: at(10), status: 'confirmed', app_link: 'https://applink.larksuite.com/client/calendar/event/detail?key=w',
        vchat: { vc_type: 'vc', meeting_url: 'vc.larksuite.com/j/123' }, event_organizer: { display_name: 'Bo' }, attendees: [{ type: 'resource', display_name: '会议室 A' }], description: '议程：本周进展' },
      { event_id: 'e-gone', summary: '取消了', start_time: at(11), end_time: at(12), status: 'cancelled' },
      { event_id: 'e-blank', start_time: at(14), end_time: at(15), status: 'confirmed', location: { name: '前台' }, free_busy_status: 'free' },
      ...lark.calendarExtra,
    ] } });
  }
  // creating and reading documents
  const noDocs = () => send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [docx:document:create]' });
  if (p === '/docx/v1/documents' && req.method === 'POST') {
    if (!lark.docsTokens.has(bearer)) return noDocs();
    const id = `doxMade${lark.made.size + 1}`;
    lark.made.set(id, { title: body.title, folder: body.folder_token, blocks: [], top: [], calls: 0 });
    return send({ code: 0, data: { document: { document_id: id, title: body.title } } });
  }
  if (p === '/wiki/v2/spaces/sp1/nodes' && req.method === 'POST') {
    if (!lark.wikiTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [wiki:wiki]' });
    const id = `doxWiki${lark.made.size + 1}`;
    lark.made.set(id, { title: body.title, folder: `wiki:${body.parent_node_token}`, blocks: [], calls: 0 });
    return send({ code: 0, data: { node: { node_token: `wikMade${lark.made.size}`, obj_token: id, obj_type: 'docx', title: body.title, space_id: 'sp1' } } });
  }
  // a created document read back: its title and (for edit_lark_doc) a root block
  const madeDoc = p.match(/^\/docx\/v1\/documents\/(doxMade\d+)(\/blocks)?$/);
  if (madeDoc && lark.made.has(madeDoc[1]) && req.method === 'GET') {
    const d = lark.made.get(madeDoc[1])!;
    return madeDoc[2]
      ? send({ code: 0, data: { items: [{ block_id: madeDoc[1], block_type: 1, children: d.top ?? [] }, ...d.blocks], has_more: false } })
      : send({ code: 0, data: { document: { document_id: madeDoc[1], title: lark.made.get(madeDoc[1])!.title } } });
  }
  const descendant = p.match(/^\/docx\/v1\/documents\/(\w+)\/blocks\/(\w+)\/descendant$/);
  if (descendant) {
    const d = lark.made.get(descendant[1]);
    if (!d || descendant[1] !== descendant[2]) return send({ code: 1770002, msg: 'not found' });
    if (!lark.docsTokens.has(bearer)) return noDocs();
    const ids = new Set((body.descendants as { block_id: string }[]).map((b) => b.block_id));
    const bad = body.children_id.length > 1000 || body.descendants.length > 1000
      || (body.descendants as { table?: { property?: { merge_info?: unknown } } }[]).some((b) => b.table?.property?.merge_info)
      || (body.descendants as { children?: string[] }[]).some((b) => (b.children ?? []).some((c) => !ids.has(c)))
      || (body.children_id as string[]).some((c) => !ids.has(c));
    if (bad) return send({ code: 1770001, msg: 'invalid param' });
    d.blocks.push(...body.descendants);
    d.top?.push(...body.children_id);
    d.calls++;
    return send({ code: 0, data: { children: [] } });
  }
  const madeDelete = p.match(/^\/docx\/v1\/documents\/(doxMade\d+)\/blocks\/(doxMade\d+)\/children\/batch_delete$/);
  if (madeDelete && req.method === 'DELETE') {
    const d = lark.made.get(madeDelete[1])!;
    if (!lark.docsTokens.has(bearer)) return noDocs();
    d.top?.splice(body.start_index, body.end_index - body.start_index);
    return send({ code: 0, data: {} });
  }
  if (p === '/docx/v1/documents/doxFolder/blocks') {
    if (!userOk()) return send({ code: 99991668, msg: 'bad token' });
    const run = (content: string, style = {}) => ({ text_run: { content, text_element_style: style } });
    return send({ code: 0, data: { has_more: false, items: [
      { block_id: 'doxFolder', block_type: 1, children: ['f1', 'f2', 'f3', 'f4'] },
      { block_id: 'f1', block_type: 4, heading2: { elements: [run('怎么开日会')] } },
      { block_id: 'f2', block_type: 2, text: { elements: [run('每天早上 '), run('9:30', { bold: true }), run('，日报放在这里，'), { mention_user: { user_id: 'ou_dev_alice' } }, run(' 主持。')] } },
      { block_id: 'f3', block_type: 12, bullet: { elements: [run('先看昨天')] }, children: ['f5'] },
      { block_id: 'f5', block_type: 12, bullet: { elements: [run('卡点优先')] } },
      { block_id: 'f4', block_type: 31, table: { cells: ['c1', 'c2', 'c3', 'c4'], property: { row_size: 2, column_size: 2 } }, children: ['c1', 'c2', 'c3', 'c4'] },
      { block_id: 'c1', block_type: 32, children: ['t1'] }, { block_id: 't1', block_type: 2, text: { elements: [run('负责', { bold: true }), run('人', { bold: true })] } },
      { block_id: 'c2', block_type: 32, children: ['t2'] }, { block_id: 't2', block_type: 2, text: { elements: [run('时间')] } },
      { block_id: 'c3', block_type: 32, children: ['t3'] }, { block_id: 't3', block_type: 2, text: { elements: [{ mention_user: { user_id: 'ou_dev_alex' } }] } },
      { block_id: 'c4', block_type: 32, children: ['t4'] }, { block_id: 't4', block_type: 2, text: { elements: [run('周一')] } },
    ] } });
  }
  if (p === '/docx/v1/documents/doxFolder') return send({ code: 0, data: { document: { document_id: 'doxFolder', title: '团队日会' } } });
  // files in Drive and the wiki: download (read scope), upload into a folder and move under a wiki page (write scopes)
  if (p === '/wiki/v2/spaces/get_node' && url.searchParams.get('token') === 'wikLocked') {
    return send({ code: 0, data: { node: { space_id: 'sp2', node_token: 'wikLocked', title: '别人的知识库', obj_type: 'docx', obj_token: 'doxLocked' } } });
  }
  if (p === '/wiki/v2/spaces/get_node' && url.searchParams.get('token') === 'wikHtml') {
    return send({ code: 0, data: { node: { space_id: 'sp1', node_token: 'wikHtml', title: 'aisa-one-site-suggestions.html', obj_type: 'file', obj_token: 'boxHtml' } } });
  }
  const driveDownload = p.match(/^\/drive\/v1\/files\/(\w+)\/download$/);
  if (driveDownload) {
    if (!lark.driveReadTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [drive:file:readonly]' });
    const f = lark.driveFiles.get(driveDownload[1]);
    if (!f) return send({ code: 1061004, msg: 'forbidden' });
    res.writeHead(200, { 'content-type': f.name.endsWith('.html') ? 'text/html' : 'application/octet-stream', 'content-disposition': `attachment; filename="${encodeURIComponent(f.name)}"`, 'content-length': Buffer.byteLength(f.bytes) });
    return res.end(f.bytes);
  }
  if (p === '/drive/explorer/v2/root_folder/meta') {
    if (!lark.driveWriteTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [drive:drive.metadata:readonly]' });
    return send({ code: 0, data: { token: 'fldRoot', id: '1', user_id: 'u1' } });
  }
  if (p === '/drive/v1/files/upload_all' && req.method === 'POST') {
    if (!lark.driveWriteTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [drive:file]' });
    const field = (name: string) => raw.match(new RegExp(`name="${name}"(?:; filename="[^"]*")?\r\n(?:Content-Type: [^\r]*\r\n)?\r\n([^\r]*)`))?.[1] ?? '';
    const token = `boxUp${lark.driveFiles.size + 1}`;
    lark.driveFiles.set(token, { name: field('file_name'), folder: field('parent_node'), bytes: field('file') });
    return send({ code: 0, data: { file_token: token } });
  }
  const move = p.match(/^\/wiki\/v2\/spaces\/(\w+)\/nodes\/move_docs_to_wiki$/);
  if (move) {
    if (!lark.wikiTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [wiki:wiki]' });
    const f = lark.driveFiles.get(body.obj_token);
    if (!f || body.obj_type !== 'file') return send({ code: 131005, msg: 'not found' });
    if (body.parent_wiki_token === 'wikLocked') return send({ code: 131006, msg: 'permission denied: no destination parent node permission' });
    f.wiki = body.parent_wiki_token;
    const task = `task${lark.wikiMoves.size + 1}`;
    lark.wikiMoves.set(task, `wikFile${lark.wikiMoves.size + 1}`);
    return send({ code: 0, data: { task_id: task } });
  }
  const moveTask = p.match(/^\/wiki\/v2\/tasks\/(\w+)$/);
  if (moveTask) {
    const node = lark.wikiMoves.get(moveTask[1]);
    return send({ code: 0, data: { task: { task_id: moveTask[1], move_result: [{ node: { node_token: node, obj_type: 'file' }, status: node ? 0 : -1, status_msg: node ? 'success' : 'failed' }] } } });
  }
  if (p === '/wiki/v2/spaces/get_node' && url.searchParams.get('token') === 'wik1020') {
    return send({ code: 0, data: { node: { space_id: 'sp1', node_token: 'wik1020', title: '团队工作日报 1020', obj_type: 'docx', obj_token: 'doxDaily' } } });
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
    if (!sub && req.method === 'PATCH') {
      if (!lark.docsTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [docx:document]' });
      const key = Object.keys(block).find((k) => (block[k] as { elements?: unknown })?.elements)!;
      block[key] = { elements: body.update_text_elements.elements };
      return send({ code: 0, data: { block } });
    }
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
  // creating Bases, tables and columns, and sharing (needs the Base write scope)
  // records in a Base created during the run (needs the Base write scope); search filters on one "is" condition
  const madeRecords = p.match(/^\/bitable\/v1\/apps\/(appMade\d+)\/tables\/(\w+)\/records(?:\/(\w+))?$/);
  if (madeRecords) {
    if (!lark.writeTokens.has(bearer)) return send({ code: 99991679, msg: 'Unauthorized. required one of these privileges under the user identity: [bitable:app]' });
    const key = `${madeRecords[1]}/${madeRecords[2]}`;
    const rows = lark.records.get(key) ?? new Map<string, Record<string, unknown>>();
    lark.records.set(key, rows);
    const rec = madeRecords[3];
    const text = (v: unknown) => (typeof v === 'object' && v ? String((v as { text?: string; link?: string }).text ?? (v as { link?: string }).link ?? '') : String(v ?? ''));
    if (rec === 'search' && req.method === 'POST') {
      const conds = (body.filter?.conditions ?? []) as { field_name: string; value: string[] }[];
      const items = [...rows].filter(([, f]) => conds.every((c) => text(f[c.field_name]) === c.value[0])).map(([record_id, fields]) => ({ record_id, fields }));
      return send({ code: 0, data: { items, has_more: false, total: items.length } });
    }
    if (!rec && req.method === 'POST') {
      const id = `rec${++serial}`;
      rows.set(id, { ...body.fields });
      return send({ code: 0, data: { record: { record_id: id, fields: rows.get(id) } } });
    }
    if (rec && !rows.has(rec)) return send({ code: 1254043, msg: 'RecordIdNotFound' });
    if (rec && req.method === 'PUT') {
      const merged: Record<string, unknown> = { ...rows.get(rec), ...body.fields };
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
      rows.set(rec, merged);
      return send({ code: 0, data: { record: { record_id: rec, fields: merged } } });
    }
    return send({ code: 0, data: { record: { record_id: rec, fields: rows.get(rec) } } });
  }
  if ((p === '/bitable/v1/apps' && req.method === 'POST') || (/^\/bitable\/v1\/apps\/[^/]+\/tables(\/[^/]+\/fields)?$/.test(p) && req.method === 'POST') || req.method === 'DELETE' && p.startsWith('/bitable/')) {
    if (!lark.writeTokens.has(bearer)) return send({ code: 99991679, msg: 'required one of these privileges under the user identity: [bitable:app]' });
    if (p === '/bitable/v1/apps') {
      const token = `appMade${lark.bases.size + 1}`;
      lark.bases.set(token, { name: body.name, tables: [{ id: 'tblDefault', name: '数据表', fields: [{ field_name: '多行文本', type: 1 }] }] });
      return send({ code: 0, data: { app: { app_token: token, default_table_id: 'tblDefault', url: `https://x.larksuite.com/base/${token}` } } });
    }
    const t = p.match(/^\/bitable\/v1\/apps\/([^/]+)\/tables(?:\/([^/]+))?(\/fields)?$/)!;
    if (req.method === 'DELETE') { const b = lark.bases.get(t[1])!; b.tables = b.tables.filter((x) => x.id !== t[2]); return send({ code: 0, data: {} }); }
    if (t[3]) {
      lark.addedFields.push({ app: t[1], table: t[2], field: body.field_name });
      lark.bases.get(t[1])?.tables.find((x) => x.id === t[2])?.fields.push(body);
      return send({ code: 0, data: { field: { field_id: 'fldNew', field_name: body.field_name } } });
    }
    const b = lark.bases.get(t[1])!;
    const id = `tblMade${b.tables.length}`;
    b.tables.push({ id, name: body.table.name, fields: body.table.fields });
    return send({ code: 0, data: { table_id: id } });
  }
  const madeTables = p.match(/^\/bitable\/v1\/apps\/(appMade\d+)\/tables$/);
  if (madeTables) return send({ code: 0, data: { items: (lark.bases.get(madeTables[1])?.tables ?? []).map((x) => ({ table_id: x.id, name: x.name })), has_more: false } });
  const madeFields = p.match(/^\/bitable\/v1\/apps\/(appMade\d+)\/tables\/([^/]+)\/fields$/);
  if (madeFields) return send({ code: 0, data: { items: (lark.bases.get(madeFields[1])?.tables.find((x) => x.id === madeFields[2])?.fields ?? []).map((f, i) => ({ field_id: `fld${i}`, field_name: f.field_name, type: f.type })), has_more: false } });
  const perm = p.match(/^\/drive\/v[12]\/permissions\/([^/]+)\/(public|members)$/);
  if (perm) {
    lark.perms.push({ token: perm[1], type: url.searchParams.get('type') ?? '', ...(perm[2] === 'public' ? { public: body.link_share_entity } : { member: body.member_id }) });
    return send({ code: 0, data: {} });
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
      const text = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' && x ? (x as { text?: string }).text ?? '' : String(x))).join('') : String(v ?? ''));
      if (c.operator === 'contains') rows = rows.filter((r) => text((r as Record<string, unknown>)[c.field_name]).toLowerCase().includes(String(c.value[0]).toLowerCase()));
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
    AISA_API_BASE: `http://localhost:${LARK_PORT}/aisa`,
    LINEAR_CLIENT_ID: 'lin-client', LINEAR_CLIENT_SECRET: 'lin-secret', LINEAR_AUTH_BASE: `http://localhost:${LARK_PORT}/linear`, LINEAR_API_BASE: `http://localhost:${LARK_PORT}/linear`,
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
  const onHub = await fetch(`${HUB}/__hub/sdk.js`);
  check(onHub.status === 404 && (await onHub.text()).includes('<slug>'), "the hub's own domain says the SDK lives on the app's domain instead of serving the web page");
  const init = await (await fetch(`${HUB}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }) })).json() as { result: { instructions: string } };
  const intro = init.result.instructions;
  check(intro.includes('中台') && intro.includes('call app_guide first') && intro.includes('Business data lives in Lark') && intro.includes('keep a new app private') && !intro.includes('ask the user three things'), 'agents get the core principles when they connect, and decide the defaults themselves');
  check(intro.length < 14000, `and the instructions stay short (${intro.length} chars)`);
  const guide = String((await tool(alex.token, 'app_guide', {})).guide);
  check(guide.includes('their own Gmail, never sent') && guide.includes('records(alias, {where') && guide.includes('No table named (the usual case): create_lark_base') && guide.includes('## 8. Report'),
    'app_guide has the full steps: where data lives, the SDK and what it returns, the report');
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
  // people's agents use the app's tables through hub-agent.json, run by the hub as the person after the same consent as the app
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'hub.db'));
    const tables = {
      projects: { description: '项目', find: true, add: { fields: ['项目名称'] } },
      requests: { description: '开票申请', find: { fields: ['Name', 'Amount'] }, add: { fields: ['Name', 'Amount', 'Channel', 'Date', 'Owner', 'Tags'], required: ['Name'], unique: ['Name'], defaults: { Owner: '$me', Date: '$now' } }, update: { fields: ['Channel'] } },
      ghost: { find: true },
    };
    db.prepare("UPDATE app_releases SET agent_manifest = ? WHERE app_slug = 'invoice' AND version = (SELECT current_release FROM apps WHERE slug = 'invoice')").run(JSON.stringify({ tables, actions: [{ name: 'x', description: 'x', method: 'GET', path: '/x', input: { type: 'object', properties: {}, required: [] }, write: false }] }));
    const offer = (await tool(bob.token, 'list_apps', { app: 'invoice' }) as { actions: { name: string; write: boolean; input?: { note?: string } }[] }[])[0].actions;
    check(offer.map((a) => a.name).join() === 'projects.find,requests.find,requests.add,requests.update' && offer[2].write && !offer[1].write,
      "a static app offers the table operations its Lark declaration allows (no writes to a read table, no undeclared tables, no server actions)");
    check(String(offer[2].input?.note).includes('/auth/app-lark?app=invoice'), 'columns come once the person agreed to the app; until then the schema says where to agree');
    const notYet = await tool(bob.token, 'call_app', { app: 'invoice', action: 'requests.find' });
    check(String(notYet.error).includes('/auth/app-lark?app=invoice'), 'someone who has not agreed to the app\'s Lark access gets the link first');
    const schema = (await tool(alex.token, 'list_apps', { app: 'invoice' }) as { actions: { name: string; input: { properties: { fields: { properties: Record<string, { enum?: string[] }>; required?: string[] } } } }[] }[])[0]
      .actions.find((a) => a.name === 'requests.add')!.input.properties.fields;
    check(schema.properties.Channel.enum?.join() === CHANNELS.join() && schema.required?.join() === 'Name' && !('Score' in schema.properties), 'add takes the columns listed, typed from the table (select options as enum)');
    const proj = await tool(alex.token, 'call_app', { app: 'invoice', action: 'projects.find', input: { max: 3 } });
    check(proj.ok && proj.result.records.length === 3 && proj.result.records[0].id && proj.result.records[0]['项目名称'] === '春季投放', 'find reads the table as the person, as text');
    const req = await tool(alex.token, 'call_app', { app: 'invoice', action: 'requests.find', input: { max: 2 } });
    check(Object.keys(req.result.records[0]).sort().join() === 'Amount,Name,id', 'find returns only the columns listed');
    const before = lark.created.length;
    const addedByAgent = await tool(alex.token, 'call_app', { app: 'invoice', action: 'requests.add', input: { fields: { Name: 'Agent 开票', Amount: '1,200', Channel: 'API', Tags: ['vip'] } } });
    const row = lark.created.at(-1)!.fields;
    check(addedByAgent.ok && addedByAgent.write && addedByAgent.result.id && lark.created.length === before + 1 && row.Amount === 1200 && JSON.stringify(row.Owner) === '[{"id":"ou_dev_alex"}]' && typeof row.Date === 'number' && JSON.stringify(row.Tags) === '["vip"]',
      'add writes typed values with the defaults ($me, $now)');
    const dup = await tool(alex.token, 'call_app', { app: 'invoice', action: 'requests.add', input: { fields: { Name: ' order 5 ' } } });
    check(String(dup.error).includes('Order 5') === false && String(dup.error).includes('order 5') && String(dup.error).includes('rec') && lark.created.length === before + 1, 'a record that already exists in a unique column is refused, naming it (case and spaces ignored)');
    check((await tool(alex.token, 'call_app', { app: 'invoice', action: 'requests.add', input: { fields: { Name: 'Order 5b' } } })).ok && lark.created.length === before + 2, 'a value that only contains an existing one is not a duplicate');
    check((await tool(alex.token, 'call_app', { app: 'invoice', action: 'requests.add', input: { fields: { Name: '$me.id' } } })).ok && lark.created.at(-1)?.fields.Name === 'ou_dev_alex' && lark.created.length === before + 3, '$me.id writes the person\'s id into a text column');
    check(String((await tool(alex.token, 'call_app', { app: 'invoice', action: 'requests.add', input: { fields: { Name: 'x', Channel: 'Fax' } } })).error).includes('API') && lark.created.length === before + 3, 'a value the select does not have is refused, naming the options');
    check(String((await tool(alex.token, 'call_app', { app: 'invoice', action: 'requests.add', input: { fields: { Name: 'x', Score: 1 } } })).error).includes('Score'), 'columns not listed cannot be written');
    check(String((await tool(alex.token, 'call_app', { app: 'invoice', action: 'requests.add', input: { fields: { Amount: 1 } } })).error).includes('Name'), 'required columns must be given');
    check(String((await tool(alex.token, 'call_app', { app: 'invoice', action: 'requests.add', input: { fields: { Name: 'x', Amount: 'lots' } } })).error).includes('Amount'), 'and values must fit the column');
    const changed = await tool(alex.token, 'call_app', { app: 'invoice', action: 'requests.update', input: { id: 'recNew1', fields: { Channel: 'Skills' } } });
    check(changed.ok && lark.updated.at(-1)?.record === 'recNew1' && lark.updated.at(-1)?.fields.Channel === 'Skills', 'update changes the columns listed');
    check(String((await tool(alex.token, 'call_app', { app: 'invoice', action: 'projects.add', input: { fields: { 项目名称: 'x' } } })).error).includes('requests.add'), 'a table the app may only read offers no writes, whatever hub-agent.json says');
    const card = (await api(alex.jar, 'GET', '/apps/invoice')).body.agent as { actions: { name: string; table?: { op: string; fields: string[] | null } }[] };
    check(card.actions.find((a) => a.name === 'requests.add')?.table?.fields?.includes('Channel'), 'the app page lists table operations with their columns');
    db.prepare("UPDATE app_releases SET agent_manifest = NULL WHERE app_slug = 'invoice'").run();
    db.prepare("DELETE FROM app_agent_calls WHERE app_slug = 'invoice'").run();
    db.close();
  }
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
  const ownerTold = () => lark.messages.some((m) => m.id === 'ou_dev_alex' && m.text.includes('专票'));
  await until(ownerTold);
  check(ownerTold(), 'the owner is messaged');
  check((await api(alice.jar, 'POST', '/apps/invoice/feedback', { body: 'x' })).status === 400, 'feedback that is too short is refused');
  const bobFb = await api(bob.jar, 'GET', '/apps/invoice');
  check((bobFb.body.feedback as unknown[]).length === 0 && bobFb.body.usage === null, "others see neither someone else's feedback nor usage details");
  const ownerView = await api(alex.jar, 'GET', '/apps/invoice');
  check((ownerView.body.feedback as { body: string }[])[0]?.body.includes('专票') && (ownerView.body.usage as { last30: number }).last30 === 1 && (ownerView.body.app as { openFeedback: number }).openFeedback === 1,
    'the owner sees all feedback, usage per day and the open count');
  const todo = await tool(alex.token, 'list_feedback', {});
  check(todo.items?.length === 1 && todo.items[0].author.name === '林小雨', "the owner's agent lists open feedback on their apps");
  check(String((await tool(alice.token, 'resolve_feedback', { id: todo.items[0].id, status: 'done' })).error).length > 0, 'only the owner can resolve it');
  lark.messages = [];
  const resolved = await tool(alex.token, 'resolve_feedback', { id: todo.items[0].id, status: 'done', reply: '加上了' });
  const toColleague = () => lark.messages.some((m) => m.id === 'ou_dev_alice' && m.text.includes('加上了'));
  await until(toColleague);
  check(resolved.status === 'done' && toColleague(), 'resolving it tells the colleague, with the reply');
  check((await tool(alex.token, 'list_feedback', {})).items.length === 0, 'and it leaves the open list');

  // the 「feedback」 button inside apps: on by default, posts with the page it was sent from, and the owner can turn it off
  const appPage = await appFetch('invoice', '/', aliceInvoice, { 'sec-fetch-dest': 'document', accept: 'text/html' });
  check((await appPage.text()).endsWith('<script src="/__hub/sdk.js"></script><script src="/__hub/feedback.js" defer></script>'), 'app pages get the feedback button (at the end when there is no </body>)');
  const asset = await appFetch('invoice', '/', aliceInvoice, { 'sec-fetch-dest': 'script' });
  check(!(await asset.text()).includes('/__hub/feedback.js'), 'only when a page is opened, not when fetched as something else');
  const widget = await (await appFetch('invoice', '/__hub/feedback.js', aliceInvoice)).text();
  check(/给作者提意见|Feedback for the owner/.test(widget) && widget.includes('attachShadow'), "the button comes in the person's language");
  check((await appFetch('invoice', '/__hub/feedback', aliceInvoice, { 'content-type': 'application/json' }, 'POST', JSON.stringify({ body: '跨站' }))).status === 405, 'posting without the hub header is refused');
  lark.messages = [];
  const inApp = await appFetch('invoice', '/__hub/feedback', aliceInvoice, { 'content-type': 'application/json', 'x-hub-feedback': '1' }, 'POST', JSON.stringify({ body: '提交按钮太靠下了', page: '/new?type=vat' }));
  await until(() => lark.messages.some((m) => m.id === 'ou_dev_alex'));
  check(inApp.status === 200 && lark.messages.some((m) => m.id === 'ou_dev_alex'), 'feedback from inside the app reaches the owner');
  const fromApp = (await tool(alex.token, 'list_feedback', { slug: 'invoice' })).items[0];
  check(fromApp.via === 'app' && fromApp.context === 'URL: http://invoice.apps.localhost:18930/new?type=vat', 'with the page it was sent from');
  await tool(alex.token, 'resolve_feedback', { id: fromApp.id, status: 'done' });
  check(String((await tool(alice.token, 'update_app', { slug: 'invoice', feedback_button: false })).error).length > 0, 'only the owner turns the button off');
  await tool(alex.token, 'update_app', { slug: 'invoice', feedback_button: false });
  const quiet = await appFetch('invoice', '/', aliceInvoice, { 'sec-fetch-dest': 'document' });
  check(!(await quiet.text()).includes('/__hub/feedback.js') && ((await api(alex.jar, 'GET', '/apps/invoice')).body.app as { feedbackButton: boolean }).feedbackButton === false, 'and then pages come without it');
  await api(alex.jar, 'PATCH', '/apps/invoice', { feedbackButton: true });

  // a container app's pages get it too: the gateway adds it to the HTML on the way back
  const upstream = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-from': 'upstream' });
      return res.end(`<html><body><h1>server app</h1>${req.headers['accept-encoding'] ? 'gzip-asked' : ''}</body></html>`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }).listen(0);
  await new Promise((r) => upstream.once('listening', r));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'hub.db'));
  db.prepare("UPDATE apps SET kind = 'container', upstream = ? WHERE slug = 'invoice'").run(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`);
  const proxied = await appFetch('invoice', '/', aliceInvoice, { 'sec-fetch-dest': 'document', 'accept-encoding': 'gzip' });
  const proxiedHtml = await proxied.text();
  check(proxiedHtml === '<html><body><h1>server app</h1><script src="/__hub/feedback.js" defer></script></body></html>' && proxied.headers.get('x-from') === 'upstream'
    && proxied.headers.get('content-length') === String(Buffer.byteLength(proxiedHtml)), "a container app's page comes back with the button and its own headers, uncompressed");
  const api2 = await appFetch('invoice', '/data', aliceInvoice, { 'sec-fetch-dest': 'empty' });
  check((await api2.text()) === '{"ok":true}', 'its API responses pass through untouched');
  {
    // a path that URL parsing would turn into another host must not take the person's identity there
    const before = lark.aiCalls.length;
    const escape = await api(alice.jar, 'GET', `/home/source?app=invoice&path=${encodeURIComponent(`/.//127.0.0.1:${LARK_PORT}/aisa/v1/models`)}`);
    const escape2 = await api(alice.jar, 'GET', `/home/source?app=invoice&path=${encodeURIComponent(`//127.0.0.1:${LARK_PORT}/aisa/v1/models`)}`);
    check(escape.status >= 400 && escape2.status >= 400 && lark.aiCalls.length === before, "an app's data path cannot point at another host");
    // another app's page (or any other site) cannot act in this app as the visitor; the app's own pages and servers can
    const own = `http://invoice.apps.localhost:${HUB_PORT}`;
    check((await appFetch('invoice', '/data', aliceInvoice, { origin: `http://other.apps.localhost:${HUB_PORT}`, 'content-type': 'application/json' }, 'POST', '{}')).status === 403
      && (await appFetch('invoice', '/data', aliceInvoice, { origin: own, 'content-type': 'application/json' }, 'POST', '{}')).status === 200
      && (await appFetch('invoice', '/data', aliceInvoice, { 'content-type': 'application/json' }, 'POST', '{}')).status === 200, 'cross-site writes to an app are refused, its own and server-to-server ones pass');
  }
  check((await fetch(`${HUB}/`)).headers.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test((await fetch(`${HUB}/auth/login`, { redirect: 'manual' })).headers.get('content-security-policy') ?? ''),
    "the hub's pages cannot be framed by an app or any other site");

  {
    // agents use the app through the actions it declares (hub-agent.json), as the person behind them
    const seen: { method: string; url: string; user: string; agent: string; ticket: boolean; body: string }[] = [];
    const actionsApp = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, user: String(req.headers['x-hub-user-id']), agent: decodeURIComponent(String(req.headers['x-hub-agent'] ?? '')), ticket: !!req.headers['x-hub-ticket'], body: raw });
        const u = new URL(req.url!, 'http://x');
        res.writeHead(u.pathname === '/api/invoices/bad' ? 400 : 200, { 'content-type': 'application/json' });
        if (u.pathname === '/api/invoices/bad') return res.end('{"error":"no such invoice"}');
        if (req.method === 'POST') return res.end(JSON.stringify({ id: 'inv-9', ...JSON.parse(raw) }));
        res.end(JSON.stringify({ path: u.pathname, q: u.searchParams.get('q'), tags: u.searchParams.getAll('tag') }));
      });
    }).listen(0);
    await new Promise((r) => actionsApp.once('listening', r));
    const manifest = [
      { name: 'find_invoices', description: 'Find invoices', method: 'GET', path: '/api/invoices', input: { type: 'object', properties: { q: { type: 'string' }, tag: { type: 'array' } }, required: ['q'] }, write: false },
      { name: 'get_invoice', description: 'One invoice', method: 'GET', path: '/api/invoices/{id}', input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, write: false },
      { name: 'request_invoice', description: 'Request an invoice', method: 'POST', path: '/api/invoices', input: { type: 'object', properties: { company: { type: 'string' }, amount: { type: 'number' } }, required: ['company'] }, write: true },
    ];
    db.prepare("UPDATE apps SET upstream = ? WHERE slug = 'invoice'").run(`http://127.0.0.1:${(actionsApp.address() as { port: number }).port}`);
    db.prepare("UPDATE app_releases SET agent_manifest = ? WHERE app_slug = 'invoice' AND version = (SELECT current_release FROM apps WHERE slug = 'invoice')").run(JSON.stringify({ actions: manifest }));
    const listed = await tool(bob.token, 'list_apps', { query: 'invoice' }) as { slug: string; actions: { name: string; write: boolean; input?: unknown }[] }[];
    const inv = listed.find((a) => a.slug === 'invoice');
    const names = inv?.actions.map((a) => a.name).join() ?? '';
    check(names === 'find_invoices,get_invoice,request_invoice' && inv!.actions[2].write && !inv!.actions[1].write && !('input' in inv!.actions[0]), 'list_apps shows the actions an app offers (write marked)');
    const one = await tool(bob.token, 'list_apps', { app: 'invoice' }) as { actions: { name: string; input?: { required: string[] } }[] }[];
    check(one[0].actions[0].input?.required[0] === 'q', 'and with app, their arguments');
    const found = await tool(bob.token, 'call_app', { app: 'invoice', action: 'find_invoices', input: { q: 'Tether', tag: ['a', 'b'] } });
    check(found.ok && found.result.q === 'Tether' && found.result.tags.join() === 'a,b' && seen.at(-1)?.user && seen.at(-1)?.ticket, 'call_app sends a GET with the arguments as the person, with a ticket');
    const byId = await tool(bob.token, 'call_app', { app: 'invoice', action: 'get_invoice', input: { id: 'a/b' } });
    check(byId.result.path === '/api/invoices/a%2Fb', 'path arguments are filled in and escaped');
    {
      // an action path that would leave the app (stored without the manifest check) is refused at call time too
      const before = lark.aiCalls.length;
      db.prepare("UPDATE app_releases SET agent_manifest = ? WHERE app_slug = 'invoice' AND version = (SELECT current_release FROM apps WHERE slug = 'invoice')")
        .run(JSON.stringify({ actions: [...manifest, { name: 'escape', description: 'x', method: 'GET', path: `//127.0.0.1:${LARK_PORT}/aisa/v1/models`, input: { type: 'object', properties: {} }, write: false }] }));
      check(!!(await tool(bob.token, 'call_app', { app: 'invoice', action: 'escape', input: {} })).error && lark.aiCalls.length === before, "an action cannot send the person's identity to another host");
      db.prepare("UPDATE app_releases SET agent_manifest = ? WHERE app_slug = 'invoice' AND version = (SELECT current_release FROM apps WHERE slug = 'invoice')").run(JSON.stringify({ actions: manifest }));
    }
    const made = await tool(bob.token, 'call_app', { app: 'invoice', action: 'request_invoice', input: { company: 'Circle', amount: 5 } });
    check(made.ok && made.write && made.result.id === 'inv-9' && seen.at(-1)?.method === 'POST' && JSON.parse(seen.at(-1)!.body).company === 'Circle', 'a write action posts the arguments as JSON');
    const bad = await tool(bob.token, 'call_app', { app: 'invoice', action: 'get_invoice', input: { id: 'bad' } });
    check(!bad.ok && bad.status === 400 && bad.result.error === 'no such invoice', "the app's own error comes back with its status");
    check(String((await tool(bob.token, 'call_app', { app: 'invoice', action: 'find_invoices', input: {} })).error).includes('q'), 'missing required arguments are refused before the app is called');
    check(String((await tool(bob.token, 'call_app', { app: 'invoice', action: 'delete_everything' })).error).includes('find_invoices'), 'undeclared actions are refused, naming the ones there are');
    const calls = seen.length;
    db.prepare("UPDATE apps SET visibility = 'private' WHERE slug = 'invoice'").run();
    check((await tool(bob.token, 'call_app', { app: 'invoice', action: 'find_invoices', input: { q: 'x' } })).error && !(await tool(bob.token, 'list_apps', {}) as { slug: string }[]).some((a) => a.slug === 'invoice'), 'someone who may not open the app cannot see or call it');
    db.prepare("UPDATE apps SET visibility = 'company' WHERE slug = 'invoice'").run();
    check(String((await tool(bob.token, 'update_app', { slug: 'invoice', agent_access: false })).error).length > 0, 'only who looks after the app turns agent calls off');
    await api(alex.jar, 'PATCH', '/apps/invoice', { agentAccess: false });
    check((await tool(bob.token, 'call_app', { app: 'invoice', action: 'find_invoices', input: { q: 'x' } })).error && seen.length === calls, 'turned off, agents cannot call it');
    const detail = (await api(alex.jar, 'GET', '/apps/invoice')).body.agent as { enabled: boolean; actions: unknown[]; calls30: number };
    check(!detail.enabled && detail.actions.length === 3 && detail.calls30 === 4, 'the app page shows the actions, the switch and how often agents called');
    check(((await api(bob.jar, 'GET', '/apps/invoice')).body.agent as { calls30?: number }).calls30 === undefined, 'call counts only for who looks after it');
    await api(alex.jar, 'PATCH', '/apps/invoice', { agentAccess: true });

    db.prepare("UPDATE app_releases SET agent_manifest = NULL WHERE app_slug = 'invoice'").run();
    actionsApp.close();
  }

  // hub-agent.json is checked when a version is published
  {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const dirs = ['ok', 'bad', 'static', 'none'].map((n) => { const d = path.join(mkdtempSync(path.join(tmpdir(), 'hub-agent-')), n); mkdirSync(d); return d; });
    writeFileSync(path.join(dirs[0], 'hub-agent.json'), JSON.stringify({ tables: { leads: { find: true, add: { fields: ['Company'], required: ['Company'] } }, later: { find: true } },
      actions: [{ name: 'add_note', description: 'Add a note', method: 'POST', path: '/api/notes' }, { name: 'list_notes', description: 'Notes', path: '/api/notes' }] }));
    writeFileSync(path.join(dirs[1], 'hub-agent.json'), JSON.stringify({ tables: { leads: { add: { fields: ['A'], required: ['B'], unique: ['C'] } } }, actions: [{ name: 'peek', description: 'x', path: '/__hub/lark/tables' }, { name: 'get', description: 'x', path: '/api/{id}' }] }));
    mkdirSync(path.join(dirs[2], 'dist'));
    writeFileSync(path.join(dirs[2], 'dist', 'hub-agent.json'), JSON.stringify({ tables: { leads: { find: true } }, actions: [{ name: 'x', description: 'x', path: '/x' }] }));
    const lark = JSON.stringify({ tables: [{ name: 'leads', access: 'write' }], notify: { people: [], chats: [] } });
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { readManifest } = await import(${JSON.stringify(path.resolve('server/apps/agentActions.ts'))});
      const dirs = ${JSON.stringify(dirs)};
      console.log(JSON.stringify([readManifest(dirs[0], 'container', null, ${JSON.stringify(lark)}), readManifest(dirs[1], 'container', null, null), readManifest(dirs[2], 'static', 'dist', null), readManifest(dirs[3], 'static', '.', null)]));`],
    { env: { ...process.env, DATA_DIR: dataDir, HUB_SECRET: 'smoke' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    type Read = { manifest: string | null; notes: { key: string; params?: { error?: string; names?: string; tables?: string } }[] };
    const [ok, badM, stat, none] = JSON.parse(out.trim().split('\n').at(-1)!) as Read[];
    const m = JSON.parse(ok.manifest ?? '{}') as { actions: { name: string; write: boolean; method: string }[] };
    check(ok.notes[0]?.key === 'note.agentActions' && ok.notes[0].params?.names === 'leads.find, leads.add, later.find, add_note, list_notes' && m.actions[0].write && !m.actions[1].write && m.actions[1].method === 'GET',
      'a valid hub-agent.json is taken; POST counts as a write, GET is the default and reads');
    check(ok.notes[1]?.key === 'note.agentTablesUndeclared' && ok.notes[1].params?.tables === 'later', 'tables the app has not declared in Lark are pointed out');
    check(!badM.manifest && badM.notes[0]?.key === 'note.agentInvalid' && ['__hub', '{id}', 'add.required', 'add.unique'].every((x) => badM.notes[0].params?.error?.includes(x)), 'an invalid one is refused with the reasons (hub paths, path arguments, required columns not listed)');
    check(stat.notes.some((n) => n.key === 'note.agentStatic') && JSON.parse(stat.manifest ?? '{}').tables?.leads && !JSON.parse(stat.manifest ?? '{}').actions?.length, "a static app keeps its tables (also from its published folder); actions need a server");
    check(!none.manifest && none.notes[0]?.key === 'note.agentMissing', 'an app without it is reminded');
    for (const d of dirs) rmSync(path.dirname(d), { recursive: true, force: true });
  }
  db.prepare("UPDATE apps SET kind = 'static', upstream = NULL WHERE slug = 'invoice'").run();
  db.close();
  upstream.close();

  // Skills get feedback too, from the hub page or from the person's agent
  const skillDir = mkdtempSync(path.join(tmpdir(), 'hub-skill-'));
  (await import('node:fs')).writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: invoice-check\ndescription: Checks invoices\n---\nCheck invoices.');
  (await import('node:fs')).mkdirSync(path.join(skillDir, 'references'));
  (await import('node:fs')).writeFileSync(path.join(skillDir, 'references', 'rules.md'), '# 规则\n专票要核对税号。');
  (await import('node:fs')).writeFileSync(path.join(skillDir, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe]));
  execFileSync(process.execPath, ['scripts/admin.ts', 'publish-skill', skillDir, '--owner', 'alex@example.com',
    '--localized', JSON.stringify({ 'zh-CN': { name: '发票检查', description: '检查发票' }, en: { name: 'Invoice check', description: 'Checks invoices' } })],
    { env: { ...process.env, DATA_DIR: dataDir, HUB_SECRET: 'smoke', DEV_LOGIN: '1', HUB_URL: HUB, LARK_APP_ID: 'cli_smoke', LARK_API_BASE: `http://localhost:${LARK_PORT}/open-apis` }, stdio: 'pipe' });
  rmSync(skillDir, { recursive: true, force: true });
  check(String((await tool(bob.token, 'install_skill', { name: 'invoice-check' })).install).includes('invoice-check'), 'install_skill also takes the name');
  const howTo = String((await tool(bob.token, 'install_skill', { slug: 'invoice-check' })).install);
  check(howTo.includes('DIR=~/.claude/skills/invoice-check;') && howTo.includes('DIR=~/.codex/skills/invoice-check;') && howTo.includes('.codex\\skills\\invoice-check'), 'install_skill gives a ready command for Claude Code and for Codex');
  // agents that cannot install Skills read them instead
  const readSk = await tool(bob.token, 'read_skill', { skill: 'invoice-check' }) as { version: number; instructions: string; files: { path: string; text: boolean }[] };
  check(readSk.version === 1 && readSk.instructions.includes('Check invoices.') && readSk.files.map((f) => `${f.path}:${f.text}`).sort().join() === 'logo.bin:false,references/rules.md:true',
    'read_skill gives the latest SKILL.md and lists the other files (not the hub\'s own .hub-skill.json)');
  const shownName = ((await tool(bob.token, 'list_skills')) as { slug: string; name: string }[]).find((x) => x.slug === 'invoice-check')!.name;
  check((await tool(bob.token, 'read_skill', { skill: shownName }) as { slug: string }).slug === 'invoice-check', 'and finds a Skill by its display name too');
  check((await tool(bob.token, 'read_skill', { skill: 'invoice-check', file: 'references/rules.md' }) as { content: string }).content === '# 规则\n专票要核对税号。', 'one of its files is read by path');
  check(String((await tool(bob.token, 'read_skill', { skill: 'invoice-check', file: 'logo.bin' })).error).includes('install_skill'), 'a binary file points to installing the Skill');
  check(String((await tool(bob.token, 'read_skill', { skill: 'invoice-check', file: 'nope.md' })).error).length > 0 && String((await tool(bob.token, 'read_skill', { skill: 'no-such-skill' })).error).length > 0, 'a missing file or Skill is refused');
  check(String(((await api(bob.jar, 'GET', '/skills/invoice-check')).body as { readme: string }).readme).includes('Check invoices.'), 'the Skill page still shows SKILL.md');
  lark.messages = [];
  check((await api(bob.jar, 'POST', '/skills/invoice-check/feedback', { body: '日期格式识别错了' })).status === 200, 'a colleague leaves feedback on a Skill');
  const sent = await tool(alice.token, 'send_feedback', { kind: 'skill', slug: 'invoice-check', body: '遇到增值税专票会报错', context: 'Step 2, error: unknown field "tax_rate" (v1)' });
  // messages go out in the background: wait for the one about this feedback
  const agentMsg = () => lark.messages.find((m) => m.text.includes('遇到增值税专票会报错'));
  for (let i = 0; i < 50 && !agentMsg(); i++) await new Promise((r) => setTimeout(r, 100));
  check(typeof sent.id === 'number' && agentMsg()?.text.includes('test') && agentMsg()?.text.includes('/skills/invoice-check#feedback'),
    "or has their agent send it; the owner is told which agent and where to look");
  const skillView = await api(alex.jar, 'GET', '/skills/invoice-check');
  const viaAgent = (skillView.body.feedback as { via: string; agent: string; context: string }[]).find((f) => f.via === 'agent');
  check((skillView.body.feedback as unknown[]).length === 2 && !!viaAgent?.agent && viaAgent.context.includes('tax_rate'), 'the owner sees both on the Skill page, with the details the agent added');
  check(((await api(bob.jar, 'GET', '/skills/invoice-check')).body.feedback as unknown[]).length === 1, "others only see what they sent themselves");
  const skillTodo = await tool(alex.token, 'list_feedback', { kind: 'skill' });
  check(skillTodo.items.length === 2 && skillTodo.items.every((f: { kind: string }) => f.kind === 'skill'), "the owner's agent lists Skill feedback");
  check(String((await tool(bob.token, 'list_feedback', { slug: 'invoice-check' })).error).length > 0, "and nobody else's agent can");
  lark.messages = [];
  await tool(alex.token, 'resolve_feedback', { id: sent.id, status: 'done', reply: 'v2 支持专票了' });
  // other messages may still be on their way: wait for the one to the sender
  const toSender = () => lark.messages.find((m) => m.id === 'ou_dev_alice' && m.text.includes('v2 支持专票了'));
  for (let i = 0; i < 50 && !toSender(); i++) await new Promise((r) => setTimeout(r, 100));
  check(toSender(), 'and resolving tells the sender');
  check(String((await tool(alice.token, 'send_feedback', { kind: 'skill', slug: 'no-such-skill', body: '你好' })).error).length > 0, 'feedback on something that does not exist is refused');
  lark.messages = [];
  const own = await api(alex.jar, 'POST', '/skills/invoice-check/feedback', { body: '自己先试一下' });
  await until(() => lark.messages.some((m) => m.id === 'ou_dev_alex'));
  check(own.status === 200 && lark.messages.some((m) => m.id === 'ou_dev_alex'), 'owners can send feedback on their own Skill to try it, and get the message');
  lark.messages = [];
  await tool(alex.token, 'resolve_feedback', { id: own.body.id, status: 'done', reply: '收到' });
  const reply = () => lark.messages.some((m) => m.id === 'ou_dev_alex' && m.text.includes('收到'));
  await until(reply);
  check(reply(), 'and the reply too');

  // several people looking after one Skill or app
  lark.messages = [];
  const team = await tool(alex.token, 'set_collaborators', { kind: 'skill', slug: 'invoice-check', add: ['bob@example.com'] });
  const toBob = () => lark.messages.some((m) => m.id === 'ou_dev_bob' && m.text.includes('/skills/invoice-check'));
  await until(toBob);
  check(team.collaborators?.map((c: { role: string }) => c.role).join() === 'owner,collaborator' && toBob(),
    'the owner adds a collaborator, who is told in Lark');
  check(String((await tool(bob.token, 'set_collaborators', { kind: 'skill', slug: 'invoice-check', add: ['alice@example.com'] })).error).length > 0, 'collaborators cannot add others');
  const skillDir2 = mkdtempSync(path.join(tmpdir(), 'hub-skill-'));
  (await import('node:fs')).writeFileSync(path.join(skillDir2, 'SKILL.md'), '---\nname: invoice-check\ndescription: Checks invoices\n---\nCheck invoices, VAT too.');
  execFileSync(process.execPath, ['scripts/admin.ts', 'publish-skill', skillDir2, '--owner', 'bob@example.com', '--notes', 'VAT'],
    { env: { ...process.env, DATA_DIR: dataDir, HUB_SECRET: 'smoke', DEV_LOGIN: '1', HUB_URL: HUB, LARK_APP_ID: 'cli_smoke', LARK_API_BASE: `http://localhost:${LARK_PORT}/open-apis` }, stdio: 'pipe' });
  rmSync(skillDir2, { recursive: true, force: true });
  const afterBob = (await api(alex.jar, 'GET', '/skills/invoice-check')).body as { skill: { version: number; owner: { id: string } } };
  check(afterBob.skill.version === 2 && afterBob.skill.owner.id === 'ou_dev_alex', 'a collaborator publishes a new version; the owner stays the owner');
  const bobSkill = (await api(bob.jar, 'GET', '/skills/invoice-check')).body.skill as { canManage: boolean; canAdminister: boolean; myRole: string };
  check(bobSkill.canManage && !bobSkill.canAdminister && bobSkill.myRole === 'collaborator', 'the Skill page knows what a collaborator may do');
  check((await tool(bob.token, 'list_feedback', { kind: 'skill' })).items?.length >= 1, "collaborators handle the Skill's feedback");
  lark.messages = [];
  await api(alice.jar, 'POST', '/skills/invoice-check/feedback', { body: '能不能支持电子发票' });
  // messages go out in the background, others may still be on their way: wait for the two about this feedback
  const aboutIt = () => lark.messages.filter((m) => m.text.includes('能不能支持电子发票')).map((m) => m.id).sort().join();
  for (let i = 0; i < 50 && aboutIt() !== 'ou_dev_alex,ou_dev_bob'; i++) await new Promise((r) => setTimeout(r, 100));
  check(aboutIt() === 'ou_dev_alex,ou_dev_bob', 'new feedback reaches the owner and the collaborators');
  check((await api(bob.jar, 'DELETE', '/skills/invoice-check')).status === 400, 'collaborators cannot delete it');
  check(((await api(bob.jar, 'GET', '/profile')).body.skills as { slug: string }[]).some((x) => x.slug === 'invoice-check'), "it shows among the collaborator's own Skills");
  await api(bob.jar, 'POST', '/skills/invoice-check/collaborators', { remove: ['ou_dev_bob'] });
  check(!((await api(bob.jar, 'GET', '/skills/invoice-check')).body.skill as { canManage: boolean }).canManage, 'anyone can leave on their own');

  await tool(alex.token, 'set_collaborators', { kind: 'app', slug: 'invoice', add: ['bob@example.com'] });
  const bobApps = await tool(bob.token, 'list_my_apps', {});
  check(Array.isArray(bobApps) && bobApps.some((x: { slug: string; myRole: string }) => x.slug === 'invoice' && x.myRole === 'collaborator'), 'collaborators find the app among theirs');
  check(!(await tool(bob.token, 'update_app', { slug: 'invoice', feedback_button: true })).error, 'and change its settings');
  check(String((await tool(bob.token, 'delete_app', { slug: 'invoice', confirm_slug: 'invoice' })).error).length > 0, 'but not delete it');
  lark.messages = [];
  const handed = await tool(alex.token, 'transfer_ownership', { kind: 'app', slug: 'invoice', to: 'alice@example.com' });
  await until(() => lark.messages.some((m) => m.id === 'ou_dev_alice'));
  check(handed.collaborators?.[0]?.id === 'ou_dev_alice' && handed.collaborators.some((c: { id: string; role: string }) => c.id === 'ou_dev_alex' && c.role === 'collaborator')
    && lark.messages.some((m) => m.id === 'ou_dev_alice'), 'the owner hands the app over and stays on as a collaborator');
  check(String((await tool(alex.token, 'set_collaborators', { kind: 'app', slug: 'invoice', remove: ['bob@example.com'] })).error).length > 0, 'after which they no longer choose collaborators');
  await tool(alice.token, 'transfer_ownership', { kind: 'app', slug: 'invoice', to: 'alex@example.com' });
  await tool(alex.token, 'set_collaborators', { kind: 'app', slug: 'invoice', remove: ['alice@example.com', 'bob@example.com'] });
  check((await tool(alex.token, 'set_collaborators', { kind: 'app', slug: 'invoice' })).collaborators.length === 1, 'and back again');

  // a Lark spreadsheet works like a table for agents and apps (row 1 = column names)
  const sheetUrl = 'https://x.larksuite.com/sheets/shtDeals?sheet=S1';
  await connect(alex.jar);
  const noSheets = await tool(alex.token, 'inspect_base', { url: sheetUrl });
  check(String(noSheets.error).includes('sheets=1'), 'reading a spreadsheet first asks for the spreadsheet permission');
  await connect(alex.jar, '&sheets=1');
  check(lark.scopesAsked.split(' ').includes('sheets:spreadsheet') && lark.scopesAsked.split(' ').includes('bitable:app:readonly'), 'which is asked for on top of Lark data access');
  const sheetLook = await tool(alex.token, 'inspect_base', { url: sheetUrl });
  check(sheetLook.fields?.map((f: { name: string }) => f.name).join() === '客户,产品,金额,状态' && sheetLook.sample?.length === 3 && sheetLook.sample.at(-1).row === 'row5', 'inspect_base shows its columns and last rows, skipping blank ones');
  const dealsDir = mkdtempSync(path.join(tmpdir(), 'hub-deals-'));
  (await import('node:fs')).writeFileSync(path.join(dealsDir, 'index.html'), '<!doctype html><title>deals</title>');
  execFileSync(process.execPath, ['scripts/admin.ts', 'publish-app', dealsDir, '--owner', 'alex@example.com', '--slug', 'deals', '--visibility', 'private',
    '--localized', JSON.stringify({ 'zh-CN': { name: '企业客户', description: '录入' }, en: { name: 'Deals', description: 'File deals' } })],
    { env: { ...process.env, DATA_DIR: dataDir, HUB_SECRET: 'smoke', DEV_LOGIN: '1', HUB_URL: HUB, LARK_APP_ID: 'cli_smoke', LARK_API_BASE: `http://localhost:${LARK_PORT}/open-apis` }, stdio: 'pipe' });
  rmSync(dealsDir, { recursive: true, force: true });
  const oneSheet = await tool(alex.token, 'set_app_lark', { slug: 'deals', lark: { tables: [{ name: 'deals', url: 'https://x.larksuite.com/sheets/shtDeals', access: 'write' }] } });
  check(!oneSheet.error && JSON.parse(String(new (await import('node:sqlite')).DatabaseSync(path.join(dataDir, 'hub.db')).prepare("SELECT lark_manifest FROM apps WHERE slug = 'deals'").get()?.lark_manifest)).tables[0].table === 'S1', 'a spreadsheet with one sheet needs no ?sheet=');
  const twoTables = String((await tool(alex.token, 'set_app_lark', { slug: 'deals', lark: { tables: [{ name: 'deals', url: 'https://x.larksuite.com/base/appOrders', access: 'read' }] } })).error);
  check(twoTables.includes('订单 (?table=tblOrders)') && twoTables.includes('项目 (?table=tblProjects)'), 'a Base with several tables asks which one, listing them');
  check(!(await tool(alex.token, 'set_app_lark', { slug: 'deals', lark: { tables: [{ name: 'deals', url: sheetUrl, access: 'write' }] } })).error, 'an app declares a spreadsheet like a table');
  const dealsApp = await loginToApp('deals', alex.jar);
  const consentAt = ((await (await appFetch('deals', '/__hub/lark/tables/deals/records', dealsApp)).json()) as { consentUrl: string }).consentUrl;
  const dealsCsrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(consentAt, { headers: { cookie: alex.jar.header() } })).text())![1];
  const dealsAllow = await fetch(`${HUB}/auth/app-lark`, { method: 'POST', redirect: 'manual', headers: { cookie: alex.jar.header() }, body: new URLSearchParams({ app: 'deals', return: '/', decision: 'allow', csrf: dealsCsrf }) });
  const dealsBack = (await fetch(`${HUB}${dealsAllow.headers.get('location')}`, { redirect: 'manual', headers: { cookie: alex.jar.header() } })).headers.get('location');
  check(dealsBack === 'http://deals.apps.localhost:18930/', 'with the permission already given, agreeing goes straight back to the app');
  const signed = await (await appFetch('deals', `/__hub/lark/tables/deals/records?where=${encodeURIComponent(JSON.stringify([{ field: '状态', op: 'is', value: '已签' }]))}`, dealsApp)).json() as { records: { id: string; text: Record<string, string> }[] };
  check(signed.records.map((r) => r.id).join() === 'row2,row5' && signed.records[1].text['客户'] === 'Atlas', 'the app reads rows as records, filtered');
  const sheetPost = (p: string, b: unknown, method = 'POST') => appFetch('deals', p, dealsApp, { 'content-type': 'application/json' }, method, JSON.stringify(b));
  const appended = await (await sheetPost('/__hub/lark/tables/deals/records', { fields: { 客户: 'Cobalt', 金额: 5000, 状态: '已签' } })).json() as { id: string };
  check(appended.id === 'row6' && JSON.stringify(lark.sheet[5]) === JSON.stringify(['Cobalt', null, 5000, '已签']), 'adds a row in column order');
  check((await sheetPost('/__hub/lark/tables/deals/records/row3', { fields: { 状态: '已签' } }, 'PATCH')).status === 200 && JSON.stringify(lark.sheet[2]) === JSON.stringify(['Lumen', 'Skills', '3000', '已签']), 'and changes one column of a row, keeping the rest');
  const typo = await (await sheetPost('/__hub/lark/tables/deals/records', { fields: { 客户名: 'x' } })).json() as { error: string };
  check(typo.error.includes('客户名') && typo.error.includes('客户, 产品, 金额, 状态'), 'a wrong column name is refused with the real ones');

  // no table named: the agent creates a Base for the app; records live in Lark, shared with whoever may open the app
  await connect(alex.jar, '&write=1&sheets=1');
  const newBase = await tool(alex.token, 'create_lark_base', { app: 'deals', name: '企业客户', tables: [{ name: '合作', columns: [
    { name: '客户', type: 'text' }, { name: '状态', type: 'select', options: ['待确认', '已确认'] }, { name: '金额', type: 'number' }, { name: '确认函', type: 'url' }] }] });
  const madeBase = lark.bases.get(newBase.token);
  check(newBase.tables?.[0]?.url === `https://x.larksuite.com/base/${newBase.token}?table=tblMade1` && madeBase?.tables.map((t) => t.name).join() === '合作'
    && madeBase.tables[0].fields.map((f) => f.field_name).join() === '客户,状态,金额,确认函', 'create_lark_base makes the tables and columns the app needs (without the empty default table)');
  check(lark.perms.at(-1)?.token === newBase.token && lark.perms.at(-1)?.public === 'closed', 'a private app keeps its Base private');
  lark.perms = [];
  await tool(alex.token, 'set_collaborators', { kind: 'app', slug: 'deals', add: ['bob@example.com'] });
  await until(() => lark.perms.some((x) => x.member === 'ou_dev_bob' && x.token === newBase.token));
  check(lark.perms.some((x) => x.member === 'ou_dev_bob' && x.token === newBase.token), 'a collaborator on the app gets edit access to its Base');
  lark.perms = [];
  await tool(alex.token, 'set_app_access', { slug: 'deals', visibility: 'company' });
  await until(() => lark.perms.some((x) => x.token === newBase.token && x.public === 'tenant_editable'));
  check(lark.perms.some((x) => x.token === newBase.token && x.public === 'tenant_editable'), 'opening the app to the company opens its Base to the company');
  const cols = await tool(alex.token, 'add_lark_columns', { url: newBase.tables[0].url, columns: [{ name: '邮箱', type: 'text' }, { name: '状态', type: 'select' }] });
  check(cols.added?.join() === '邮箱' && cols.skipped?.join() === '状态', 'add_lark_columns adds what is missing and leaves existing columns alone');
  const sheetCols = await tool(alex.token, 'add_lark_columns', { url: sheetUrl, columns: [{ name: '邮箱', type: 'text' }, { name: '确认日期', type: 'date' }, { name: '客户', type: 'text' }] });
  check(sheetCols.added?.join() === '邮箱,确认日期' && JSON.stringify(lark.sheet[0]) === JSON.stringify(['客户', '产品', '金额', '状态', '邮箱', '确认日期']) && lark.sheetCols === 6,
    'on a spreadsheet they go after the last column name');
  lark.sheetReadOnly = true;
  const readOnly = await tool(alex.token, 'add_lark_columns', { url: sheetUrl, columns: [{ name: '备注', type: 'text' }] });
  check(/create_lark_base/.test(String(readOnly.error)) && !/打不开|cannot open/.test(String(readOnly.error)), 'a table the person can only view says so, and what to do instead');
  lark.sheetReadOnly = false;

  // the Base can come first: it is the app's once the app is published and declares it
  lark.perms = [];
  const early = await tool(alex.token, 'create_lark_base', { app: 'later', name: '活动报名', tables: [{ name: '报名', columns: [{ name: '姓名', type: 'text' }, { name: '日期', type: 'date' }] }] });
  check(!early.error && String(early.next).includes('set_app_lark') && !lark.perms.length, 'create_lark_base works before the app exists');
  const laterDir = mkdtempSync(path.join(tmpdir(), 'hub-later-'));
  (await import('node:fs')).writeFileSync(path.join(laterDir, 'index.html'), '<!doctype html><title>later</title>');
  execFileSync(process.execPath, ['scripts/admin.ts', 'publish-app', laterDir, '--owner', 'alex@example.com', '--slug', 'later', '--visibility', 'company',
    '--localized', JSON.stringify({ 'zh-CN': { name: '活动报名', description: '报名' }, en: { name: 'Sign-ups', description: 'Sign up' } })],
    { env: { ...process.env, DATA_DIR: dataDir, HUB_SECRET: 'smoke', DEV_LOGIN: '1', HUB_URL: HUB, LARK_APP_ID: 'cli_smoke', LARK_API_BASE: `http://localhost:${LARK_PORT}/open-apis` }, stdio: 'pipe' });
  rmSync(laterDir, { recursive: true, force: true });
  const adopt = await tool(alex.token, 'set_app_lark', { slug: 'later', lark: { tables: [{ name: 'signups', url: `https://x.larksuite.com/base/${early.token}`, access: 'write' }] } });
  check(!adopt.error && adopt.sharedBases?.join() === '活动报名' && lark.perms.some((x) => x.token === early.token && x.public === 'tenant_editable'), 'declaring it shares it with whoever may open the app (and a Base with one table needs no ?table=)');
  lark.perms = [];
  await tool(alex.token, 'set_app_lark', { slug: 'later', lark: { tables: [{ name: 'signups', url: `https://x.larksuite.com/base/${early.token}`, access: 'write' }] } });
  check(!lark.perms.length, 'declaring it again does not share it again');

  // documents an app produces are Lark documents, created as the person
  check(!(await tool(alex.token, 'set_app_lark', { slug: 'deals', lark: { tables: [{ name: 'deals', url: sheetUrl, access: 'write' }], docs: {} } })).error, 'an app declares that it creates documents');
  const docConsent = ((await (await appFetch('deals', '/__hub/lark/docs', dealsApp, { 'content-type': 'application/json' }, 'POST', '{}')).json()) as { error: string; consentUrl: string });
  check(docConsent.error === 'consent_required', 'which needs agreeing again');
  const docPage = await (await fetch(docConsent.consentUrl, { headers: { cookie: alex.jar.header() } })).text();
  const docCsrf = /name="csrf" value="([^"]+)"/.exec(docPage)![1];
  const docAllow = await fetch(`${HUB}/auth/app-lark`, { method: 'POST', redirect: 'manual', headers: { cookie: alex.jar.header() }, body: new URLSearchParams({ app: 'deals', return: '/', decision: 'allow', csrf: docCsrf }) });
  const docGo = (await fetch(`${HUB}${docAllow.headers.get('location')}`, { redirect: 'manual', headers: { cookie: alex.jar.header() } })).headers.get('location') ?? '';
  check(docGo.startsWith('/auth/lark/connect') && docGo.includes('docs=1'), 'and, the first time, the document permission in Lark');
  await connect(alex.jar, '&docs=1');
  const letter = await (await appFetch('deals', '/__hub/lark/docs', dealsApp, { 'content-type': 'application/json' }, 'POST', JSON.stringify({ title: '合作确认函 · Cobalt', markdown: '## 合作内容\n\nAPI 套餐，12 个月' }))).json() as { url: string };
  check(String(letter.url).startsWith('https://www.larksuite.com/docx/') && [...lark.made.values()].some((d) => d.title === '合作确认函 · Cobalt'), 'then the app creates a Lark document from Markdown as the person');
  const letterDoc = [...lark.made.entries()].find(([, d]) => d.title === '合作确认函 · Cobalt')![0];
  check((letter as { sharedWith?: string }).sharedWith === 'company' && lark.perms.some((x) => x.token === letterDoc && x.type === 'docx' && x.public === 'tenant_readable'),
    'the new document is shared for viewing with whoever may open the app');

  // an app may notify whoever may use it (e.g. the person who submitted a request), checked when it sends
  await tool(alex.token, 'set_app_lark', { slug: 'deals', lark: { tables: [{ name: 'deals', url: sheetUrl, access: 'write' }], docs: {}, notify: { app_users: true } } });
  const usersConsent = ((await (await appFetch('deals', '/__hub/notify', dealsApp, { 'content-type': 'application/json' }, 'POST', '{}')).json()) as { consentUrl: string }).consentUrl;
  const usersPage = await (await fetch(usersConsent, { headers: { cookie: alex.jar.header() } })).text();
  check(/通知能使用这个应用的同事|notify colleagues who use this app/.test(usersPage) && /分享给能打开这个应用的人查看|shared for viewing with whoever may open this app/.test(usersPage), 'the consent page says it may message colleagues who use the app and shares documents');
  await fetch(`${HUB}/auth/app-lark`, { method: 'POST', redirect: 'manual', headers: { cookie: alex.jar.header() }, body: new URLSearchParams({ app: 'deals', return: '/', decision: 'allow', csrf: /name="csrf" value="([^"]+)"/.exec(usersPage)![1] }) });
  lark.messages = [];
  const tellBob = await (await appFetch('deals', '/__hub/notify', dealsApp, { 'content-type': 'application/json' }, 'POST', JSON.stringify({ to: ['ou_dev_bob'], text: '你的申请已通过' }))).json() as { sent: number };
  check(tellBob.sent === 1 && lark.messages[0]?.id === 'ou_dev_bob', 'a company app notifies a colleague by id without listing them');
  const stranger = await (await appFetch('deals', '/__hub/notify', dealsApp, { 'content-type': 'application/json' }, 'POST', JSON.stringify({ to: ['nobody@example.com'], text: 'x' }))).json() as { error: string };
  check(/nobody@example.com/.test(stranger.error) && /不是能使用这个应用的同事|not a colleague/.test(stranger.error), 'someone who is not a colleague is refused');
  await tool(alex.token, 'set_app_access', { slug: 'deals', visibility: 'private' });
  const outsider = await appFetch('deals', '/__hub/notify', dealsApp, { 'content-type': 'application/json' }, 'POST', JSON.stringify({ to: ['alice@example.com'], text: 'x' }));
  check(outsider.status === 400, 'once the app is private, colleagues who may not open it cannot be messaged');
  await tool(alex.token, 'set_app_access', { slug: 'deals', visibility: 'company' });

  // the code of the live version, for whoever looks after the app
  const { c: tarC } = await import('tar');
  const src = await tool(bob.token, 'get_app_source', { slug: 'deals' });
  const srcTgz = path.join(tmpdir(), `hub-src-${Date.now()}.tgz`);
  (await import('node:fs')).writeFileSync(srcTgz, Buffer.from(await (await fetch(src.download_url)).arrayBuffer()));
  const srcFiles: string[] = [];
  await (await import('tar')).t({ file: srcTgz, onReadEntry: (e) => { srcFiles.push(e.path); } });
  check(src.live && srcFiles.some((f) => f.endsWith('index.html')) && String(src.command).includes('tar -xz'), 'a collaborator gets the code of the live version');
  check(String((await tool(alice.token, 'get_app_source', { slug: 'deals' })).error).length > 0, 'someone who does not look after the app does not');
  check((await fetch(src.download_url.replace(/t=[^&]+/, 't=1.x'))).status === 403, 'and the download link is signed');
  // a project folder with a key in it is refused before anything changes
  const leakDir = mkdtempSync(path.join(tmpdir(), 'hub-leak-'));
  const fsx = await import('node:fs');
  fsx.writeFileSync(path.join(leakDir, 'index.html'), '<h1>v2</h1>');
  fsx.writeFileSync(path.join(leakDir, 'deploy.js'), 'const key = `-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----`;');
  const putTar = async (purpose: string, dir: string) => {
    const up = await tool(alex.token, 'create_upload', { purpose });
    const file = path.join(tmpdir(), `${up.upload_id}.tgz`);
    await tarC({ gzip: true, file, cwd: dir }, ['.']);
    await fetch(up.upload_url, { method: 'PUT', body: fsx.readFileSync(file) });
    rmSync(file, { force: true });
    return up.upload_id as string;
  };
  const leak = await tool(alex.token, 'publish_app', { upload_id: await putTar('app', leakDir), source_upload_id: await putTar('source', leakDir), slug: 'deals', kind: 'static' });
  check(/deploy\.js/.test(String(leak.error)), 'a source with a private key in it is refused, naming the file');
  fsx.rmSync(path.join(leakDir, 'deploy.js'));
  const distDir = mkdtempSync(path.join(tmpdir(), 'hub-dist-'));
  fsx.writeFileSync(path.join(distDir, 'index.html'), '<h1>built</h1>');
  fsx.writeFileSync(path.join(leakDir, 'package.json'), '{"scripts":{"build":"vite build"}}');
  const built = await tool(alex.token, 'publish_app', { upload_id: await putTar('app', distDir), source_upload_id: await putTar('source', leakDir), slug: 'deals', kind: 'static' });
  const src2 = await tool(alex.token, 'get_app_source', { slug: 'deals' });
  const srcFiles2: string[] = [];
  fsx.writeFileSync(srcTgz, Buffer.from(await (await fetch(src2.download_url)).arrayBuffer()));
  await (await import('tar')).t({ file: srcTgz, onReadEntry: (e) => { srcFiles2.push(e.path); } });
  check(!built.error && src2.version === built.version && srcFiles2.some((f) => f.endsWith('package.json')), 'a build publishes with its project folder kept as the source');
  rmSync(leakDir, { recursive: true, force: true }); rmSync(distDir, { recursive: true, force: true }); rmSync(srcTgz, { force: true });

  // asking to open an app to everyone messages the admins; their decision messages the owner
  lark.messages = [];
  const pubDir = mkdtempSync(path.join(tmpdir(), 'hub-pub-'));
  (await import('node:fs')).writeFileSync(path.join(pubDir, 'index.html'), '<h1>open</h1>');
  execFileSync(process.execPath, ['scripts/admin.ts', 'publish-app', pubDir, '--owner', 'alice@example.com', '--slug', 'open-demo', '--visibility', 'company',
    '--localized', JSON.stringify({ 'zh-CN': { name: '公开演示', description: '演示' }, en: { name: 'Open demo', description: 'Demo' } })],
    { env: { ...process.env, DATA_DIR: dataDir, HUB_SECRET: 'smoke', DEV_LOGIN: '1', HUB_URL: HUB, LARK_APP_ID: 'cli_smoke', LARK_API_BASE: `http://localhost:${LARK_PORT}/open-apis` }, stdio: 'pipe' });
  rmSync(pubDir, { recursive: true, force: true });
  check((await tool(alice.token, 'set_app_access', { slug: 'open-demo', visibility: 'public' })).publicStatus === 'pending', 'the owner asks to open it to everyone');
  // messages go out in the background (and an earlier one may still land): wait for the one meant, up to 3 s
  const waitFor = async (ok: (m: { id: string; text: string }) => boolean) => {
    for (let i = 0; i < 30 && !lark.messages.some(ok); i++) await new Promise((r) => setTimeout(r, 100));
    return lark.messages.filter(ok);
  };
  const toAdmin = await waitFor((m) => m.text.includes('open-demo'));
  check(toAdmin.length === 1 && toAdmin[0].id === 'ou_dev_alex' && toAdmin[0].text.includes('/admin'), 'a public request messages the admins with a link to approve');
  lark.messages = [];
  check((await api(alex.jar, 'POST', '/admin/apps/open-demo/public', { approve: true })).status === 200, 'the admin approves it');
  const toOwner = await waitFor((m) => m.id === 'ou_dev_alice');
  check(toOwner.length === 1, 'and the owner is told');

  // GitHub: link the account once, then agents read commits, pull requests and reviews through the hub
  const notLinked = await tool(alex.token, 'github_activity', {});
  check(notLinked.linked === false && String(notLinked.hint).includes('/auth/github/connect'), 'before linking, github_activity says how to link GitHub');
  const calBefore = (await api(alex.jar, 'GET', '/github/contributions')).body;
  check(calBefore.linked === false && String(calBefore.connectUrl).includes('/auth/github/connect'), 'the GitHub home module asks to link the account first');
  check((await tool(alex.token, 'preview_homepage', { scope: 'me', layout: { modules: [{ type: 'github', weeks: 26 }] } })).previewUrl, 'home module "my GitHub contributions"');
  const ghStart = await fetch(`${HUB}/auth/github/connect?return=/me`, { redirect: 'manual', headers: { cookie: alex.jar.header() } });
  alex.jar.store(ghStart);
  const ghAuth = await fetch(ghStart.headers.get('location')!, { redirect: 'manual' });
  const ghBack = await fetch(ghAuth.headers.get('location')!, { redirect: 'manual', headers: { cookie: alex.jar.header() } });
  check(ghBack.status === 302 && ghBack.headers.get('location') === '/me', 'linking GitHub returns to the Me page');
  const ghStatus = (await api(alex.jar, 'GET', '/github/status')).body;
  check(ghStatus.available === true && ghStatus.login === 'alex-gh' && ghStatus.org === 'acme', 'the Me page shows the linked GitHub username');
  const cal = (await api(alex.jar, 'GET', '/github/contributions?weeks=12')).body as {
    linked: boolean; days: { value: number }[]; profile: string; streak: { current: number; longest: number }; activeDays: number; commits: number; total: number; reviews: number; repos: { name: string; url: string }[];
  };
  check(cal.linked && cal.days.length === 84 && cal.days.at(-1)?.value === 2 && cal.profile.endsWith('/alex-gh'), 'the calendar has a count for every day of the window, up to today');
  check(cal.streak.current === 3 && cal.streak.longest === 3 && cal.activeDays === cal.days.filter((d: { value: number }) => d.value > 0).length && cal.commits === cal.total - 3 && cal.reviews === 1,
    'with the totals, active days and streaks');
  check(cal.repos[0]?.name === 'hub' && cal.repos[0].url === 'https://github.com/acme/hub', 'and the repositories with the most commits');
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

  // Lark documents an agent works through, e.g. for the daily report Skill: find a page under a wiki page by its
  // title, read its tables cell by cell, change one's own cells as oneself
  await connect(alex.jar);
  await connect(alice.jar);
  const listedWiki = await tool(alex.token, 'list_lark_wiki', { url: 'https://x.larksuite.com/wiki/wikDaily', title: '1020' });
  check(listedWiki.title === '团队日会' && listedWiki.pages.length === 1 && listedWiki.pages[0].url === 'https://x.larksuite.com/wiki/wik1020' && listedWiki.pages[0].type === 'docx',
    'list_lark_wiki finds a page by its title (on the second page of results), linked on the company\'s Lark address');
  check((await tool(alex.token, 'list_lark_wiki', { url: 'https://x.larksuite.com/wiki/wikDaily' })).total === 2, 'and lists them all without a title');
  check(String((await tool(alex.token, 'list_lark_wiki', { url: 'https://x.larksuite.com/docx/doxDaily' })).error).includes('/wiki/'), 'only for wiki pages');
  const report = await tool(alex.token, 'read_lark_doc', { url: listedWiki.pages[0].url, tables: true }) as { title: string; tables: { id: string; heading: string; rows: { id: string; text: string; people?: { id: string; name: string }[] }[][] }[] };
  check(report.title === '团队工作日报 1020' && report.tables.map((x) => x.heading).join('|') === '社媒资源层 @林小雨|三、日常工作', 'read_lark_doc with tables gives each table under its heading');
  const social = report.tables[0];
  check(social.rows[0].map((c) => c.text).join() === '负责人,昨天完成,今天计划,卡点和需要谁' && social.rows[1][0].people?.[0].id === 'ou_dev_alex' && social.rows[2][1].text === '招募 47 位创作者\n完善 SOP',
    'row by row, each cell with its text and the people mentioned (read across pages of blocks)');
  const mineRow = social.rows.find((r) => r[0].people?.some((x) => x.id === 'ou_dev_alex'))!;
  const edits = [{ id: mineRow[1].id, text: '写完日报工具\n修好网关' }, { id: mineRow[2].id, text: '接 GitHub webhook' }];
  check(String((await tool(alex.token, 'edit_lark_doc', { url: listedWiki.pages[0].url, edits })).error).includes('docs=1'), 'editing first asks the person to let the hub edit Lark documents');
  await connect(alex.jar, '&docs=1');
  check(lark.scopesAsked.split(' ').includes('docx:document') && lark.scopesAsked.split(' ').includes('docx:document:readonly'), 'that connection asks for document editing on top of reading');
  check(String((await tool(alex.token, 'edit_lark_doc', { url: listedWiki.pages[0].url, edits: [...edits, { id: 'nope', text: 'x' }] })).error).includes('nope'), 'an unknown id is refused before anything is written');
  const edited = await tool(alex.token, 'edit_lark_doc', { url: listedWiki.pages[0].url, edits });
  const after = await tool(alex.token, 'read_lark_doc', { url: listedWiki.pages[0].url, tables: true }) as typeof report;
  check(edited.edited?.length === 2 && after.tables[0].rows[1].slice(1).map((c) => c.text).join('|') === '写完日报工具\n修好网关|接 GitHub webhook|', 'edit_lark_doc replaces the cells given, one paragraph per line');
  check(after.tables[0].rows[2][1].text === '招募 47 位创作者\n完善 SOP' && after.tables[0].rows[1][0].people?.[0].id === 'ou_dev_alex', "and leaves the rest as it was");
  const styled = '**写完**日报工具，见[说明](https://x.com/a)\n2\\*3 用 `pnpm test`';
  await tool(alex.token, 'edit_lark_doc', { url: listedWiki.pages[0].url, edits: [{ id: mineRow[1].id, text: styled }] });
  const styledCell = (await tool(alex.token, 'read_lark_doc', { url: listedWiki.pages[0].url, tables: true }) as typeof report).tables[0].rows[1][1];
  const cellRuns = lark.doc.get(lark.doc.get(mineRow[1].id)!.children![0])!.text as { elements: { text_run: { content: string; text_element_style?: Record<string, unknown> } }[] };
  check(cellRuns.elements[0].text_run.content === '写完' && cellRuns.elements[0].text_run.text_element_style?.bold === true && cellRuns.elements.some((e) => (e.text_run.text_element_style?.link as { url?: string })?.url === encodeURIComponent('https://x.com/a')),
    'edits take inline Markdown: bold and links become Lark styles');
  check(styledCell.text === styled && (lark.doc.get(lark.doc.get(mineRow[1].id)!.children![1])!.text as typeof cellRuns).elements[0].text_run.content === '2*3 用 ',
    'and a cell reads back as the same Markdown, a literal * escaped, so reading and writing back changes nothing');
  const headingId = [...lark.doc.values()].find((x) => x.block_type === 3)!.block_id;
  await tool(alex.token, 'edit_lark_doc', { url: listedWiki.pages[0].url, edits: [{ id: headingId, text: '二、本周项目' }] });
  check(((await tool(alex.token, 'read_lark_doc', { url: listedWiki.pages[0].url })).markdown as string).startsWith('# 二、本周项目'), 'and the text of a paragraph or heading');
  check(String((await tool(alex.token, 'edit_lark_doc', { url: listedWiki.pages[0].url, edits: [{ id: social.id, text: 'x' }] })).error).includes(social.id), 'but not of a table as a whole');
  check(String((await tool(alex.token, 'edit_lark_doc', { url: listedWiki.pages[0].url })).error).length > 0, 'asking for no change is refused');
  const toolList = JSON.stringify(await (await fetch(`${HUB}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }) })).json());
  check(toolList.includes('edit_lark_doc') && !toolList.includes('daily_report'), 'the hub has no daily-report tools of its own (that is a Skill)');

  // Lark documents: read one as Markdown, create one from Markdown as the person
  const wikiPage = await tool(alex.token, 'read_lark_doc', { url: 'https://x.larksuite.com/wiki/wikDaily' });
  check(wikiPage.title === '团队日会' && wikiPage.url === 'https://www.larksuite.com/wiki/wikDaily', 'an agent reads the document behind a wiki page');
  check(wikiPage.markdown === '## 怎么开日会\n\n每天早上 **9:30**，日报放在这里，@林小雨 主持。\n- 先看昨天\n  - 卡点优先\n\n| **负责人** | 时间 |\n| --- | --- |\n| @Alex | 周一 |', 'as Markdown: headings, bold, @people, nested lists and tables');
  check(String((await tool(alex.token, 'read_lark_doc', { url: 'https://example.com/whatever' })).error).length > 0, 'a link that is not a Lark document is refused');
  await api(alex.jar, 'POST', '/lark/disconnect');
  await connect(alex.jar);
  const bigMd = ['# 方案', '背景说明', '| 项目 | 负责人 |\n| --- | --- |\n| 日报 | Alex |\n| 网关 | 林小雨 |', '![架构图](https://x/y.png)', ...Array.from({ length: 1200 }, (_, i) => `第 ${i + 1} 条`)].join('\n\n');
  check(String((await tool(alex.token, 'create_lark_doc', { title: '周会纪要', markdown: bigMd })).error).includes('docs=1'), 'creating a document first asks the person to let the hub create and edit documents');
  await connect(alex.jar, '&docs=1');
  check(['docx:document', 'docx:document:create'].every((x) => lark.scopesAsked.split(' ').includes(x)), 'that connection asks for creating and editing documents');
  const made = await tool(alex.token, 'create_lark_doc', { title: '周会纪要', markdown: bigMd });
  const madeDoc = lark.made.get(String(made.url).split('/').pop()!);
  check(made.url?.startsWith('https://www.larksuite.com/docx/') && madeDoc?.title === '周会纪要' && !madeDoc.folder, 'a document is created in the person\'s own space, with a link to it');
  check(made.blocks === 1215 && madeDoc!.calls === 2 && madeDoc!.blocks.some((b) => b.block_type === 31), 'the Markdown goes in as blocks, tables included, in batches Lark accepts');
  check(madeDoc!.blocks.some((b) => b.block_type === 3 && JSON.stringify(b).includes('方案')) && madeDoc!.blocks.filter((b) => b.block_type === 32).length === 6, 'headings and table cells come out as Lark blocks');
  check(made.imagesLeftOut === 1 && !madeDoc!.blocks.some((b) => b.block_type === 27), 'images are left out, and the result says so');
  const inFolder = await tool(alex.token, 'create_lark_doc', { title: '放进文件夹', markdown: '一行', parent: 'https://x.larksuite.com/drive/folder/fldAbc123' });
  check(lark.made.get(String(inFolder.url).split('/').pop()!)?.folder === 'fldAbc123', 'or in a Drive folder');
  const appendedDoc = await tool(alex.token, 'edit_lark_doc', { url: inFolder.url, append: '## 补充\n\n- 第二行' });
  check(appendedDoc.appendedBlocks === 2 && lark.made.get(String(inFolder.url).split('/').pop()!)!.blocks.length === 3, 'edit_lark_doc adds Markdown at the end of a document');

  check(String((await tool(alex.token, 'create_lark_doc', { title: '放进知识库', markdown: '一行', parent: 'https://x.larksuite.com/wiki/wikDaily' })).error).includes('wiki=1'), 'placing it under a wiki page first asks for wiki editing');
  await connect(alex.jar, '&wiki=1');
  check(lark.scopesAsked.split(' ').includes('wiki:wiki') && lark.scopesAsked.split(' ').includes('docx:document:create'), 'which is added on top of document access');
  const inWiki = await tool(alex.token, 'create_lark_doc', { title: '放进知识库', markdown: '一行', parent: 'https://x.larksuite.com/wiki/wikDaily' });
  check(String(inWiki.url).startsWith('https://www.larksuite.com/wiki/wikMade') && [...lark.made.values()].some((d) => d.folder === 'wiki:wikDaily' && d.title === '放进知识库'), 'the document becomes a page under the wiki page');
  check(String((await tool(alex.token, 'create_lark_doc', { title: 'x', markdown: 'y', parent: 'https://x.larksuite.com/docx/doxDaily' })).error).length > 0, 'a document cannot go inside another document');

  // files in the wiki and Drive: an uploaded HTML page read as text, anything else as a download link; uploading one
  const htmlPage = 'https://x.larksuite.com/wiki/wikHtml';
  check(String((await tool(alex.token, 'read_lark_doc', { url: htmlPage })).error).includes('drive=1'), 'reading a file first asks the person to let the hub download files');
  await connect(alex.jar, '&drive=1');
  check(lark.scopesAsked.split(' ').includes('drive:file:readonly') && !lark.scopesAsked.split(' ').includes('drive:file'), 'that asks only for downloading, nothing more');
  const htmlRead = await tool(alex.token, 'read_lark_doc', { url: htmlPage });
  check(htmlRead.title === 'aisa-one-site-suggestions.html' && htmlRead.text === lark.driveFiles.get('boxHtml')!.bytes && htmlRead.url === htmlPage && String(htmlRead.download).includes('/lark-drive-file/boxHtml'),
    'a wiki link to an uploaded HTML page reads the page as text, with a download link');
  const got = await fetch(String(htmlRead.download));
  check(got.status === 200 && (await got.text()) === lark.driveFiles.get('boxHtml')!.bytes && (got.headers.get('content-disposition') ?? '').includes(encodeURIComponent('aisa-one-site-suggestions.html')), 'the link streams the file, under its name');
  check((await fetch(String(htmlRead.download).replace(/t=[^&]+/, 't=forged'))).status === 403, 'a link that was not given out does not work');
  const pdf = await tool(alex.token, 'read_lark_doc', { url: 'https://x.larksuite.com/file/boxPdf' });
  check(pdf.text === undefined && pdf.file?.name === '合同.pdf' && String(pdf.download).includes('/lark-drive-file/boxPdf'), 'a file that is not text comes as a download link only');

  const html = { name: '官网改版建议.html', mime_type: 'text/html', data: Buffer.from('<html>建议</html>').toString('base64') };
  const filesBefore = lark.driveFiles.size;
  const noUpload = await tool(alex.token, 'upload_lark_file', { file: html, parent: 'https://x.larksuite.com/wiki/wik1020' });
  check(String(noUpload.error).includes('upload=1') && String(noUpload.error).includes('wiki=1') && lark.driveFiles.size === filesBefore, 'uploading first asks the person to let the hub upload files (and place them in the wiki), before anything goes up');
  await connect(alex.jar, '&upload=1&wiki=1');
  const asked = lark.scopesAsked.split(' ');
  check(asked.includes('drive:file') && asked.includes('drive:drive.metadata:readonly') && asked.includes('wiki:wiki') && !asked.includes('drive:drive'), 'that asks for uploading, never for managing or deleting files');
  const fileInWiki = await tool(alex.token, 'upload_lark_file', { file: html, parent: 'https://x.larksuite.com/wiki/wik1020' });
  const uploaded = [...lark.driveFiles.values()].at(-1)!;
  check(fileInWiki.place === 'wiki' && String(fileInWiki.url).endsWith('/wiki/wikFile1') && uploaded.name === '官网改版建议.html' && uploaded.bytes === '<html>建议</html>' && uploaded.folder === 'fldRoot' && uploaded.wiki === 'wik1020',
    'upload_lark_file puts the file in the person\'s space and moves it under the wiki page, returning the page');
  const inFolderFile = await tool(alex.token, 'upload_lark_file', { file: html, parent: 'https://x.larksuite.com/drive/folder/fldTeam' });
  check(String(inFolderFile.url).includes('/file/boxUp') && [...lark.driveFiles.values()].at(-1)!.folder === 'fldTeam' && !(await tool(alex.token, 'read_lark_doc', { url: htmlPage })).error,
    'or into a Drive folder; and downloading still works with the upload access');
  check(String((await tool(alex.token, 'upload_lark_file', { file: html, parent: 'https://x.larksuite.com/docx/doxDaily' })).error).includes('wiki'), 'but not inside a document');
  const locked = await tool(alex.token, 'upload_lark_file', { file: html, parent: 'https://x.larksuite.com/wiki/wikLocked' });
  check(!locked.error && locked.place === 'my space' && String(locked.url).includes('/file/boxUp') && String(locked.note).includes('did not put it under the wiki page'),
    'a wiki page the person may not add to leaves the file in their own space, and the agent is told so with its link');

  // the admin's picker: Lark's own features always; the company's apps once the hub may read them
  check((await api(alice.jar, 'GET', '/lark-links/catalog')).status === 400, 'only admins see the Lark app picker');
  let catalog = (await api(alex.jar, 'GET', '/lark-links/catalog')).body as { builtins: { name: string; url: string }[]; installed: { key: string; name: string; url: string; description: string }[]; installedMissing: boolean };
  check(catalog.installedMissing && catalog.installed.length === 0 && catalog.builtins.some((x) => x.url === 'https://applink.larksuite.com/client/calendar/open'), 'without app info access the picker still offers Calendar and Tasks');
  lark.appInfo = true;
  catalog = (await api(alex.jar, 'GET', '/lark-links/catalog')).body as typeof catalog;
  check(!catalog.installedMissing && catalog.installed.map((x) => x.key).join() === 'cli_approval,cli_wiki', 'it lists enabled apps that can be opened, not the hub itself');
  const approval = catalog.installed.find((x) => x.key === 'cli_approval')!;
  check(approval.name === 'Approval' && approval.description === 'Request approvals' && approval.url === 'https://applink.larksuite.com/client/mini_program/open?appId=cli_approval&mode=appCenter', 'in the reader\'s language, opening the right way');

  // an admin pins a Lark shortcut under the sidebar navigation
  await api(alex.jar, 'POST', '/lark-links', { name: '审批', url: 'https://applink.larksuite.com/approval', icon: '✅' });
  const link = ((await api(alex.jar, 'GET', '/admin')).body.larkLinks as { id: number; name: string }[]).find((l) => l.name === '审批')!;
  check(((await api(alice.jar, 'GET', '/me')).body.sidebarLinks as unknown[]).length === 0, 'shortcuts are not in the sidebar until an admin puts them there');
  check((await api(alice.jar, 'POST', `/lark-links/${link.id}/sidebar`, { on: true })).status === 400, 'only admins pin shortcuts');
  await api(alex.jar, 'POST', `/lark-links/${link.id}/sidebar`, { on: true });
  check(((await api(alice.jar, 'GET', '/me')).body.sidebarLinks as { name: string }[])[0]?.name === '审批', 'a pinned shortcut shows in everyone\'s sidebar');

  // data connections: an admin connects Metabase with a key; the hub decides who sees each question
  const MB = `http://localhost:${LARK_PORT}/mb`;
  check((await api(alice.jar, 'POST', '/admin/connections', { type: 'metabase', config: { url: MB, apiKey: 'mb_good' } })).status === 400, 'only admins set up data connections');
  check(/管理员分组|admin group/.test(String((await api(alex.jar, 'POST', '/admin/connections', { type: 'metabase', config: { url: MB, apiKey: 'mb_admin' } })).body.error)), 'a key in the admin group is refused');
  check(/API key/.test(String((await api(alex.jar, 'POST', '/admin/connections', { type: 'metabase', config: { url: MB, apiKey: 'mb_wrong' } })).body.error)), 'a wrong key is refused before anything is saved');
  const conn = (await api(alex.jar, 'POST', '/admin/connections', { type: 'metabase', config: { url: MB, apiKey: 'mb_good' } })).body;
  check(conn.id === 'metabase' && conn.as === 'AIsa Hub', 'a working key is saved, and the page says who it reads as');
  const conns = (await api(alex.jar, 'GET', '/admin/connections')).body as { connections: { config: Record<string, string>; secretsSet: string[] }[] };
  check(conns.connections[0].config.url === MB && !JSON.stringify(conns).includes('mb_good') && conns.connections[0].secretsSet.join() === 'apiKey', 'the key is never sent back, only that it is set');
  check((await api(alex.jar, 'POST', '/admin/connections', { type: 'metabase', config: { url: MB, apiKey: '' } })).status === 200, 'changing the address keeps the stored key');
  const items = (await api(alex.jar, 'GET', '/admin/connections/metabase/browse?q=收入')).body.items as { id: string }[];
  check(items.map((i) => i.id).join() === '309', 'admins search the questions it can read (archived ones left out)');
  const mbSaved = await api(alex.jar, 'POST', '/admin/data-sources', { id: 'mb-signups', title: { 'zh-CN': '每日新增用户', en: 'Daily sign-ups' }, connection: 'metabase', item: '232' });
  check(mbSaved.status === 200, 'an admin adds a question as a data source');
  check(!((await api(bob.jar, 'GET', '/data/sources')).body.sources as { id: string }[]).some((x) => x.id === 'mb-signups'), 'new connection sources are for admins only: others do not even see them listed');
  check(String((await tool(bob.token, 'query_data', { source: 'mb-signups', query: { measure: { op: 'sum', field: 'real_users' } } })).error).length > 0, "and a colleague's agent cannot query it");
  const mbAdmin = await tool(alex.token, 'query_data', { source: 'mb-signups', query: { measure: { op: 'sum', field: 'real_users' }, date: { field: 'reg_date', bucket: 'day', last: 3 } } });
  check(mbAdmin.value === 18 + 19 + 17 && mbAdmin.rows?.length === 3, 'the question\'s date column works as a date (types come from Metabase)');
  const mbDenied = await api(bob.jar, 'POST', '/data/module', { source: 'mb-signups', query: { measure: { op: 'count' } }, kind: 'stat' });
  check(mbDenied.status === 400 && mbDenied.body.code === 'err.data.deniedSource', 'a home module on it tells a colleague they may not see it');
  check((await api(alice.jar, 'POST', '/admin/data-sources/mb-signups/audience', { audience: { company: true } })).status === 400, 'only admins choose who sees it');
  await api(alex.jar, 'POST', '/admin/data-sources/mb-signups/audience', { audience: { people: ['ou_dev_bob'] } });
  const runs = lark.mbRuns;
  const bobQ = await tool(bob.token, 'query_data', { source: 'mb-signups', query: { measure: { op: 'count' } } });
  check(bobQ.value === 10, 'once added to the audience, the colleague (and their agent) can read it');
  check(String((await tool(alice.token, 'query_data', { source: 'mb-signups', query: { measure: { op: 'count' } } })).error).length > 0, 'people outside the audience still cannot');
  await api(bob.jar, 'POST', '/data/module', { source: 'mb-signups', query: { measure: { op: 'sum', field: 'real_users' } }, kind: 'stat' });
  await api(alex.jar, 'POST', '/data/module', { source: 'mb-signups', query: { measure: { op: 'sum', field: 'real_users' } }, kind: 'stat' });
  check(lark.mbRuns - runs <= 1, 'everyone shares one cached copy of the rows (it is the same key for all)');
  const fsDb = new (await import('node:sqlite')).DatabaseSync(path.join(dataDir, 'hub.db'));
  fsDb.prepare("INSERT OR IGNORE INTO departments (id, name, updated_at) VALUES ('od-growth', '增长', 0)").run();
  fsDb.prepare("INSERT OR IGNORE INTO user_departments (user_id, department_id) VALUES ('ou_dev_alice', 'od-growth')").run();
  await api(alex.jar, 'POST', '/admin/data-sources/mb-signups/audience', { audience: { departments: ['od-growth'] } });
  check(!(await tool(alice.token, 'query_data', { source: 'mb-signups', query: { measure: { op: 'count' } } })).error, 'a department in the audience: its members can read it');
  await api(alex.jar, 'POST', '/admin/data-sources/mb-signups/audience', { audience: { company: true } });
  const mbListed = ((await api(alice.jar, 'GET', '/data/sources')).body.sources as { id: string; audience?: { company: boolean } }[]).find((x) => x.id === 'mb-signups');
  check(mbListed?.audience?.company === true, 'the whole company: everyone sees it listed');
  check((await api(alex.jar, 'DELETE', '/admin/connections/metabase')).status === 400, 'a connection in use cannot be deleted');
  const intro2 = String(((await (await fetch(`${HUB}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }) })).json()) as { result: { instructions: string } }).result.instructions);
  check(intro2.includes('Data connections:') && !intro2.includes('METABASE_API_KEY'), 'agents are told to use a data connection instead of building a Metabase app');
  // agents keep the instructions and tools from when they connected: tell them when the hub changed since
  const rawCall = async (name: string) => ((await (await fetch(`${HUB}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: {} } }) })).json()) as { result: { content: { text: string }[] } }).result.content.map((c) => c.text);
  const reconnect = () => fetch(`${HUB}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }) });
  const resources = (await (await fetch(`${HUB}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'resources/read', params: { uri: 'hub://data-sources' } }) })).json()) as { result: { contents: { text: string }[] } };
  check((JSON.parse(resources.result.contents[0].text).sources as { id: string }[]).some((x) => x.id === 'mb-signups'), 'agents that look at resources first find the data sources there too');
  let texts = await rawCall('whoami');
  check(texts.length === 1 && /^[0-9a-f]{12}$/.test(JSON.parse(texts[0]).version), 'an agent that just connected gets plain results, and whoami says the version');
  fsDb.prepare("UPDATE agent_connections SET seen_version = 'older' WHERE user_id = 'ou_dev_alex'").run();
  texts = await rawCall('whoami');
  check(texts.length === 2 && /重新连接|Reconnect/.test(texts[1]), 'one that connected to an older version is told to reconnect, with every result');
  await reconnect();
  check((await rawCall('whoami')).length === 1, 'and no longer once it has reconnected');

  // agents read the records themselves, with the person's access
  const rowsBob = await tool(bob.token, 'read_data_rows', { source: 'mb-signups', where: [{ field: 'real_users', op: 'isGreater', value: 15 }], sort: { field: 'real_users', desc: true }, limit: 2 });
  check(rowsBob.matched === 4 && rowsBob.rows?.length === 2 && rowsBob.rows[0].real_users === '19' && String(rowsBob.note).includes('2 of 4'), 'read_data_rows: matching records, sorted, limited, as the person');
  await api(alex.jar, 'POST', '/admin/data-sources', { id: 'mb-revenue', title: { 'zh-CN': '每日收入', en: 'Daily revenue' }, connection: 'metabase', item: '309' });
  check(String((await tool(bob.token, 'read_data_rows', { source: 'mb-revenue' })).error).length > 0, 'and not what they may not see');

  // a whole dashboard comes in as boards: questions become sources, cards become modules, one board per tab
  check((await api(bob.jar, 'POST', '/admin/connections/metabase/import', { board: '100' })).status === 400, 'only admins import dashboards');
  check(((await api(alex.jar, 'GET', '/admin/connections/metabase/boards')).body.items as { id: string }[]).map((b) => b.id).join() === '100', 'admins see its dashboards (archived ones left out)');
  const imp = (await api(alex.jar, 'POST', '/admin/connections/metabase/import', { board: '100' })).body as { boards: { id: string; title: string }[]; sources: { created: string[]; reused: string[] }; skipped: { name: string }[] };
  check(imp.boards.map((b) => `${b.id}:${b.title}`).join() === 'metabase-100-1:每日运营 · 基础,metabase-100-2:每日运营 · 明细', 'one board per tab with charts (a tab of text only is left out)');
  check(imp.sources.created.length === 7 && imp.sources.reused.join() === 'mb-signups' && imp.skipped.map((x) => x.name).join() === 'gone', 'each question is a data source once (one already connected is reused); a broken one is reported, not fatal');
  const boardsAlex = (await api(alex.jar, 'GET', '/boards')).body.boards as { id: string; layout: { modules: Record<string, any>[] } }[];
  const tabA = boardsAlex.find((b) => b.id === 'metabase-100-1')!.layout.modules;
  check(tabA.map((m) => m.type === 'chart' ? `chart:${m.kind}` : m.type).join() === 'note,chart:line,chart:line,stats,chart:bar,chart:bar,chart:bar', 'cards keep their kind and order');
  check(tabA[3].title?.['zh-CN'] === '本周销售', 'a short line right above numbers becomes their heading');
  check(tabA[6].source.query.series === 'api_name' && tabA[6].source.query.date.bucket === 'day', 'a date chart with a text column is split by it (one series per API)');
  check(tabA[0].body['zh-CN'] === '口径\n上海时间，说明 (https://example.com/doc)', 'text cards become notes without Markdown');
  check(tabA[1].source.query.also?.[0]?.field === 'builder_usd' && tabA[1].source.query.date.bucket === 'day' && tabA[2].source.query.measure.op === 'avg' && tabA[2].source.query.measure.field === 'success_rate',
    'several value columns share one chart; rates get one of their own, averaged');
  check(tabA[3].items.length === 2 && tabA[3].width === 'full', 'numbers side by side become one row of tiles');
  check(tabA[4].source.query.groupBy === 'bucket' && tabA[4].source.query.sort === 'label', 'a bar over categories keeps their order');
  check(tabA[4].source.query.also?.[0]?.field === 'registrations' && tabA[4].source.query.also[0].op === 'sum', '"registrations" is a count, not a ratio');
  check(tabA[4].stacked === true && tabA[4].format?.currency === 'USD' && tabA[4].subtitle?.['zh-CN'] === '订单（未扣退款）' && !tabA[2].stacked,
    'stacked bars stay stacked, money stays money, and the axis notes come along (rates are never stacked)');
  const tabB = boardsAlex.find((b) => b.id === 'metabase-100-2')!.layout.modules;
  check(tabB.map((m) => m.type === 'chart' ? `chart:${m.kind}` : m.type).join() === 'table,chart:funnel', 'tables become table modules, funnels funnels');
  const lines = (await api(alex.jar, 'POST', '/data/module', { source: tabA[1].source.data, query: tabA[1].source.query, kind: 'line' })).body.value as { series: { name: string; values: number[] }[] };
  check(lines.series.map((x) => x.name).join() === 'PAYG 收入,builder_usd' && lines.series[0].values.at(-1) === 119 && lines.series[1].values.at(-1) === 10,
    'and the chart draws one line per value column, named as there (export names like "payg_usd ($)" mapped back)');
  const tableRows = (await api(alex.jar, 'POST', '/data/rows', { source: tabB[0].source.data, where: [], limit: tabB[0].limit })).body as { rows: { email: string }[] };
  check(tableRows.rows.length === 2, 'the table module reads the records');
  const bobBoard = ((await api(bob.jar, 'GET', '/boards')).body.boards as { id: string; layout: { modules: Record<string, any>[] } }[]).find((b) => b.id === 'metabase-100-1')!.layout.modules;
  check(bobBoard.map((m) => m.type).join() === 'note,chart' && bobBoard[1].source.data === 'mb-signups', 'new sources are for admins until opened up: others see the notes and what they may see');
  // what a source counts comes from the other system, and can be written in the hub instead (kept on sync)
  const srcDesc = async () => ((await tool(alex.token, 'list_data_sources', {})).sources as { id: string; description?: string }[]).find((x) => x.id === 'mb-signups')?.description;
  check(await srcDesc() === '每日有效注册，排除 bot 和内部账号；上海时间归日。', "a connected question brings its description: what it counts, for agents choosing between sources");
  check(!(await tool(alex.token, 'set_data_source_description', { id: 'mb-signups', description: { 'zh-CN': '有效注册（排除机器账号）', en: 'Valid sign-ups (no bots)' } })).error, 'an admin writes it in the hub');
  const resync = (await api(alex.jar, 'POST', '/admin/connections/metabase/import', { board: '100' })).body as { boards: { id: string }[]; sources: { created: string[]; reused: string[] } };
  check(['有效注册（排除机器账号）', 'Valid sign-ups (no bots)'].includes(String(await srcDesc())), "a description written in the hub survives a sync (in the reader's language)");
  check(String((await tool(bob.token, 'set_data_source_description', { id: 'mb-signups', description: { 'zh-CN': 'x' } })).error).length > 0, 'only whoever registered it, or an admin, describes a source');
  await tool(alex.token, 'set_data_source_description', { id: 'mb-signups', description: null });
  check(await srcDesc() === '每日有效注册，排除 bot 和内部账号；上海时间归日。' && ((await api(bob.jar, 'GET', '/data/sources/mb-signups')).body as { description: string }).description?.startsWith('每日有效注册'),
    "cleared, it goes back to the other system's; the detail page shows it");
  check(resync.boards.length === 2 && resync.sources.created.length === 0 && resync.sources.reused.length === 8, 'syncing again rebuilds the same boards and keeps the sources');
  check(((await api(alex.jar, 'GET', '/admin/connections')).body.connections as { imported: { id: string }[] }[])[0].imported.length === 2, 'the admin page lists the imported boards to sync');

  // the detail page behind a number: what the source is and its records, read as the viewer
  const dsMeta = (await api(bob.jar, 'GET', '/data/sources/mb-signups')).body as { fields: { name: string; kind: string }[]; where: { label: string; url: string }; records: number };
  check(dsMeta.fields.map((f) => `${f.name}:${f.kind}`).join() === 'reg_date:date,real_users:number' && dsMeta.where.label === 'metabase' && dsMeta.where.url.endsWith('/question/232') && dsMeta.records === 10,
    'a source describes itself for its detail page (fields sorted into dates and numbers, where it lives)');
  const dsRows = (await api(bob.jar, 'POST', '/data/rows', { source: 'mb-signups', where: [{ field: 'reg_date', op: 'isGreater', value: NOW - 3 * DAY }], sort: { field: 'reg_date', desc: true } })).body as { matched: number; rows: { reg_date: string }[] };
  check(dsRows.matched === 3 && dsRows.rows[0].reg_date > dsRows.rows[2].reg_date, 'and its records in a date range, newest first');
  check((await api(bob.jar, 'GET', '/data/sources/mb-revenue')).status === 400, 'not for sources the viewer may not see');

  // one company page for everyone: shared modules, each person's own changes on top, and only numbers they may see
  const tile = (id: string, field: string) => ({ label: { 'zh-CN': id, en: id }, source: { data: id, query: { measure: { op: 'sum', field } } } });
  await tool(alex.token, 'save_homepage', { scope: 'company', layout: { modules: [
    { type: 'stats', items: [tile('mb-signups', 'real_users'), tile('mb-revenue', 'payg_usd')] },
    { type: 'chart', kind: 'line', source: { data: 'mb-revenue', query: { measure: { op: 'sum', field: 'payg_usd' } } } },
    { type: 'apps' },
    { type: 'skills', width: 'half' },
  ] } });
  type HomeBody = { from: string; adjusted: boolean; hidden: { id: string }[]; layout: { modules: { id: string; type: string; width?: string; own?: boolean; items?: { label: Record<string, string> }[] }[] } };
  const homeOf = async (jar: Jar) => (await api(jar, 'GET', '/home')).body as unknown as HomeBody;
  let bobHome = await homeOf(bob.jar);
  check(bobHome.from === 'company' && bobHome.layout.modules.every((m) => m.id), 'someone without a page of their own gets the company page, every module with an id');
  check(bobHome.layout.modules[0].items?.length === 1 && bobHome.layout.modules[0].items[0].label.en === 'mb-signups' && !bobHome.layout.modules.some((m) => m.type === 'chart'),
    'numbers they may not see are left out (a tile, or a whole chart)');
  check((await homeOf(alex.jar)).layout.modules.some((m) => m.type === 'chart'), 'an admin sees them');
  const [statsId, , appsId, skillsId] = (await tool(alex.token, 'get_homepage', { scope: 'company' })).layout.modules.map((m: { id: string }) => m.id);
  await api(bob.jar, 'POST', '/home/adjust', { hide: appsId });
  await api(bob.jar, 'POST', '/home/adjust', { width: { id: statsId, width: 'half' } });
  await api(bob.jar, 'POST', '/home/adjust', { order: [skillsId, statsId, appsId] });
  bobHome = await homeOf(bob.jar);
  check(bobHome.adjusted && bobHome.hidden.map((m) => m.id).join() === appsId && bobHome.layout.modules.map((m) => m.id).join() === `${skillsId},${statsId}` && bobHome.layout.modules[1].width === 'half',
    'a person hides, resizes and moves shared modules on the page itself');
  await tool(alex.token, 'save_homepage', { scope: 'company', layout: { modules: [
    ...(await tool(alex.token, 'get_homepage', { scope: 'company' })).layout.modules,
    { type: 'note', body: { 'zh-CN': '新公告', en: 'News' } },
  ] } });
  bobHome = await homeOf(bob.jar);
  check(bobHome.layout.modules.some((m) => m.type === 'note') && !bobHome.layout.modules.some((m) => m.id === appsId) && bobHome.layout.modules[0].id === skillsId,
    'what the company adds later reaches them, and their changes stay');
  const mine = (await tool(bob.token, 'get_homepage', { scope: 'me' })).layout.modules as { id: string; own: boolean }[];
  await tool(bob.token, 'save_homepage', { scope: 'me', layout: { modules: [
    ...mine.filter((m) => m.id !== skillsId),
    { type: 'links', items: [{ label: { 'zh-CN': '文档', en: 'Docs' }, url: 'https://example.com/docs' }] },
  ] } });
  bobHome = await homeOf(bob.jar);
  check(bobHome.from === 'company' && bobHome.hidden.map((m) => m.id).sort().join() === [appsId, skillsId].sort().join() && bobHome.layout.modules.at(-1)?.own === true,
    "an agent saving their page keeps it built on the company page: left-out modules hidden, new ones their own");
  await api(bob.jar, 'POST', '/home/adjust', { show: appsId });
  check((await homeOf(bob.jar)).layout.modules.some((m) => m.id === appsId), 'a hidden module comes back');
  await api(bob.jar, 'DELETE', '/home/adjust');
  bobHome = await homeOf(bob.jar);
  check(!bobHome.adjusted && !bobHome.layout.modules.some((m) => m.own), 'and back to the company page as it is');
  check((await api(bob.jar, 'POST', '/home/adjust', { hide: 'nope' })).status === 400, 'unknown modules are refused');
  const revBoard = await tool(alex.token, 'save_board', { id: 'revenue', title: { 'zh-CN': '收入', en: 'Revenue' }, layout: { modules: [{ type: 'chart', kind: 'line', source: { data: 'mb-revenue', query: { measure: { op: 'sum', field: 'payg_usd' } } } }, { type: 'note', body: { 'zh-CN': '说明', en: 'About' } }] } });
  const bobBoards = (await api(bob.jar, 'GET', '/boards')).body.boards as { id: string; layout: { modules: { type: string }[] } }[];
  check(!!revBoard.id && bobBoards.find((b) => b.id === revBoard.id)?.layout.modules.map((m) => m.type).join() === 'note', 'boards leave out what the viewer may not see too');

  // app requests: the pool (posted to the group admins chose), invitations, me too, taking and delivering
  {
    check((await api(alice.jar, 'POST', '/admin/requests-chat', { chat: { id: 'oc_dev', name: '开发群' } })).status >= 400, 'only admins choose the requests group');
    const chats = (await api(alex.jar, 'GET', '/admin/lark-chats')).body.chats as { id: string }[];
    await api(alex.jar, 'POST', '/admin/requests-chat', { chat: { id: 'oc_dev', name: '开发群' } });
    check(chats.map((c) => c.id).join() === 'oc_dev,oc_finance' && ((await api(alex.jar, 'GET', '/admin')).body.requestsChat as { id: string }).id === 'oc_dev', 'admins pick the group from the ones the bot is in');
    const wait = async (n: number) => { for (let i = 0; i < 50 && lark.messages.length < n; i++) await new Promise((r) => setTimeout(r, 100)); };
    lark.messages = [];
    check((await api(alice.jar, 'POST', '/requests', { title: 'x', body: 'too short' })).status === 400, 'a request needs a title and enough detail');
    const pool = (await api(alice.jar, 'POST', '/requests', { title: 'KOL 周报', body: '每周一汇总 KOL 合作进度，数据在 KOL 名单表里，市场组用', due: '2026-12-01' })).body as { id: number; scope: string; status: string };
    await wait(1);
    check(pool.scope === 'pool' && pool.status === 'open' && lark.messages[0]?.id === 'oc_dev' && lark.messages[0].text.includes('KOL 周报') && lark.messages[0].text.includes(`/requests/${pool.id}`) && lark.messages[0].text.startsWith('[Requests]'),
      'a pool request is posted to the requests group, in the language of the admin who chose it');
    const bobList = (await api(bob.jar, 'GET', '/requests?status=open')).body as { requests: { id: number }[]; waiting: number };
    check(bobList.requests.some((r) => r.id === pool.id) && bobList.waiting >= 1 && ((await api(bob.jar, 'GET', '/apps')).body.requestsWaiting as number) >= 1, 'everyone sees pool requests, and the apps page counts the waiting ones');
    await api(bob.jar, 'POST', `/requests/${pool.id}`, { action: 'me_too', note: '我们组也要' });
    check((await api(alice.jar, 'POST', `/requests/${pool.id}`, { action: 'me_too' })).status === 400, 'the requester does not vote for their own request');
    const voted = (await api(alice.jar, 'GET', `/requests/${pool.id}`)).body as { voters: { name: string; note: string }[] };
    check(voted.voters.length === 1 && voted.voters[0].note === '我们组也要', 'colleagues who need it too add a line about their case');

    // an invitation is private to the people involved
    lark.messages = [];
    const inv = (await api(alice.jar, 'POST', '/requests', { title: '报销小助手', body: '帮我做个报销单填写工具，只有财务和我用', invite: 'ou_dev_alex' })).body as { id: number; scope: string };
    await wait(1);
    check(inv.scope === 'invite' && lark.messages[0]?.id === 'ou_dev_alex' && lark.messages[0].text.includes('报销小助手') && !lark.messages.some((m) => m.id === 'oc_dev'), 'an invitation messages the person invited, not the group');
    check((await api(bob.jar, 'GET', `/requests/${inv.id}`)).status === 400 && !((await api(bob.jar, 'GET', '/requests?status=all')).body.requests as { id: number }[]).some((r) => r.id === inv.id), 'others cannot see an invitation');
    check((await api(bob.jar, 'POST', `/requests/${inv.id}`, { action: 'take' })).status === 400, 'and cannot take it');
    lark.messages = [];
    const declined = (await api(alex.jar, 'POST', `/requests/${inv.id}`, { action: 'decline', reason: '这周没空' })).body as { request: { invitee: unknown; status: string; scope: string } };
    await wait(1);
    check(declined.request.invitee === null && declined.request.status === 'open' && declined.request.scope === 'invite' && lark.messages[0]?.id === 'ou_dev_alice' && lark.messages[0].text.includes('这周没空'), 'declining tells the requester why, and the request stays private');
    await api(alex.jar, 'POST', '/admin/requests-chat', { chat: { id: 'oc_dev', name: '开发群', locale: 'zh-CN' } });
    lark.messages = [];
    await api(alice.jar, 'POST', `/requests/${inv.id}`, { action: 'to_pool' });
    await wait(1);
    check(lark.messages[0]?.text.startsWith('【需求池】'), 'or in the language chosen for the group');
    check(lark.messages[0]?.id === 'oc_dev' && ((await api(bob.jar, 'GET', `/requests/${inv.id}`)).body as { scope: string }).scope === 'pool', 'moved to the pool, it is posted and everyone sees it');
    await api(alice.jar, 'POST', `/requests/${inv.id}`, { action: 'close', reason: '不需要了' });
    check(((await api(bob.jar, 'GET', `/requests/${inv.id}`)).body as { status: string; can: { take: boolean } }).can.take === false, 'a closed request cannot be taken');

    // an agent takes the pool request and delivers it by publishing with request_id
    const listed = await tool(alex.token, 'list_app_requests', {}) as { id: number; alsoNeeded: number }[];
    check(listed.find((r) => r.id === pool.id)?.alsoNeeded === 1, 'agents list waiting requests');
    const full = await tool(alex.token, 'get_app_request', { id: pool.id }) as { body: string; voters: { note: string }[]; can: { take: boolean } };
    check(full.body.includes('KOL 名单') && full.voters[0].note === '我们组也要' && full.can.take, 'and read one in full, with what colleagues added');
    lark.messages = [];
    const siteDir = mkdtempSync(path.join(tmpdir(), 'hub-req-'));
    fsx.writeFileSync(path.join(siteDir, 'index.html'), '<h1>KOL weekly</h1>');
    const pub = await tool(alex.token, 'publish_app', { upload_id: await putTar('app', siteDir), slug: 'kol-weekly', kind: 'static', name: 'KOL 周报', request_id: pool.id });
    rmSync(siteDir, { recursive: true, force: true });
    await wait(2);
    const done = (await api(alice.jar, 'GET', `/requests/${pool.id}`)).body as { status: string; builder: { id: string }; app: { slug: string } };
    const collabs = (await tool(alex.token, 'set_collaborators', { kind: 'app', slug: 'kol-weekly' })).collaborators as { id: string }[];
    check(pub.status === 'online' && pub.notes.join(' ').includes(`#${pool.id}`) && done.status === 'done' && done.builder.id === 'ou_dev_alex' && done.app.slug === 'kol-weekly',
      'publish_app with request_id takes the request and marks it live');
    check(collabs.some((c) => c.id === 'ou_dev_alice'), 'the requester becomes a collaborator on the app');
    check(lark.messages.some((m) => m.id === 'ou_dev_alice' && m.text.includes('KOL 周报')) && lark.messages.some((m) => m.id === 'ou_dev_bob' && m.text.includes('kol-weekly')), 'the requester and everyone who needed it are told');
    const created = await tool(bob.token, 'create_app_request', { title: '招聘看板', body: '把招聘进度从 Lark 表里汇总成看板，HR 每周看', invite: 'alice@example.com' }) as { id: number; via: string; invitee: { id: string } };
    check(created.via === 'agent' && created.invitee.id === 'ou_dev_alice', 'agents submit requests for the user, inviting a colleague by name or email');
    await tool(alex.token, 'delete_app', { slug: 'kol-weekly', confirm_slug: 'kol-weekly' });

    // the home page module and the search
    const secret = (await api(alice.jar, 'POST', '/requests', { title: '保密的薪酬工具', body: '只想请 Alex 帮忙做的薪酬测算工具，先别公开' , invite: 'ou_dev_alex' })).body as { id: number };
    const poolOpen = (await api(bob.jar, 'POST', '/requests', { title: '会议室预约', body: '大家都在群里抢会议室，想要一个预约页面，按时间段占用' })).body as { id: number };
    const waitingFor = async (jar: Jar) => ((await api(jar, 'GET', '/requests?status=open&waiting=1')).body.requests as { id: number }[]).map((r) => r.id);
    const aliceWaits = await waitingFor(alice.jar);
    const alexWaits = await waitingFor(alex.jar);
    check(aliceWaits.includes(poolOpen.id) && !aliceWaits.includes(secret.id) && aliceWaits.includes(created.id) && alexWaits.includes(secret.id),
      'the requests module lists the pool and invitations to the viewer, not invitations they sent');
    check((await tool(bob.token, 'preview_homepage', { scope: 'me', layout: { modules: [{ type: 'requests', width: 'half', limit: 3 }] } })).error === undefined, 'a home page takes a requests module');
    const found = async (jar: Jar, q: string) => ((await api(jar, 'GET', `/search?q=${encodeURIComponent(q)}`)).body.requests as { id: number }[]).map((r) => r.id);
    check((await found(bob.jar, '会议室')).includes(poolOpen.id) && (await found(alice.jar, 'KOL')).includes(pool.id), 'search finds requests');
    check(!(await found(bob.jar, '薪酬')).includes(secret.id) && (await found(alex.jar, '薪酬')).includes(secret.id), 'but not invitations the searcher may not see');
  }

  // 项目: each person connects their own Linear (read only), and sees projects as Linear shows them to them
  {
    const st0 = (await api(bob.jar, 'GET', '/projects')).body as { status: { available: boolean; connected: boolean; connectUrl: string }; projects: unknown[] };
    check(st0.status.available && !st0.status.connected && st0.projects.length === 0 && st0.status.connectUrl.includes('/auth/linear/connect'), 'before connecting, the projects page offers to connect Linear');
    const start = await fetch(`${HUB}/auth/linear/connect?return=/projects`, { redirect: 'manual', headers: { cookie: bob.jar.header() } });
    bob.jar.store(start);
    const authz = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    check(linear.scope === 'read,write', 'it asks Linear for read and write access (the 项目 page edits as the person)');
    const back = await fetch(authz.headers.get('location')!, { redirect: 'manual', headers: { cookie: bob.jar.header() } });
    check(back.status === 302 && back.headers.get('location') === '/projects', 'and comes back to the projects page');
    // one click on the Me page walks through both Linear authorisations: back from the first, on to the next
    const chain = `/auth/services/linear/connect?return=${encodeURIComponent('/me')}`;
    const s1 = await fetch(`${HUB}/auth/linear/connect?return=${encodeURIComponent(chain)}`, { redirect: 'manual', headers: { cookie: bob.jar.header() } });
    bob.jar.store(s1);
    const b1 = await fetch((await fetch(s1.headers.get('location')!, { redirect: 'manual' })).headers.get('location')!, { redirect: 'manual', headers: { cookie: bob.jar.header() } });
    check(b1.headers.get('location') === chain, 'connecting Linear can hand on to the next authorisation');
    const status = (await api(bob.jar, 'GET', '/linear/status')).body as { connected: boolean; name: string; workspace: string };
    check(status.connected && status.name === 'Alex L' && status.workspace === 'Acme', 'the Me page knows which Linear account and workspace');
    const list = (await api(bob.jar, 'GET', '/projects')).body as { projects: { id: string; name: string; status: { type: string }; health: string | null; lastUpdate: { body: string } | null; teams: string[] }[] };
    check((list.projects as unknown as { id: string; mine: boolean }[]).filter((x) => x.mine).map((x) => x.id).join() === 'p1,p2', "each project says whether it is the person's: issues assigned to them (p1) or they are a member (p2)");
    check(list.projects.map((x) => x.id).join() === 'p1,p2,p3,p4' && list.projects[0].health === 'atRisk' && list.projects[0].lastUpdate?.body === '接口延期一周' && list.projects[0].teams[0] === 'Engineering',
      'projects come across pages of results, started first, with health, the latest update and teams');
    const detail = (await api(bob.jar, 'GET', '/projects/p1')).body as { milestones: { name: string; issues: number; done: number }[]; issueCounts: { total: number; done: number }; issues: { identifier: string }[]; updates: { body: string }[] };
    check(detail.milestones.map((m) => `${m.name}:${m.done}/${m.issues}`).join() === 'Alpha:1/2,Beta:0/1' && detail.issueCounts.total === 4 && detail.issueCounts.done === 1 && detail.updates[0].body.includes('其余正常'),
      'a project in detail: milestones by date with their issues done (canceled ones left out), counts and updates');
    check((await api(bob.jar, 'GET', '/projects/nope')).status === 400, 'a project the person cannot see is refused');
    check(((await api(alice.jar, 'GET', '/projects')).body as { status: { connected: boolean } }).status.connected === false, "another colleague's page still asks them to connect their own");
    // editing from the 项目 page, as the person
    const ed = (await api(bob.jar, 'GET', '/projects/p1')).body as { canWrite: boolean; teams: string[]; teamOptions: { states: { id: string }[]; members: { name: string }[] }[] };
    check(ed.canWrite && ed.teams[0] === 'Engineering' && ed.teamOptions[0].states.map((x) => x.id).join() === 's-back,s-todo,s-doing,s-done' && ed.teamOptions[0].members.map((m) => m.name).join() === 'Alex L,Bo',
      "a project offers its teams' workflow states (in Linear's order) and members to edit with");
    linear.changes = [];
    check((await api(bob.jar, 'PATCH', '/linear/issues/i2', { stateId: 's-done', priority: 1 })).status === 200 && JSON.stringify(linear.changes[0]) === JSON.stringify({ op: 'issueUpdate', variables: { id: 'i2', input: { stateId: 's-done', priority: 1 } } }),
      "an issue's state and priority are changed in Linear");
    await api(bob.jar, 'PATCH', '/linear/issues/i2', { assigneeId: null, dueDate: null });
    check(JSON.stringify(linear.changes[1]?.variables) === JSON.stringify({ id: 'i2', input: { assigneeId: null, dueDate: null } }), 'its assignee and due date can be cleared');
    check((await api(bob.jar, 'PATCH', '/linear/issues/i2', { priority: 7 })).status === 400 && (await api(bob.jar, 'PATCH', '/linear/issues/i2', { dueDate: 'soon' })).status === 400 && linear.changes.length === 2, 'values Linear would not take are refused before asking it');
    const iss = (await api(bob.jar, 'GET', '/linear/issues/i2')).body as { description: string; comments: { body: string }[]; assigneeId: string; team: string; teamOptions: { states: { id: string }[] }[]; project: { name: string } };
    check(iss.description.includes('第二行') && iss.comments.map((c) => c.body).join() === '第一条,第二条' && iss.assigneeId === 'lin-u1' && iss.team === 't1', 'an issue opens with its description and comments, oldest first');
    check(iss.teamOptions[0]?.states[0]?.id === 's-back' && iss.project.name === '中台 v2', "with its own team's states and members and its project, so it can be edited from anywhere");
    const mine = (await api(bob.jar, 'GET', '/projects/my-issues')).body as { canWrite: boolean; issues: { identifier: string; doneStateId: string; project: { name: string } }[] };
    check(mine.canWrite && mine.issues.map((i) => i.identifier).join() === 'ENG-2,ENG-3' && mine.issues[0].doneStateId === 's-done' && mine.issues[0].project.name === '中台 v2',
      "the person's open issues come nearest due first, each with its team's done state to tick it off");
    const before2 = linear.changes.length;
    await api(bob.jar, 'PATCH', `/linear/issues/i2`, { stateId: mine.issues[0].doneStateId });
    check(JSON.stringify(linear.changes[before2]?.variables) === JSON.stringify({ id: 'i2', input: { stateId: 's-done' } }), 'ticking one moves it to done');
    linear.changes.splice(before2, 1);
    const withPeople = (await api(bob.jar, 'GET', '/projects')).body as { projects: { id: string; members: { name: string }[]; milestoneDates: { name: string }[] }[] };
    const p2m = withPeople.projects.find((x) => x.id === 'p2');
    check(p2m?.members.map((m) => m.name).join() === 'alex,Bo' && p2m.milestoneDates.map((m) => m.name).join() === '内测', 'projects come with their members and dated milestones');
    await api(bob.jar, 'POST', '/linear/issues/i2/comments', { body: '  看过了  ' });
    check(JSON.stringify(linear.changes[2]) === JSON.stringify({ op: 'commentCreate', variables: { input: { issueId: 'i2', body: '看过了' } } }), 'a comment is posted as the person');
    const made = (await api(bob.jar, 'POST', '/projects/p1/issues', { teamId: 't1', title: ' 补文档 ', priority: 2, milestoneId: 'm1', assigneeId: 'lin-u2' })).body as { identifier: string };
    check(made.identifier === 'ENG-9' && JSON.stringify(linear.changes[3]?.variables) === JSON.stringify({ input: { teamId: 't1', projectId: 'p1', title: '补文档', assigneeId: 'lin-u2', priority: 2, projectMilestoneId: 'm1' } }), 'a new issue goes into the project and milestone');
    check((await api(bob.jar, 'POST', '/projects/p1/updates', { health: 'sideways', body: 'x' })).status === 400, 'a project update needs a health Linear knows');
    await api(bob.jar, 'POST', '/projects/p1/updates', { health: 'atRisk', body: '接口还差一周' });
    check(JSON.stringify(linear.changes[4]) === JSON.stringify({ op: 'projectUpdateCreate', variables: { input: { projectId: 'p1', body: '接口还差一周', health: 'atRisk' } } }), 'and a project update is posted with its health');
    // a connection made when the page was read only: reading still works, changing asks to agree once more
    const { DatabaseSync: DS } = await import('node:sqlite');
    const db0 = new DS(path.join(dataDir, 'hub.db'));
    db0.prepare("UPDATE linear_connections SET scope = 'read' WHERE user_id = 'ou_dev_bob'").run();
    const ro = (await api(bob.jar, 'GET', '/projects/p1')).body as { canWrite: boolean };
    const roChange = await api(bob.jar, 'PATCH', '/linear/issues/i2', { priority: 3 });
    check(!ro.canWrite && roChange.status === 400 && String(roChange.body.error).includes('/auth/linear/connect') && linear.changes.length === 5, 'a read-only connection reads, and is asked to agree again before changing anything');
    db0.close();
    // agreeing again: the page can edit at once, nothing read with the old connection lingers
    const again = await fetch(`${HUB}/auth/linear/connect?return=/projects/p1`, { redirect: 'manual', headers: { cookie: bob.jar.header() } });
    bob.jar.store(again);
    await fetch((await fetch(again.headers.get('location')!, { redirect: 'manual' })).headers.get('location')!, { redirect: 'manual', headers: { cookie: bob.jar.header() } });
    check(((await api(bob.jar, 'GET', '/projects/p1')).body as { canWrite: boolean }).canWrite, 'after agreeing again the project page can edit at once');

    // an access token about to run out is refreshed first
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'hub.db'));
    db.prepare("UPDATE linear_connections SET expires_at = ? WHERE user_id = 'ou_dev_bob'").run(Date.now() + 60_000);
    const before = linear.refreshes;
    // disconnecting forgets what was read; connect again, then let the token run low and read
    await api(bob.jar, 'POST', '/linear/disconnect');
    const s2 = await fetch(`${HUB}/auth/linear/connect?return=/projects`, { redirect: 'manual', headers: { cookie: bob.jar.header() } });
    bob.jar.store(s2);
    await fetch((await fetch(s2.headers.get('location')!, { redirect: 'manual' })).headers.get('location')!, { redirect: 'manual', headers: { cookie: bob.jar.header() } });
    db.prepare("UPDATE linear_connections SET expires_at = ? WHERE user_id = 'ou_dev_bob'").run(Date.now() + 60_000);
    const fresh = await api(bob.jar, 'GET', '/projects/p1');
    check(fresh.status === 200 && linear.refreshes === before + 1, 'an access token about to run out is refreshed first');
    linear.revoked = true;
    db.prepare("UPDATE linear_connections SET expires_at = ? WHERE user_id = 'ou_dev_bob'").run(Date.now() + 3600_000);
    // (p2: not read yet, so nothing kept from before answers it)
    const refused = await api(bob.jar, 'GET', '/projects/p2');
    const after = (await api(bob.jar, 'GET', '/linear/status')).body as { connected: boolean };
    check(refused.status === 400 && String(refused.body.error).includes('/auth/linear/connect') && !after.connected, 'when Linear no longer accepts it, the connection is dropped and the person is asked to connect again');
    linear.revoked = false;
    db.close();
  }

  // other services' MCP servers through the hub, each person with their own account; the hub's own /mcp stands in
  // for the service, so the whole OAuth dance (discovery, registration, PKCE, consent, tokens) runs for real
  {
    check((await api(bob.jar, 'POST', '/admin/services', { id: 'selfhub', name: 'Hub', url: `${HUB}/mcp` })).status >= 400, 'only admins add services');
    check(String((await api(alex.jar, 'POST', '/admin/services', { id: 'selfhub', name: 'Hub', url: `${HUB}/auth/services/callback` })).body.error).includes('/mcp'), "the hub's own addresses (e.g. the callback) are refused as an MCP endpoint");
    const added = (await api(alex.jar, 'POST', '/admin/services', { id: 'selfhub', name: 'Hub', url: `${HUB}/mcp`, create: true })).body as { id: string; connected: boolean };
    check((await api(alex.jar, 'POST', '/admin/services', { id: 'selfhub', name: 'Other', url: 'https://example.com/mcp', create: true })).status === 400, 'adding a service with an id already used does not replace it');
    check(added.id === 'selfhub' && !added.connected, 'an admin adds a service by its MCP address (the whole company may use it by default)');
    const offered = await tool(bob.token, 'list_connected_tools', {}) as { service: string; connected: boolean; connectUrl?: string }[];
    check(offered.some((x) => x.service === 'selfhub' && !x.connected && x.connectUrl?.includes('/auth/services/selfhub/connect')), "agents see the service and the link to connect the user's account");
    check(String((await tool(bob.token, 'call_connected_tool', { service: 'selfhub', tool: 'whoami' })).error).includes('/auth/services/selfhub/connect'), 'calling before connecting gives the link');
    // bob connects: the hub sends him to the service's consent page and takes the tokens on the way back
    const go = await fetch(`${HUB}/auth/services/selfhub/connect?return=/me`, { redirect: 'manual', headers: { cookie: bob.jar.header() } });
    bob.jar.store(go);
    const consentAt = go.headers.get('location') ?? '';
    const consentHtml = await (await fetch(consentAt, { headers: { cookie: bob.jar.header() } })).text();
    check(consentAt.includes('/oauth/authorize') && consentAt.includes('code_challenge='), 'connecting registers the hub with the service and asks for consent with PKCE');
    // allowed in a browser on Windows: that is the device the hub remembers for this agent
    const allow = await fetch(consentAt, { method: 'POST', redirect: 'manual', headers: { cookie: bob.jar.header(), 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0' }, body: new URLSearchParams({ decision: 'allow', csrf: /name="csrf" value="([^"]+)"/.exec(consentHtml)![1] }) });
    const back = await fetch(allow.headers.get('location')!, { redirect: 'manual', headers: { cookie: bob.jar.header() } });
    check(back.status === 302 && back.headers.get('location') === '/me', 'and comes back connected');
    check(((await api(bob.jar, 'GET', '/profile')).body.agents as { device: string | null }[]).some((a) => a.device === 'Windows · Edge'), 'an agent allowed in a browser shows the device it was allowed from');
    check(((await api(bob.jar, 'GET', '/services')).body.services as { id: string; connected: boolean }[]).find((x) => x.id === 'selfhub')?.connected === true, 'the Me page shows the service connected');
    const listed = await tool(bob.token, 'list_connected_tools', { service: 'selfhub' }) as { tools: { name: string; input: unknown }[] };
    check(listed.tools.some((x) => x.name === 'whoami') && listed.tools.length > 20, "the service's own tools are listed with their input schemas");
    const who = await tool(bob.token, 'call_connected_tool', { service: 'selfhub', tool: 'whoami' }) as { ok: boolean; content: { text: string }[] };
    check(who.ok && who.content[0].text.includes('ou_dev_bob'), 'a tool is called as the user, with their own account there');
    await api(alex.jar, 'POST', '/admin/services', { id: 'selfhub', name: 'Hub', url: `${HUB}/mcp`, disabledTools: ['whoami'] });
    check(String((await tool(bob.token, 'call_connected_tool', { service: 'selfhub', tool: 'whoami' })).error).includes('whoami')
      && !(await tool(bob.token, 'list_connected_tools', { service: 'selfhub' }) as { tools: { name: string }[] }).tools.some((x) => x.name === 'whoami'), 'tools an admin switched off are neither listed nor called');
    await api(alex.jar, 'POST', '/admin/services', { id: 'selfhub', name: 'Hub', url: `${HUB}/mcp`, audience: { people: ['ou_dev_alex'] }, disabledTools: [] });
    check(!(await tool(bob.token, 'list_connected_tools', {}) as { service: string }[]).some((x) => x.service === 'selfhub')
      && String((await tool(bob.token, 'call_connected_tool', { service: 'selfhub', tool: 'whoami' })).error).length > 0, 'people outside its audience neither see nor use it');
    await api(alex.jar, 'POST', '/admin/services', { id: 'selfhub', name: 'Hub', url: `${HUB}/mcp`, audience: { company: true } });
    await api(bob.jar, 'POST', '/services/selfhub/disconnect');
    check(!((await api(bob.jar, 'GET', '/services')).body.services as { id: string; connected: boolean }[]).find((x) => x.id === 'selfhub')?.connected, 'and anyone can disconnect their account');
    await api(alex.jar, 'DELETE', '/admin/services/selfhub');

    // a service reached with a data connection's key: Metabase's own MCP server, one company identity for everyone
    const svcAdmin = (await api(alex.jar, 'GET', '/admin/services')).body as { connections: { id: string; type: string }[] };
    check(svcAdmin.connections.some((x) => x.id === 'metabase'), 'admins can pick a data connection whose system has its own MCP server');
    const mbSvc = (await api(alex.jar, 'POST', '/admin/services', { id: 'metabase', name: 'Metabase', connection: 'metabase', create: true })).body as { url: string; shared: boolean; connected: boolean };
    check(mbSvc.shared && mbSvc.connected && mbSvc.url.endsWith('/mb/api/metabase-mcp'), "adding it takes the address from the connection, and nobody has to connect an account");
    const bobSees = (await tool(bob.token, 'list_connected_tools', {}) as { service: string; shared?: boolean; connected: boolean; connectUrl?: string }[]).find((x) => x.service === 'metabase');
    check(!!bobSees?.shared && bobSees.connected && !bobSees.connectUrl, 'agents see it as shared and ready, with no link to connect');
    const mbTools = await tool(bob.token, 'list_connected_tools', { service: 'metabase' }) as { tools: { name: string; readOnly: boolean }[] };
    check(mbTools.tools.map((x) => x.name).join() === 'search,execute_sql,question_write' && mbTools.tools[0].readOnly, "Metabase's own tools are listed");
    const sql = await tool(bob.token, 'call_connected_tool', { service: 'metabase', tool: 'execute_sql', arguments: { database_id: 2, sql: 'select 1' } }) as { ok: boolean };
    check(sql.ok && lark.mbMcp.at(-1)?.tool === 'execute_sql' && lark.mbMcp.at(-1)?.key === 'mb_good', "a call goes out with the data connection's key, whoever asks");
    check(((await api(bob.jar, 'GET', '/services')).body.services as { id: string; shared?: boolean }[]).find((x) => x.id === 'metabase')?.shared === true, 'the Me page knows it needs no connecting');
    await api(alex.jar, 'POST', '/admin/services', { id: 'metabase', name: 'Metabase', disabledTools: ['question_write'] });
    check(String((await tool(bob.token, 'call_connected_tool', { service: 'metabase', tool: 'question_write' })).error).includes('question_write') && lark.mbMcp.at(-1)?.tool === 'execute_sql',
      'admins switch off the tools that change things, and they are not called');
    check(((await api(alex.jar, 'GET', '/admin/services/metabase/tools')).body.tools as { name: string; enabled: boolean }[]).find((x) => x.name === 'question_write')?.enabled === false, 'and see every tool with whether it is on');
    await api(alex.jar, 'DELETE', '/admin/services/metabase');
  }

  // ---------------------------------------------------------------- the person's own Lark calendar (read-only)
  {
    const first = await tool(alex.token, 'list_calendar_events');
    check(String(first.error).includes('calendar=1'), 'reading the calendar first asks the person to allow it');
    const noScope = await api(alex.jar, 'GET', '/calendar?return=%2F');
    check(noScope.status >= 400 && noScope.body.code === 'err.calendar.scope' && String((noScope.body.params as { url: string }).url).includes('return=%2F'), 'the home page gets the same, with a link back to it');
    await connect(alex.jar, '&calendar=1');
    check(lark.scopesAsked.split(' ').includes('calendar:calendar:readonly'), 'allowing it asks Lark for calendar reading only');
    const today = new Date().toISOString().slice(0, 10);
    const day = await tool(alex.token, 'list_calendar_events') as { from: string; events: { title: string; allDay: boolean; start: string; end: string; meetingUrl?: string; rooms?: string[]; organizer?: string; location?: string; showsAsFree?: boolean; description?: string }[] };
    const q = lark.calendarQueries.at(-1)!;
    check(day.from === today && q.end - q.start === 86_400 && new Date(q.start * 1000).toISOString().slice(0, 10) === today, 'by default today, from midnight to midnight in the company time zone');
    check(day.events.map((e) => e.title).join() === '团建,周会,' && !day.events.some((e) => e.title === '取消了'), 'all-day first, then by time; cancelled events left out');
    const week = day.events[1];
    check(day.events[0].allDay && day.events[0].start === today && day.events[0].end === today, 'an all-day event is its dates');
    check(week.start === `${today} 09:00` && week.end === `${today} 10:00` && week.meetingUrl === 'https://vc.larksuite.com/j/123' && week.rooms?.[0] === '会议室 A' && week.organizer === 'Bo' && week.description === '议程：本周进展',
      'a meeting comes with its local times, meeting link, room, organizer and description');
    check(day.events[2].location === '前台' && day.events[2].showsAsFree === true, 'and the place, and whether it shows as free');
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await tool(alex.token, 'list_calendar_events', { from: today, to: later });
    check(lark.calendarQueries.at(-1)!.end - lark.calendarQueries.at(-1)!.start === 6 * 86_400, 'a range of days is read in one go');
    const tooLong = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    check(String((await tool(alex.token, 'list_calendar_events', { from: today, to: tooLong })).error).includes('31'), 'at most 31 days');
    const month = await api(alex.jar, 'GET', '/calendar?month=current');
    const lastDay = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
    check(month.status === 200 && month.body.from === `${today.slice(0, 7)}-01` && month.body.to === lastDay && month.body.today === today
      && lark.calendarQueries.at(-1)!.end - lark.calendarQueries.at(-1)!.start === Number(lastDay.slice(8)) * 86_400 && String(month.body.openUrl).includes('/calendar/open'),
      'the month calendar reads the whole month, and links to Lark calendar');
    check((await api(alex.jar, 'GET', '/calendar?month=2026-13')).status === 400, 'a month that does not exist is refused');
    const home = await api(alex.jar, 'GET', '/calendar?days=3');
    check(home.status === 200 && (home.body.events as unknown[]).length === 3 && home.body.from === today && lark.calendarQueries.at(-1)!.end - lark.calendarQueries.at(-1)!.start === 3 * 86_400, 'the agenda module reads the next days the same way');
    await connect(alex.jar);
    check(lark.scopesAsked.split(' ').includes('calendar:calendar:readonly'), 'reconnecting Lark keeps calendar reading');
    check(!(await tool(alex.token, 'save_homepage', { scope: 'me', layout: { modules: [{ type: 'agenda', width: 'half' }, { type: 'apps' }] } })).error, 'an agenda module can be put on a home page');
    check(!!(await tool(bob.token, 'list_calendar_events')).error && lark.calendarQueries.length === 4, 'someone else is asked for their own permission, never shown Alex\'s calendar');
  }

  // ---------------------------------------------------------------- Lark messages sent as the person, once they turn it on
  {
    const before = lark.messages.length;
    const off = await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], text: '会议改到三点' });
    check(String(off.error).includes('/me') && lark.messages.length === before && (await api(alex.jar, 'GET', '/lark/messages')).body.on === false, 'sending as the person is off until they turn it on on their Me page');
    const on = await api(alex.jar, 'POST', '/lark/messages', { on: true });
    check(on.body.on === true && on.body.granted === false && String(on.body.connectUrl).includes('messages=1'), 'turning it on sends them to allow it in Lark');
    check(String((await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], text: 'x' })).error).includes('messages=1'), 'until then the agent gets the same link');
    await connect(alex.jar, '&messages=1');
    check(['im:message', 'im:message.send_as_user'].every((s) => lark.scopesAsked.split(' ').includes(s)), 'allowing it asks Lark to send as them');
    const preview = await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], text: '会议改到三点' });
    check(preview.preview?.to?.[0] === '周明' && preview.preview.text === "会议改到三点\n\n—— Sent by Alex's AI twin" && !!preview.send_code && lark.messages.length === before, 'the first call only shows who gets what, signed as sent by their AI twin');
    check(lark.cards.length === 0 && !String(preview.next).includes('card'), 'without cards set up in Lark, no card is sent');
    const again = await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], text: '会议改到三点' });
    check(again.send_code === preview.send_code && lark.messages.length === before, 'preparing the same message again keeps its send_code and still sends nothing');
    const waiting = JSON.stringify(fsDb.prepare('SELECT * FROM lark_pending').all());
    check(waiting.includes(preview.send_code) && !waiting.includes('三点'), 'a preview waits in the database (so a restart keeps it), encrypted');
    check(String((await tool(alex.token, 'send_lark_message', { send_code: '确认' })).error).includes('send_code') && lark.messages.length === before, 'a send_code that is not one says how to send');
    const bobLocale = (fsDb.prepare("SELECT locale FROM users WHERE id = 'ou_dev_bob'").get() as { locale: string | null }).locale;
    fsDb.prepare("UPDATE users SET locale = 'zh-CN' WHERE id = 'ou_dev_bob'").run();
    const sent = await tool(alex.token, 'send_lark_message', { send_code: preview.send_code });
    const m = lark.messages.at(-1)!;
    check(sent.sent?.[0] === '周明' && m.id === 'ou_dev_bob' && m.text.startsWith('会议改到三点\n') && m.as === 'user', 'the code sends exactly that, as the person');
    check(m.text === '会议改到三点\n\n—— 由 Alex 的 AI 分身发送', 'the signature is in the recipient\'s language, after a blank line');
    check((fsDb.prepare('SELECT state, payload FROM lark_pending WHERE code = ?').get(preview.send_code) as { state: string; payload: string }).payload === '', 'and is emptied once sent');
    fsDb.prepare('UPDATE users SET locale = ? WHERE id = ?').run(bobLocale, 'ou_dev_bob');
    check(String((await tool(alex.token, 'send_lark_message', { send_code: preview.send_code })).error).includes('already sent') && lark.messages.length === before + 1, 'a code sends once');
    check((await api(alex.jar, 'GET', '/lark/messages')).body.sentThisWeek === 1 && !JSON.stringify(fsDb.prepare('SELECT * FROM lark_sent').all()).includes('三点'), 'the hub counts who was messaged, never the text');
    const md = await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], text: '**三点**改到：\n1. 会议室 A\n2. [日程](https://example.com)', format: 'markdown' });
    check(md.preview?.format === 'markdown' && md.send_code !== (await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], text: '**三点**改到：\n1. 会议室 A\n2. [日程](https://example.com)' })).send_code, 'the same text as Markdown is a different message from plain text');
    await tool(alex.token, 'send_lark_message', { send_code: md.send_code });
    const post = lark.messages.at(-1)!;
    const postBody = JSON.parse(post.text) as Record<string, { content: { tag: string; text: string }[][] }>;
    const mdText = Object.values(postBody)[0]?.content[0][0];
    check(post.msgType === 'post' && mdText?.tag === 'md' && mdText.text.startsWith('**三点**改到：\n1. 会议室 A') && mdText.text.includes('\n\n—— ') && post.as === 'user',
      'format markdown goes out as Lark rich text (md), signed after a blank line, as the person');

    // an agent whose app can ask (MCP elicitation): the person says yes there, and it goes out in the same call
    const asker = (await api(alex.jar, 'POST', '/tokens', { name: 'Claude Code' })).body.token as string;
    const mcpPost = (token: string, msg: object) => fetch(`${HUB}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(msg),
    });
    await (await mcpPost(asker, { jsonrpc: '2.0', id: ++rpc, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'smoke', version: '1' } } })).text();
    type Asked = { question?: { params: { message: string } }; stream: boolean; out: Record<string, unknown> & { sent?: string[]; send_code?: string; next?: string; declined?: boolean }; intruderStatus?: number };
    const askedCall = async (args: Record<string, unknown>, answer: 'accept' | 'decline' | 'cancel', intruder?: string): Promise<Asked> => {
      const res = await mcpPost(asker, { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name: 'send_lark_message', arguments: args } });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      const r: Partial<Asked> = { stream: (res.headers.get('content-type') ?? '').includes('text/event-stream') };
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('the call ended without a result');
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          buf = buf.slice(i + 2);
          if (!data) continue;
          const msg = JSON.parse(data);
          if (msg.method === 'elicitation/create') {
            r.question = msg;
            if (intruder) r.intruderStatus = (await mcpPost(intruder, { jsonrpc: '2.0', id: msg.id, result: { action: 'accept' } })).status;
            await mcpPost(asker, { jsonrpc: '2.0', id: msg.id, result: { action: answer } });
          } else if (msg.result) {
            void reader.cancel();
            const text = msg.result.content[0].text;
            return { ...r, out: msg.result.isError ? { error: text } : JSON.parse(text) } as Asked;
          }
        }
      }
    };
    const n0 = lark.messages.length;
    const yes = await askedCall({ to: ['ou_dev_bob'], text: '晚上见' }, 'accept');
    check(yes.stream && yes.question?.params.message.startsWith('Send as you to 周明:') === true && yes.question.params.message.includes("晚上见\n\n—— Sent by Alex's AI twin"),
      'the agent\'s app asks Alex, showing who gets what, signed');
    check(yes.out.sent?.[0] === '周明' && !yes.out.send_code && lark.messages.length === n0 + 1 && lark.messages.at(-1)!.text.startsWith('晚上见\n'), 'and once Alex accepts, it is sent in the same call');
    const no = await askedCall({ to: ['ou_dev_bob'], text: '不发这条' }, 'decline', bob.token);
    check(no.out.declined === true && lark.messages.length === n0 + 1, 'declining sends nothing, and someone else cannot answer for Alex');
    const closed = await askedCall({ to: ['ou_dev_bob'], text: '等会儿再说' }, 'cancel');
    check(!!closed.out.send_code && String(closed.out.next).includes('closed') && lark.messages.length === n0 + 1, 'closing the question leaves the preview, so Alex can still agree in the chat');
    check((await tool(asker, 'send_lark_message', { send_code: closed.out.send_code! })).sent?.[0] === '周明' && lark.messages.length === n0 + 2, 'and then the code sends it');
    check(!!(await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], text: 'x' })).send_code, 'an agent whose app cannot ask still gets the preview and a code');

    // where the hub is set up for it, the person answers on a card in Lark instead (a tap comes through the long
    // connection; here the hub's code is called directly, with cards on)
    const { execFile } = await import('node:child_process');
    const inHub = (js: string) => new Promise<Record<string, any>>((ok, fail) => execFile(process.execPath, ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(path.resolve('server/lark/messages.ts'))});
      const { get } = await import(${JSON.stringify(path.resolve('server/db.ts'))});
      const user = get("SELECT * FROM users WHERE id = 'ou_dev_alex'");
      console.log(JSON.stringify(await (${js})));
    `], { env: { ...process.env, DATA_DIR: dataDir, HUB_SECRET: 'smoke', DEV_LOGIN: '1', DEFAULT_LOCALE: 'en', HUB_URL: HUB, LARK_APP_ID: 'cli_smoke', LARK_APP_SECRET: 'secret', LARK_API_BASE: `http://localhost:${LARK_PORT}/open-apis`, LARK_ACCOUNTS_BASE: `http://localhost:${LARK_PORT}/open-apis`, LARK_CONFIRM_CARDS: 'on' } },
      (e, out, err) => (e ? fail(new Error(String(err).split('\n').filter((l) => !/Warning|--trace/.test(l)).slice(0, 6).join(' | '))) : ok(JSON.parse(out.trim().split('\n').at(-1)!)))));
    const withCard = (text: string, answer = 'null', markdown = false) => inHub(`m.sendOrPrepare(user, ${JSON.stringify({ to: ['ou_dev_bob'], text, file: null, markdown })}, 'en', async () => ${answer})`);
    const tap = (operator: string, code: string, choice: 'send' | 'decline') => inHub(`m.onCardTap(${JSON.stringify({ operator: { open_id: operator }, action: { value: { hub: 'send_message', code, choice } } })})`);
    const byCard = await withCard('五点见');
    const sentBefore = lark.messages.length;
    const card = lark.cards.at(-1)!;
    check(lark.cards.length === 1 && card.to === 'ou_dev_alex' && card.card.includes('五点见') && card.card.includes(byCard.send_code) && card.card.includes('"Send"') && String(byCard.next).includes('card') && sentBefore === n0 + 2,
      'with cards set up, the hub\'s bot shows Alex the preview in Lark, with Send and Don\'t send');
    check((await withCard('五点见')).send_code === byCard.send_code && lark.cards.length === 1, 'preparing the same message again keeps its code and card');
    const notHis = await tap('ou_dev_bob', byCard.send_code, 'send');
    check(notHis.toast?.type === 'error' && !notHis.card && lark.messages.length === sentBefore, 'only the sender can answer the card');
    const tapped = await tap('ou_dev_alex', byCard.send_code, 'send');
    check(tapped.toast?.type === 'success' && JSON.stringify(tapped.card).includes('✓') && lark.messages.length === sentBefore + 1 && lark.messages.at(-1)!.text.startsWith('五点见\n') && lark.messages.at(-1)!.as === 'user',
      'tapping Send sends it as the person and turns the card into a sent note');
    check(String((await tool(alex.token, 'send_lark_message', { send_code: byCard.send_code })).error).includes('already sent') && lark.messages.length === sentBefore + 1, 'the agent\'s yes afterwards is told it went out already, and nothing goes twice');
    check((await tap('ou_dev_alex', byCard.send_code, 'send')).toast?.type === 'info' && lark.messages.length === sentBefore + 1, 'and a second tap does nothing');
    const viaAgent = await withCard('六点见');
    await tool(alex.token, 'send_lark_message', { send_code: viaAgent.send_code });
    await new Promise((ok) => setTimeout(ok, 200));
    const agentCard = lark.cards.at(-1)!;
    check(lark.messages.length === sentBefore + 2 && agentCard.updates.length === 1 && agentCard.updates[0].includes('✓') && !agentCard.updates[0].includes('"button"'), 'sent with the agent\'s yes, the card says so, without the buttons');
    const unwanted = await withCard('算了');
    const declined = await tap('ou_dev_alex', unwanted.send_code, 'decline');
    check(JSON.stringify(declined.card).includes('Cancelled') && String((await tool(alex.token, 'send_lark_message', { send_code: unwanted.send_code })).error).includes("Don't send") && lark.messages.length === sentBefore + 2,
      'tapping Don\'t send cancels it, and the agent is told so');
    check((await tap('ou_dev_alex', 'nope1234', 'send')).toast?.type === 'error', 'an unknown or expired preview only says so');
    const cards = lark.cards.length;
    const notAsked = await withCard('七点见', "'accept'");
    check(!!notAsked.send_code && lark.cards.length === cards + 1 && lark.messages.length === sentBefore + 2, 'and the card is used even for an agent whose app could ask');
    const rich = await withCard('**周五**前要：\n- 报价单\n- 合同', 'null', true);
    const richCard = lark.cards.at(-1)!.card;
    check(rich.preview.format === 'markdown' && richCard.includes('"tag":"markdown"') && richCard.includes('**周五**'), 'a Markdown message is previewed on the card as formatted text');
    // a file, uploaded as it is, then sent before the text
    const up = await tool(alex.token, 'create_upload', { purpose: 'file' });
    check((await fetch(up.upload_url, { method: 'PUT', body: 'PDF-BYTES' })).ok && String(up.command).includes('--data-binary @<FILE>'), 'a file is uploaded as it is');
    const quote = { upload_id: up.upload_id, name: '报价单.pdf' };
    check(String((await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], text: '报价单在这', file: quote })).error).includes('files=1'), 'the first file asks the person to allow uploading files');
    await connect(alex.jar, '&files=1');
    check(['im:resource', 'im:message.send_as_user'].every((s) => lark.scopesAsked.split(' ').includes(s)), 'which is asked for on top of sending messages');
    const withFile = await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], text: '报价单在这', file: quote });
    check(withFile.preview?.file?.name === '报价单.pdf' && withFile.preview.file.bytes === 9 && String(withFile.preview.text).endsWith('AI twin'), 'the preview shows the file and the signed text');
    const n = lark.messages.length;
    const sentFile = await tool(alex.token, 'send_lark_message', { send_code: withFile.send_code });
    const [f, t] = lark.messages.slice(n);
    const upload = lark.uploads.at(-1)!;
    check(sentFile.file === '报价单.pdf' && upload.name === '报价单.pdf' && upload.bytes === 'PDF-BYTES' && f?.text === `[file:${upload.key}]` && f.as === 'user' && t?.text.startsWith('报价单在这\n') && t.as === 'user',
      'the file goes up to Lark as the person and arrives before the signed text');
    check(!!(await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], file: quote })).error, 'an uploaded file is sent once');
    // a platform that cannot run commands puts the file in the request; pictures go as images shown in the chat
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    const pic = await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], text: '看下截图', file: { name: '截图', mime_type: 'image/png', data: b64('PNG-PICTURE') } });
    check(pic.preview?.file?.name === '截图.png' && pic.preview.file.as === 'image' && pic.preview.file.bytes === 11, 'a picture handed over in the request is previewed as an image, named by its type');
    const n2 = lark.messages.length;
    await tool(alex.token, 'send_lark_message', { send_code: pic.send_code });
    const img = lark.uploads.at(-1)!;
    check(img.image === true && img.bytes === 'PNG-PICTURE' && img.as === 'user' && lark.messages[n2]?.text === `[image:${img.key}]` && lark.messages[n2 + 1]?.text.startsWith('看下截图\n'),
      'and goes to Lark as the person as an image, before the text');
    const odd = await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], file: { name: 'broken.png', data: b64('NOT-A-PICTURE') } });
    const n3 = lark.messages.length;
    await tool(alex.token, 'send_lark_message', { send_code: odd.send_code });
    check(lark.uploads.at(-1)!.image !== true && lark.messages[n3]?.text === `[file:${lark.uploads.at(-1)!.key}]`, 'a picture Lark will not take as an image is sent as a file');
    const doc = await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], file: { name: '合同.pdf', mime_type: 'application/pdf', data: b64('PDF') } });
    check(doc.preview?.file?.as === 'file', 'other files handed over in the request are sent as files');
    check(String((await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], file: { name: 'x.png', data: '这不是base64' } })).error).includes('base64'), 'data that is not base64 is refused');
    const huge = await fetch(`${HUB}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: 'x'.repeat(49 * 1024 * 1024) });
    check(huge.status === 413, 'a request over 48 MB is refused before it is read');
    // full access: no preview, sent at once
    check((await api(alex.jar, 'POST', '/lark/messages', { noConfirm: true })).body.noConfirm === true, 'the person can let their agents send without asking first');
    const k = lark.messages.length;
    const direct = await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], text: '马上到' });
    check(direct.sent?.[0] === '周明' && !direct.send_code && lark.messages.length === k + 1 && lark.messages.at(-1)!.text.startsWith('马上到\n\n—— '), 'then a message goes out at once, still signed');
    await api(alex.jar, 'POST', '/lark/messages', { noConfirm: false });
    check(!!(await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], text: 'x' })).send_code && lark.messages.length === k + 1, 'and asking first comes back when they turn it off');
    await connect(alex.jar);
    check(['im:message.send_as_user', 'im:resource'].every((s) => lark.scopesAsked.split(' ').includes(s)), 'reconnecting Lark keeps it while it is on');
    const pendingOne = await tool(alex.token, 'send_lark_message', { to: ['ou_dev_bob'], text: 'hi' });
    const count = lark.messages.length;
    await api(alex.jar, 'POST', '/lark/messages', { noConfirm: true });
    await api(alex.jar, 'POST', '/lark/messages', { on: false });
    check((await api(alex.jar, 'GET', '/lark/messages')).body.noConfirm === false, 'turning sending off also turns full access off');
    check(!!(await tool(alex.token, 'send_lark_message', { send_code: pendingOne.send_code })).error && lark.messages.length === count, 'turning it off stops a message that was waiting for the go-ahead');
    await connect(alex.jar);
    check(!['im:message.send_as_user', 'im:resource'].some((s) => lark.scopesAsked.split(' ').includes(s)), 'and reconnecting no longer asks for it');
  }

  // ---------------------------------------------------------------- Lark messages read as the person, once they turn it on
  {
    check(String((await tool(alex.token, 'read_lark_messages', { colleague: 'ou_dev_bob' })).error).includes('/me'), 'reading messages is off until the person turns it on');
    const on = await api(alex.jar, 'POST', '/lark/reading', { on: true });
    check(on.body.on === true && on.body.granted === false && String(on.body.connectUrl).includes('reading=1'), 'turning it on sends them to allow it in Lark');
    await connect(alex.jar, '&reading=1');
    check(['im:message:readonly', 'im:message.p2p_msg:get_as_user', 'im:message.group_msg:get_as_user', 'im:chat:read'].every((s) => lark.scopesAsked.split(' ').includes(s)),
      'allowing it asks Lark to read messages and find chats as them');
    type Read = { chat_id: string; messages: { from: string; text: string; time: string; file?: { name?: string; download: string } }[] };
    const dm = await tool(alex.token, 'read_lark_messages', { colleague: 'ou_dev_bob' }) as Read;
    check(dm.chat_id === 'oc_p2p_bob' && dm.messages.map((m) => m.text).join('|') === '报价单收到了|@Alex 周三见|[file: 合同.pdf]' && dm.messages[0].from === '周明' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dm.messages[0].time),
      "a colleague's direct chat, oldest first, with who said what and when");
    const link = dm.messages[2].file!.download;
    const file = await fetch(link);
    check(file.ok && (await file.text()) === 'CONTRACT' && String(file.headers.get('content-disposition')).includes('filename'), 'a file someone sent comes through a short-lived link, as it is');
    check((await fetch(link.replace(/t=[^&]+/, 't=x'))).status === 403, 'and only with that link');
    const groups = await tool(alex.token, 'find_lark_chat', { query: '开发' }) as { chats: { chat_id: string; name: string }[] };
    check(groups.chats.length === 1 && groups.chats[0].chat_id === 'oc_dev', 'group chats are found by name');
    const grp = await tool(alex.token, 'read_lark_messages', { chat_id: 'oc_dev', limit: 2 }) as Read;
    check(grp.messages.length === 2 && lark.messageReads.at(-1)?.chat === 'oc_dev' && lark.messageReads.at(-1)?.size === 2, 'a group reads only as many recent messages as asked');
    check((await api(alex.jar, 'GET', '/lark/reading')).body.readsThisWeek === 2 && !JSON.stringify(fsDb.prepare('SELECT * FROM lark_reads').all()).includes('周三'),
      'the hub counts which conversation was read, never the messages');
    await api(alex.jar, 'POST', '/lark/reading', { on: false });
    check(!!(await tool(alex.token, 'read_lark_messages', { colleague: 'ou_dev_bob' })).error && (await fetch(link)).status === 403, 'turning it off stops reading, file links included');
    await connect(alex.jar);
    check(!lark.scopesAsked.split(' ').includes('im:message.p2p_msg:get_as_user'), 'and reconnecting no longer asks for it');
  }

  // ---------------------------------------------------------------- the AI twin in shadow mode
  {
    const twinDb = (sql: string, ...args: (string | number)[]) => fsDb.prepare(sql).all(...args) as Record<string, unknown>[];
    check(String((await tool(alex.token, 'check_new_messages', {})).error).includes('/me'), 'the AI twin is off until the person turns it on');
    const on = await api(alex.jar, 'POST', '/lark/twin', { on: true });
    check(on.body.on === true && on.body.granted === false && String(on.body.connectUrl).includes('twin=1') && (await api(alex.jar, 'GET', '/lark/reading')).body.on === true,
      'turning it on turns reading on with it, and sends them to allow it in Lark');
    check(String((await tool(alex.token, 'setup_twin', {})).error).includes('twin=1'), 'until then the agent gets the same link');
    await connect(alex.jar, '&reading=1&twin=1&write=1&docs=1');
    const asked = lark.scopesAsked.split(' ');
    check(['search:message', 'im:message.p2p_msg:get_as_user', 'bitable:app', 'docx:document'].every((x) => asked.includes(x)), 'one authorisation asks for searching messages, reading them, and writing its Base and documents');

    const inbox = (id: string, chat: string, from: string, ago: number, text: string, more: { bot?: boolean; mentions?: string[]; parent?: string } = {}) =>
      lark.inbox.set(id, { id, chat, from, at: Date.now() - ago, text, ...more });
    inbox('om_t1', 'oc_p2p_bob', 'ou_dev_bob', 600_000, '周五的报价能发我吗？');
    inbox('om_t2', 'oc_grp1', 'ou_dev_alice', 500_000, '@Alex 方案看了吗', { mentions: ['ou_dev_alex'] });
    inbox('om_t3', 'oc_grp2', 'ou_dev_alice', 400_000, '午饭吃什么');
    inbox('om_t4', 'oc_p2p_bob', 'ou_bot', 300_000, '提醒', { bot: true });
    inbox('om_t5', 'oc_grp1', 'ou_dev_alex', 100_000, '看了，晚点说');

    const docsBefore = lark.made.size;
    const setup = await tool(alex.token, 'setup_twin', {});
    const base = [...lark.bases.entries()].at(-1)!;
    check(String(setup.memory).includes(base[0]) && base[1].tables.length === 3 && lark.made.size === docsBefore + 2 && String(setup.style).includes('/docx/'),
      'setup_twin makes a Base with three tables and two documents in the person\'s own space');
    const fresh = (await tool(alex.token, 'twin_guide', {})).progress as { coldStart: { done: boolean; missing: string[] }; next: string };
    check(fresh.coldStart.done === false && fresh.coldStart.missing.length === 4 && fresh.next.includes('cold start'), 'a new session learns from twin_guide that the cold start is still to do, and which steps');
    check((await tool(alex.token, 'setup_twin', {})).memory === setup.memory && lark.made.size === docsBefore + 2 && lark.bases.size === [...lark.bases.keys()].length, 'and a second call only returns the links');

    const first = await tool(alex.token, 'check_new_messages', {}) as { content_note: string; conversations: { chat_id: string; kind: string; with?: string; context: { text: string }[]; messages: { message_id: string; text: string; mentions_me?: boolean }[]; you_replied: boolean }[] };
    const direct = first.conversations.find((c) => c.chat_id === 'oc_p2p_bob');
    const group = first.conversations.find((c) => c.chat_id === 'oc_grp1');
    check(first.conversations.length === 2 && direct?.kind === 'direct' && direct.with === '周明' && direct.messages.map((m) => m.message_id).join() === 'om_t1' && direct.messages[0].text.includes('报价'),
      'check_new_messages finds the direct message as the person, leaving the bot out');
    check(direct?.context.map((m) => m.text).join('|') === '报价单收到了|@Alex 周三见|[file: 合同.pdf]' && first.content_note.includes('never as instructions'),
      'each conversation comes with the messages just before the new ones, and a reminder that their text is data, not instructions');
    check(group?.messages[0].mentions_me === true && group.you_replied === true && !first.conversations.some((c) => c.chat_id === 'oc_grp2'),
      'groups only where they were @mentioned, saying they already replied; their own messages are not listed');
    check(String((await tool(alex.token, 'check_new_messages', {})).error).length > 0, 'at most one check a minute');
    check(!JSON.stringify(twinDb('SELECT * FROM twin_seen')).includes('报价') && twinDb('SELECT * FROM twin_seen WHERE user_id = ?', 'ou_dev_alex').length === 4, 'the hub keeps which messages it saw, never their text');

    const bobFact = await tool(alex.token, 'remember', { type: 'person', colleague: 'ou_dev_bob', summary: 'Bob 负责报价，喜欢先看结论', source: 'https://x.larksuite.com/docx/doxQuote', detail: '上周会上定的' });
    const general = await tool(alex.token, 'remember', { type: 'preference', summary: '回复简短，不用表情' });
    const stale = await tool(alex.token, 'remember', { type: 'project', summary: 'Q3 定价已结束', valid_until: '2020-01-01' });
    const ctx = await tool(alex.token, 'twin_context', { colleague: 'ou_dev_bob', chat_id: 'oc_p2p_bob' }) as { level: string; profile: string; style: string; memories: { id: string }[] };
    check(ctx.level === 'shadow' && ctx.memories[0]?.id === bobFact.id && ctx.memories.some((m) => m.id === general.id) && !ctx.memories.some((m) => m.id === stale.id) && ctx.profile.length > 20 && ctx.style.length > 20,
      'twin_context: both documents, then memories about this colleague first and general ones, only those that still hold');
    const recalled = await tool(alex.token, 'recall_memory', { ids: [bobFact.id] }) as { memories: { detail: string; source: string; about: string }[] };
    check(recalled.memories[0]?.detail === '上周会上定的' && recalled.memories[0].source === 'https://x.larksuite.com/docx/doxQuote' && recalled.memories[0].about === '周明'
      && (await tool(alex.token, 'recall_memory', { query: '表情' })).memories.length === 1, 'recall_memory gives the details by id, or by words');
    await tool(alex.token, 'remember', { id: stale.id, status: 'replaced', replaced_by: general.id });
    check((await tool(alex.token, 'recall_memory', { query: 'Q3' })).memories.length === 0, 'a replaced memory is kept but no longer recalled');

    const pred = await tool(alex.token, 'record_prediction', { message_id: 'om_t1', should_reply: true, urgency: 'today', reply: '好的，下午发你', scenario: '要资料' });
    check(pred.recorded === true && pred.sent === false && lark.messages.every((m) => !m.text.includes('下午发你')), 'record_prediction records, and sends nothing');
    check(!!(await tool(alex.token, 'record_prediction', { message_id: 'om_t5', should_reply: true })).error, 'nor for the person\'s own messages');
    inbox('om_t6', 'oc_p2p_bob', 'ou_dev_alex', 1000, '下午发');
    fsDb.prepare('UPDATE twin SET last_check = 0 WHERE user_id = ?').run('ou_dev_alex');
    const second = await tool(alex.token, 'check_new_messages', {});
    const predRows = lark.records.get(`${base[0]}/${base[1].tables[1].id}`)!;
    const settledRow = JSON.stringify(predRows.get(pred.id));
    check(second.conversations.length === 0 && twinDb('SELECT outcome FROM twin_predictions WHERE record_id = ?', pred.id)[0]?.outcome === 'replied' && settledRow.includes('下午发"'),
      'their reply in that chat settles the prediction: the Base gets what they actually said, the hub only that they replied');
    const replay = await tool(alex.token, 'record_prediction', { message_id: 'om_t2', should_reply: false, scenario: '方案', replay: { replied: true, reply: '看了，晚点说', gap_minutes: 7 } });
    const toReview = (await tool(alex.token, 'list_predictions', {})).predictions as { id: string; predictedReply?: string; actualReply?: string }[];
    check(toReview.length === 2 && toReview.find((r) => r.id === pred.id)?.actualReply === '下午发' && toReview.some((r) => r.id === replay.id), 'list_predictions gives the settled ones, live and replayed, for the reflection');
    await tool(alex.token, 'review_prediction', { id: pred.id, cause: 'tone', closeness: 4, distilled: true });
    check(!(await tool(alex.token, 'list_predictions', {})).predictions.some((r: { id: string }) => r.id === pred.id) && twinDb('SELECT cause, closeness FROM twin_predictions WHERE record_id = ?', pred.id)[0]?.closeness === 4,
      'a reviewed prediction leaves the queue');

    // a prediction nobody answered for a day is settled as "no reply" by the hourly round
    const quiet = await tool(alex.token, 'record_prediction', { message_id: 'om_t3', should_reply: true, scenario: '闲聊' });
    fsDb.prepare('UPDATE twin_predictions SET received = received - 90000000 WHERE record_id = ?').run(quiet.id);
    const { execFile } = await import('node:child_process');
    const inTwin = (js: string, env: Record<string, string> = {}) => new Promise<Record<string, any>>((ok, fail) => execFile(process.execPath, ['--input-type=module', '-e', `
      const t = await import(${JSON.stringify(path.resolve('server/lark/twin.ts'))});
      const { get } = await import(${JSON.stringify(path.resolve('server/db.ts'))});
      const user = get("SELECT * FROM users WHERE id = 'ou_dev_alex'");
      console.log(JSON.stringify(await (${js})));
    `], { env: { ...process.env, DATA_DIR: dataDir, HUB_SECRET: 'smoke', DEV_LOGIN: '1', DEFAULT_LOCALE: 'en', HUB_URL: HUB, LARK_APP_ID: 'cli_smoke', LARK_APP_SECRET: 'secret', LARK_API_BASE: `http://localhost:${LARK_PORT}/open-apis`, LARK_ACCOUNTS_BASE: `http://localhost:${LARK_PORT}/open-apis`, ...env } },
      (e, out, err) => (e ? fail(new Error(String(err).split('\n').filter((l) => !/Warning|--trace/.test(l)).slice(0, 6).join(' | '))) : ok(JSON.parse(out.trim().split('\n').at(-1)!)))));
    await inTwin('t.twinRound().then(() => ({}))');
    check(twinDb('SELECT outcome FROM twin_predictions WHERE record_id = ?', quiet.id)[0]?.outcome === 'none' && /没回|No reply/.test(JSON.stringify(predRows.get(quiet.id))),
      'after a day without their reply, the round settles it as no reply');
    const brief = JSON.stringify(await inTwin('t.weeklyBrief(user)'));
    check(brief.includes('3 predictions') && brief.includes('33%') && brief.includes(String(setup.memory)), 'the weekly brief counts predictions and how often it was right, with the memory link');

    // the two documents change only with the person's yes
    const styleDoc = String(setup.style).split('/').pop()!;
    check(String((await tool(alex.token, 'edit_lark_doc', { url: String(setup.style), append: '- 随便改' })).error).includes('suggest_twin_doc_change'), 'the agent cannot edit the twin\'s documents directly');
    const prop = await tool(alex.token, 'suggest_twin_doc_change', { doc: 'style', markdown: '## 语气\n\n简短直接，不用表情', reason: '最近几次你都删掉了表情' });
    const waiting = (await api(alex.jar, 'GET', '/lark/twin')).body as { proposals: { code: string; reason: string }[] };
    check(prop.changed === false && waiting.proposals.length === 1 && waiting.proposals[0].reason.includes('表情'), 'a proposal waits for the person on their Me page');
    await api(alex.jar, 'POST', `/lark/twin/proposals/${waiting.proposals[0].code}`, { apply: true });
    const restyled = await tool(alex.token, 'twin_context', { colleague: 'ou_dev_bob' });
    check(restyled.style.includes('简短直接') && lark.made.get(styleDoc)!.top!.length === 2 && ((await api(alex.jar, 'GET', '/lark/twin')).body.proposals as unknown[]).length === 0,
      'applying it rewrites the document');
    const declined = await tool(alex.token, 'suggest_twin_doc_change', { doc: 'style', markdown: '全部用英文', reason: '试试' });
    await api(alex.jar, 'POST', `/lark/twin/proposals/${declined.proposal}`, { apply: false });
    check(!(await tool(alex.token, 'twin_context', {})).style.includes('英文') && (await api(alex.jar, 'POST', `/lark/twin/proposals/${declined.proposal}`, { apply: true })).status === 400,
      'turning it down changes nothing, and an answered proposal cannot be answered again');
    const cardsBefore = lark.cards.length;
    const viaCard = await inTwin("t.suggestDocChange(user, { doc: 'profile', markdown: '## 角色\\n\\n负责中台', reason: '从 OKR 看到' })", { LARK_CONFIRM_CARDS: 'on' });
    const tapped = await inTwin(`t.onTwinCardTap({ operator: { open_id: 'ou_dev_alex' }, action: { value: { hub: 'twin_doc', code: '${viaCard.proposal}', choice: 'apply' } } })`, { LARK_CONFIRM_CARDS: 'on' });
    const notHers = await inTwin(`t.onTwinCardTap({ operator: { open_id: 'ou_dev_bob' }, action: { value: { hub: 'twin_doc', code: '${viaCard.proposal}', choice: 'apply' } } })`, { LARK_CONFIRM_CARDS: 'on' });
    check(lark.cards.length === cardsBefore + 1 && lark.cards.at(-1)!.card.includes('负责中台') && tapped.toast?.type === 'success' && notHers.toast?.type === 'error'
      && (await tool(alex.token, 'twin_context', {})).profile.includes('负责中台'), 'with cards set up, the bot sends the proposal as a card and only the person can apply it there');

    // which groups it looks at
    inbox('om_t7', 'oc_grp2', 'ou_dev_alice', 1000, '下周团建去哪', { parent: 'om_t3' });
    await tool(alex.token, 'twin_settings', { watch: ['oc_grp2'] });
    fsDb.prepare('UPDATE twin SET last_check = 0 WHERE user_id = ?').run('ou_dev_alex');
    const third = await tool(alex.token, 'check_new_messages', {});
    check(third.conversations[0]?.messages[0].reply_to?.text === '午饭吃什么', 'a reply comes with the message it replies to');
    check(third.conversations.length === 1 && third.conversations[0].chat_id === 'oc_grp2' && ((await api(alex.jar, 'GET', '/lark/twin')).body.watch as { name: string }[])[0]?.name === '群 grp2',
      'a watched group is looked at without an @mention, and the Me page names it');

    // the person's past conversations, for the cold start
    const hist = await tool(alex.token, 'my_message_history', { days: 30 }) as { conversations: { chat_id: string; kind: string }[] };
    check(hist.conversations.some((c) => c.chat_id === 'oc_p2p_bob' && c.kind === 'direct') && hist.conversations.some((c) => c.chat_id === 'oc_grp1' && c.kind === 'group') && !hist.conversations.some((c) => c.chat_id === 'oc_grp2'),
      'my_message_history lists direct chats with colleagues and the groups the person spoke in');
    const bobHist = await tool(alex.token, 'my_message_history', { chat_id: 'oc_p2p_bob' });
    check(bobHist.messages.length === 3 && bobHist.messages[0].text === '报价单收到了', 'and reads one conversation oldest first');

    const later = (await tool(alex.token, 'twin_guide', {})).progress as { coldStart: { done: boolean; documents: Record<string, string> }; toReview: number; lastCheck: string; next: string };
    check(later.coldStart.done === true && later.coldStart.documents.style === 'approved' && later.toReview === 2 && !!later.lastCheck && later.next.includes('Patrol'),
      'once memories, both documents and a replay exist, a new session goes straight to patrolling instead of starting over');
    // the hub watches the twin from outside: a silent patrol, a prediction redone again and again
    const warnings = () => lark.messages.filter((m) => m.id === 'ou_dev_alex' && m.as === 'bot' && /AI (分身|twin)/.test(m.text));
    const warned = warnings().length;
    fsDb.prepare('UPDATE twin SET last_check = ? WHERE user_id = ?').run(Date.now() - 40 * 60_000, 'ou_dev_alex');
    await inTwin('t.twinWatch(Date.now(), [24, 0]).then(() => ({}))');
    await inTwin('t.twinWatch(Date.now(), [24, 0]).then(() => ({}))');
    check(warnings().length === warned + 1 && /40/.test(warnings().at(-1)!.text) && (await tool(alex.token, 'twin_guide', {})).progress.alert === 'stalled',
      'a patrol silent for 30 minutes is reported to the person once, and shows in the progress');
    await tool(alex.token, 'check_new_messages', {});
    check(!(await tool(alex.token, 'twin_guide', {})).progress.alert, 'and the next check clears it');
    for (let i = 0; i < 5; i++) await tool(alex.token, 'record_prediction', { message_id: 'om_t1', should_reply: true, scenario: '要资料' });
    await inTwin('t.twinWatch(Date.now(), [24, 0]).then(() => ({}))');
    check(warnings().length === warned + 2 && warnings().at(-1)!.text.includes('6'), 'the same message predicted again and again is reported as spinning');
    check(twinDb('SELECT outcome FROM twin_predictions WHERE record_id = ?', pred.id)[0]?.outcome === 'replied' && /回了|Replied/.test(JSON.stringify(predRows.get(pred.id))),
      'predicting a message again never wipes out what the person actually did');
    fsDb.prepare("UPDATE users SET send_no_confirm = 1 WHERE id = 'ou_dev_alex'").run();
    check((await api(alex.jar, 'GET', '/lark/messages')).body.twinHolds === true, 'while the twin is on, sending as the person without confirming is held');
    fsDb.prepare("UPDATE users SET send_no_confirm = 0 WHERE id = 'ou_dev_alex'").run();

    const status = (await api(alex.jar, 'GET', '/lark/twin')).body as { week: { predictions: number; accuracy: number } };
    check(status.week.predictions === 3 && status.week.accuracy === 33, 'the Me page shows the week in numbers');
    await api(alex.jar, 'POST', '/lark/reading', { on: false });
    check((await api(alex.jar, 'GET', '/lark/twin')).body.on === false && String((await tool(alex.token, 'check_new_messages', {})).error).includes('/me'), 'turning reading off turns the twin off too');
  }

  // ---------------------------------------------------------------- a department's page
  {
    fsDb.prepare("INSERT OR REPLACE INTO departments (id, name, parent_id, leader_ids, updated_at) VALUES ('od-sea', '东南亚', 'od-growth', '[\"ou_dev_alice\"]', 0)").run();
    for (const u of ['ou_dev_alice', 'ou_dev_bob']) fsDb.prepare("INSERT OR IGNORE INTO user_departments (user_id, department_id) VALUES (?, 'od-sea')").run(u);
    type DP = { department: { name: string; parent: { name: string } | null; children: { id: string }[]; leaders: string[] }; people: { id: string }[]; canEdit: boolean; home: { modules: { type: string; title: string | null }[] } | null; boards: { id: string }[]; apps: { owner: { id: string } }[] };
    const asBob = (await api(bob.jar, 'GET', '/org/departments/od-sea')).body as unknown as DP;
    check(asBob.department.name === '东南亚' && asBob.department.parent?.name === '增长' && asBob.people.map((p) => p.id).join() === 'ou_dev_alice,ou_dev_bob' && !asBob.canEdit && asBob.home === null,
      'a department page shows where it sits and its people, leaders first; a member cannot change it');
    check(((await api(bob.jar, 'GET', '/org/departments/od-growth')).body as unknown as DP).department.children.some((c) => c.id === 'od-sea'), 'and the departments under it');
    check(asBob.apps.every((a) => ['ou_dev_alice', 'ou_dev_bob'].includes(a.owner.id)), "only its members' apps, and only those the viewer may open");
    check(((await api(alice.jar, 'GET', '/org/departments/od-sea')).body as unknown as DP).canEdit, 'its leader can');
    await tool(alice.token, 'save_homepage', { scope: 'department', department_id: 'od-sea', layout: { modules: [{ type: 'note', title: { 'zh-CN': '本周重点', en: 'This week' }, body: { 'zh-CN': '……', en: '…' } }, { type: 'apps' }] } });
    await tool(alice.token, 'save_board', { id: 'sea-weekly', title: { 'zh-CN': '东南亚周报', en: 'SEA weekly' }, scope: 'department', department_id: 'od-sea', layout: { modules: [{ type: 'note', body: { 'zh-CN': '……', en: '…' } }] } });
    const after = (await api(bob.jar, 'GET', '/org/departments/od-sea')).body as unknown as DP;
    check(after.home?.modules.map((m) => m.title ?? m.type).join() === 'This week,apps' && after.boards.map((b) => b.id).join() === 'sea-weekly', 'its home page (titles in the reader\'s language) and boards show up for its members');
    check((await api(bob.jar, 'GET', '/org/departments/nope')).status === 400, 'a department that does not exist is refused');
    await tool(alice.token, 'delete_board', { id: 'sea-weekly' });
    await tool(alice.token, 'reset_homepage', { scope: 'department', department_id: 'od-sea' });
    fsDb.prepare("DELETE FROM user_departments WHERE department_id = 'od-sea'").run();
    fsDb.prepare("DELETE FROM departments WHERE id = 'od-sea'").run();
  }

  // ---------------------------------------------------------------- AI models and data APIs for apps (the company's key)
  {
    const aiApp = await loginToApp('invoice', alex.jar);
    const chat = (body: unknown, jar: Jar | null = aiApp, extra: Record<string, string> = {}) =>
      appFetch('invoice', '/__hub/ai/v1/chat/completions', jar ?? undefined, { 'content-type': 'application/json', ...extra }, 'POST', JSON.stringify(body));
    check((await chat({ model: 'gpt-x', messages: [] })).status === 404, 'with no provider set, apps are told AI is not configured');
    check((await tool(bob.token, 'ai_resources')).configured === false, 'and agents too');
    check((await api(bob.jar, 'POST', '/admin/ai', { preset: 'aisa', key: 'sk-good' })).status >= 400, 'only admins set the provider');
    check(/key/i.test(String((await api(alex.jar, 'POST', '/admin/ai', { preset: 'aisa', key: 'sk-bad' })).body.error)), 'a key the provider refuses is not saved');
    const saved = (await api(alex.jar, 'POST', '/admin/ai', { preset: 'aisa', key: 'sk-good' })).body as { provider: { models: string[]; apisUrl: string; keySet: boolean } };
    check(saved.provider.keySet && saved.provider.models.join() === 'claude-y,gpt-x' && saved.provider.apisUrl.endsWith('/aisa/apis/v1'), 'AIsa is one key for models and data APIs, tried before it is saved');
    check(!JSON.stringify((await api(alex.jar, 'GET', '/admin/ai')).body).includes('sk-good'), 'the key never comes back to the browser');
    const res = await chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] });
    const answer = await res.json() as { choices: { message: { content: string } }[] };
    const sent = lark.aiCalls.at(-1)!;
    check(res.status === 200 && answer.choices[0].message.content === 'hi' && sent.auth === 'Bearer sk-good' && !sent.cookie && sent.path === '/aisa/v1/chat/completions',
      "an app calls a model with no key of its own: the hub adds the company's and passes nothing of the visitor's");
    check(/^agent-foyer\/\d+\.\d+\.\d+$/.test(sent.ua), 'the provider can tell the call comes through Agent Foyer');
    const streamed = await (await chat({ model: 'claude-y', stream: true, messages: [] })).text();
    check(streamed.includes('"你"') && streamed.includes('[DONE]'), 'answers stream through');
    const data = await appFetch('invoice', '/__hub/ai/apis/v1/twitter/user/info?userName=aisa', aiApp);
    check(data.status === 200 && (await data.json() as { data: { followers: number } }).data.followers === 4200 && lark.aiCalls.at(-1)!.path === '/aisa/apis/v1/twitter/user/info?userName=aisa', "and AIsa's data APIs with their own paths");
    check((await appFetch('invoice', '/__hub/ai/v1/chat/completions', undefined, { 'content-type': 'application/json', 'x-hub-ticket': issueTicket('invoice', 'ou_dev_alex') }, 'POST', JSON.stringify({ model: 'gpt-x', messages: [] }))).status === 200,
      "an app's server calls it with the ticket of the person's request");
    check((await appFetch('invoice', '/__hub/ai/v1/files', aiApp)).status === 404 && (await appFetch('invoice', '/__hub/ai/apis/v1/twitter/%2e%2e/admin', aiApp)).status === 404
      && lark.aiCalls.every((x) => !x.path.includes('/files') && !x.path.includes('admin')), "apps reach only the model endpoints they need, and nothing climbs out of a data API's path");
    check((await chat({ model: 'gpt-x', messages: [] }, null)).status === 401, 'someone not signed in gets nothing (a public app cannot spend the credit for strangers)');
    check((await chat({ model: 'gpt-x', messages: [] }, aiApp, { origin: 'https://evil.example' })).status === 403
      && (await appFetch('invoice', '/__hub/ai/v1/chat/completions', aiApp, { 'content-type': 'text/plain' }, 'POST', '{}')).status === 415, 'other sites cannot spend through a colleague\'s browser');
    const usage = (await api(alex.jar, 'GET', '/admin/ai')).body.usage as { apps: { app: string; calls: number; tokens: number; people: number }[] };
    const inv = usage.apps.find((a) => a.app === 'invoice')!;
    // a chat (11+3), a stream (7+2), a data API call (no tokens), a call from the app's server (11+3); refused calls are not counted
    check(inv.calls === 4 && inv.tokens === 37 && inv.people === 1, 'every call is recorded by app and person, with tokens from answers and streams');
    const status = await tool(bob.token, 'ai_resources') as { configured: boolean; provider: string; models: string[]; dataApis: boolean };
    check(status.configured && status.provider === 'AIsa' && status.dataApis && status.models.includes('gpt-x'), 'agents see the provider, its models and the data APIs');
    check(String((await tool(bob.token, 'app_guide')).guide).includes('/__hub/ai/v1/chat/completions'), 'and app_guide tells them how apps use it');
    await api(alex.jar, 'POST', '/admin/ai/limits', { limits: { perAppPerDay: 500, perPersonPerDay: inv.calls } });
    const limited = await chat({ model: 'gpt-x', messages: [] });
    check(limited.status === 429 && (await limited.json() as { error: string }).error === 'person_daily_limit', 'past the daily limit a person gets a clear 429');
    await api(alex.jar, 'POST', '/admin/ai/limits', { limits: { perPersonPerDay: 200 }, disabledApps: ['invoice'] });
    check((await chat({ model: 'gpt-x', messages: [] })).status === 403, 'admins switch AI off for one app');
    await api(alex.jar, 'POST', '/admin/ai/limits', { disabledApps: [] });
    check((await api(alex.jar, 'POST', '/admin/ai', { preset: 'openai', baseUrl: `http://localhost:${LARK_PORT}/aisa/v1`, key: '' })).status === 200
      && (await appFetch('invoice', '/__hub/ai/apis/v1/twitter/user/info', aiApp)).status === 404 && (await chat({ model: 'gpt-x', messages: [] })).status === 200,
      'any OpenAI-compatible provider works for models (keeping the stored key); data APIs need AIsa');
    await api(alex.jar, 'DELETE', '/admin/ai');
    check((await chat({ model: 'gpt-x', messages: [] })).status === 404, 'removing the provider stops it');
  }

  // ---------------------------------------------------------------- telling one person's agents apart
  {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
    const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
    const make = async (ua: string) => (await (await fetch(`${HUB}/api/tokens`, { method: 'POST', headers: { cookie: bob.jar.header(), 'content-type': 'application/json', 'user-agent': ua }, body: '{"name":"Codex"}' })).json() as { token: string }).token;
    const t1 = await make(mac), t2 = await make(win);
    await fetch(`${HUB}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${t2}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'codex-mcp-client/0.163.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) });
    type A = { id: string; name: string; label: string | null; device: string | null; version: string | null };
    const agents = () => api(bob.jar, 'GET', '/profile').then((r) => (r.body.agents as A[]).filter((a) => a.name === 'Codex'));
    const two = await agents();
    check(two.length === 2 && two.some((a) => a.device === 'macOS · Chrome') && two.some((a) => a.device === 'Windows · Edge'), 'two agents of the same kind show the device each was added from');
    check(two.find((a) => a.device === 'Windows · Edge')?.version === '0.163.0' && two.find((a) => a.device === 'macOS · Chrome')?.version === null, 'and the version each agent reports when it calls');
    const winId = two.find((a) => a.device === 'Windows · Edge')!.id;
    check((await api(bob.jar, 'POST', `/agents/${encodeURIComponent(winId)}/label`, { label: '  公司   台式机 ' })).body.label === '公司 台式机'
      && (await agents()).find((a) => a.id === winId)?.label === '公司 台式机', 'the person names one of them');
    await api(alice.jar, 'POST', `/agents/${encodeURIComponent(winId)}/label`, { label: 'mine' });
    check((await agents()).find((a) => a.id === winId)?.label === '公司 台式机', "nobody else can rename someone's agent");
    await api(bob.jar, 'POST', `/agents/${encodeURIComponent(winId)}/label`, { label: '' });
    check((await agents()).find((a) => a.id === winId)?.label === null, 'an empty name goes back to the agent\'s own');
    for (const a of await agents()) await api(bob.jar, 'DELETE', `/agents/${encodeURIComponent(a.id)}`);
    void t1;
  }

  // ---------------------------------------------------------------- imported dashboards and their data stay in step
  {
    type Synced = { boards: { board: string; ok: boolean }[]; refreshed: number };
    check((await api(bob.jar, 'POST', '/admin/connections/sync')).status >= 400, 'only admins update now');
    const runs = lark.mbRuns;
    const idle = (await api(alex.jar, 'POST', '/admin/connections/sync')).body as Synced;
    check(idle.boards.length === 0, 'a dashboard that has not changed there is left as it is');
    check(idle.refreshed > 0 && lark.mbRuns > runs, 'every Metabase source on a page or board is read again');
    const tab1 = () => (((api(alex.jar, 'GET', '/boards')) as Promise<{ body: Record<string, unknown> }>));
    const modulesOf = async (id: string) => ((await tab1()).body.boards as { id: string; layout: { modules: unknown[] } }[]).find((b) => b.id === id)?.layout.modules.length;
    const before = await modulesOf('metabase-100-1');
    lark.mbDash = { changedAt: new Date(Date.now() + 1000).toISOString(), extraCard: true, dropDetail: false };
    const changed = (await api(alex.jar, 'POST', '/admin/connections/sync')).body as Synced;
    check(changed.boards.length === 1 && changed.boards[0].ok && (await modulesOf('metabase-100-1'))! > before!, 'a dashboard changed there is synced: a card added there shows up here');
    lark.mbDash = { changedAt: new Date(Date.now() + 2000).toISOString(), extraCard: true, dropDetail: true };
    await api(alex.jar, 'POST', '/admin/connections/sync');
    check((await modulesOf('metabase-100-2')) === undefined, 'a tab removed there is removed here');
    lark.mbDash = { changedAt: new Date(Date.now() + 3000).toISOString(), extraCard: false, dropDetail: false };
    await api(alex.jar, 'POST', '/admin/connections/sync');
    check((await modulesOf('metabase-100-2'))! > 0 && (await modulesOf('metabase-100-1')) === before, 'and changing it back brings the board back as it was');
  }

  // ---------------------------------------------------------------- the directory comes from the channel (Lark contacts)
  {
    // a hub that signs in with Lark for real (not the dev login used above), on its own database
    const dirData = mkdtempSync(path.join(tmpdir(), 'hub-dir-'));
    const { execFile } = await import('node:child_process');
    const run = () => new Promise<string>((ok, fail) => execFile(process.execPath, ['--input-type=module', '-e', `
      const { syncDirectory } = await import(${JSON.stringify(path.resolve('server/directory.ts'))});
      const { all } = await import(${JSON.stringify(path.resolve('server/db.ts'))});
      const n = await syncDirectory();
      console.log(JSON.stringify({ n, users: all('SELECT id, name, email FROM users ORDER BY id'), deps: all('SELECT id, name, name_i18n, parent_id, leader_ids FROM departments ORDER BY id'), mem: all('SELECT department_id, user_id FROM user_departments ORDER BY department_id, user_id') }));
    `], { env: { ...process.env, DEV_LOGIN: '', AUTH_PROVIDER: 'lark', DATA_DIR: dirData, HUB_SECRET: 'smoke', HUB_URL: HUB, LARK_APP_ID: 'cli_smoke', LARK_APP_SECRET: 'secret', LARK_API_BASE: `http://localhost:${LARK_PORT}/open-apis`, LARK_ACCOUNTS_BASE: `http://localhost:${LARK_PORT}/open-apis` } },
      (e, out, err) => (e ? fail(new Error(String(err).split('\n').filter((l) => !/Warning|--trace/.test(l)).slice(0, 6).join(' | '))) : ok(out))));
    type Dir = { n: number; users: { id: string; email: string }[]; deps: { id: string; name_i18n: string; parent_id: string | null; leader_ids: string }[]; mem: { department_id: string; user_id: string }[] };
    const first = JSON.parse((await run()).trim().split('\n').at(-1)!) as Dir;
    check(first.n === 3 && first.users.map((u) => u.id).join() === 'ou_bea,ou_lead,ou_solo' && first.users[0].email === 'ou_bea@acme.example', 'a sync brings in everyone in the contact range, with their company email');
    check(first.deps.map((d) => `${d.id}<${d.parent_id ?? ''}`).join() === 'od-east<od-sales,od-sales<' && JSON.parse(first.deps[1].leader_ids)[0] === 'ou_lead' && JSON.parse(first.deps[1].name_i18n).en === 'Sales',
      'and the departments, with their parent, leader and names per language');
    check(first.mem.map((m) => `${m.department_id}:${m.user_id}`).join() === 'od-east:ou_bea,od-sales:ou_lead', 'and who is in which department');
    lark.beaIn = 'od-sales';
    const second = JSON.parse((await run()).trim().split('\n').at(-1)!) as Dir;
    check(second.users.length === 3 && second.mem.map((m) => `${m.department_id}:${m.user_id}`).join() === 'od-sales:ou_bea,od-sales:ou_lead', 'syncing again picks up someone moving department, without duplicates');
    rmSync(dirData, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- searching Lark documents (read-only, as the person)
  {
    check(String((await tool(alex.token, 'search_lark_docs', { query: '日报' })).error).includes('search=1'), 'searching first asks the person to allow it');
    await connect(alex.jar, '&search=1');
    check(lark.scopesAsked.split(' ').includes('search:docs:read'), 'allowing it asks Lark for searching only');
    type Found = { total: number; results: { title: string; type: string; url: string; summary?: string; owner: string; updated: string; lastEditedBy?: string }[] };
    const found = await tool(alex.token, 'search_lark_docs', { query: '日报' }) as Found;
    check(found.total === 2 && found.results[0].title === '团队工作日报 1023' && found.results[0].type === 'wiki' && found.results[0].url.endsWith('/wiki/wikDaily1023')
      && found.results[0].updated === '2026-10-23' && found.results[0].lastEditedBy === 'Bo' && found.results[1].type === 'docx',
      'documents and wiki pages come back with title (no highlight marks), type, link, owner and date');
    const sent = lark.searches.at(-1) as { doc_filter?: unknown; wiki_filter?: unknown };
    check(!!sent.doc_filter && !!sent.wiki_filter, 'both documents and wiki pages are searched by default');
    await tool(alex.token, 'search_lark_docs', { query: '用户', where: 'wiki', title_only: true });
    const wikiOnly = lark.searches.at(-1) as { doc_filter?: unknown; wiki_filter?: { only_title?: boolean } };
    check(!wikiOnly.doc_filter && wikiOnly.wiki_filter?.only_title === true, 'and it can be wiki pages only, titles only');
    check((await tool(alex.token, 'search_lark_docs', { query: '用户与市场洞察' }) as Found).results[0]?.url.endsWith('/wiki/wikInsight'), 'a page is found by its name');
    const one = await tool(alex.token, 'search_lark_docs', { query: '日报', limit: 1 }) as Found;
    check(one.results.length === 1 && one.total === 2, 'limit keeps the first results and says how many there are');
    check(String((await tool(alex.token, 'search_lark_docs', { query: '  ' })).error).length > 0, 'an empty search is refused');
    await connect(alex.jar);
    check(lark.scopesAsked.split(' ').includes('search:docs:read'), 'reconnecting Lark keeps searching');
  }

  // ---------------------------------------------------------------- people pull their own data from Metabase
  {
    type Conn = { id: string; sql?: boolean; config?: unknown };
    const conns = (await tool(bob.token, 'list_connections')) as { connections: Conn[] };
    check(conns.connections.some((c) => c.id === 'metabase' && c.sql) && conns.connections.every((c) => c.config === undefined), 'anyone sees the data connections, without their settings');
    const browsed = await tool(bob.token, 'browse_connection', { connection: 'metabase' }) as { items: { id: string }[]; databases: { id: string; name: string }[] };
    check(browsed.items.some((x) => x.id === '232') && browsed.databases[0]?.id === '2', 'and browses what it can read, with the databases SQL can run on');
    check(String((await tool(bob.token, 'save_data_source', { id: 'bob-signups', title: { 'zh-CN': '新增', en: 'Sign-ups' }, connection: 'metabase', item: '232', audience: { company: true } })).error).includes('admin'),
      'sharing what is read through the key is for admins');
    check((await tool(bob.token, 'save_data_source', { id: 'bob-q', title: { 'zh-CN': '新增', en: 'Sign-ups' }, connection: 'metabase', item: '232' })).saved === true, 'a member registers a Metabase question for themselves');
    const sqlBad = await tool(bob.token, 'save_data_source', { id: 'bob-bad', title: { en: 'x' }, connection: 'metabase', database: '2', sql: "select 1; delete from orders" });
    check(String(sqlBad.error).length > 0 && !lark.mbSql.some((q) => /delete/i.test(q)), 'SQL that is more than one SELECT is refused before Metabase sees it');
    check(String((await tool(bob.token, 'save_data_source', { id: 'bob-bad', title: { en: 'x' }, connection: 'metabase', database: '2', sql: 'update orders set amount = 0' })).error).length > 0, 'and so is SQL that writes');
    check(String((await tool(bob.token, 'save_data_source', { id: 'bob-bad', title: { en: 'x' }, connection: 'metabase', database: '2', sql: "select $$'$$, x from (with d as (delete from orders returning 1) select 1) z --'" })).error).length > 0
      && !lark.mbSql.some((q) => /delete/i.test(q)), 'quoting that one database reads differently cannot hide a write');
    check((await tool(bob.token, 'save_data_source', { id: 'bob-orders', title: { 'zh-CN': '我的订单', en: 'My orders' }, connection: 'metabase', database: '2', sql: 'select customer, amount from orders' })).saved === true,
      'a read-only SELECT becomes a data source');
    const sum = await tool(bob.token, 'query_data', { source: 'bob-orders', query: { measure: { op: 'sum', field: 'amount' } } }) as { stat: { value: number } };
    check(sum.stat.value === 16, 'and is queried like any other source');
    check((await tool(bob.token, 'save_data_source', { id: 'bob-big', title: { en: 'Big' }, connection: 'metabase', database: '2', sql: 'select k from big' })).saved === true
      && (await tool(bob.token, 'read_data_rows', { source: 'bob-big', limit: 1 }) as { total: number }).total === 2500, 'more rows than a regular query returns come through the export');
    const aliceSees = (await tool(alice.token, 'list_data_sources')) as { sources: { id: string }[] };
    check(!aliceSees.sources.some((x) => x.id === 'bob-orders') && !!(await tool(alice.token, 'read_data_rows', { source: 'bob-orders' })).error, "it is the member's own: colleagues neither see nor read it");
    const sharedSrc = await tool(alex.token, 'set_data_source_audience', { id: 'bob-orders', audience: { company: true } });
    check(!sharedSrc.error && !(await tool(alice.token, 'read_data_rows', { source: 'bob-orders' })).error, 'an admin shares it with the company');
    await tool(bob.token, 'save_data_source', { id: 'bob-orders', title: { 'zh-CN': '我的订单', en: 'My orders' }, connection: 'metabase', database: '2', sql: 'select customer, amount from orders where amount > 1' });
    check(!!(await tool(alice.token, 'read_data_rows', { source: 'bob-orders' })).error, 'when its owner changes what it reads, it is private again until an admin looks');
    await tool(alex.token, 'set_data_source_audience', { id: 'bob-orders', audience: {} });
    await tool(bob.token, 'save_data_source', { id: 'bob-orders', title: { 'zh-CN': '我的订单', en: 'My orders' }, connection: 'metabase', database: '2', sql: 'select customer, amount from orders' });

    // ---------------------------------------------------------------- everyone's own boards
    const ownLayout = { modules: [{ type: 'note', body: { 'zh-CN': '我的笔记', en: 'My note' } }, { type: 'stats', items: [{ label: { 'zh-CN': '金额', en: 'Amount' }, source: { data: 'bob-orders', query: { measure: { op: 'sum', field: 'amount' } } } }] }] };
    check(String((await tool(bob.token, 'save_board', { id: 'bob-board', title: { 'zh-CN': '我的', en: 'Mine' }, layout: ownLayout })).error).includes('scope'), 'a member asking for a company board is told to make their own');
    const own = await tool(bob.token, 'save_board', { id: 'bob-board', title: { 'zh-CN': '我的看板', en: 'My board' }, scope: 'me', layout: ownLayout }) as { saved: boolean; scope: string; url: string };
    check(own.saved && own.scope === 'me' && own.url.endsWith('/data?board=bob-board'), 'anyone builds a board of their own');
    type B = { id: string; scope: string; mine?: boolean; owner?: { name: string }; share?: { company: boolean }; layout: { modules: { type: string }[] } };
    const bobList = (await api(bob.jar, 'GET', '/boards')).body.boards as B[];
    check(bobList.find((b) => b.id === 'bob-board')?.mine === true && bobList.find((b) => b.id === 'bob-board')?.layout.modules.length === 2, 'it is on their Data page');
    check(!((await api(alice.jar, 'GET', '/boards')).body.boards as B[]).some((b) => b.id === 'bob-board') && !((await api(alex.jar, 'GET', '/boards')).body.boards as B[]).some((b) => b.id === 'bob-board'),
      'nobody else sees it, admins included');
    check(String((await tool(alice.token, 'save_board', { id: 'bob-board', title: { en: 'x' }, scope: 'me', layout: ownLayout })).error).length > 0
      && String((await tool(alice.token, 'delete_board', { id: 'bob-board' })).error).length > 0, "others can neither take its id nor delete it");
    const shared = await tool(bob.token, 'share_board', { id: 'bob-board', share: { people: ['alice@example.com'] } }) as { sharedWith: { people?: string[] } };
    check(shared.sharedWith.people?.length === 1, 'its owner shares it with a colleague');
    const aliceBoard = ((await api(alice.jar, 'GET', '/boards')).body.boards as B[]).find((b) => b.id === 'bob-board');
    check(aliceBoard?.owner?.name !== undefined && !aliceBoard?.mine && !aliceBoard?.share, 'who it is shared with sees it, with whose it is (but not whom else it is shared with)');
    check(aliceBoard?.layout.modules.map((m) => m.type).join() === 'note', "a module on the owner's own data stays hidden for them");
    check(String((await tool(alex.token, 'share_board', { id: 'company-sales', share: { company: true } })).error).length > 0, 'company and department boards are not shared this way');
    await tool(bob.token, 'share_board', { id: 'bob-board', share: {} });
    check(!((await api(alice.jar, 'GET', '/boards')).body.boards as B[]).some((b) => b.id === 'bob-board'), 'sharing with nobody makes it private again');

    // ---------------------------------------------------------------- combining two sources (admins turn it on)
    await tool(bob.token, 'save_data_source', { id: 'bob-tiers', title: { 'zh-CN': '客户分级', en: 'Tiers' }, connection: 'metabase', database: '2', sql: 'select customer, tier from tiers' });
    const joinDef = { sources: ['bob-orders', 'bob-tiers'], mode: 'join', on: [{ left: 'customer', right: 'customer' }] };
    check(String((await tool(bob.token, 'save_data_source', { id: 'bob-joined', title: { en: 'Joined' }, combine: joinDef })).error).includes('admin'), 'combining is off until an admin turns it on');
    check((await api(bob.jar, 'POST', '/admin/data-combine', { on: true })).status >= 400, 'only admins switch it');
    check((await api(alex.jar, 'POST', '/admin/data-combine', { on: true })).body.on === true, 'an admin turns combining on');
    check((await tool(bob.token, 'save_data_source', { id: 'bob-joined', title: { 'zh-CN': '订单和分级', en: 'Orders with tiers' }, combine: joinDef })).saved === true, 'then two sources are joined on a field');
    const joined = await tool(bob.token, 'read_data_rows', { source: 'bob-joined', sort: { field: 'amount', desc: true } }) as { total: number; rows: Record<string, string>[] };
    check(joined.total === 3 && joined.rows.map((r) => `${r.customer}:${r.tier ?? ''}`).join() === 'c1:A,C2 :B,c3:', 'every left row stays, matched ignoring case and spaces');
    const byTier = await tool(bob.token, 'query_data', { source: 'bob-joined', query: { measure: { op: 'sum', field: 'amount' }, groupBy: 'tier' } }) as { rows: { key: string; value: number }[] };
    check(byTier.rows.some((r) => r.key === 'A' && r.value === 10) && byTier.rows.some((r) => r.key === 'B' && r.value === 5), 'and is charted by fields of either side');
    await tool(bob.token, 'save_data_source', { id: 'bob-inner', title: { en: 'Inner' }, combine: { ...joinDef, how: 'inner' } });
    check((await tool(bob.token, 'read_data_rows', { source: 'bob-inner' }) as { total: number }).total === 2, 'an inner join drops rows without a match');
    await tool(bob.token, 'save_data_source', { id: 'bob-stacked', title: { en: 'Stacked' }, combine: { sources: ['bob-orders', 'bob-tiers'], mode: 'union', label: 'from' } });
    const stacked = await tool(bob.token, 'read_data_rows', { source: 'bob-stacked', fields: ['customer', 'from'] }) as { total: number; rows: Record<string, string>[] };
    check(stacked.total === 5 && new Set(stacked.rows.map((r) => r.from)).size === 2, 'two sources are stacked, saying where each row came from');
    check(String((await tool(bob.token, 'save_data_source', { id: 'bob-nested', title: { en: 'x' }, combine: { sources: ['bob-joined', 'bob-tiers'], mode: 'union' } })).error).length > 0, 'a combined source is not combined again');
    check(String((await tool(bob.token, 'save_data_source', { id: 'bob-nokey', title: { en: 'x' }, combine: { sources: ['bob-orders', 'bob-tiers'], mode: 'join', on: [{ left: 'customer', right: 'nope' }] } })).error).includes('nope'), 'join fields are checked');
    check(!!(await tool(alice.token, 'read_data_rows', { source: 'bob-joined' })).error, 'whoever cannot read a part cannot read the combination');
    check(String((await tool(bob.token, 'delete_data_source', { id: 'bob-tiers' })).error).includes('bob-'), 'a part cannot be deleted while a combination uses it');
    await api(alex.jar, 'POST', '/admin/data-combine', { on: false });
    check(String((await tool(bob.token, 'read_data_rows', { source: 'bob-joined' })).error).length > 0, 'turning combining off stops combined sources');
    await api(alex.jar, 'POST', '/admin/data-combine', { on: true });
    for (const id of ['bob-joined', 'bob-inner', 'bob-stacked']) await tool(bob.token, 'delete_data_source', { id });
  }

  if (KEEP) {
    // leave a demo running for screenshots: Alex connected with a full home page and a firing alert
    await connect(alex.jar);
    const minutes = (n: number) => ({ timestamp: String(Math.floor(Date.now() / 1000) + n * 60), timezone: 'UTC' });
    await api(alex.jar, 'POST', '/admin/services', { id: 'metabase', name: 'Metabase', connection: 'metabase', create: true, disabledTools: ['question_write'] });
    await api(alex.jar, 'POST', '/admin/ai', { preset: 'aisa', key: 'sk-good' });
    fsDb.prepare("UPDATE departments SET leader_ids = '[\"ou_dev_alex\"]' WHERE id = 'od-growth'").run();
    fsDb.prepare("INSERT OR REPLACE INTO departments (id, name, parent_id, leader_ids, updated_at) VALUES ('od-sea', '东南亚', 'od-growth', '[]', 0)").run();
    for (const [u, d] of [['ou_dev_alex', 'od-growth'], ['ou_dev_bob', 'od-growth'], ['ou_dev_bob', 'od-sea']]) fsDb.prepare('INSERT OR IGNORE INTO user_departments (user_id, department_id) VALUES (?, ?)').run(u, d);
    await tool(alex.token, 'save_homepage', { scope: 'department', department_id: 'od-growth', layout: { modules: [{ type: 'note', title: { 'zh-CN': '本周重点', en: 'This week' }, body: { 'zh-CN': '……', en: '…' } }, { type: 'agenda' }, { type: 'apps' }, { type: 'requests' }] } });
    await tool(alex.token, 'save_board', { id: 'growth-weekly', title: { 'zh-CN': '增长周报', en: 'Growth weekly' }, scope: 'department', department_id: 'od-growth', layout: { modules: [{ type: 'note', body: { 'zh-CN': '……', en: '…' } }] } });
    const demoApp = await loginToApp('invoice', alex.jar);
    for (let i = 0; i < 3; i++) await appFetch('invoice', '/__hub/ai/v1/chat/completions', demoApp, { 'content-type': 'application/json' }, 'POST', JSON.stringify({ model: 'gpt-x', messages: [] }));
    await appFetch('invoice', '/__hub/ai/apis/v1/twitter/user/info?userName=aisa', demoApp);
    for (const [ua, label] of [['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0', '公司台式机'], ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36', '']]) {
      const tok = (await (await fetch(`${HUB}/api/tokens`, { method: 'POST', headers: { cookie: alex.jar.header(), 'content-type': 'application/json', 'user-agent': ua }, body: '{"name":"Codex"}' })).json() as { token: string }).token;
      await fetch(`${HUB}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'codex-mcp-client/0.163.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) });
      const id = ((await api(alex.jar, 'GET', '/profile')).body.agents as { id: string; name: string }[]).find((a) => a.name === 'Codex')!.id;
      if (label) await api(alex.jar, 'POST', `/agents/${encodeURIComponent(id)}/label`, { label });
    }
    await tool(bob.token, 'save_data_source', { id: 'bob-joined', title: { 'zh-CN': '订单和客户分级', en: 'Orders with tiers' }, combine: { sources: ['bob-orders', 'bob-tiers'], mode: 'join', on: [{ left: 'customer', right: 'customer' }] } });
    await tool(bob.token, 'save_board', { id: 'bob-board', title: { 'zh-CN': '我的客户', en: 'My customers' }, scope: 'me', layout: { modules: [
      { type: 'stats', items: [{ label: { 'zh-CN': '订单金额', en: 'Amount' }, source: { data: 'bob-orders', query: { measure: { op: 'sum', field: 'amount' } } } }, { label: { 'zh-CN': '客户数', en: 'Customers' }, source: { data: 'bob-joined', query: { measure: { op: 'count' } } } }] },
      { type: 'chart', kind: 'bar', width: 'half', title: { 'zh-CN': '各分级金额', en: 'Amount by tier' }, source: { data: 'bob-joined', query: { measure: { op: 'sum', field: 'amount' }, groupBy: 'tier' } } },
      { type: 'table', width: 'half', title: { 'zh-CN': '订单', en: 'Orders' }, source: { data: 'bob-joined' } },
    ] } });
    lark.calendarExtra.push(
      { event_id: 'e-now', summary: '产品评审', start_time: minutes(-20), end_time: minutes(25), status: 'confirmed', vchat: { meeting_url: 'https://vc.larksuite.com/j/9' }, attendees: [{ type: 'resource', display_name: '会议室 B' }], event_organizer: { display_name: 'Alex L' } },
      { event_id: 'e-soon', summary: 'Tether 支付对接', start_time: minutes(35), end_time: minutes(80), status: 'confirmed', vchat: { meeting_url: 'https://vc.larksuite.com/j/10' }, event_organizer: { display_name: 'Bo' } },
      { event_id: 'e-tmr', summary: '增长周会', start_time: minutes(24 * 60 + 30), end_time: minutes(24 * 60 + 90), status: 'confirmed', event_organizer: { display_name: 'Alex L' } },
      { event_id: 'e-tmr2', summary: '客户回访', start_time: minutes(24 * 60 + 180), end_time: minutes(24 * 60 + 210), status: 'confirmed' },
      { event_id: 'e-d3', summary: '全员会', start_time: minutes(3 * 24 * 60), end_time: minutes(3 * 24 * 60 + 60), status: 'confirmed', location: { name: '大会议室' } },
    );
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
      { type: 'agenda' },
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
      { type: 'agenda', width: 'half' },
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
