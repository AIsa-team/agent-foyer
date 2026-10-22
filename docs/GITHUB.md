# GitHub and the daily report

> [中文](GITHUB.zh-CN.md)

With GitHub connected, agents can ask the hub what someone did in a time window: the commits they made, the pull requests they opened or merged and the ones they reviewed. The usual use is the daily report: the agent reads yesterday's work, drafts it against the report's sections and columns, and after you agree fills it into the Lark report for you.

The hub only **reads** GitHub. It never changes code or comments.

## 1. Create a GitHub App (once)

Anyone can create it; an owner of the organisation approves the installation. In GitHub go to **Settings → Developer settings → GitHub Apps → New GitHub App** (under a personal account or the organisation):

| Field | Value |
|---|---|
| GitHub App name | your hub's name (unique across GitHub) |
| Homepage URL | `https://hub.example.com` |
| Redirect URI | `https://hub.example.com/auth/github/callback` |
| Expire user authorization tokens | leave as is |
| Request user authorization during installation / Device Flow | off |
| Webhook | see step 3; untick **Active** if you don't use it |
| Repository permissions | **Contents**: Read-only; **Pull requests**: Read-only; Metadata becomes Read-only automatically. Nothing else |
| Organization / Account permissions | none |
| Where can this GitHub App be installed? | **Any account** when created under a personal account, or it can't be installed on the organisation |

Then:

1. Note the **App ID** and **Client ID**.
2. **Generate a new client secret** and copy it (shown once).
3. At the bottom, **Generate a private key**; a `.pem` file downloads.
4. **Install App** → pick the organisation → all repositories or the ones you need. If you are not an owner, this becomes a request an owner approves.

## 2. Configure the hub

Put the `.pem` in the hub's data folder (`/data` inside the container with Docker) and add to `.env`:

```
GITHUB_ORG=your-org
GITHUB_APP_ID=123456
GITHUB_CLIENT_ID=Iv23li...
GITHUB_CLIENT_SECRET=...
GITHUB_APP_PRIVATE_KEY=github-app.pem
```

Restart the hub. Everyone clicks "Connect GitHub" once on their Me page; the hub keeps only their GitHub username, not a token.

## 3. Optional: let GitHub push events

GitHub's commit search only covers default branches. Branches with a pull request are fine (the hub reads the pull request's commits), but **work pushed to a branch with no pull request yet** is missed. To count it:

1. Make a random secret (e.g. `openssl rand -hex 32`), put it in `.env` as `GITHUB_WEBHOOK_SECRET=...` and restart.
2. In the App settings tick Webhook **Active**, URL `https://hub.example.com/hooks/github`, the same secret.
3. Under **Subscribe to events** tick **Push**, **Pull request** and **Pull request review**.

The hub checks the signature and keeps pushed commits for 90 days, starting from when this is turned on. Commits are matched to people by the GitHub account their email belongs to.

## 4. The daily report

The hub has no daily-report feature of its own: drafting one is a Skill people choose to install. The example in
[`skills/daily-report`](../skills/daily-report/SKILL.md) finds the day's Lark document under a wiki page
(`list_lark_wiki`), reads its tables (`read_lark_doc` with `tables`), gathers the person's work (`github_activity`,
Linear if their agent has the Linear MCP, what they say) and, after they agree, writes their own cells
(`edit_lark_doc`). Set the wiki page and title pattern at the top of the Skill, then publish it to the Skill market.
Writing asks each person once to let the hub edit Lark documents, the Lark scope `docx:document` (see
[LARK_SETUP](LARK_SETUP.md)).
