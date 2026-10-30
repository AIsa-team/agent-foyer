import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { appUrl, config, version as hubVersion } from './config.ts';
import { messenger } from './notify.ts';
import { all, get, run, type User } from './db.ts';
import { sha256 } from './crypto.ts';
import * as apps from './apps/service.ts';
import * as skills from './skills/service.ts';
import * as lib from './library.ts';
import * as homepage from './homepage.ts';
import * as dataSources from './data/sources.ts';
import * as alerts from './data/alerts.ts';
import { querySchema, toStat, type Query } from './data/query.ts';
import * as checks from './data/checks.ts';
import * as feedback from './feedback.ts';
import * as collab from './collab.ts';
import { githubEnabled } from './github/app.ts';
import { githubActivity } from './github/activity.ts';
import { githubConnectUrl } from './github/link.ts';
import * as boards from './boards.ts';
import { createUpload, type UploadPurpose } from './uploads.ts';
import { tr, UserError, type Msg } from './i18n/index.ts';
import { localeCodes, type LocalizedMap } from './localized.ts';
import { appGuide } from './appGuide.ts';
import { aiStatus } from './ai.ts';
import { sourceDownload } from './apps/source.ts';
import * as agentActions from './apps/agentActions.ts';
import * as appRequests from './requests.ts';
import * as services from './services/index.ts';
import * as connectors from './data/connectors/index.ts';
import { importBoard } from './data/importBoard.ts';
import { larkAppTools, larkDataTools, larkWorkTools, type ToolKit } from './lark/tools.ts';

const LARK = config.lark.enabled;
// where hub.lark.mailDraft puts drafts on this hub (Gmail or Lark Mail), so agents describe it right
const MESSAGES = !!messenger;

const INSTRUCTIONS = `This is the ${config.companyName} company hub (colleagues also call it 中台 or 公司中台; "publish to the hub / 发布到中台" means this server). It lets the user publish web apps to the company server and share/install Skills. When the user mentions the hub, use these tools; do not ask for its address.

Language: the team is multilingual and the hub UI is shown in ${localeCodes().join(', ')}. Always talk to the user in the language they use with you.
Whenever you publish or update an app or a Skill, pass \`localized\` with a short display name and a one-sentence description for EVERY hub language (${localeCodes().join(', ')}), translating them yourself, so colleagues see the listing in their own language. Do not ask the user to translate; just show them the names you chose. Only this listing text is translated: never translate the Skill content (SKILL.md) or the app itself. Hub messages you receive (errors, notes) are already in the user's hub language.

Building or changing an app (e.g. "make an app that…", "publish this project to the company server"): call app_guide first and follow it; it has the steps, the hub SDK and the report format. The core of it:
- Look before building: if one of the user's apps (list_my_apps) already does this, improve it, starting from its feedback (list_feedback) and the code of its live version (get_app_source).
- Decide the defaults yourself (name in every hub language, subdomain, icon) and keep a new app private to the user unless they said who should use it.
- AI models and data APIs come from the hub (/__hub/ai, no key in the app) when an admin set a provider; ai_resources says what is there. Ask only what you cannot decide; if you work unattended, write open questions into your report instead of stopping.
${LARK ? `- Business data lives in Lark, never only in the app: a table the user named, or a Base you create (create_lark_base, typed columns). Documents the app produces are Lark documents. The app's own storage is for technical state only.
- The app reaches Lark only through the hub SDK as the person using it (/__hub/sdk.js, declared with set_app_lark). No Lark tokens, no own login.
` : `- Business records live in the app's own server storage ($DATA_DIR in a container app), never only in the browser. No own login: the hub signs people in.
`}${config.designSkills.length ? `- The interface uses the company design system: install_skill ${config.designSkills.join(', ')} and build from its kit and templates, no other UI library.
` : ''}- Check it works (locally against a fake hub, then get_app_status), without writing test data into real tables or mailboxes, and end with the short report app_guide describes.
Using apps: colleagues' apps offer operations to agents: finding, adding and changing records in their Lark tables (<table>.find / .add / .update) and their own actions (e.g. create a quote). When the user wants something done in one of the company's apps, or asks for something an app may already do, list_apps (query by topic), then list_apps with app for the arguments, and call_app; never reach an app's URLs or its Lark tables another way. Operations with write: true change data: say what you will do and call after the user agrees, unless they asked beforehand for it to be done without asking; then tell them afterwards what was done. If call_app says the user must first agree to the app's Lark access, give them the link.
App requests (需求): colleagues post apps they need, invite someone to build one, or leave it in the pool for whoever has time. When the user needs an app built by someone else ("帮我提个需求", "ask someone to make…"), create_app_request (after checking list_app_requests and list_apps for one that exists, and after the user agrees to the text). When they want to help or build a request ("做需求 #12"), get_app_request, take it, follow app_guide, and publish_app with request_id.
Other services: the company can reach other tools it uses through the hub (e.g. Linear, to read and change issues; Metabase, to search and query company data), mostly each person with their own account there; a service marked shared is reached with one company credential and needs no connecting. When the user wants something done in one of them, list_connected_tools, then call_connected_tool; if they have not connected their account, give them the link it returns.
Feedback on apps and Skills: colleagues leave it on the hub page, with the 「feedback」 button inside every app, or through their agent. When the user asks to improve one of their apps or Skills (or what people said), list_feedback, change and republish, then resolve_feedback each item with a short reply. When they hit a problem with someone else's app or Skill, draft it with send_feedback and send only after they agree with the text.
Working together: an app or Skill can have collaborators (set_collaborators). They publish and change settings like the owner; only the owner (or an admin) deletes it, changes collaborators or hands it over (transfer_ownership). If a slug or Skill name belongs to someone else, suggest asking them to add the user as a collaborator.
Never put secrets in an upload; use set_app_env for API keys.

Sharing a Skill: if it has no icon, draw a simple square SVG icon and pass icon_svg. The folder must have SKILL.md at its root with frontmatter "name" (lowercase-hyphen) and "description". create_upload(purpose="skill"), upload the folder contents, then publish_skill with localized market names/descriptions for every hub language. Republishing the same name creates a new version. To change only the market text later, use update_skill.
${LARK ? `Lark data (Base tables): the hub reads Lark Base with each person's own Lark access, so everyone only sees rows they could open in Lark. If a tool says Lark data is not connected, give the user the link it returns (they approve once in Lark) and continue after they confirm.\n` : ''}
Company numbers (sign-ups, revenue, usage, orders…): when the user asks about them, look in the hub first: list_data_sources, then query_data for totals and trends or read_data_rows for the records themselves. Everything is read with the user's own access, so say so plainly when a source exists but they may not see it, and never work around it.
To chart data: register it once as a data source (${LARK ? 'a Lark Base table: inspect_base(url) to see its tables and fields; ' : ''}a data app: see below), save_data_source with a short id and a title in every hub language, then try query_data until the numbers look right, then put it on a home page (chart/stats module with source {data: <id>, query}) via preview_homepage. Use count / sum / avg with groupBy for breakdowns and date {field, bucket, last} for trends; stats tiles with date get the trend and the change vs the previous bucket automatically (add date.complete: true so the current, unfinished period is not compared with a full one; the tile's period text is just "last month" / "上月").
Data apps: ${LARK ? 'data that is not in Lark Base' : 'company data'} (Metabase, a database, a CRM, another SaaS) comes in through a small hub app the user's agent builds and publishes like any other app. The app answers GET <path> with JSON {"rows": [{...}, ...]} (or a bare array): one flat object per row; dates as ISO strings ("2026-07-20T06:32:29Z") or ms timestamps, numbers as numbers. Optional per row: "_id" (unique and stable; needed for data checks) and "_url" (link to the row in its own system). Optional top level "fields": [{"name", "type": "text|number|date|person|select|multi|checkbox"}] when inference is not enough. Put a person's name or email in a normal field (e.g. "owner") to assign data-check issues. Keep credentials in set_app_env, cache upstream results for a few minutes, and keep rows under ~50k. Visibility of the app = who may see its data: the hub fetches as the viewer (X-Hub-User-* headers) and only for people allowed to open the app. Then inspect_app_data, save_data_source with app + path, and use it like any other data source.
Data connections: systems the hub reads itself, set up by admins on the admin page with their key (today: Metabase). When one exists, anyone registers what they need with save_data_source instead of building a data app: one of its items (connection + item, see browse_connection) or a read-only SQL query (connection + database + sql). A source someone registers is theirs: only they and admins see it until an admin shares it (set_data_source_audience). For a system with no connection, build a data app.
Combining (only if an admin turned it on; save_data_source says so otherwise): a data source can be made of two others (save_data_source with combine): joined on matching fields (e.g. orders from Metabase with the customer tiers in someone's Lark table, on the customer id) or stacked (the same columns from two places). Each part is read as the viewer, so it never shows anyone more than its parts would. Check the parts' fields first (read_data_rows), then read_data_rows on the result before charting it.

Boards: the Data page holds boards for the whole company or a department (save_board), and each person's own boards (save_board with scope "me", any number, private unless they share them with colleagues, departments or the company); all are built from the same modules as home pages and every number is read as the viewer. Use company and department boards for numbers a team looks at together, someone's own boards for what they put together for themselves, and the home page for their day-to-day view.
Data quality ("异常项"): the hub can check data sources for records that need fixing. When asked to clean up a table, look at it first (${LARK ? 'inspect_base / ' : ''}inspect_app_data), then work out the business rules with the user: contradictions (paid but no payment date), missing values (signed but no payment method), stale rows (in progress but untouched for 14 days), duplicates (same project twice) and the same value written differently. List the rules for the user to confirm, then save_check each one (it runs at once and shows a sample; tune until the sample is right). Levels: error = definitely wrong, verify = a human must confirm, style = written inconsistently. Set owner_field to the field naming whoever must fix the record (a person field, or names / emails): they see their issues on the issues page and their home page (module {type: "issues"}). Checks rerun every few hours.
${LARK ? `Lark documents: search_lark_docs finds documents and wiki pages by keyword (only what the user may open); read_lark_doc reads one as Markdown (tables: true adds each table cell by cell, with ids); edit_lark_doc changes the text of cells and paragraphs by those ids or adds Markdown at the end; list_lark_wiki lists the pages under a wiki page (e.g. to find one by its title); create_lark_doc writes Markdown into a new document the user owns (their own space, or under a wiki page / in a folder they give). All of it is done as the user, with their own Lark access. The first time the user writes, they are asked once to let the hub create and edit documents.\n` : ''}${LARK ? `Calendar: list_calendar_events reads the user's own Lark calendar (read-only), e.g. "what meetings do I have this afternoon" or the meetings of a day for a daily report. The first time, the user is asked once to allow reading their calendar. Lark itself reminds people before events; the hub cannot create or change events. The agenda home module {type: "agenda"} shows each viewer their own day.\n` : ''}${LARK ? `Messages: send_lark_message sends a Lark message as the user to colleagues (e.g. "tell Alex the meeting moved to three"), once the user turned it on on their Me page. It is two steps: a preview with a code, then sending with that code after the user agreed to exactly that text and those recipients.\n` : ''}${LARK ? `OKRs: the company tracks goals in Lark OKR. get_okrs reads them with the user's Lark access (default: their own, current period). To show them on a home page, add a module {type: "okr"}; without \`user\` everyone sees their own, so it suits department and company layouts.\n` : ''}
Alerts: save_alert_rule watches one number (a query without groupBy) against a condition (above / below a threshold, or a drop / rise vs the previous date bucket). It is checked on a schedule as its creator and shows on the recipients' home pages (alerts module)${MESSAGES ? `; when it starts or stops firing the hub bot also messages them${LARK ? ' (and optionally a Lark group via chat_id) in Lark' : ''}. Messages are deliberately calm: at most one per rule every few hours, none at night (held until morning), several rules combined into one message, and anyone can opt out on their home page. Unless an admin changes it, the hub only messages hub admins; other recipients see alerts on their home page` : ''}. Ask the user who should be told before saving; recipients will see the numbers, so only add people who should.
Installing a Skill: install_skill returns a download command; run it. Agents that cannot install Skills (no skills folder, e.g. hosted agents or scheduled tasks) use read_skill and follow what it says; a scheduled task that should follow a Skill names it and calls read_skill each run, so it always uses the latest version. To check for updates, read .hub-skill.json in each installed skill folder and call check_skill_updates.`;

const localizedSchema = () => z.record(z.string(), z.object({ name: z.string().optional(), description: z.string().optional() }))
  .optional()
  .describe(`Listing text per hub language. Keys must be: ${localeCodes().join(', ')}. Give every language a short name and a one-sentence description; translate them yourself. Only this listing text is translated, never the app or Skill content.`);

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

const visibility = z.enum(['private', 'members', 'company', 'public']);

function resolveColleagues(refs: string[]): string[] {
  return refs.map((r) => {
    const q = r.trim();
    const hit = all<{ id: string }>('SELECT id FROM users WHERE id = ? OR lower(email) = lower(?) OR name = ? OR en_name = ?', q, q, q, q);
    if (hit.length === 0) throw new UserError('err.colleagueNotFound', { query: q });
    if (hit.length > 1) throw new UserError('err.colleagueAmbiguous', { query: q });
    return hit[0].id;
  });
}

/**
 * What an agent sees of the hub (the instructions and every tool with its description and parameters) as a short
 * hash. Agents keep both from when they connected, often for a whole session; when the hash they connected with is
 * not the current one, tool results tell them to reconnect.
 */
const versions = new WeakMap<McpServer, string>();
export const surfaceVersion = (server: McpServer) => versions.get(server) ?? '';

export function buildMcpServer(user: User, clientId?: string): McpServer {
  const server = new McpServer({ name: config.mcpName, version: hubVersion }, { instructions: INSTRUCTIONS });
  const surface: string[] = [INSTRUCTIONS];
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, def: { description?: string; inputSchema?: z.ZodRawShape }, cb: never) => {
    let params = '';
    try {
      params = JSON.stringify(z.toJSONSchema(z.object(def.inputSchema ?? {})));
    } catch {
      params = Object.keys(def.inputSchema ?? {}).join(',');
    }
    surface.push(`${name}\u0000${def.description ?? ''}\u0000${params}`);
    return register(name, def as never, cb);
  }) as typeof server.registerTool;
  let version = '';
  // feedback sent through an agent says which one
  const agentName = (clientId && get<{ client_name: string }>('SELECT client_name FROM agent_connections WHERE user_id = ? AND client_id = ?', user.id, clientId)?.client_name) || 'Agent';
  // replies use the language this person picked in the hub UI
  const locale = user.locale ?? config.defaultLocale;
  const say = (m: Msg) => tr(locale, m.key, m.params);

  // an agent that connected to an older version of the hub is told so with every result, until it reconnects
  const staleNote = () => {
    const seen = clientId ? get<{ seen_version: string | null }>('SELECT seen_version FROM agent_connections WHERE user_id = ? AND client_id = ?', user.id, clientId)?.seen_version : null;
    return seen && version && seen !== version ? [{ type: 'text' as const, text: say({ key: 'note.hubUpdated' }) }] : [];
  };
  function guard<A>(fn: (args: A) => Promise<unknown> | unknown) {
    return async (args: A) => {
      try {
        const out = json(await fn(args));
        return { ...out, content: [...out.content, ...staleNote()] };
      } catch (e) {
        const known = e instanceof UserError;
        if (!known) console.error('[mcp] tool error', e);
        const text = known ? e.localized(locale) : tr(locale, 'err.internal', { message: (e as Error).message });
        return { content: [{ type: 'text' as const, text }], isError: true };
      }
    };
  }
  // what the Lark tools (server/lark/tools.ts) need from this server
  const kit: ToolKit = { server, user, locale, guard, resolveColleagues };

  server.registerTool('whoami', { description: 'Who the hub thinks you are, and the app domain.' }, guard(() => ({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    hub: config.hubUrl,
    appsDomain: config.appsDomain,
    version,
  })));

  server.registerTool('create_upload', {
    description: 'Get a one-time upload URL (valid 30 min) and the shell command to upload a project folder as a .tar.gz.',
    inputSchema: { purpose: z.enum(['app', 'skill', 'source']).describe('source: the project folder an app is built from, passed to publish_app as source_upload_id') },
  }, guard(({ purpose }: { purpose: UploadPurpose }) => {
    const up = createUpload(user.id, purpose);
    return {
      upload_id: up.id,
      upload_url: up.url,
      command: `tar --exclude=node_modules --exclude=.git --exclude='.env*' --exclude=.DS_Store -czf /tmp/${up.id}.tgz -C <FOLDER> . && curl -fsS -X PUT --data-binary @/tmp/${up.id}.tgz '${up.url}' && rm /tmp/${up.id}.tgz`,
      // Windows 10+ ships tar.exe and curl.exe; plain `curl` in Windows PowerShell is Invoke-WebRequest, so name the .exe
      command_windows_powershell: `$f = "$env:TEMP\\${up.id}.tgz"; tar.exe --exclude=node_modules --exclude=.git --exclude='.env*' -czf $f -C "<FOLDER>" .; if ($LASTEXITCODE -eq 0) { curl.exe -fsS -X PUT --data-binary "@$f" "${up.url}" }; Remove-Item $f -ErrorAction SilentlyContinue`,
      note: 'Use `command` on macOS/Linux (or Git Bash/WSL), `command_windows_powershell` in PowerShell on Windows. Replace <FOLDER> with the folder to upload (for static sites: the build output; for source: the project folder). Then call '
        + (purpose === 'skill' ? 'publish_skill with upload_id.' : purpose === 'source' ? 'publish_app with it as source_upload_id.' : 'publish_app with upload_id.'),
    };
  }));

  server.registerTool('check_slug', {
    description: `Check whether a subdomain is free (<slug>.${config.appsDomain}). Your own existing apps count as available (publishing updates them).`,
    inputSchema: { slug: z.string() },
  }, guard(({ slug }: { slug: string }) => {
    const r = apps.slugAvailable(slug.toLowerCase(), user);
    return { ok: r.ok, reason: r.reason && say(r.reason), url: appUrl(slug.toLowerCase()), existingAppOfYours: !!apps.getApp(slug.toLowerCase()) && r.ok };
  }));

  server.registerTool('find_colleagues', {
    description: 'Search company colleagues by name or email (for members access).',
    inputSchema: { query: z.string() },
  }, guard(({ query }: { query: string }) => all(
    `SELECT id, name, en_name, email FROM users WHERE name LIKE ? OR en_name LIKE ? OR email LIKE ? ORDER BY name LIMIT 20`,
    `%${query}%`, `%${query}%`, `%${query}%`,
  )));

  server.registerTool('ai_resources', {
    description: 'Whether apps on this hub can use AI models (and data APIs) through /__hub/ai without a key of their own: the provider, every model it offers, whether data APIs are there, the daily limits, and how to call it. See app_guide for using it in an app.',
  }, guard(() => {
    const s = aiStatus();
    return s.configured ? { ...s, models: s.models, call: { models: '/__hub/ai/v1/chat/completions (OpenAI-compatible)', ...(s.dataApis ? { dataApis: '/__hub/ai/apis/v1/<provider>/<endpoint>' } : {}) } }
      : { configured: false, hint: 'An admin sets an AI provider on the admin page (AI resources).' };
  }));

  server.registerTool('app_guide', {
    description: 'How to build, publish and report on an app on this hub, step by step (data, interface, hub SDK, checks, report). Call it before building or changing an app.',
  }, guard(() => ({ guide: appGuide() })));

  server.registerTool('publish_app', {
    description: 'Publish (or update) an app from an upload. First publish needs name. Choose name, subdomain and icon yourself unless the user gave them; a new app is private unless visibility says otherwise. Follow app_guide.',
    inputSchema: {
      upload_id: z.string(),
      slug: z.string().describe('subdomain, lowercase letters/digits/hyphens'),
      kind: z.enum(['static', 'container']),
      name: z.string().optional().describe('display name, any language'),
      description: z.string().optional().describe('one sentence, in the user\'s language'),
      visibility: visibility.optional().describe('private | members | company | public; defaults to private for new apps'),
      members: z.array(z.string()).optional().describe('colleague emails, names or ids when visibility = members'),
      static_dir: z.string().optional().describe('folder inside the upload that contains index.html (auto-detected if omitted)'),
      container_port: z.number().int().optional().describe('port the container listens on, default 3000'),
      icon_svg: z.string().optional(),
      icon_png_base64: z.string().optional(),
      localized: localizedSchema(),
      related_skill: z.string().optional().describe('optional: slug of the Skill that goes with this app (most apps have none; "" removes the link)'),
      source_upload_id: z.string().optional().describe('when the upload is a build (e.g. dist), an upload (purpose "source") of the project folder it was built from, so the app can be changed later on any machine'),
      request_id: z.number().int().optional().describe('the app request (需求) this app answers: once the app is online the request is marked done, the requester becomes a collaborator and everyone who asked is told'),
    },
  }, guard(async (a: {
    upload_id: string; slug: string; kind: 'static' | 'container'; name?: string; description?: string; visibility?: apps.Visibility;
    members?: string[]; static_dir?: string; container_port?: number; icon_svg?: string; icon_png_base64?: string; localized?: LocalizedMap; related_skill?: string; source_upload_id?: string;
    request_id?: number;
  }) => {
    const r = await apps.publishApp(user, {
      uploadId: a.upload_id, slug: a.slug, kind: a.kind, name: a.name, description: a.description, visibility: a.visibility,
      memberIds: a.members ? resolveColleagues(a.members) : undefined, staticDir: a.static_dir, containerPort: a.container_port,
      iconSvg: a.icon_svg, iconPngBase64: a.icon_png_base64, localized: a.localized, relatedSkill: a.related_skill, sourceUploadId: a.source_upload_id,
    });
    const notes = r.notes.map(say);
    if (a.request_id !== undefined) {
      if (r.status === 'online') {
        const d = await appRequests.deliverFromPublish(user, a.request_id, r.slug, locale);
        notes.push(`Request #${a.request_id} is done; the requester and everyone who asked for it were told.`, ...d.notes);
      } else notes.push(`Request #${a.request_id} is not marked done yet: once the app is online, call update_app_request with action "deliver".`);
    }
    return { ...r, notes };
  }));

  server.registerTool('get_app_status', {
    description: 'Status, recent releases with build logs, and runtime logs of one of your apps.',
    inputSchema: { slug: z.string() },
  }, guard(({ slug }: { slug: string }) => apps.appStatus(user, slug, locale)));

  server.registerTool('get_app_source', {
    description: 'Download command for the code of an app\'s live version (owner, collaborators and admins), to change an app you did not build on this machine. Start from it instead of an old local copy.',
    inputSchema: { slug: z.string() },
  }, guard(({ slug }: { slug: string }) => sourceDownload(apps.requireManageable(slug, user))));

  server.registerTool('list_my_apps', { description: 'Apps you own or collaborate on (myRole says which).' }, guard(() =>
    apps.listAppsFor(user, locale).filter((a) => a.myRole)));

  server.registerTool('list_apps', {
    description: 'Apps the user may open, and the operations an agent can take in each (call_app). Pass app for that app\'s operations with their input schemas (table columns, select options); query narrows the list by words in names, descriptions and operations.',
    inputSchema: { query: z.string().optional(), app: z.string().optional().describe('slug of one app') },
  }, guard((a: { query?: string; app?: string }) => agentActions.listUsableApps(user, locale, { query: a.query, slug: a.app })));

  server.registerTool('call_app', {
    description: 'Take one operation an app offers to agents (see list_apps), as the user and with their access: <table>.find / .add / .update on the app\'s Lark tables, or one of its own actions (the app sees who you act for and that an agent made the call). Operations with write: true change data: tell the user what you will do and call after they agree, unless they asked beforehand for it to be done without asking. Returns what the table or the app answered.',
    inputSchema: {
      app: z.string().describe('slug'),
      action: z.string(),
      input: z.record(z.string(), z.unknown()).optional().describe('arguments, as the action\'s input schema describes'),
    },
  }, guard((a: { app: string; action: string; input?: Record<string, unknown> }) => agentActions.callAction(user, a.app, a.action, a.input ?? {}, agentName)));

  server.registerTool('list_connected_tools', {
    description: 'Other services the company reaches through the hub (e.g. Linear), each with the user\'s own account there, or shared: one company credential for everyone, nothing to connect. Without service: which services the user may use and whether they connected their account (if not, give them connectUrl). With service: its tools with descriptions and input schemas; readOnly says the service marked a tool as only reading.',
    inputSchema: { service: z.string().optional().describe('service id, e.g. linear') },
  }, guard((a: { service?: string }) => services.listTools(user, a.service)));

  server.registerTool('call_connected_tool', {
    description: 'Call one tool of a connected service (see list_connected_tools) as the user, with their own account and access there. Tools not marked readOnly can change things (create, update, comment, delete): tell the user what you will do and call after they agree, unless they asked beforehand for it to be done without asking. Returns what the service answered.',
    inputSchema: {
      service: z.string(),
      tool: z.string(),
      arguments: z.record(z.string(), z.unknown()).optional().describe('as the tool\'s input schema describes'),
    },
  }, guard((a: { service: string; tool: string; arguments?: Record<string, unknown> }) => services.callTool(user, a.service, a.tool, a.arguments ?? {}, agentName)));

  server.registerTool('list_app_requests', {
    description: 'App requests (需求): apps colleagues need and want someone to build. Pool requests are open to everyone; invitations only to the people involved. status: open (waiting for someone), taken, done, closed, all; mine: the ones the user asked for, was invited to, builds or also needs; query: words in title or text.',
    inputSchema: { status: z.enum(['open', 'taken', 'done', 'closed', 'all']).optional(), mine: z.boolean().optional(), query: z.string().optional() },
  }, guard((a: { status?: appRequests.Status | 'all'; mine?: boolean; query?: string }) =>
    appRequests.listRequests(user, locale, { status: a.status ?? 'open', mine: a.mine, query: a.query }).map((r) => ({
      id: r.id, title: r.title, status: r.status, scope: r.scope, requester: r.requester?.name, invitee: r.invitee?.name, builder: r.builder?.name,
      due: r.due, alsoNeeded: r.voters.length, app: r.app?.slug ?? null, url: r.url,
    }))));

  server.registerTool('get_app_request', {
    description: 'One app request in full: what is needed and why, who asked, who else needs it (with their notes), its state and what the user may do with it (can). To build it: take it (update_app_request take), follow app_guide, and publish_app with request_id.',
    inputSchema: { id: z.number().int() },
  }, guard(({ id }: { id: number }) => appRequests.getRequest(user, id, locale)));

  server.registerTool('create_app_request', {
    description: 'Ask for an app (需求) on the user\'s behalf: put it in the pool for whoever has time (posted to the team\'s Lark group) or invite one colleague. Write it so a builder can start: the problem, who will use it, where the data is (a Lark table link…), what done looks like. First list_app_requests (query) and list_apps for something that already does it. Show the user the text and who it goes to, and submit after they agree.',
    inputSchema: {
      title: z.string().describe('short, in the user\'s language'),
      body: z.string().describe('what is needed and why, who uses it, data, what done looks like'),
      due: z.string().optional().describe('wanted by, YYYY-MM-DD'),
      invite: z.string().optional().describe('a colleague (name or email) to ask; leave out to put it in the pool'),
    },
  }, guard((a: { title: string; body: string; due?: string; invite?: string }) => appRequests.createRequest(user, {
    title: a.title, body: a.body, due: a.due ?? null, invite: a.invite ? resolveColleagues([a.invite])[0] : null, via: 'agent', agent: agentName,
  }, locale)));

  server.registerTool('update_app_request', {
    description: 'Act on an app request (see its can). take: start building it. decline: say no to an invitation. release: give it back. invite (user): ask a colleague. to_pool: open it to everyone. close (reason): no longer needed. edit (title/body/due). me_too (note): the user needs it too; not_me undoes it. deliver (app): it became this app (publish_app with request_id does it for you). The people concerned are told in Lark, so confirm with the user first.',
    inputSchema: {
      id: z.number().int(),
      action: z.enum(['take', 'decline', 'release', 'invite', 'to_pool', 'close', 'edit', 'me_too', 'not_me', 'deliver']),
      user: z.string().optional().describe('invite: name or email'),
      reason: z.string().optional(), note: z.string().optional(),
      title: z.string().optional(), body: z.string().optional(), due: z.string().optional(),
      app: z.string().optional().describe('deliver: the app slug'),
    },
  }, guard((a: { id: number; action: appRequests.Action['action']; user?: string; reason?: string; note?: string; title?: string; body?: string; due?: string; app?: string }) => {
    const act = { ...a, ...(a.action === 'invite' ? { user: resolveColleagues([a.user ?? ''])[0] } : {}) } as unknown as appRequests.Action;
    return appRequests.actOn(user, a.id, act, locale);
  }));

  server.registerTool('set_collaborators', {
    description: 'Colleagues who look after an app or Skill with its owner: they can publish new versions, change the listing, access and env, and handle feedback; deleting, choosing collaborators and handing it over stay with the owner (and admins). Added people get a Lark message. Call with neither add nor remove to see the list. Anyone can remove themselves.',
    inputSchema: {
      kind: z.enum(['app', 'skill']), slug: z.string(),
      add: z.array(z.string()).optional().describe('names or emails (see find_colleagues)'),
      remove: z.array(z.string()).optional().describe('names or emails'),
    },
  }, guard((a: { kind: 'app' | 'skill'; slug: string; add?: string[]; remove?: string[] }) => ({
    collaborators: collab.setCollaborators(user, a.kind, a.slug, { add: a.add && resolveColleagues(a.add), remove: a.remove && resolveColleagues(a.remove) }),
  })));

  server.registerTool('transfer_ownership', {
    description: 'Hand an app or Skill you own to a colleague, who becomes its owner; you stay on as a collaborator. Confirm with the user first.',
    inputSchema: { kind: z.enum(['app', 'skill']), slug: z.string(), to: z.string().describe('name or email') },
  }, guard((a: { kind: 'app' | 'skill'; slug: string; to: string }) => ({
    collaborators: collab.transferOwnership(user, a.kind, a.slug, resolveColleagues([a.to])[0]),
  })));

  server.registerTool('update_app', {
    description: 'Change the listing text (per language), name, description or icon of your app, or hide the 「feedback」 button the hub adds inside it.',
    inputSchema: {
      slug: z.string(), name: z.string().optional(), description: z.string().optional(),
      localized: localizedSchema(), icon_svg: z.string().optional(), icon_png_base64: z.string().optional(),
      related_skill: z.string().optional().describe('link this app to a Skill slug, or "" to remove the link'),
      feedback_button: z.boolean().optional().describe('show the feedback button inside the app (default true); false if the app has its own feedback'),
      agent_access: z.boolean().optional().describe('let people\'s agents take the operations in its hub-agent.json (default true)'),
    },
  }, guard((a: { slug: string; name?: string; description?: string; localized?: LocalizedMap; icon_svg?: string; icon_png_base64?: string; related_skill?: string; feedback_button?: boolean; agent_access?: boolean }) => {
    return apps.updateApp(user, a.slug, { name: a.name, description: a.description, localized: a.localized, iconSvg: a.icon_svg, iconPngBase64: a.icon_png_base64, relatedSkill: a.related_skill, feedbackButton: a.feedback_button, agentAccess: a.agent_access });
  }));

  server.registerTool('set_app_access', {
    description: 'Change who can open your app. members replaces the member list when given.',
    inputSchema: { slug: z.string(), visibility, members: z.array(z.string()).optional() },
  }, guard((a: { slug: string; visibility: apps.Visibility; members?: string[] }) => {
    apps.setVisibility(user, a.slug, a.visibility, a.members ? resolveColleagues(a.members) : undefined);
    const app = apps.getApp(a.slug)!;
    return { visibility: app.visibility, publicStatus: app.public_status };
  }));

  server.registerTool('set_app_env', {
    description: 'Set (or delete with null) environment variables for a container app, stored encrypted. Restarts the app to apply.',
    inputSchema: { slug: z.string(), vars: z.record(z.string(), z.string().nullable()) },
  }, guard(async (a: { slug: string; vars: Record<string, string | null> }) => {
    const keys = apps.setEnv(user, a.slug, a.vars);
    const app = apps.getApp(a.slug)!;
    if (app.kind === 'container' && app.current_release) await apps.restartApp(user, a.slug);
    return { keys, restarted: app.kind === 'container' && !!app.current_release };
  }));

  server.registerTool('list_feedback', {
    description: 'What colleagues said about the apps and Skills you own (bugs, missing features, confusing steps), newest first, with who said it, where from (hub page, the button inside the app, or their agent) and any details the sender added (context). Default: open items on everything you own.',
    inputSchema: {
      kind: z.enum(['app', 'skill']).optional().describe('only apps or only Skills'),
      slug: z.string().optional().describe('one app or Skill; default: all you own'),
      status: z.enum(['open', 'done', 'declined', 'all']).optional().describe('default open'),
    },
  }, guard((a: { kind?: feedback.Kind; slug?: string; status?: 'open' | 'done' | 'declined' | 'all' }) => {
    const items = feedback.feedbackToHandle(user, a);
    return { items, hint: items.length ? 'Fix what the user agrees to, publish the update, then resolve_feedback each item (the person is told).' : undefined };
  }));

  server.registerTool('send_feedback', {
    description: 'Tell the owner of an app or Skill about a problem or wish, as the user. Only after the user has seen and agreed to the exact text. The owner gets a message and the user is told when it is handled.',
    inputSchema: {
      kind: z.enum(['app', 'skill']),
      slug: z.string().describe('the app subdomain or the Skill name'),
      body: z.string().min(2).max(2000).describe("what went wrong or what is missing, in the user's language and words"),
      context: z.string().max(4000).optional().describe('details that help the owner reproduce it: what was being done, the step, error messages, the Skill version. Never secrets, tokens or private data.'),
    },
  }, guard(async (a: { kind: feedback.Kind; slug: string; body: string; context?: string }) => {
    const item = await feedback.addFeedback(user, a.kind, a.slug, { body: a.body, context: a.context, via: 'agent', agent: agentName });
    return { id: item.id, status: item.status, message: say({ key: 'note.feedbackSent' }) };
  }));

  server.registerTool('resolve_feedback', {
    description: 'Mark a feedback item done (fixed and published) or declined (will not change), with a short reply in the language the person wrote in. The person who sent it gets a message.',
    inputSchema: { id: z.number().int(), status: z.enum(['done', 'declined', 'open']), reply: z.string().max(2000).optional() },
  }, guard((a: { id: number; status: 'done' | 'declined' | 'open'; reply?: string }) => feedback.resolveFeedback(user, a.id, a.status, a.reply)));

  server.registerTool('set_app_running', {
    description: 'Stop or start your app without deleting it.',
    inputSchema: { slug: z.string(), running: z.boolean() },
  }, guard(async (a: { slug: string; running: boolean }) => {
    await apps.setRunning(user, a.slug, a.running);
    return { ok: true };
  }));

  server.registerTool('delete_app', {
    description: 'Permanently delete your app, its files and its subdomain. Only call after the user explicitly confirms.',
    inputSchema: { slug: z.string(), confirm_slug: z.string().describe('must equal slug') },
  }, guard(async (a: { slug: string; confirm_slug: string }) => {
    if (a.slug !== a.confirm_slug) throw new UserError('err.confirmSlugMismatch');
    await apps.deleteApp(user, a.slug);
    return { deleted: a.slug };
  }));

  server.registerTool('publish_skill', {
    description: 'Publish an uploaded skill folder to the company Skill market (new version if it already exists). Pass localized market text for every hub language.',
    inputSchema: {
      upload_id: z.string(),
      display_name: z.string().optional().describe('fallback market name when a language has no localized name'),
      description: z.string().optional(),
      notes: z.string().optional().describe('what changed in this version'),
      localized: localizedSchema(),
      icon_svg: z.string().optional().describe('square SVG icon for the market card (flat, one or two colours, no text)'),
      icon_png_base64: z.string().optional(),
      related_app: z.string().optional().describe('optional: slug of a hub app this Skill belongs to (most Skills have none)'),
    },
  }, guard(async (a: { upload_id: string; display_name?: string; description?: string; notes?: string; localized?: LocalizedMap; icon_svg?: string; icon_png_base64?: string; related_app?: string }) => {
    const r = await skills.publishSkill(user, { uploadId: a.upload_id, displayName: a.display_name, description: a.description, notes: a.notes, localized: a.localized, iconSvg: a.icon_svg, iconPngBase64: a.icon_png_base64, relatedApp: a.related_app });
    return { ...r, notes: r.notes.map(say) };
  }));

  server.registerTool('update_skill', {
    description: 'Change the market listing of a Skill you published: per-language name/description, icon, the optional related app, or hide it (listed=false). Does not change the Skill content.',
    inputSchema: {
      slug: z.string(), localized: localizedSchema(), listed: z.boolean().optional(),
      icon_svg: z.string().optional(), icon_png_base64: z.string().optional(),
      related_app: z.string().optional().describe('link to a hub app slug (you must manage that app), or "" to remove the link'),
    },
  }, guard((a: { slug: string; localized?: LocalizedMap; listed?: boolean; icon_svg?: string; icon_png_base64?: string; related_app?: string }) =>
    skills.updateSkill(user, a.slug, { localized: a.localized, listed: a.listed, iconSvg: a.icon_svg, iconPngBase64: a.icon_png_base64, relatedApp: a.related_app })));

  server.registerTool('list_skills', { description: 'Skills in the company market, with your installed version.' }, guard(() =>
    skills.listSkills(user, locale).map(({ slug, name, description, version, myVersion, owner }) => ({ slug, name, description, version, installedVersion: myVersion, owner: owner.name }))));

  // ---- resources page (资料): admins curate it through their agent ----
  const i18nText = () => z.record(z.string(), z.string()).describe(`text per hub language, keys: ${localeCodes().join(', ')}; translate yourself`);
  server.registerTool('get_library', {
    description: 'The hub resources page: company mission/vision/values and grouped links (sections: policies, brand), with ids and every language.',
  }, guard(() => lib.library(locale, true)));

  server.registerTool('set_culture', {
    description: 'Admin only. Set the company mission, vision and/or values shown on the resources page. Give every hub language.',
    inputSchema: {
      mission: i18nText().optional(),
      vision: i18nText().optional(),
      values: z.array(z.object({ icon: z.string().optional().describe('one emoji or a short lucide icon name'), title: i18nText(), description: i18nText().optional() })).optional(),
    },
  }, guard((a: lib.Culture) => lib.setCulture(user, a)));

  server.registerTool('save_resource_group', {
    description: 'Admin only. Create (no id) or update a group on the resources page, e.g. "HR policies" under section policies.',
    inputSchema: { id: z.number().int().optional(), section: z.enum(['policies', 'brand']), name: i18nText(), note: i18nText().optional().describe('e.g. owning department'), sort: z.number().int().optional() },
  }, guard((a: { id?: number; section: string; name: lib.I18nText; note?: lib.I18nText; sort?: number }) => ({ id: lib.upsertGroup(user, a) })));

  server.registerTool('save_resource', {
    description: 'Admin only. Create (no id) or update a link in a resources group: a Lark doc/wiki URL for a policy or SOP, or brand material.',
    inputSchema: {
      id: z.number().int().optional(), group_id: z.number().int(), url: z.string(), title: i18nText(), description: i18nText().optional(),
      owner: z.string().optional().describe('maintainer name shown on the card'), sort: z.number().int().optional(),
      app_slug: z.string().optional(), skill_slug: z.string().optional().describe('Skill that teaches agents to use this material'),
      preview: z.enum(['brand', 'slides', 'ui']).optional().describe('brand section cards: which illustration to show'),
    },
  }, guard((a: { id?: number; group_id: number; url: string; title: lib.I18nText; description?: lib.I18nText; owner?: string; sort?: number; app_slug?: string; skill_slug?: string; preview?: string }) =>
    ({ id: lib.upsertResource(user, { id: a.id, groupId: a.group_id, url: a.url, title: a.title, description: a.description, owner: a.owner, sort: a.sort, appSlug: a.app_slug, skillSlug: a.skill_slug, preview: a.preview }) })));

  server.registerTool('delete_resource', {
    description: 'Admin only. Remove a link (kind=resource) or a whole group with its links (kind=group) from the resources page.',
    inputSchema: { kind: z.enum(['resource', 'group']), id: z.number().int() },
  }, guard((a: { kind: 'resource' | 'group'; id: number }) => {
    if (a.kind === 'group') lib.deleteGroup(user, a.id);
    else lib.deleteResource(user, a.id);
    return { ok: true };
  }));

  // ---- agent-built home pages ----
  const scopeArgs = {
    scope: z.enum(['me', 'department', 'company']).describe('me = your own home; department = default for a department you lead (needs department_id); company = default for everyone (admin)'),
    department_id: z.string().optional(),
  };
  server.registerTool('get_homepage', {
    description: 'Read a hub home page layout plus the departments you belong to / can configure. Start from this before changing a home page. For scope me it is the page as the user sees it: the company or department layout it is built on (modules with own: false) with their changes, and their own modules (own: true).',
    inputSchema: scopeArgs,
  }, guard((a: { scope: homepage.Scope; department_id?: string }) => ({
    ...homepage.getHomeLayout(user, a.scope, a.department_id, locale),
    currentlyShownToYou: homepage.resolveHome(user, locale).from,
    defaultLayout: homepage.DEFAULT_LAYOUT,
    myDepartments: homepage.userDepartments(user, locale),
    editableDepartments: homepage.editableDepartments(user, locale),
    apps: apps.listAppsFor(user, locale).filter((x) => x.canOpen).map((x) => ({ slug: x.slug, name: x.name })),
    tip: `Modules render in order on a 6-column grid (full/half/third). Text fields are per language; fill every hub language. Keep each module's id. A person's page is built on their department's or the company's layout: saving scope me keeps that link (shared modules left out become hidden for them, widths remembered, anything new or changed is theirs), so later company changes still reach them; people can also hide, move and resize modules on the page themselves. Modules on data a viewer may not see are left out for them. Data can be static, come from an app via source {app, path, pick}, or from a registered data source via source {data, query} (see list_data_sources). The alerts module lists alert rules the viewer owns or is told about.${LARK ? ' The okr module shows Lark OKRs (default: each viewer their own) as a pace card; the agenda module shows each viewer their own Lark calendar for today (or a few days).' : ' (The okr module needs Lark and is not available on this hub.)'}${githubEnabled() ? ' The github module shows the viewer\'s own GitHub contributions as a calendar heatmap (each person sees their own).' : ''} Always preview_homepage and send the user the link; save only after they confirm.`,
  })));

  server.registerTool('preview_homepage', {
    description: 'Validate a home page layout and get a private preview link (valid 24h, only you can open it). Send the link to the user and wait for their OK before save_homepage.',
    inputSchema: { ...scopeArgs, layout: homepage.layoutSchema },
  }, guard((a: { scope: homepage.Scope; department_id?: string; layout: unknown }) => homepage.previewHome(user, a.scope, a.layout, a.department_id)));

  server.registerTool('save_homepage', {
    description: 'Save a home page layout after the user approved the preview.',
    inputSchema: { ...scopeArgs, layout: homepage.layoutSchema },
  }, guard((a: { scope: homepage.Scope; department_id?: string; layout: unknown }) => homepage.saveHome(user, a.scope, a.layout, a.department_id, locale)));

  server.registerTool('reset_homepage', {
    description: 'Remove a customised home page so it falls back to the department / company / built-in default (for scope me: drop all of the user\'s own changes).',
    inputSchema: scopeArgs,
  }, guard((a: { scope: homepage.Scope; department_id?: string }) => homepage.resetHome(user, a.scope, a.department_id)));

  // ---- data sources (Lark Base tables or data apps), alert rules ----
  if (LARK) larkDataTools(kit);

  // the same things as resources: some agents look there first for what a server offers
  server.registerResource('data-sources', 'hub://data-sources', {
    title: `${config.companyName} data sources`,
    description: 'Company numbers the user may see (sign-ups, active users, revenue, usage…), each with what it counts. Query them with query_data / read_data_rows.',
    mimeType: 'application/json',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ sources: dataSources.listSources(locale, user), howToRead: 'query_data for totals and trends, read_data_rows for the records' }, null, 2) }] }));
  server.registerResource('instructions', 'hub://instructions', {
    title: `How to use the ${config.companyName} hub`,
    description: 'What the hub offers and how to use it: company data, apps, Skills, Lark documents.',
    mimeType: 'text/markdown',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: INSTRUCTIONS }] }));

  server.registerTool('list_data_sources', {
    description: 'Data sources registered in the hub (id, title, what it counts, link, owner): Lark Base tables, data apps, and items read through a data connection (e.g. Metabase questions; only those the user may see are listed). Start here when the user asks about company numbers; the description says how each one counts (who is left out, time zone, window).',
  }, guard(() => ({ sources: dataSources.listSources(locale, user) })));

  server.registerTool('list_connections', {
    description: 'The data connections (e.g. Metabase) admins set up on the hub\'s admin page: anyone can read through them into their own data sources (browse_connection, then save_data_source); sql says it can also run a read-only SQL query. Admins also get their settings and status, never their keys: keys are only ever entered on the admin page, never through an agent.',
  }, guard(() => (user.role === 'admin'
    ? { connections: connectors.listConnections(), setUpAt: `${config.hubUrl}/admin#connections` }
    : { connections: connectors.connectionsForAll() })));

  server.registerTool('browse_connection', {
    description: 'What a data connection can read (e.g. Metabase questions), searchable, to register one with save_data_source (connection + item); for connections that run SQL, also the databases (connection + database + sql). Dashboards (boards: true) are for admins importing them.',
    inputSchema: { connection: z.string(), q: z.string().optional(), boards: z.boolean().optional().describe('list its dashboards (to import_board) instead of single items') },
  }, guard((a: { connection: string; q?: string; boards?: boolean }) => (a.boards ? connectors.browseBoards(user, a.connection, a.q) : connectors.browseConnection(user, a.connection, a.q))));

  server.registerTool('import_board', {
    description: 'Admins: import (or sync) a dashboard of a data connection, e.g. a Metabase dashboard, as boards on the Data page: each chart\'s question becomes a data source (new ones seen by admins only unless you pass an audience), each card a module, one board per tab. Find dashboards with browse_connection (boards: true). Importing the same dashboard again rebuilds its boards.',
    inputSchema: { connection: z.string(), board: z.string().describe('the dashboard id in that system'), audience: dataSources.audienceSchema.optional() },
  }, guard((a: { connection: string; board: string; audience?: dataSources.Audience }) =>
    importBoard(user, a.connection, a.board, { locale, audience: a.audience && { ...a.audience, people: a.audience.people ? resolveColleagues(a.audience.people) : undefined } })));

  server.registerTool('set_data_source_audience', {
    description: 'Admins: who besides admins may see a data source read through a data connection (everyone in the company, chosen colleagues, departments). Nothing = admins only. Lark tables follow Lark access and app data follows who may open the app instead.',
    inputSchema: { id: z.string(), audience: dataSources.audienceSchema },
  }, guard((a: { id: string; audience: dataSources.Audience }) => dataSources.setAudience(user, a.id, { ...a.audience, people: a.audience.people ? resolveColleagues(a.audience.people) : undefined })));

  server.registerTool('save_data_source', {
    description: `Register (or update, if you own it) a named data source for home pages, boards, alerts and data checks: ${LARK ? 'a Lark Base table (url), ' : ''}rows served by a hub app (app + path, see "Data apps" in the instructions), or something read through a data connection: an item (connection + item, e.g. a Metabase question) or a read-only SQL query (connection + database + sql: one SELECT, nothing that writes). Anyone may add those for themselves: only they and admins see it until an admin shares it (audience). The hub reads it once to check it.`,
    inputSchema: {
      id: z.string().describe('short lowercase id, e.g. "sales-orders"'),
      title: i18nText().describe('name per hub language'),
      ...(LARK ? {
        url: z.string().optional().describe('Lark Base or wiki link; include ?table=… (and &view=… to read only a view)'),
        table: z.string().optional().describe('table id, if the link has none'),
      } : {}),
      app: z.string().optional().describe(LARK ? 'slug of a hub app that serves rows (instead of url)' : 'slug of a hub app that serves rows'),
      path: z.string().optional().describe('path on that app returning {"rows": [...]}, e.g. /api/rows'),
      connection: z.string().optional().describe('id of a data connection (list_connections)'),
      item: z.string().optional().describe('what to read through it, e.g. a Metabase question id'),
      database: z.string().optional().describe('with sql: the database id (browse_connection lists them)'),
      sql: z.string().optional().describe('instead of item: one read-only SELECT (or WITH … SELECT); check it with execute_sql through Metabase first if you can'),
      combine: dataSources.combineSchema.optional().describe('when an admin turned combining on: a source made of two others (by id), joined on matching fields or stacked; each part is read as the viewer'),
      audience: dataSources.audienceSchema.optional().describe('admins, for connection sources: who besides admins and its owner may see it'),
      description: i18nText().optional().describe('what it counts, per hub language (who is included or left out, time zone, window); connection sources take it from the other system unless given'),
    },
  }, guard((a: { id: string; title: lib.I18nText; url?: string; table?: string; app?: string; path?: string; connection?: string; item?: string; database?: string; sql?: string; combine?: dataSources.Combine; audience?: dataSources.Audience; description?: lib.I18nText }) =>
    dataSources.saveSource(user, { ...a, audience: a.audience && { ...a.audience, people: a.audience.people ? resolveColleagues(a.audience.people) : undefined } })));

  server.registerTool('inspect_app_data', {
    description: 'Fetch the rows a hub app serves for a data source, as the user would get them: field names and types the hub inferred, row count, how many rows have _id / _url, and 5 sample rows. Use it to check a data app before save_data_source.',
    inputSchema: { app: z.string(), path: z.string() },
  }, guard((a: { app: string; path: string }) => dataSources.inspectApp(user, a.app, a.path)));

  server.registerTool('set_data_source_description', {
    description: 'Write what a data source counts, per hub language (whoever registered it, or an admin). Pass null to go back to the description from the other system (e.g. the Metabase question\'s).',
    inputSchema: { id: z.string(), description: i18nText().nullable() },
  }, guard((a: { id: string; description: lib.I18nText | null }) => dataSources.setDescription(user, a.id, a.description)));

  server.registerTool('delete_data_source', {
    description: 'Remove a data source you registered (home modules and alert rules using it stop working).',
    inputSchema: { id: z.string() },
  }, guard((a: { id: string }) => dataSources.deleteSource(user, a.id)));

  server.registerTool('query_data', {
    description: 'Run a query on a data source as the user and see the numbers (use this to check a chart or alert before saving it).',
    inputSchema: { source: z.string(), query: querySchema },
  }, guard(async (a: { source: string; query: Query }) => {
    const r = await dataSources.query(user, a.source, a.query, true);
    return { ...r, rows: r.rows.slice(0, 200), stat: toStat(r) };
  }));

  server.registerTool('read_data_rows', {
    description: 'The rows of a data source themselves (not totals), read with the user\'s own access: optionally filtered, only some fields, sorted, at most 200. Use it to answer questions like "who paid for the first time last week"; use query_data for counts and sums.',
    inputSchema: {
      source: z.string(),
      where: querySchema.shape.where,
      fields: z.array(z.string()).max(30).optional().describe('only these fields (default: all)'),
      sort: z.object({ field: z.string(), desc: z.boolean().optional() }).optional(),
      limit: z.number().int().min(1).max(200).optional().describe('default 50'),
    },
  }, guard((a: { source: string; where?: Query['where']; fields?: string[]; sort?: { field: string; desc?: boolean }; limit?: number }) =>
    dataSources.readRows(user, a.source, { where: a.where, fields: a.fields, sort: a.sort, limit: a.limit })));

  server.registerTool('list_alert_rules', {
    description: 'Alert rules the user owns or is told about, with their current state (ok / firing / error / paused).',
  }, guard(() => ({ rules: alerts.rulesFor(user, locale) })));

  server.registerTool('save_alert_rule', {
    description: `Create (no id) or update an alert rule on a data source. Checked every every_minutes as you; it shows on the home pages of you and the recipients${MESSAGES ? `, and the hub bot messages them${LARK ? ' (and chat_id)' : ''} when it starts or stops firing` : ''}.`,
    inputSchema: {
      id: z.number().int().optional(),
      title: i18nText().describe('what is being watched, per hub language, e.g. "Daily signups"'),
      source: z.string(),
      query: querySchema.describe('one number: no groupBy/series. Add date {field, bucket, last: 2, complete: true} to watch the last finished day/week/month (needed for change conditions, so a half-finished period does not look like a drop)'),
      condition: alerts.conditionSchema,
      recipients: z.array(z.string()).max(50).optional().describe('colleagues to tell (email, name or open_id); you are always included'),
      ...(LARK ? { chat_id: z.string().optional().describe('Lark group chat id (oc_…) the hub bot is in') } : {}),
      every_minutes: z.number().int().min(10).max(1440).optional().describe('default 60'),
      enabled: z.boolean().optional(),
    },
  }, guard((a: { id?: number; title: lib.I18nText; source: string; query: Query; condition: alerts.Condition; recipients?: string[]; chat_id?: string; every_minutes?: number; enabled?: boolean }) => {
    const saved = alerts.saveRule(user, { id: a.id, title: a.title, source: a.source, query: a.query, condition: a.condition, recipients: resolveColleagues(a.recipients ?? []), chatId: a.chat_id, everyMinutes: a.every_minutes, enabled: a.enabled });
    return MESSAGES && alerts.notifyMode() === 'admins' ? { ...saved, note: say({ key: 'note.alert.adminsOnly' }) } : saved;
  }));

  server.registerTool('check_alert_rule', {
    description: 'Check an alert rule right now and return its value and state. With notify (default true) due messages go out (if the hub can message people), still subject to the cooldown, quiet hours and the admins-only setting; notify=false only checks.',
    inputSchema: { id: z.number().int(), notify: z.boolean().optional() },
  }, guard(async (a: { id: number; notify?: boolean }) => {
    if (!alerts.rulesFor(user, locale).some((r) => r.id === a.id)) throw new UserError('err.alert.notFound', { id: a.id });
    const result = await alerts.checkRule(a.id);
    return a.notify === false ? result : { ...result, messages: await alerts.flushNotices() };
  }));

  server.registerTool('delete_alert_rule', {
    description: 'Delete an alert rule you own.',
    inputSchema: { id: z.number().int() },
  }, guard((a: { id: number }) => alerts.deleteRule(user, a.id)));

  // ---- data boards (the 数据 page) ----
  server.registerTool('list_boards', {
    description: 'Data boards on the hub\'s Data page that the user can see, with their layouts: company and department boards, their own boards (mine, with whom they share them) and colleagues\' boards shared with them; plus the departments they may build boards for.',
  }, guard(() => ({ boards: boards.boardsFor(user, locale), canEditCompany: user.role === 'admin', editableDepartments: homepage.editableDepartments(user, locale) })));

  server.registerTool('save_board', {
    description: 'Create or replace a data board on the Data page. scope "me": the user\'s own board (anyone may make any number; only they change it; private unless shared with share). "company": everyone sees it, admins only. "department" (with department_id): its members see it, its leaders change it. An existing board keeps its scope. Same modules as home pages; numbers are read as each viewer, so sharing never shows anyone data they may not see. Show the user the result at the returned URL.',
    inputSchema: {
      id: z.string().describe('short lowercase id, e.g. "sales-weekly" (unique across the hub; for own boards add something of the user\'s, e.g. "lin-funnel")'),
      title: i18nText(),
      scope: z.enum(['me', 'company', 'department']).optional().describe('default: department when department_id is given, else company'),
      department_id: z.string().optional(),
      share: dataSources.audienceSchema.optional().describe('own boards only: who else sees it (company, colleagues by email or name, department ids); {} makes it private again'),
      layout: homepage.layoutSchema,
      sort: z.number().int().optional(),
    },
  }, guard((a: { id: string; title: lib.I18nText; scope?: boards.Scope; department_id?: string; share?: boards.Share; layout: unknown; sort?: number }) =>
    ({ ...boards.saveBoard(user, { id: a.id, title: a.title, scope: a.scope, departmentId: a.department_id, layout: a.layout, sort: a.sort,
      share: a.share && { ...a.share, people: a.share.people ? resolveColleagues(a.share.people) : undefined } }), url: `${config.hubUrl}/data?board=${encodeURIComponent(a.id)}` })));

  server.registerTool('share_board', {
    description: 'Share one of the user\'s own boards (scope "me") with the company, colleagues (email or name) or departments, replacing whom it was shared with; {} makes it private again. They see it on their Data page with every number read as themselves; a module on a data source only the user may read (e.g. one they registered through a data connection) stays hidden for them until an admin shares that source.',
    inputSchema: { id: z.string(), share: dataSources.audienceSchema },
  }, guard((a: { id: string; share: boards.Share }) => boards.shareBoard(user, a.id, { ...a.share, people: a.share.people ? resolveColleagues(a.share.people) : undefined })));

  server.registerTool('delete_board', {
    description: 'Delete a data board (same permissions as save_board; someone\'s own board only by them).',
    inputSchema: { id: z.string() },
  }, guard((a: { id: string }) => boards.deleteBoard(user, a.id)));

  // ---- apps that use Lark as the person using them ----
  if (LARK) larkAppTools(kit);

  // ---- data checks ("异常项") ----
  server.registerTool('save_check', {
    description: 'Create (no id) or update a data check: a rule that finds records in a data source that need fixing. It runs right away as you and returns how many records it found plus a sample, so you can tune it before showing the team.',
    inputSchema: {
      id: z.number().int().optional(),
      title: i18nText().describe('what is wrong, per hub language, e.g. "Paid but no payment date"'),
      hint: i18nText().optional().describe('how to fix it'),
      source: z.string().describe('data source id (save_data_source first)'),
      level: z.enum(checks.LEVELS).describe('error = definitely wrong; verify = needs a human to confirm; style = written inconsistently'),
      team: i18nText().optional().describe('who usually fixes it, e.g. Finance'),
      spec: checks.specSchema,
      owner_field: z.string().optional().describe('person field, or a field with names / emails: whoever is in it must fix the record (they see it on their home page)'),
      label_fields: z.array(z.string()).min(1).max(3).describe('fields that name a record in the list, e.g. project name and client'),
      enabled: z.boolean().optional(),
    },
  }, guard((a: { id?: number; title: lib.I18nText; hint?: lib.I18nText; source: string; level: checks.Level; team?: lib.I18nText; spec: checks.Spec; owner_field?: string; label_fields: string[]; enabled?: boolean }) =>
    checks.saveCheck(user, { id: a.id, title: a.title, hint: a.hint, source: a.source, level: a.level, team: a.team, spec: a.spec, ownerField: a.owner_field, labelFields: a.label_fields, enabled: a.enabled })));

  server.registerTool('list_checks', {
    description: 'All data checks: rule, level, data source, how many issues each found last time.',
  }, guard(() => ({ checks: checks.listChecks(locale) })));

  server.registerTool('run_checks', {
    description: 'Run one data check (id) or all of them now, and return the results.',
    inputSchema: { id: z.number().int().optional() },
  }, guard(async (a: { id?: number }) => (a.id ? checks.runCheck(a.id) : { ...(await checks.runAll()), checks: checks.listChecks(locale).map((c) => ({ id: c.id, title: c.title, issues: c.issues, error: c.error })) })));

  server.registerTool('delete_check', {
    description: 'Delete a data check you created (and its issues).',
    inputSchema: { id: z.number().int() },
  }, guard((a: { id: number }) => checks.deleteCheck(user, a.id)));

  server.registerTool('list_issues', {
    description: 'Data issues the user may see: per check the records to fix, with owners; mine_only for the ones assigned to the user.',
    inputSchema: { mine_only: z.boolean().optional() },
  }, guard(async (a: { mine_only?: boolean }) => {
    const r = await checks.issuesFor(user, locale);
    const keep = (rows: (typeof r.checks)[number]['rows']) => rows.filter((x) => !x.exception && (!a.mine_only || x.mine)).slice(0, 50);
    return { counts: r.counts, lastRun: r.lastRun, checks: r.checks.map((c) => ({ id: c.id, title: c.title, level: c.level, rows: keep(c.rows).map(({ owners, ...x }) => ({ ...x, owners: owners.map((o) => o.name) })) })).filter((c) => c.rows.length) };
  }));

  if (LARK) larkWorkTools(kit);

  if (githubEnabled()) {
    server.registerTool('github_activity', {
      description: `What someone did on GitHub (organisation ${config.github.org}) in a time window: commits they authored (with the branch or pull request when the work is not on the default branch), pull requests they opened or updated (open / merged / closed) and pull requests they reviewed. Use it to write a daily or weekly report, or to see what a colleague is working on. Default: the user, last 24 hours.`,
      inputSchema: {
        colleague: z.string().optional().describe('email, name or open_id; default: the user'),
        since: z.string().optional().describe('ISO date-time, e.g. 2026-10-19T09:00:00+09:00; default: 24 hours ago'),
        until: z.string().optional().describe('ISO date-time; default: now'),
      },
    }, guard(async (a: { colleague?: string; since?: string; until?: string }) => {
      const person = a.colleague ? all<User>('SELECT * FROM users WHERE id = ?', resolveColleagues([a.colleague])[0])[0] : user;
      const to = a.until ? Date.parse(a.until) : Date.now();
      const from = a.since ? Date.parse(a.since) : to - 86_400_000;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new UserError('err.github.badWindow');
      if (!person.github_login) return { linked: false, hint: person.id === user.id ? `Ask the user to link their GitHub account once: ${githubConnectUrl('/me')}` : `${person.name} has not linked a GitHub account in the hub yet.` };
      return githubActivity(person, from, to);
    }));
  }

  server.registerTool('install_skill', {
    description: 'Get the download command to install (or update) a skill from the company market.',
    inputSchema: { slug: z.string().optional().describe('the Skill\'s name in the market'), name: z.string().optional().describe('same as slug') },
  }, guard(({ slug, name }: { slug?: string; name?: string }) => {
    if (!slug && !name) throw new UserError('err.skill.slugRequired');
    return skills.installInstructions(user, (slug ?? name)!);
  }));

  server.registerTool('read_skill', {
    description: 'Reads a Skill from the company market without installing it: its SKILL.md instructions (always the latest version) and the list of its other files; pass file to read one of them. For agents that cannot install Skills (hosted agents, scheduled tasks) or a task that should always follow the latest version: read it and follow it as if it were installed. Scripts in it need an agent that can run commands; otherwise do their steps with the tools you have.',
    inputSchema: {
      skill: z.string().describe('the Skill\'s name in the market (slug) or its display name, e.g. daily-report or 日报助手'),
      file: z.string().optional().describe('one of the files it lists, e.g. references/format.md'),
    },
  }, guard((a: { skill: string; file?: string }) => skills.readSkill(user, locale, a.skill, a.file)));

  server.registerTool('check_skill_updates', {
    description: 'Given installed skills (from their .hub-skill.json), return those with newer versions in the market.',
    inputSchema: { installed: z.array(z.object({ slug: z.string(), version: z.number().int() })) },
  }, guard(({ installed }: { installed: { slug: string; version: number }[] }) => {
    const updates = skills.checkUpdates(user, installed);
    return updates.length ? { updates, hint: 'Call install_skill for each to update.' } : { updates: [], message: say({ key: 'note.skillsUpToDate' }) };
  }));

  version = sha256(surface.join('\u0001')).slice(0, 12);
  versions.set(server, version);
  return server;
}

export async function handleMcp(req: Request, user: User, clientId: string, token: string): Promise<Response> {
  const server = buildMcpServer(user, clientId);
  // connecting (or reconnecting) gets the current instructions and tools: remember which ones
  const body = await req.clone().json().catch(() => null) as { method?: string } | { method?: string }[] | null;
  if ((Array.isArray(body) ? body : [body]).some((m) => m?.method === 'initialize')) {
    run('UPDATE agent_connections SET seen_version = ? WHERE user_id = ? AND client_id = ?', surfaceVersion(server), user.id, clientId);
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req, { authInfo: { token, clientId, scopes: ['hub'] } });
  } finally {
    void server.close();
  }
}
