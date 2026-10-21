/**
 * How to build an app on the hub, step by step. Agents get a short version of the principles when they connect (see
 * the instructions in mcp.ts) and call the app_guide tool for this when they start building or changing an app, so the
 * detail lives in one place on the server and is current for everyone.
 */
import { config } from './config.ts';
import { localeCodes } from './localized.ts';
import { mailboxName } from './mail.ts';

export function appGuide(): string {
  const lark = config.lark.enabled;
  const mailbox = mailboxName() || 'mailbox';
  const design = config.designSkills[0];
  return `# Building an app on the ${config.companyName} hub

Work through these steps in order. Decide what you can yourself and say what you decided in the report; only ask the user when you cannot go on without an answer (if you work unattended, put the question in the report instead).

## 0. Look for what exists
- list_my_apps: if an app already does what is asked, improve that one instead of making a second: list_feedback, then get_app_source for the code of its live version (never an old copy you happen to find on disk).
- check_slug for a new subdomain. If a slug or Skill name belongs to someone else, suggest asking them to add the user as a collaborator (set_collaborators).

## 1. Fill in the defaults
- Name: from the request, in every hub language via \`localized\` (${localeCodes().join(', ')}), translated by you.
- Subdomain: short, lowercase, becomes <slug>.${config.appsDomain}.
- Who can open it: what the user said; otherwise only them (private). members = chosen colleagues (find_colleagues), company = everyone in the company, public = the internet (an admin approves).
- Icon: a simple square SVG (flat, rounded, one or two colours, no text) as icon_svg.

## 2. Design the data first
${lark ? `- Business records (customers, deals, requests, statuses, dates, emails, who did what) live in Lark, where colleagues can see, edit, search and chart them. Not only in the browser (localStorage / IndexedDB is one person on one device), and not in the app's server storage: $DATA_DIR is for technical state (caches, idempotency keys, sync cursors).
- The user named a table (Lark Base or spreadsheet; inspect_base shows its columns): use it for what it is. If it is the list the app files into, write its real columns and options, and add only the few columns a person needs to see there (an email, a date, a document link) with add_lark_columns; never rename, remove or repurpose columns. Working data (internal ids, workflow steps, versions, pending operations, email bodies, logs) never goes into a shared table. If the table is a different kind of list (e.g. a sales pipeline when the app files signed deals), or the user cannot edit it, read it as a reference and keep the app's records in a Base of its own, linked by a shared key such as the company name.
- No table named (the usual case): create_lark_base with the tables and typed columns the app needs (date, select with options, person, number, url…, not all text), app=<slug>. It can come before or after publishing; once the app declares it, it is shared with whoever may open the app and stays in step when that changes.
- Documents the app produces (confirmation letters, briefs, reports, minutes) are Lark documents created by the app (hub.lark.createDoc), with each link written back to its record. Each new document is shared with whoever may open the app (view by default; docs.share edit for documents people work on together, none for ones only the author should see, e.g. letters to a client). Documents a team keeps for good (weekly reports, minutes) go best under a wiki page the user names (docs.parent): the wiki then decides who sees them, also after the app's access changes.
- Browser storage only for unsent form drafts and UI preferences.` : `- Business records live in the app's own server storage: a container app storing under $DATA_DIR, serving them read-only as JSON {rows} at a GET path so the team can chart them in the hub (save_data_source); offer a CSV export. Not only in the browser.`}

## 3. Build the interface
${design ? `- install_skill ${config.designSkills.join(', ')} and follow it (web apps: ${design}): its kit, components and templates, starting from the closest template. No other UI library (Bootstrap, Tailwind, MUI, Ant Design…) and no colours or fonts of your own unless the user asks.` : '- If the Skill market has design-system Skills (list_skills), install and follow them instead of another UI library.'}
- Every UI string in locale files (one per hub language), following the person's hub language (/__hub/me → locale). Desktop and 390 px wide, light and dark.
- People are already signed in through the hub: read them from fetch('/__hub/me') → {id, name, email, avatar, locale} in the browser, or the request headers X-Hub-User-Id, X-Hub-User-Name (URI-encoded), X-Hub-User-Email, X-Hub-User-Locale on a server. Never build a login.
- The hub adds a 「feedback」 button to app pages (update_app feedback_button=false hides it when the app has its own).

## 4. Write the logic
${lark ? `- Everything in Lark goes through the hub SDK, as the person using the app: <script src="/__hub/sdk.js"></script> (served only on the app's own domain). Never ask anyone for Lark tokens.
  - hub.lark.records(alias, {where: [{field, op, value}]}) → {records: [{id, fields (raw), text (plain text per column)}]}; ops: is, isNot, contains, doesNotContain, isEmpty, isNotEmpty, isGreater, isLess. Prefer text for display.
  - hub.lark.addRecord(alias, fields) → {id, fields}; hub.lark.updateRecord(alias, id, fields) → {id, fields}; hub.lark.fields(alias) → {fields: [{name, type}]}.
  - Values to write: text and numbers as they are, single select as the option name, multi select as an array of names, dates as ms timestamps, people as [{id: <id from hub.me()>}], links as {text, link}.
  - A spreadsheet works like a table: row 1 holds the column names, records are rows (id row<N>), addRecord appends a row, updateRecord changes the named columns of one row (plain values).
  - hub.lark.createDoc({title, markdown}) → {title, url, sharedWith}: a Lark document as the person, shared as declared (declare docs).
  - hub.lark.mailDraft({to, cc, subject, html}) → {ok: true}: a draft in their own ${mailbox}, never sent (declare mail_drafts).
  - hub.notify({to: [...], text, link}): the hub bot messages declared people and groups (by name or alias), or, with notify.app_users declared, anyone who may open the app by their id (from hub.me(), e.g. kept on the record of whoever submitted it) or email. Never list the whole company to reach whoever submitted something.
  - hub.me() → {id, name, email, avatar, locale}.
  - The first time, the SDK takes the person to the hub to agree and back by itself. Errors throw an Error whose message is meant for people: show it.
- Container app servers call the same paths at $HUB_APP_URL/__hub/… with the X-Hub-Ticket header from the incoming request.` : '- Read and write your own storage on the server; the person comes from the X-Hub-User-* headers.'}
- Side effects can time out after they happened (a document made, a draft saved, a row added): do not retry blindly; mark them to check and let the person confirm.
- Never put secrets in the upload; use set_app_env for API keys.

## 5. Check it locally
- Run the main flow against a fake hub object (stub /__hub/* or window.hub) and look at screenshots at desktop and 390 px, light and dark, in each language.
- Do not write test rows, drafts or documents into the user's real tables or mailbox.

## 6. Publish and declare
- kind: static (HTML/JS/CSS or a frontend build: upload the build output) or container (needs a server: upload the source; the hub builds it from its Dockerfile, or makes one for Node with a "start" script or Python with main.py/app.py; listen on $PORT, default 3000, host 0.0.0.0; files under $DATA_DIR persist). A browser extension or desktop tool gets a static download page instead.
- create_upload(purpose="app"), run the command it returns (exclude node_modules, .git, .env, secrets), then publish_app. When what you upload is a build (e.g. dist), also upload the project folder with create_upload(purpose="source") and pass it as source_upload_id, so whoever changes the app next gets its code (get_app_source). Container uploads are their own source.
${lark ? `- set_app_lark: the tables (alias, link, read or write), docs (optionally under a wiki page or folder, and how they are shared), mail_drafts, and whom it may notify (named people and groups, and/or app_users). Without ?table= / ?sheet= in a link, a Base or spreadsheet with a single table is used as is.` : ''}

## 7. Check it online
- get_app_status: the build succeeded, it runs, and its logs are clean. People who may not open it are sent to sign in.

## 8. Report to the user
Keep it short and cover:
1. The link and who can open it.
2. Where the data is: the Base or table, columns created or added, where documents go and who can see them.
3. What the person does the first time (e.g. agree to the app's Lark access, connect their mailbox).
4. What was not checked for real (e.g. writing to Lark, saving a draft).
5. The defaults you chose and anything left open.

## Afterwards
- Feedback: list_feedback, change and republish, then resolve_feedback each item with a short reply (the sender is told). For someone else's app or Skill, send_feedback after the user has seen the text.
- Collaborators publish and change settings like the owner; only the owner (or an admin) deletes the app, changes collaborators or hands it over (transfer_ownership).
`;
}
