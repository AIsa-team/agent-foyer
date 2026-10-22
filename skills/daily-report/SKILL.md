---
name: daily-report
description: Draft and fill in the user's rows of the team's daily report (日报), a Lark document per day, from what they actually did — GitHub activity, Linear issues when the Linear MCP is connected, and what they tell you — and write it as them after they agree. Use when the user asks to write, fill in, update or check their daily report, 日报, 写日报, 填日报, or who has not filled it in.
---

# Daily report

## Where the report is

<!-- Set these three before publishing this Skill to your hub's Skill market. -->
- **Wiki page the reports live under:** `<REPORT_FOLDER_URL>`
- **Title of a day's report:** `<TITLE_PATTERN>` — `{YYYY}` `{MM}` `{DD}` (zero-padded) and `{M}` `{D}` (not padded)
  stand for the date, e.g. `团队工作日报 {MM}{DD}` → 团队工作日报 1022.
- **Time zone the dates are in:** `<TIME_ZONE>`

The report has one table per project or area, under a heading. A table's first column @mentions the person a row
belongs to; the other columns are things like 昨天完成 / 今天计划 / 卡点和需要谁.

## Tools

All from the company hub's MCP server (中台), all with the user's own Lark access:

| Tool | Used for |
|---|---|
| `list_lark_wiki` | the pages under the wiki page; pass `title` to find a day's report |
| `read_lark_doc` with `tables: true` | the report's tables: heading, rows, each cell's id, text and @mentioned people |
| `edit_lark_doc` | replacing the text of the user's own cells, by id |
| `github_activity` | the user's commits, pull requests and reviews |
| `whoami` | the user's id, to find their rows |

If these tools are missing, the hub is not connected to this agent: say so and stop.

## 1. Find and read the report

1. Work out today's title from the pattern (in that time zone), and `list_lark_wiki` with that title. If there is no
   page yet, say which title you looked for; do not create it.
2. `read_lark_doc` with `tables: true`. The user's rows are those whose first cell mentions them (`people` holds
   their id from `whoami`). The header row gives the column names; ignore tables with no row for the user.
3. Also read the previous working day's report: the user's plan there is what they meant to do. Use it to ask
   about items, never as proof they were done.
4. Write in the language of the report (its headings and other people's rows).

## 2. Gather what the user did

Window: since the previous working day's report, by default the last 24 hours; on Monday, since Friday morning.
Use every source that is available and skip the others without fuss:

- **GitHub** — `github_activity`. If it answers `linked: false`, pass its link to the user once and carry on.
- **Linear** — only if this agent has the Linear MCP connected (the official one, `https://mcp.linear.app/mcp`):
  issues assigned to the user that were completed or moved forward in the window, and issues they commented on.
  Do not install or connect it yourself; mention once that it can be connected.
- **The user** — what they tell you, and work done in this conversation.

## 3. Draft

- Fill each of the user's rows column by column. One line per item, the outcome first and short:
  "合并 PR #123：支付回调重试" rather than commit messages. Several commits of one pull request are one line.
  Put each item in the table it belongs to; work that fits no project goes in the general table (e.g. 日常工作).
  Keep identifiers people recognise (#123, ENG-45); add links only if the team's rows have them.
- **Never invent work.** Every item comes from GitHub, Linear or the user. If a source is thin, the row is short.
- Leave the plan and the blockers empty unless the user gave them. If they ask you to suggest a plan, propose it
  from open pull requests and issues in progress, marked as a suggestion for them to confirm.
- Do not replace what the user already wrote in a cell unless they ask; otherwise keep it and add your lines.

## 4. Confirm, then write

- Show the draft as it will appear: per table, per column. After the user agrees, `edit_lark_doc` with one edit
  per cell (`id` from `read_lark_doc`, `text` with a line break between items). Only ever edit the user's own
  cells: never the first column, the header row or anyone else's row.
- If the user asked beforehand for it to be written without asking, write it directly, end the first cell you
  write with "（由 Agent 填写）" (or "(filled in by an agent)" in an English report), and tell them afterwards exactly
  what was written.
- Finish with the report's link and anything you left empty on purpose.

## Who has not filled it in

Read the day's report the same way: people with a row whose other cells are all empty have not filled it in.
Just report it; never write in other people's rows.
