# Lark setup

> [中文](LARK_SETUP.zh-CN.md)

The hub needs a Lark **custom app** to sign people in and read the directory. It takes about 15 minutes and a Lark
admin (the last step is an approval). Feishu works the same way: set `LARK_DOMAIN=feishu.cn` and use
<https://open.feishu.cn/app>.

Menu names follow the English console and may drift as Lark redesigns it; look for the closest match.

## 1. Create the app

1. Open <https://open.larksuite.com/app> and click **Create Custom App**.
2. Name it after your hub (e.g. "Acme Hub"), describe it as "Company apps and Skills", and upload an icon
   (`web/public/brand/app-icon.svg` or your own).
3. Under **Credentials & Basic Info**, copy the **App ID** and **App Secret** into the server's `.env`:

   ```
   LARK_APP_ID=cli_xxxxxxxx
   LARK_APP_SECRET=xxxxxxxx
   LARK_DOMAIN=larksuite.com
   ```

## 2. Web app

Under **Features → Web App**, turn it on and set:

| Field | Value |
|---|---|
| Desktop homepage | `https://hub.example.com` |
| Mobile homepage | `https://hub.example.com` |

## 3. Security settings

Under **Security Settings**:

- **Redirect URLs**: add `https://hub.example.com/auth/callback`
- **H5 Trusted Domains**: add `https://hub.example.com`

## 4. Permissions

Under **Permissions & Scopes**, add the following (searching for the code name is fastest):

| Scope | Why |
|---|---|
| `contact:user.base:readonly` | name and avatar at sign-in |
| `contact:user.email:readonly` | email, used for admin settings and choosing colleagues by email |
| `contact:contact.base:readonly` | syncing the directory (departments and members); without it Lark returns 99991672 |

When Lark asks which data a scope covers, choose **the same as the app's availability**: people outside it cannot
sign in anyway. The directory sync only reads departments and members in that range, so colleagues who have never
signed in can still be chosen for "chosen colleagues".

### Lark data (Base, OKR, alerts)

Charts, OKRs, alerts, and agents reading Lark data all use **each person's own Lark permissions**: everyone clicks
"Connect Lark data" once on their "Me" page and agrees in Lark. A table you can't open in Lark you can't see in the
hub either. This is separate from sign-in, so sign-in keeps working while the scopes below wait for approval.

Add these **user** scopes (user_access_token):

| Scope | Why |
|---|---|
| `offline_access` | a refresh token, so people don't re-authorise every two hours |
| `bitable:app:readonly` | read Base tables, fields and records |
| `wiki:wiki:readonly` | resolve a Base that lives in a wiki to its table |
| `bitable:app` **optional** | only for apps that **write** to Base (e.g. an invoice helper adding a request); only requested in such apps, when the person using it agrees |
| `okr:okr:readonly` | "My OKRs" on the home page and agents reading OKRs, as far as this person can see them in Lark OKR |
| `docx:document:readonly` | agents reading Lark documents (policies, SOPs, daily reports) the person can open |
| `docx:document`, `docx:document:create` **optional** | an agent creating a Lark document for the person (from Markdown), or changing one they may edit (e.g. their own cells of the daily report); only requested when someone first does that |
| `calendar:calendar:readonly` **optional** | the home page's agenda module and agents' `list_calendar_events`: reading the person's own calendar, read-only; only requested when someone first uses it |
| `search:docs:read` **optional** | agents' `search_lark_docs`: searching the documents and wiki pages the person may open, by keyword; only requested when someone first uses it |
| `wiki:wiki` **optional** | an agent putting a new document under a wiki page; only requested the first time someone does that |

Alerts are sent by the hub's bot in Lark:

1. **Features → Bot**: turn on the bot.
2. Add `im:message:send_as_bot` (a **tenant** scope: send messages as the app).
3. To send alerts to a group: add the hub's bot to the group and give the group ID (starting with `oc_`) to your agent.

To avoid noise: one message per rule per 6 hours at most (values flapping back and forth are merged); nothing between
22:00 and 09:00, held and merged into one morning message; several alerts for one person merged into one message;
anyone can click "Stop telling me" on their home page. **By default only hub admins get messages**; other
recipients see alerts on their home page. Admins can switch messages on for all recipients on the Admin page. Tune
the windows with `ALERT_COOLDOWN_MINUTES` and `ALERT_QUIET_HOURS` (e.g. `22-9`, or `off`), in `HUB_TIMEZONE`.

Agents sending and reading Lark messages as the person (optional; each person turns it on in the Lark card of their Me
page, and Lark asks them for these when they do):

| Scope | Why |
|---|---|
| `im:message`, `im:message.send_as_user` | `send_lark_message`: messages sent as the person, each one previewed first |
| `im:resource` | sending a file with a message |
| `im:message:readonly`, `im:message.p2p_msg:get_as_user`, `im:message.group_msg:get_as_user`, `im:chat:read` | `read_lark_messages` and `find_lark_chat`: reading the one conversation the person asks about |

The bot also shows the person each preview as a card with **Send** and **Don't send**. Taps reach the hub over a long
connection the hub opens to Lark, so no public callback address is needed: under **Events & Callbacks → Callback
Configuration**, choose **Receive callbacks through persistent connection** (with the hub running, so Lark sees it
connected), add **Card action trigger** (`card.action.trigger`), and release a new version. Without it the card still
shows the preview, and people confirm in their agent.

No extra redirect URL is needed: connecting Lark data uses the same `https://hub.example.com/auth/callback`.

## 5. Release

1. **App Versions → Create Version**.
2. Set **Availability** to the whole company.
3. Submit; a Lark admin approves it under **Lark Admin → Workplace → App Review**.

## 6. Put the hub on the workplace

- Simplest: under **Lark Admin → Workplace → Workplace Settings**, add the hub to everyone's frequently used apps and
  pin it.
- To replace the Lark workplace with the hub entirely: if your plan supports a customised workplace, choose "use a web
  page as the workplace" and enter `https://hub.example.com`. Where this lives depends on the plan; ask your Lark
  customer success manager if you can't find it.

## 7. Finish

1. Put the admins' Lark emails in `HUB_ADMINS` in `.env` and restart the hub.
2. After the first admin signs in, click **Admin → Sync Lark directory** once (it then syncs every 6 hours).
3. Under **Admin → Lark app shortcuts**, add the Lark apps people use most (approvals, Base, attendance…); copy their
   AppLinks from the Lark admin console.
