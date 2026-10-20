import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { paths } from './config.ts';

export const db = new DatabaseSync(paths.db);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,            -- Lark open_id
    name TEXT NOT NULL,
    en_name TEXT,
    email TEXT,
    avatar TEXT,
    role TEXT NOT NULL DEFAULT 'member',  -- admin | member
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_slug TEXT,                  -- null = hub session, otherwise a session scoped to one app subdomain
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE login_codes (        -- one-time codes handed from hub to an app subdomain
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_slug TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,    -- JSON array
    created_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,             -- access | refresh | pat
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,        -- oauth client id, or pat:<id> for personal tokens
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE agent_connections (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    connected_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, client_id)
  );

  CREATE TABLE apps (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon TEXT,                      -- file name under data/icons
    owner_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,             -- static | container
    visibility TEXT NOT NULL DEFAULT 'private',  -- private | members | company | public
    public_status TEXT NOT NULL DEFAULT 'none',  -- none | pending | approved | rejected
    status TEXT NOT NULL DEFAULT 'building',     -- building | online | stopped | failed
    current_release INTEGER,
    env_enc TEXT,                   -- encrypted JSON of env vars for container apps
    container_port INTEGER NOT NULL DEFAULT 3000,
    upstream TEXT,                  -- http://host:port for container apps
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE app_members (
    app_slug TEXT NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (app_slug, user_id)
  );
  CREATE TABLE app_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_slug TEXT NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,           -- building | online | failed | superseded
    root TEXT,                      -- static apps: folder inside the release that is served
    log TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,          -- app | skill
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | received | used
    size INTEGER,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE skills (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,             -- display name (may be Chinese)
    description TEXT NOT NULL DEFAULT '',
    owner_id TEXT NOT NULL REFERENCES users(id),
    latest_version INTEGER NOT NULL,
    listed INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE skill_versions (
    skill_slug TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    size INTEGER NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (skill_slug, version)
  );
  CREATE TABLE skill_installs (
    skill_slug TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    installed_at INTEGER NOT NULL,
    PRIMARY KEY (skill_slug, user_id)
  );

  CREATE TABLE lark_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',  -- emoji or image url
    sort INTEGER NOT NULL DEFAULT 0
  );
  `,
  `CREATE UNIQUE INDEX app_releases_version ON app_releases (app_slug, version);`,
  `ALTER TABLE users ADD COLUMN locale TEXT;`,
  // per-language display name and one-line description: {"zh-CN": {"name": "...", "description": "..."}, "en": {...}}
  `ALTER TABLE apps ADD COLUMN i18n TEXT; ALTER TABLE skills ADD COLUMN i18n TEXT;`,
  // the resources ("资料") page: company culture text, and grouped links to policies/SOPs and brand material
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE resource_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL,          -- policies | brand
    name_i18n TEXT NOT NULL,        -- {"zh-CN": "...", "en": "..."}
    note_i18n TEXT,                 -- optional subtitle, e.g. the owning department
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES resource_groups(id) ON DELETE CASCADE,
    title_i18n TEXT NOT NULL,
    desc_i18n TEXT,
    url TEXT NOT NULL,
    owner_name TEXT,
    preview TEXT,                   -- brand cards: brand | slides | ui (picks the illustration)
    app_slug TEXT,                  -- optional: the hub app that hosts it
    skill_slug TEXT,                -- optional: the Skill that teaches agents to use it
    sort INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // departments from the Lark directory, and agent-built home pages per person / department / company
  `
  CREATE TABLE departments (
    id TEXT PRIMARY KEY,            -- open_department_id
    name TEXT NOT NULL,
    name_i18n TEXT,                 -- {"zh-CN": "...", "en": "..."} from Lark i18n_name
    parent_id TEXT,
    leader_ids TEXT,                -- JSON array of open_ids
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE user_departments (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, department_id)
  );
  CREATE TABLE homepages (
    scope TEXT NOT NULL,            -- user | department | company
    owner_id TEXT NOT NULL,         -- user id, department id, or 'company'
    layout TEXT NOT NULL,           -- JSON, see server/homepage.ts
    updated_by TEXT REFERENCES users(id),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, owner_id)
  );
  CREATE TABLE homepage_previews (
    token_hash TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    layout TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  `,
  // skill icons, and an optional one-to-one link between an app and a Skill (e.g. a design system site and the
  // Skill that teaches agents to use it). Stored on the app; a Skill shows the app that points at it.
  `
  ALTER TABLE skills ADD COLUMN icon TEXT;
  ALTER TABLE apps ADD COLUMN skill_slug TEXT REFERENCES skills(slug) ON DELETE SET NULL;
  CREATE UNIQUE INDEX apps_skill_slug ON apps (skill_slug) WHERE skill_slug IS NOT NULL;
  `,
  // Lark data: each person's own Lark tokens (encrypted), Base tables registered as data sources, and alert rules
  `
  CREATE TABLE lark_tokens (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_enc TEXT NOT NULL,
    access_expires_at INTEGER NOT NULL,
    refresh_enc TEXT,
    refresh_expires_at INTEGER,
    scopes TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE data_sources (
    id TEXT PRIMARY KEY,            -- slug used in home layouts and alert rules
    title_i18n TEXT NOT NULL,       -- {"zh-CN": "...", "en": "..."}
    url TEXT NOT NULL,              -- the link people open in Lark
    app_token TEXT NOT NULL,        -- Base app token (resolved from wiki links)
    table_id TEXT NOT NULL,
    view_id TEXT,
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title_i18n TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    query TEXT NOT NULL,            -- JSON, see server/data/query.ts
    condition TEXT NOT NULL,        -- JSON, see server/data/alerts.ts
    recipients TEXT NOT NULL,       -- JSON array of open_ids told in Lark (they also see it on their home page)
    chat_id TEXT,                   -- optional Lark group the bot also posts to
    every_minutes INTEGER NOT NULL DEFAULT 60,
    owner_id TEXT NOT NULL REFERENCES users(id),  -- checks run with this person's Lark access
    enabled INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'pending',        -- pending | ok | firing | error
    last_value REAL,
    last_detail TEXT,
    last_error TEXT,
    last_checked_at INTEGER,
    state_since INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // alert messages: what people were last told (so flapping and repeats are held back), and who opted out
  `
  ALTER TABLE alert_rules ADD COLUMN notified_state TEXT;  -- ok | firing; NULL = never told (same as ok)
  ALTER TABLE alert_rules ADD COLUMN notified_at INTEGER;
  ALTER TABLE alert_rules ADD COLUMN muted TEXT NOT NULL DEFAULT '[]';  -- user ids who asked not to be messaged
  `,
  // data checks ("异常项"): rules that find records needing a fix, and the records they found
  `
  CREATE TABLE data_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title_i18n TEXT NOT NULL,
    hint_i18n TEXT,                 -- how to fix it
    source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    level TEXT NOT NULL,            -- error | verify | style  (确定错误 / 需核实 / 写法不统一)
    team_i18n TEXT,                 -- who usually fixes it, e.g. {"zh-CN": "财务"}
    spec TEXT NOT NULL,             -- JSON, see server/data/checks.ts
    owner_field TEXT,               -- person field naming who must fix each record
    label_fields TEXT NOT NULL,     -- JSON array: fields that identify a record in the list
    owner_id TEXT NOT NULL REFERENCES users(id),   -- runs with this person's Lark access
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE data_issues (
    check_id INTEGER NOT NULL REFERENCES data_checks(id) ON DELETE CASCADE,
    record_id TEXT NOT NULL,
    label TEXT NOT NULL,
    detail TEXT NOT NULL,           -- JSON: the field values that make it an issue
    owners TEXT NOT NULL,           -- JSON array of {id, name} from the owner field
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (check_id, record_id)
  );
  CREATE TABLE data_exceptions (
    check_id INTEGER NOT NULL REFERENCES data_checks(id) ON DELETE CASCADE,
    record_id TEXT NOT NULL,
    reason TEXT,
    by_user TEXT NOT NULL REFERENCES users(id),
    at INTEGER NOT NULL,
    PRIMARY KEY (check_id, record_id)
  );
  `,
  // apps that use Lark as the person using them: what each app declared (tables, who it may notify), each person's
  // consent to it, and a log for the notification rate limit
  `
  ALTER TABLE apps ADD COLUMN lark_manifest TEXT;   -- JSON, see server/apps/larkApi.ts
  CREATE TABLE app_lark_consents (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_slug TEXT NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    manifest_hash TEXT NOT NULL,    -- consent covers exactly this declaration; a changed one asks again
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, app_slug)
  );
  CREATE TABLE app_notify_log (app_slug TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX app_notify_log_app ON app_notify_log (app_slug, at);
  `,
  // data boards: shared dashboards on the 数据 page, for the company or one department, built by agents
  `
  CREATE TABLE boards (
    id TEXT PRIMARY KEY,
    title_i18n TEXT NOT NULL,
    department_id TEXT REFERENCES departments(id) ON DELETE CASCADE,  -- NULL = company-wide
    layout TEXT NOT NULL,           -- same module layout as home pages (server/homepage.ts)
    sort INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT REFERENCES users(id),
    updated_at INTEGER NOT NULL
  );
  `,
  // data sources served by hub apps (rows as JSON), and a link back for issues found in them
  `
  ALTER TABLE data_sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'base';  -- base | app
  ALTER TABLE data_sources ADD COLUMN app_slug TEXT;
  ALTER TABLE data_sources ADD COLUMN app_path TEXT;
  ALTER TABLE data_issues ADD COLUMN url TEXT;
  `,
];

{
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

type Params = SQLInputValue[];

export function get<T>(sql: string, ...params: Params): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T>(sql: string, ...params: Params): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: Params) {
  return db.prepare(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const now = () => Date.now();

export interface User {
  id: string;
  name: string;
  en_name: string | null;
  email: string | null;
  avatar: string | null;
  role: 'admin' | 'member';
  locale: string | null;
  created_at: number;
  last_seen_at: number | null;
}

export interface App {
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  owner_id: string;
  kind: 'static' | 'container';
  visibility: 'private' | 'members' | 'company' | 'public';
  public_status: 'none' | 'pending' | 'approved' | 'rejected';
  status: 'building' | 'online' | 'stopped' | 'failed';
  current_release: number | null;
  env_enc: string | null;
  container_port: number;
  upstream: string | null;
  i18n: string | null;
  skill_slug: string | null;
  lark_manifest: string | null;
  created_at: number;
  updated_at: number;
}

export interface Skill {
  slug: string;
  name: string;
  description: string;
  owner_id: string;
  latest_version: number;
  listed: number;
  i18n: string | null;
  icon: string | null;
  created_at: number;
  updated_at: number;
}
