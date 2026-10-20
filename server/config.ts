import { mkdirSync } from 'node:fs';
import path from 'node:path';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var ${name}`);
}

const hubUrl = new URL(env('HUB_URL', 'http://localhost:8080'));
const larkAppId = process.env.LARK_APP_ID ?? '';

export const config = {
  port: Number(env('PORT', '8080')),
  /** Public URL of the hub itself, e.g. https://hub.example.com */
  hubUrl: hubUrl.origin,
  hubHost: hubUrl.host,
  secure: hubUrl.protocol === 'https:',
  /** Parent domain of deployed apps: <slug>.<appsDomain>. Dev default works in Chrome/curl via *.localhost */
  appsDomain: env('APPS_DOMAIN', `apps.localhost${hubUrl.port ? ':' + hubUrl.port : ''}`),
  appsProtocol: env('APPS_PROTOCOL', hubUrl.protocol.replace(':', '')),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  /** Used to sign cookies and encrypt app env vars. Must be stable in production. */
  secret: env('HUB_SECRET', larkAppId ? undefined : 'dev-only-secret-change-me'),
  companyName: env('COMPANY_NAME', 'Acme'),
  /** Name agents register the hub's MCP server under (shown in the "connect your agent" prompt) */
  mcpName: env('HUB_MCP_NAME', 'agent-hub'),
  /** Folder with the company's own logo.svg / app-icon.svg / motif.svg; built-in neutral ones are used otherwise */
  brandDir: process.env.HUB_BRAND_DIR ? path.resolve(process.env.HUB_BRAND_DIR) : '',
  /** Brand colour for buttons and highlights (hex), e.g. #F76918; empty keeps the default theme */
  accent: /^#[0-9a-f]{6}$/i.test(process.env.HUB_ACCENT ?? '') ? process.env.HUB_ACCENT! : '',
  /** Skills in the market that hold the company's design system; agents use them for anything visual */
  designSkills: env('HUB_DESIGN_SKILLS', '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Language for messages when nothing tells us the person's language (BCP 47, must be a supported locale) */
  defaultLocale: env('DEFAULT_LOCALE', 'en'),
  /** Extra subdomains apps may not use, e.g. names that already have their own DNS records under APPS_DOMAIN */
  reservedSlugs: env('RESERVED_SLUGS', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  lark: {
    appId: larkAppId,
    appSecret: process.env.LARK_APP_SECRET ?? '',
    /** larksuite.com for Lark (international), feishu.cn for Feishu */
    domain: env('LARK_DOMAIN', 'larksuite.com'),
    /** Overrides for tests against a fake Lark; normally derived from the domain */
    apiBase: env('LARK_API_BASE', `https://open.${env('LARK_DOMAIN', 'larksuite.com')}/open-apis`),
    accountsBase: env('LARK_ACCOUNTS_BASE', `https://accounts.${env('LARK_DOMAIN', 'larksuite.com')}/open-apis`),
  },
  /** With no Lark app configured, a local "pick a user" login is used instead (DEV_LOGIN=1 forces it on plain-http test setups). */
  devLogin: !larkAppId || (process.env.DEV_LOGIN === '1' && hubUrl.protocol !== 'https:'),
  /** Time zone for date buckets in Lark Base data (week/month boundaries) and alert messages */
  timezone: env('HUB_TIMEZONE', 'UTC'),
  alerts: {
    /** At most one Lark message per alert rule in this window; flips back and forth inside it are merged */
    cooldownMinutes: Number(env('ALERT_COOLDOWN_MINUTES', '360')),
    /** "22-9" = no messages from 22:00 to 09:00 (company time zone), held until morning; "off" to disable */
    quietHours: env('ALERT_QUIET_HOURS', '22-9'),
  },
  /** Comma separated Lark emails or open_ids that are hub admins. The first user to log in is also made admin. */
  admins: env('HUB_ADMINS', '').split(',').map((s) => s.trim()).filter(Boolean),

  docker: {
    /** "network": hub runs inside docker; each app gets a private network shared only with the hub container.
     *  "port": hub runs on the host (local dev) and reaches containers through a published 127.0.0.1 port. */
    mode: env('APP_UPSTREAM_MODE', 'port') as 'network' | 'port',
    /** Name of the hub's own container, attached to every app network in "network" mode */
    hubContainer: env('HUB_CONTAINER', 'agent-hub'),
    memory: env('APP_MEMORY_LIMIT', '512m'),
    cpus: env('APP_CPU_LIMIT', '1'),
    /** Host path that maps to dataDir, needed when the hub itself runs in docker and mounts volumes for apps */
    hostDataDir: process.env.HOST_DATA_DIR ?? '',
  },
  maxUploadBytes: Number(env('MAX_UPLOAD_MB', '200')) * 1024 * 1024,
};

// Dev login lets anyone pick any user. Never allow it on a real (https) deployment.
if (config.devLogin && config.secure) {
  throw new Error('LARK_APP_ID is not set but HUB_URL is https: refusing to start with the development login. Configure the Lark app (docs/LARK_SETUP.md).');
}

export const paths = {
  db: path.join(config.dataDir, 'hub.db'),
  uploads: path.join(config.dataDir, 'uploads'),
  apps: path.join(config.dataDir, 'apps'),
  appData: path.join(config.dataDir, 'app-data'),
  skills: path.join(config.dataDir, 'skills'),
  icons: path.join(config.dataDir, 'icons'),
};
for (const p of Object.values(paths)) if (p !== paths.db) mkdirSync(p, { recursive: true });

export function appUrl(slug: string): string {
  return `${config.appsProtocol}://${slug}.${config.appsDomain}`;
}
