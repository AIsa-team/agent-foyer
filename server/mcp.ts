import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { appUrl, config } from './config.ts';
import { messenger } from './notify.ts';
import { all, get, type User } from './db.ts';
import * as apps from './apps/service.ts';
import * as skills from './skills/service.ts';
import * as lib from './library.ts';
import * as homepage from './homepage.ts';
import * as dataSources from './data/sources.ts';
import * as alerts from './data/alerts.ts';
import { querySchema, toStat, type Query } from './data/query.ts';
import { connection, connectUrl } from './lark/userToken.ts';
import { listPeriods, userOkrs } from './lark/okr.ts';
import { okrBoard } from './lark/okrBoard.ts';
import * as checks from './data/checks.ts';
import * as appLark from './apps/larkApi.ts';
import * as feedback from './feedback.ts';
import * as collab from './collab.ts';
import * as workspace from './lark/workspace.ts';
import * as resources from './apps/resources.ts';
import { githubEnabled } from './github/app.ts';
import { githubActivity } from './github/activity.ts';
import { githubConnectUrl } from './github/link.ts';
import { fillDailyReport, readDailyReport, setDailyConfig } from './lark/daily.ts';
import { createDoc, readDoc } from './lark/docs.ts';
import * as boards from './boards.ts';
import { createUpload, type UploadPurpose } from './uploads.ts';
import { tr, UserError, type Msg } from './i18n/index.ts';
import { localeCodes, type LocalizedMap } from './localized.ts';
import { appGuide } from './appGuide.ts';
import { sourceDownload } from './apps/source.ts';
import * as connectors from './data/connectors/index.ts';
import { importBoard } from './data/importBoard.ts';

const LARK = config.lark.enabled;
// where hub.lark.mailDraft puts drafts on this hub (Gmail or Lark Mail), so agents describe it right
const MESSAGES = !!messenger;

const INSTRUCTIONS = `This is the ${config.companyName} company hub (colleagues also call it 中台 or 公司中台; "publish to the hub / 发布到中台" means this server). It lets the user publish web apps to the company server and share/install Skills. When the user mentions the hub, use these tools; do not ask for its address.

Language: the team is multilingual and the hub UI is shown in ${localeCodes().join(', ')}. Always talk to the user in the language they use with you.
Whenever you publish or update an app or a Skill, pass \`localized\` with a short display name and a one-sentence description for EVERY hub language (${localeCodes().join(', ')}), translating them yourself, so colleagues see the listing in their own language. Do not ask the user to translate; just show them the names you chose. Only this listing text is translated: never translate the Skill content (SKILL.md) or the app itself. Hub messages you receive (errors, notes) are already in the user's hub language.

Building or changing an app (e.g. "make an app that…", "publish this project to the company server"): call app_guide first and follow it; it has the steps, the hub SDK and the report format. The core of it:
- Look before building: if one of the user's apps (list_my_apps) already does this, improve it, starting from its feedback (list_feedback) and the code of its live version (get_app_source).
- Decide the defaults yourself (name in every hub language, subdomain, icon) and keep a new app private to the user unless they said who should use it. Ask only what you cannot decide; if you work unattended, write open questions into your report instead of stopping.
${LARK ? `- Business data lives in Lark, never only in the app: a table the user named, or a Base you create (create_lark_base, typed columns). Documents the app produces are Lark documents. The app's own storage is for technical state only.
- The app reaches Lark only through the hub SDK as the person using it (/__hub/sdk.js, declared with set_app_lark). No Lark tokens, no own login.
` : `- Business records live in the app's own server storage ($DATA_DIR in a container app), never only in the browser. No own login: the hub signs people in.
`}${config.designSkills.length ? `- The interface uses the company design system: install_skill ${config.designSkills.join(', ')} and build from its kit and templates, no other UI library.
` : ''}- Check it works (locally against a fake hub, then get_app_status), without writing test data into real tables or mailboxes, and end with the short report app_guide describes.
Feedback on apps and Skills: colleagues leave it on the hub page, with the 「feedback」 button inside every app, or through their agent. When the user asks to improve one of their apps or Skills (or what people said), list_feedback, change and republish, then resolve_feedback each item with a short reply. When they hit a problem with someone else's app or Skill, draft it with send_feedback and send only after they agree with the text.
Working together: an app or Skill can have collaborators (set_collaborators). They publish and change settings like the owner; only the owner (or an admin) deletes it, changes collaborators or hands it over (transfer_ownership). If a slug or Skill name belongs to someone else, suggest asking them to add the user as a collaborator.
Never put secrets in an upload; use set_app_env for API keys.

Sharing a Skill: if it has no icon, draw a simple square SVG icon and pass icon_svg. The folder must have SKILL.md at its root with frontmatter "name" (lowercase-hyphen) and "description". create_upload(purpose="skill"), upload the folder contents, then publish_skill with localized market names/descriptions for every hub language. Republishing the same name creates a new version. To change only the market text later, use update_skill.
${LARK ? `Lark data (Base tables): the hub reads Lark Base with each person's own Lark access, so everyone only sees rows they could open in Lark. If a tool says Lark data is not connected, give the user the link it returns (they approve once in Lark) and continue after they confirm.\n` : ''}
Company numbers (sign-ups, revenue, usage, orders…): when the user asks about them, look in the hub first: list_data_sources, then query_data for totals and trends or read_data_rows for the records themselves. Everything is read with the user's own access, so say so plainly when a source exists but they may not see it, and never work around it.
To chart data: register it once as a data source (${LARK ? 'a Lark Base table: inspect_base(url) to see its tables and fields; ' : ''}a data app: see below), save_data_source with a short id and a title in every hub language, then try query_data until the numbers look right, then put it on a home page (chart/stats module with source {data: <id>, query}) via preview_homepage. Use count / sum / avg with groupBy for breakdowns and date {field, bucket, last} for trends; stats tiles with date get the trend and the change vs the previous bucket automatically (add date.complete: true so the current, unfinished period is not compared with a full one; the tile's period text is just "last month" / "上月").
Data apps: ${LARK ? 'data that is not in Lark Base' : 'company data'} (Metabase, a database, a CRM, another SaaS) comes in through a small hub app the user's agent builds and publishes like any other app. The app answers GET <path> with JSON {"rows": [{...}, ...]} (or a bare array): one flat object per row; dates as ISO strings ("2026-07-20T06:32:29Z") or ms timestamps, numbers as numbers. Optional per row: "_id" (unique and stable; needed for data checks) and "_url" (link to the row in its own system). Optional top level "fields": [{"name", "type": "text|number|date|person|select|multi|checkbox"}] when inference is not enough. Put a person's name or email in a normal field (e.g. "owner") to assign data-check issues. Keep credentials in set_app_env, cache upstream results for a few minutes, and keep rows under ~50k. Visibility of the app = who may see its data: the hub fetches as the viewer (X-Hub-User-* headers) and only for people allowed to open the app. Then inspect_app_data, save_data_source with app + path, and use it like any other data source.
Data connections: systems the hub reads itself, set up by admins on the admin page with their key (today: Metabase). When one exists, register its items with save_data_source (connection + item; admins, see browse_connection) instead of building a data app; each such source has an audience that admins set (set_data_source_audience). For a system with no connection, build a data app.
Shared dashboards: the Data page holds boards for the whole company or a department (save_board), built from the same modules as home pages; use them for numbers a team looks at together, and home pages for what one person wants to see.
Data quality ("异常项"): the hub can check data sources for records that need fixing. When asked to clean up a table, look at it first (${LARK ? 'inspect_base / ' : ''}inspect_app_data), then work out the business rules with the user: contradictions (paid but no payment date), missing values (signed but no payment method), stale rows (in progress but untouched for 14 days), duplicates (same project twice) and the same value written differently. List the rules for the user to confirm, then save_check each one (it runs at once and shows a sample; tune until the sample is right). Levels: error = definitely wrong, verify = a human must confirm, style = written inconsistently. Set owner_field to the field naming whoever must fix the record (a person field, or names / emails): they see their issues on the issues page and their home page (module {type: "issues"}). Checks rerun every few hours.
${LARK ? `Lark documents: read_lark_doc reads one as Markdown; create_lark_doc writes Markdown into a new document the user owns (their own space, or under a wiki page / in a folder they give). The first time, the user is asked once to let the hub create and edit documents.\n` : ''}${LARK ? `Daily report: get_daily_report reads the team's report for a day; fill_daily_report writes the user's own rows as the user. To draft it, gather what they did (github_activity when GitHub is connected, plus what they tell you), match the work to the report's sections and columns, show the draft and write only after they agree. Ask for tomorrow's plan and blockers rather than inventing them.\n` : ''}${LARK ? `OKRs: the company tracks goals in Lark OKR. get_okrs reads them with the user's Lark access (default: their own, current period). To show them on a home page, add a module {type: "okr"}; without \`user\` everyone sees their own, so it suits department and company layouts.\n` : ''}
Alerts: save_alert_rule watches one number (a query without groupBy) against a condition (above / below a threshold, or a drop / rise vs the previous date bucket). It is checked on a schedule as its creator and shows on the recipients' home pages (alerts module)${MESSAGES ? `; when it starts or stops firing the hub bot also messages them${LARK ? ' (and optionally a Lark group via chat_id) in Lark' : ''}. Messages are deliberately calm: at most one per rule every few hours, none at night (held until morning), several rules combined into one message, and anyone can opt out on their home page. Unless an admin changes it, the hub only messages hub admins; other recipients see alerts on their home page` : ''}. Ask the user who should be told before saving; recipients will see the numbers, so only add people who should.
Installing a Skill: install_skill returns a download command; run it. To check for updates, read .hub-skill.json in each installed skill folder and call check_skill_updates.`;

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

export function buildMcpServer(user: User, clientId?: string): McpServer {
  const server = new McpServer({ name: config.mcpName, version: '0.1.0' }, { instructions: INSTRUCTIONS });
  // feedback sent through an agent says which one
  const agentName = (clientId && get<{ client_name: string }>('SELECT client_name FROM agent_connections WHERE user_id = ? AND client_id = ?', user.id, clientId)?.client_name) || 'Agent';
  // replies use the language this person picked in the hub UI
  const locale = user.locale ?? config.defaultLocale;
  const say = (m: Msg) => tr(locale, m.key, m.params);

  function guard<A>(fn: (args: A) => Promise<unknown> | unknown) {
    return async (args: A) => {
      try {
        return json(await fn(args));
      } catch (e) {
        const known = e instanceof UserError;
        if (!known) console.error('[mcp] tool error', e);
        const text = known ? e.localized(locale) : tr(locale, 'err.internal', { message: (e as Error).message });
        return { content: [{ type: 'text' as const, text }], isError: true };
      }
    };
  }

  server.registerTool('whoami', { description: 'Who the hub thinks you are, and the app domain.' }, guard(() => ({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    hub: config.hubUrl,
    appsDomain: config.appsDomain,
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
    },
  }, guard(async (a: {
    upload_id: string; slug: string; kind: 'static' | 'container'; name?: string; description?: string; visibility?: apps.Visibility;
    members?: string[]; static_dir?: string; container_port?: number; icon_svg?: string; icon_png_base64?: string; localized?: LocalizedMap; related_skill?: string; source_upload_id?: string;
  }) => apps.publishApp(user, {
    uploadId: a.upload_id, slug: a.slug, kind: a.kind, name: a.name, description: a.description, visibility: a.visibility,
    memberIds: a.members ? resolveColleagues(a.members) : undefined, staticDir: a.static_dir, containerPort: a.container_port,
    iconSvg: a.icon_svg, iconPngBase64: a.icon_png_base64, localized: a.localized, relatedSkill: a.related_skill, sourceUploadId: a.source_upload_id,
  }).then((r) => ({ ...r, notes: r.notes.map(say) }))));

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
    },
  }, guard((a: { slug: string; name?: string; description?: string; localized?: LocalizedMap; icon_svg?: string; icon_png_base64?: string; related_skill?: string; feedback_button?: boolean }) => {
    return apps.updateApp(user, a.slug, { name: a.name, description: a.description, localized: a.localized, iconSvg: a.icon_svg, iconPngBase64: a.icon_png_base64, relatedSkill: a.related_skill, feedbackButton: a.feedback_button });
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
    tip: `Modules render in order on a 6-column grid (full/half/third). Text fields are per language; fill every hub language. Keep each module's id. A person's page is built on their department's or the company's layout: saving scope me keeps that link (shared modules left out become hidden for them, widths remembered, anything new or changed is theirs), so later company changes still reach them; people can also hide, move and resize modules on the page themselves. Modules on data a viewer may not see are left out for them. Data can be static, come from an app via source {app, path, pick}, or from a registered data source via source {data, query} (see list_data_sources). The alerts module lists alert rules the viewer owns or is told about.${LARK ? ' The okr module shows Lark OKRs (default: each viewer their own) as a pace card.' : ' (The okr module needs Lark and is not available on this hub.)'}${githubEnabled() ? ' The github module shows the viewer\'s own GitHub contributions as a calendar heatmap (each person sees their own).' : ''} Always preview_homepage and send the user the link; save only after they confirm.`,
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
  if (LARK) {
    server.registerTool('lark_data_status', {
      description: 'Whether the user has connected their Lark data (needed before reading Base tables). If not, returns the link they open once to approve.',
    }, guard(() => {
      const c = connection(user.id);
      return c.connected ? c : { ...c, connectUrl: connectUrl('/me'), hint: 'Send this link to the user; they approve in Lark, then call again.' };
    }));

    server.registerTool('inspect_base', {
      description: 'Look inside a Lark Base (Bitable) or spreadsheet link with the user\'s Lark access. Base: its tables, and for the chosen table (from ?table= in the link, or `table`) the fields with their types and 5 sample rows. Spreadsheet: its sheets, and for the chosen sheet (?sheet= or `table`) the columns from row 1 and the last 5 rows.',
      inputSchema: { url: z.string().describe('a Lark Base, spreadsheet or wiki link, e.g. https://xxx.larksuite.com/base/AbC…?table=tbl… or …/sheets/AbC…?sheet=…'), table: z.string().optional().describe('table id (Base) or sheet id (spreadsheet)') },
    }, guard((a: { url: string; table?: string }) => dataSources.inspect(user, a.url, a.table)));
  }

  server.registerTool('list_data_sources', {
    description: 'Data sources registered in the hub (id, title, link, owner): Lark Base tables, data apps, and items read through a data connection (e.g. Metabase questions; only those the user may see are listed). Start here when the user asks about company numbers.',
  }, guard(() => ({ sources: dataSources.listSources(locale, user) })));

  server.registerTool('list_connections', {
    description: 'Admins: the data connections (e.g. Metabase) set up on the hub\'s admin page, without their keys. Keys are only ever entered there, never through an agent.',
  }, guard(() => {
    if (user.role !== 'admin') throw new UserError('err.adminOnly');
    return { connections: connectors.listConnections(), setUpAt: `${config.hubUrl}/admin#connections` };
  }));

  server.registerTool('browse_connection', {
    description: 'Admins: what a data connection can read (e.g. Metabase questions), searchable, to register one with save_data_source (connection + item).',
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
    description: `Register (or update, if you own it) a named data source for home pages, boards, alerts and data checks: ${LARK ? 'a Lark Base table (url), ' : ''}rows served by a hub app (app + path, see "Data apps" in the instructions), or (admins) an item read through a data connection (connection + item, see browse_connection; new ones are seen by admins only until you set an audience). The hub reads it once to check it.`,
    inputSchema: {
      id: z.string().describe('short lowercase id, e.g. "sales-orders"'),
      title: i18nText().describe('name per hub language'),
      ...(LARK ? {
        url: z.string().optional().describe('Lark Base or wiki link; include ?table=… (and &view=… to read only a view)'),
        table: z.string().optional().describe('table id, if the link has none'),
      } : {}),
      app: z.string().optional().describe(LARK ? 'slug of a hub app that serves rows (instead of url)' : 'slug of a hub app that serves rows'),
      path: z.string().optional().describe('path on that app returning {"rows": [...]}, e.g. /api/rows'),
      connection: z.string().optional().describe('admins: id of a data connection (list_connections)'),
      item: z.string().optional().describe('what to read through it, e.g. a Metabase question id'),
      audience: dataSources.audienceSchema.optional().describe('for connection sources: who besides admins may see it'),
    },
  }, guard((a: { id: string; title: lib.I18nText; url?: string; table?: string; app?: string; path?: string; connection?: string; item?: string; audience?: dataSources.Audience }) =>
    dataSources.saveSource(user, { ...a, audience: a.audience && { ...a.audience, people: a.audience.people ? resolveColleagues(a.audience.people) : undefined } })));

  server.registerTool('inspect_app_data', {
    description: 'Fetch the rows a hub app serves for a data source, as the user would get them: field names and types the hub inferred, row count, how many rows have _id / _url, and 5 sample rows. Use it to check a data app before save_data_source.',
    inputSchema: { app: z.string(), path: z.string() },
  }, guard((a: { app: string; path: string }) => dataSources.inspectApp(user, a.app, a.path)));

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
    description: 'Shared data boards on the hub\'s Data page that the user can see, with their layouts, and the departments they may build boards for.',
  }, guard(() => ({ boards: boards.boardsFor(user, locale), canEditCompany: user.role === 'admin', editableDepartments: homepage.editableDepartments(user, locale) })));

  server.registerTool('save_board', {
    description: 'Create or replace a shared data board on the Data page. Company boards (no department_id) need an admin; department boards need a leader of that department and are shown to its members. Same modules as home pages; numbers are read as each viewer. Show the user the result at the returned URL.',
    inputSchema: {
      id: z.string().describe('short lowercase id, e.g. "sales-weekly"'),
      title: i18nText(),
      department_id: z.string().optional(),
      layout: homepage.layoutSchema,
      sort: z.number().int().optional(),
    },
  }, guard((a: { id: string; title: lib.I18nText; department_id?: string; layout: unknown; sort?: number }) =>
    ({ ...boards.saveBoard(user, { id: a.id, title: a.title, departmentId: a.department_id, layout: a.layout, sort: a.sort }), url: `${config.hubUrl}/data?board=${encodeURIComponent(a.id)}` })));

  server.registerTool('delete_board', {
    description: 'Delete a data board (same permissions as save_board).',
    inputSchema: { id: z.string() },
  }, guard((a: { id: string }) => boards.deleteBoard(user, a.id)));

  // ---- apps that use Lark as the person using them ----
  if (LARK) {
    server.registerTool('create_lark_base', {
      description: 'Create a Lark Base (multidimensional table) as the user for an app to keep its records in, with the tables and columns the app needs. Use it when the user named no table: business records belong in Lark, not in the app. The first column of each table is its title column (make it text, e.g. the customer name). Works before or after the app is published: once the app declares it (set_app_lark), it is shared with whoever may open the app and re-shared when that changes. Returns links with ?table= to pass to set_app_lark.',
      inputSchema: {
        app: z.string().optional().describe('slug of the app it is for, if the app exists already: shares it right away'),
        name: z.string().describe('the Base name, e.g. the app name'),
        tables: z.array(z.object({
          name: z.string(),
          columns: z.array(z.object({ name: z.string(), type: z.enum(workspace.COLUMN_TYPES), options: z.array(z.string()).optional().describe('for select / multi') })).min(1),
        })).min(1),
      },
    }, guard(async (a: { app?: string; name: string; tables: { name: string; columns: workspace.Column[] }[] }) => {
      const app = a.app && apps.getApp(a.app) ? apps.requireManageable(a.app, user) : null;
      const base = await workspace.createBase(user, a);
      const res = { kind: 'bitable' as const, token: base.token, name: a.name, url: base.url };
      resources.rememberCreated(user, res);
      if (!app) return { ...base, next: 'Publish the app if needed, then declare these links with set_app_lark: that shares the Base with whoever may open the app.' };
      resources.recordResource(app, user, res);
      const shared = await resources.shareAppResources(user, app.slug, res);
      return { ...base, sharedWith: app.visibility, shareProblems: shared.failed.length ? shared.failed : undefined };
    }));

    server.registerTool('add_lark_columns', {
      description: 'Add columns at the end of a table the user named (Lark Base table, or a spreadsheet sheet where row 1 holds the names), as the user. Existing columns are never renamed, removed or changed; names that exist are skipped. Use it when the app must keep something the table has no column for.',
      inputSchema: {
        url: z.string().describe('the table link with ?table= (Base) or ?sheet= (spreadsheet)'),
        columns: z.array(z.object({ name: z.string(), type: z.enum(workspace.COLUMN_TYPES).describe('spreadsheets ignore it'), options: z.array(z.string()).optional() })).min(1),
      },
    }, guard((a: { url: string; columns: workspace.Column[] }) => workspace.addColumns(user, a.url, a.columns)));

    server.registerTool('set_app_lark', {
      description: 'Declare which Lark Base tables or spreadsheets an app may use (read or write), whom it may notify through the hub bot, whether it may save email drafts in the person\'s mailbox and create Lark documents. Each colleague agrees once before the app can act as them; changing the declaration asks again. A Base made with create_lark_base becomes the app\'s and is shared with whoever may open it. Send empty lists to remove it.',
      inputSchema: { slug: z.string(), lark: appLark.manifestSchema },
    }, guard(async (a: { slug: string; lark: appLark.ManifestInput }) => {
      const app = apps.getApp(a.slug);
      if (!app) throw new UserError('err.appNotFound', { slug: a.slug });
      const m = await appLark.setManifest(user, app, a.lark, resolveColleagues(a.lark.notify?.people ?? []));
      const own = m ? await resources.adoptCreated(user, app, m.tables.filter((t) => t.kind !== 'sheet').map((t) => t.app)) : { adopted: [], failed: [] };
      return {
        declared: m && appLark.describeManifest(undefined, { ...app, lark_manifest: JSON.stringify(m) }), sdk: `${appUrl(a.slug)}/__hub/sdk.js`,
        ...(own.adopted.length ? { sharedBases: own.adopted.map((r) => r.name), sharedWith: app.visibility } : {}),
        ...(own.failed.length ? { shareProblems: own.failed } : {}),
      };
    }));
  }

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

  if (LARK) {
    server.registerTool('get_okrs', {
      description: 'Lark OKRs with the user\'s Lark access: objectives and key results with progress (0–1) for a period (default: current), the overall progress and how much of the period has passed.',
      inputSchema: {
        colleague: z.string().optional().describe('whose OKRs (email, name or open_id); default: the user'),
        period_id: z.string().optional().describe('from list_okr_periods; default: the current period'),
      },
    }, guard((a: { colleague?: string; period_id?: string }) => userOkrs(user, { userId: a.colleague ? resolveColleagues([a.colleague])[0] : undefined, periodId: a.period_id, locale })));

    server.registerTool('get_company_okrs', {
      description: 'Everyone\'s Lark OKRs for a period (default: current), read with the user\'s Lark access: each objective with owner, progress and what it aligns to, the company\'s objectives, objectives not aligned to anything, each person\'s average progress and who has no OKRs yet. Good for OKR reviews and weekly reports.',
      inputSchema: { period_id: z.string().optional() },
    }, guard(async (a: { period_id?: string }) => {
      const b = await okrBoard(user, locale, a.period_id);
      return { ...b, people: { total: b.people.total, withOkrs: b.people.withOkrs, without: b.people.without.map((p) => p.name), hidden: b.people.hidden.map((p) => p.name) } };
    }));

    server.registerTool('list_okr_periods', {
      description: 'Lark OKR periods (id, name, date range when it can be read from the name).',
    }, guard(async () => ({ periods: await listPeriods(user, locale) })));

    server.registerTool('read_lark_doc', {
      description: 'Reads a Lark document (or the document behind a wiki page) as Markdown, with the user\'s own Lark access: policies, SOPs, meeting notes, specs. Give its link.',
      inputSchema: { url: z.string().describe('link to a Lark document (/docx/...) or wiki page (/wiki/...)') },
    }, guard((a: { url: string }) => readDoc(user, a.url)));

    server.registerTool('create_lark_doc', {
      description: 'Creates a Lark document from Markdown as the user (they own it) and returns its link. Headings, lists, tables, quotes, code and links carry over; images are left out. Without parent it goes to the user\'s own space; parent can be a wiki page (the document becomes a page under it) or a Drive folder. Show the user the outline first if they have not seen the content, and send them the link afterwards.',
      inputSchema: {
        title: z.string(),
        markdown: z.string().describe('the body, without repeating the title as a heading'),
        parent: z.string().optional().describe('link to a wiki page or Drive folder to put it in'),
      },
    }, guard((a: { title: string; markdown: string; parent?: string }) => createDoc(user, a)));

    server.registerTool('get_daily_report', {
      description: 'The team\'s daily report for a day (default: today, company time zone), read with the user\'s Lark access: each section\'s table (columns, and each person\'s row), the user\'s own rows, and who has not filled theirs in yet. Read it before fill_daily_report to see the sections and columns.',
      inputSchema: { date: z.string().optional().describe('YYYY-MM-DD; default: today') },
    }, guard((a: { date?: string }) => readDailyReport(user, a.date)));

    server.registerTool('fill_daily_report', {
      description: 'Writes the user\'s own rows in the daily report, as the user. Draft the text first (e.g. from github_activity and what the user tells you), show it to the user and write only after they agree. Each row names a section as returned by get_daily_report and gives the columns after the person, in order (e.g. [done yesterday, plan today, blockers]); null or "" leaves a column as it is. Use one line per item.',
      inputSchema: {
        date: z.string().optional().describe('YYYY-MM-DD; default: today'),
        rows: z.array(z.object({ section: z.string(), cells: z.array(z.string().nullable()) })).min(1),
      },
    }, guard((a: { date?: string; rows: { section: string; cells: (string | null)[] }[] }) => fillDailyReport(user, a)));

    server.registerTool('set_daily_report', {
      description: 'Admin: where the daily reports are. folder_url is the Lark wiki page whose child pages are the reports; title is their title with a date placeholder, e.g. "团队工作日报 {MM}{DD}" ({YYYY} {MM} {DD} {M} {D}, in the company time zone).',
      inputSchema: { folder_url: z.string(), title: z.string() },
    }, guard((a: { folder_url: string; title: string }) => setDailyConfig(user, a.folder_url, a.title)));
  }

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

  server.registerTool('check_skill_updates', {
    description: 'Given installed skills (from their .hub-skill.json), return those with newer versions in the market.',
    inputSchema: { installed: z.array(z.object({ slug: z.string(), version: z.number().int() })) },
  }, guard(({ installed }: { installed: { slug: string; version: number }[] }) => {
    const updates = skills.checkUpdates(user, installed);
    return updates.length ? { updates, hint: 'Call install_skill for each to update.' } : { updates: [], message: say({ key: 'note.skillsUpToDate' }) };
  }));

  return server;
}

export async function handleMcp(req: Request, user: User, clientId: string, token: string): Promise<Response> {
  const server = buildMcpServer(user, clientId);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req, { authInfo: { token, clientId, scopes: ['hub'] } });
  } finally {
    void server.close();
  }
}
