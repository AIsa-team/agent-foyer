/**
 * Lark as an integration of the hub (integration.ts). Lark is also the company's platform, brought in as the channel
 * (channels.ts: sign-in, directory, Base data sources, messages); this module adds what is Lark's own: its API routes,
 * connecting Lark data and the consent pages (web.ts), the agent tools (tools.ts), the agents' paragraph about them,
 * and the long connection and the AI twin's rounds.
 */
import { config } from '../config.ts';
import { UserError } from '../i18n/index.ts';
import type { Integration } from '../integration.ts';
import { startLarkEvents } from './events.ts';
import { createDraft } from './mail.ts';
import { LARK_ONLY, larkApi } from './routes.ts';
import { larkAppTools, larkDataTools, larkTwinTools, larkWorkTools } from './tools.ts';
import { startTwin } from './twin.ts';
import { larkWeb } from './web.ts';

export const lark: Integration = {
  id: 'lark',
  enabled: () => config.lark.enabled,
  api(r) {
    // without Lark, its paths say Lark is off
    if (config.lark.enabled) r.route('/', larkApi);
    else for (const p of LARK_ONLY) r.use(p, () => { throw new UserError('err.lark.disabled'); });
  },
  web(r) {
    r.route('/', larkWeb);
  },
  tools(kit) {
    larkDataTools(kit);
    larkAppTools(kit);
    larkWorkTools(kit);
    larkTwinTools(kit);
  },
  // Lark Mail's access is part of "connect Lark data", asked for by the app's consent
  mailbox: { name: 'Lark Mail', connectUrl: () => null, saveDraft: createDraft },
  instructions: () => `Lark documents: search_lark_docs finds documents and wiki pages by keyword (only what the user may open); read_lark_doc reads one as Markdown (tables: true adds each table cell by cell, with ids); edit_lark_doc changes the text of cells and paragraphs by those ids or adds Markdown at the end; list_lark_wiki lists the pages under a wiki page (e.g. to find one by its title); create_lark_doc writes Markdown into a new document the user owns (their own space, or under a wiki page / in a folder they give). Files in the wiki or Drive (e.g. an uploaded HTML page) are read with read_lark_doc too; upload_lark_file puts a file there (e.g. an HTML page, which Lark shows as a web page). All of it is done as the user, with their own Lark access. The first time the user writes, they are asked once to let the hub create and edit documents.\nCalendar: list_calendar_events reads the user's own Lark calendar (read-only), e.g. "what meetings do I have this afternoon" or the meetings of a day for a daily report. The first time, the user is asked once to allow reading their calendar. Lark itself reminds people before events; the hub cannot create or change events. The agenda home module {type: "agenda"} shows each viewer their own day.\nMessages: send_lark_message sends a Lark message, and optionally a file, as the user to colleagues (e.g. "send Alex the quote and tell him the meeting moved to three"), once the user turned it on on their Me page; each message ends with a line saying it was sent by the user's AI twin. The user confirms each message: in a question your app shows them (then it is sent in the same call), or, if your app cannot show one, in two steps: a preview with a send_code, then calling again with only that send_code after the user agreed to exactly that message and those recipients (unless the user turned confirming off, then it is sent at once and you tell them what went out). Once the user also turned reading on, read_lark_messages reads one conversation as them (a colleague's replies, a group's recent discussion via find_lark_chat, files people sent them); read only the conversation the user asked about.\nAI twin (分身): when the user asks you to act as their twin or keep an eye on their Lark messages, call twin_guide first and follow it. Phase one is shadow mode: you predict whether and how they would reply (record_prediction) and learn from what they actually did; nothing is sent.\nOKRs: the company tracks goals in Lark OKR. get_okrs reads them with the user's Lark access (default: their own, current period). To show them on a home page, add a module {type: "okr"}; without \`user\` everyone sees their own, so it suits department and company layouts.\n`,
  start() {
    startLarkEvents();
    startTwin();
  },
};
