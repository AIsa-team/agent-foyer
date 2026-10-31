/**
 * What agents get from the hub only when it signs in with Lark: reading Base tables and spreadsheets, apps keeping
 * their records in Lark, OKRs, documents and the calendar. Everything runs as the person, with their own Lark access.
 * The MCP server registers these at the same places as before, only on a hub with Lark (see buildMcpServer).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appUrl, config } from '../config.ts';
import type { User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import * as apps from '../apps/service.ts';
import * as appLark from '../apps/larkApi.ts';
import * as resources from '../apps/resources.ts';
import { connection, connectUrl } from './userToken.ts';
import { listPeriods, userOkrs } from './okr.ts';
import { okrBoard } from './okrBoard.ts';
import * as workspace from './workspace.ts';
import { inspect } from './baseSource.ts';
import { createDoc, editDoc, listWiki, readDoc, searchDocs } from './docs.ts';
import { calendarEvents, localTime, today as calendarToday } from './calendar.ts';
import { sendOrPrepare, sendPrepared, type FileRef } from './messages.ts';
import { findChats, readMessages } from './reading.ts';

/** What a group of tools needs from the server being built: the person, their language and the result wrapper. */
export interface ToolKit {
  server: McpServer;
  user: User;
  locale: string;
  guard: <A>(fn: (args: A) => Promise<unknown> | unknown) => (args: A) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
  resolveColleagues: (refs: string[]) => string[];
}

/** Whether the person connected their Lark data, and looking inside a Base or spreadsheet. */
export function larkDataTools({ server, user, guard }: ToolKit) {
  server.registerTool('lark_data_status', {
    description: 'Whether the user has connected their Lark data (needed before reading Base tables). If not, returns the link they open once to approve.',
  }, guard(() => {
    const c = connection(user.id);
    return c.connected ? c : { ...c, connectUrl: connectUrl('/me'), hint: 'Send this link to the user; they approve in Lark, then call again.' };
  }));

  server.registerTool('inspect_base', {
    description: 'Look inside a Lark Base (Bitable) or spreadsheet link with the user\'s Lark access. Base: its tables, and for the chosen table (from ?table= in the link, or `table`) the fields with their types and 5 sample rows. Spreadsheet: its sheets, and for the chosen sheet (?sheet= or `table`) the columns from row 1 and the last 5 rows.',
    inputSchema: { url: z.string().describe('a Lark Base, spreadsheet or wiki link, e.g. https://xxx.larksuite.com/base/AbC…?table=tbl… or …/sheets/AbC…?sheet=…'), table: z.string().optional().describe('table id (Base) or sheet id (spreadsheet)') },
  }, guard((a: { url: string; table?: string }) => inspect(user, a.url, a.table)));
}

/** Apps that keep their records and documents in Lark, as the person using them. */
export function larkAppTools({ server, user, locale, guard, resolveColleagues }: ToolKit) {
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

/** OKRs, documents and the calendar. */
export function larkWorkTools({ server, user, locale, guard, resolveColleagues }: ToolKit) {
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
    description: 'Reads a Lark document (or the document behind a wiki page) as Markdown, with the user\'s own Lark access: policies, SOPs, meeting notes, specs, reports. Give its link. tables: true also returns each table under the heading it sits under, row by row, each cell with its id, text and the people @mentioned in it, for edit_lark_doc.',
    inputSchema: {
      url: z.string().describe('link to a Lark document (/docx/...) or wiki page (/wiki/...)'),
      tables: z.boolean().optional(),
    },
  }, guard((a: { url: string; tables?: boolean }) => readDoc(user, a.url, { tables: a.tables })));

  server.registerTool('list_calendar_events', {
    description: 'The user\'s own events in their Lark primary calendar, read with their Lark access: title, start and end (company time zone), all-day or not, location, meeting rooms, video meeting link, organizer, link to the event and its description. Recurring events are expanded; cancelled ones are left out. Dates are YYYY-MM-DD in the company time zone; default today; at most 31 days.',
    inputSchema: {
      from: z.string().optional().describe('first day, YYYY-MM-DD (default today)'),
      to: z.string().optional().describe('last day, YYYY-MM-DD (default = from)'),
    },
  }, guard(async (a: { from?: string; to?: string }) => {
    const from = a.from ?? calendarToday();
    const events = await calendarEvents(user, from, a.to ?? from);
    return {
      timezone: config.timezone, from, to: a.to ?? from,
      events: events.map((e) => ({
        title: e.title, allDay: e.allDay,
        start: e.allDay ? localTime(e.start).slice(0, 10) : localTime(e.start),
        end: e.allDay ? localTime(e.end - 86_400_000).slice(0, 10) : localTime(e.end),
        ...(e.location ? { location: e.location } : {}), ...(e.rooms.length ? { rooms: e.rooms } : {}),
        ...(e.meetingUrl ? { meetingUrl: e.meetingUrl } : {}), ...(e.organizer ? { organizer: e.organizer } : {}),
        ...(e.free ? { showsAsFree: true } : {}), ...(e.link ? { link: e.link } : {}),
        ...(e.description ? { description: e.description.length > 1000 ? `${e.description.slice(0, 1000)}…` : e.description } : {}),
      })),
    };
  }));

  server.registerTool('search_lark_docs', {
    description: 'Searches Lark documents and wiki pages by keyword with the user\'s own Lark access (only what they may open), most relevant first: title, type, link, a matching snippet, owner and when it changed. Use it to find a document by name or topic, then read_lark_doc with its link. The first time, the user is asked once to allow searching.',
    inputSchema: {
      query: z.string().describe('keywords, at most 50 characters'),
      title_only: z.boolean().optional().describe('match titles only'),
      where: z.enum(['all', 'docs', 'wiki']).optional().describe('documents in Drive, wiki pages, or both (default)'),
      limit: z.number().int().min(1).max(50).optional().describe('default 20'),
    },
  }, guard((a: { query: string; title_only?: boolean; where?: 'all' | 'docs' | 'wiki'; limit?: number }) => searchDocs(user, a.query, { titleOnly: a.title_only, where: a.where, limit: a.limit })));

  server.registerTool('list_lark_wiki', {
    description: 'The pages under a Lark wiki page (title, link, type, when created), with the user\'s own Lark access, e.g. to find a page by its title among many. title keeps the pages whose title contains it.',
    inputSchema: { url: z.string().describe('link to the wiki page (/wiki/...)'), title: z.string().optional() },
  }, guard((a: { url: string; title?: string }) => listWiki(user, a.url, a.title)));

  server.registerTool('edit_lark_doc', {
    description: 'Changes a Lark document as the user: edits replace the whole text of table cells or paragraphs by their id (from read_lark_doc with tables: true; a line break starts a new paragraph in a cell), append adds Markdown at the end. The user can only change documents they may edit in Lark, and Lark shows them as the editor. Read the document first, change only what the user meant, and keep everything else.',
    inputSchema: {
      url: z.string().describe('link to the document or wiki page'),
      edits: z.array(z.object({ id: z.string(), text: z.string() })).max(200).optional(),
      append: z.string().optional().describe('Markdown to add at the end'),
    },
  }, guard((a: { url: string; edits?: { id: string; text: string }[]; append?: string }) => editDoc(user, a.url, a)));

  server.registerTool('create_lark_doc', {
    description: 'Creates a Lark document from Markdown as the user (they own it) and returns its link. Headings, lists, tables, quotes, code and links carry over; images are left out. Without parent it goes to the user\'s own space; parent can be a wiki page (the document becomes a page under it) or a Drive folder. Show the user the outline first if they have not seen the content, and send them the link afterwards.',
    inputSchema: {
      title: z.string(),
      markdown: z.string().describe('the body, without repeating the title as a heading'),
      parent: z.string().optional().describe('link to a wiki page or Drive folder to put it in'),
    },
  }, guard((a: { title: string; markdown: string; parent?: string }) => createDoc(user, a)));

  server.registerTool('send_lark_message', {
    description: 'Sends a Lark message, and optionally a file, as the user (colleagues see it from them), only if the user turned this on (Me page, Lark data card). Every message ends with a line saying it was sent by the user\'s AI twin. Two steps: call with to, text and/or file to get a preview and a send_code; show the user exactly who gets what; only after they agree, call again with only send_code (copied from the preview result, valid 10 minutes) and that exact message is sent. The user also gets the preview in Lark as a card with Send and Don\'t send; if they used it, calling with the send_code says so, and nothing is sent twice. Calling with to/text again never sends; it only repeats the preview. Never send anything the user has not seen. If the user turned off confirming on their Me page, the first call sends at once (the result says so): only call it when they asked for that message, and tell them afterwards what went to whom. Up to 10 colleagues. For a file (at most 30 MB): create_upload with purpose "file", upload it with the command it gives, then pass file {upload_id, name}.',
    inputSchema: {
      to: z.array(z.string()).max(10).optional().describe('colleagues: email, name or open_id'),
      text: z.string().optional(),
      file: z.object({ upload_id: z.string(), name: z.string().describe('the file name the recipients see, e.g. 报价单.pdf') }).optional(),
      send_code: z.string().optional().describe('the send_code from the preview result (8 characters), once the user agreed: sends that message'),
    },
  }, guard((a: { to?: string[]; text?: string; file?: FileRef; send_code?: string }) =>
    (a.send_code ? sendPrepared(user, a.send_code.trim()) : sendOrPrepare(user, resolveColleagues(a.to ?? []), a.text ?? '', a.file ?? null, locale))));

  server.registerTool('read_lark_messages', {
    description: 'Reads one Lark conversation as the user, only if they turned reading on (Me page, Lark data card): their direct chat with a colleague (e.g. what they replied) or a group chat (chat_id from find_lark_chat). Recent messages, oldest first, with sender, time (company time zone) and text; files and images come with a download link valid 10 minutes. Read only the conversation the user asked about.',
    inputSchema: {
      colleague: z.string().optional().describe('the colleague of a direct chat: email, name or open_id'),
      chat_id: z.string().optional().describe('a group chat, from find_lark_chat'),
      hours: z.number().positive().max(24 * 90).optional().describe('only messages from the last this many hours'),
      limit: z.number().int().min(1).max(100).optional().describe('most recent messages to read, default 30'),
    },
  }, guard((a: { colleague?: string; chat_id?: string; hours?: number; limit?: number }) =>
    readMessages(user, { ...a, colleague: a.colleague ? resolveColleagues([a.colleague])[0] : undefined })));

  server.registerTool('find_lark_chat', {
    description: 'Finds Lark group chats the user is in (or may see) by a word in their name or a member\'s name, as the user, only if they turned reading on. Returns chat_id and name for read_lark_messages.',
    inputSchema: { query: z.string().describe('part of the group name, or a member\'s name') },
  }, guard((a: { query: string }) => findChats(user, a.query)));
}
