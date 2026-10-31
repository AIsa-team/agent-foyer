import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var ${name}`);
}

const hubUrl = new URL(env('HUB_URL', 'http://localhost:8080'));
const larkAppId = process.env.LARK_APP_ID ?? '';
const oidcIssuer = (process.env.OIDC_ISSUER ?? '').replace(/\/+$/, '');
/**
 * How people sign in. "lark" also turns on everything built on Lark (Base data, OKRs, the directory, bot messages,
 * apps acting in Lark); "oidc" is any OpenID Connect provider (Google, Microsoft Entra, Okta, Keycloak…) and gives
 * the core hub; "dev" is a local pick-a-user login. Inferred from what is configured unless AUTH_PROVIDER says.
 */
const authProvider = env('AUTH_PROVIDER', larkAppId ? 'lark' : oidcIssuer ? 'oidc' : 'dev');
if (!['lark', 'oidc', 'dev'].includes(authProvider)) throw new Error(`AUTH_PROVIDER must be lark, oidc or dev, not "${authProvider}"`);
if (authProvider === 'lark' && !larkAppId) throw new Error('AUTH_PROVIDER=lark needs LARK_APP_ID and LARK_APP_SECRET (docs/LARK_SETUP.md).');
if (authProvider === 'oidc' && (!oidcIssuer || !process.env.OIDC_CLIENT_ID)) throw new Error('AUTH_PROVIDER=oidc needs OIDC_ISSUER and OIDC_CLIENT_ID (docs/OIDC_SETUP.md).');

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
  secret: env('HUB_SECRET', authProvider === 'dev' ? 'dev-only-secret-change-me' : undefined),
  companyName: env('COMPANY_NAME', 'Acme'),
  /** Name agents register the hub's MCP server under (shown in the "connect your agent" prompt) */
  mcpName: env('HUB_MCP_NAME', 'agent-foyer'),
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

  auth: { provider: authProvider as 'lark' | 'oidc' | 'dev' },
  oidc: {
    issuer: oidcIssuer,
    clientId: process.env.OIDC_CLIENT_ID ?? '',
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
    scopes: env('OIDC_SCOPES', 'openid profile email'),
    /** Shown on buttons and in instructions: "Sign in with <name>" */
    name: env('OIDC_NAME', 'SSO'),
    /** Only people whose verified email is in one of these domains may sign in (needed for public providers like Google) */
    allowedDomains: env('OIDC_ALLOWED_DOMAINS', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  },
  lark: {
    /** Lark features (Base data, OKRs, directory sync, bot messages, apps acting in Lark) need Lark sign-in */
    enabled: authProvider === 'lark',
    appId: larkAppId,
    appSecret: process.env.LARK_APP_SECRET ?? '',
    /** larksuite.com for Lark (international), feishu.cn for Feishu */
    domain: env('LARK_DOMAIN', 'larksuite.com'),
    /** Overrides for tests against a fake Lark; normally derived from the domain */
    apiBase: env('LARK_API_BASE', `https://open.${env('LARK_DOMAIN', 'larksuite.com')}/open-apis`),
    accountsBase: env('LARK_ACCOUNTS_BASE', `https://accounts.${env('LARK_DOMAIN', 'larksuite.com')}/open-apis`),
    /**
     * Messages agents send as a person are confirmed on a card from the hub's bot in Lark, instead of in the agent's
     * own app. Needs the card callback set up in Lark (docs/LARK_SETUP.md).
     */
    confirmCards: env('LARK_CONFIRM_CARDS', 'off') === 'on',
    /**
     * The long connection that brings taps on those cards to the hub (no public callback address needed). Off against
     * a fake Lark, which has none.
     */
    longConnection: env('LARK_CONFIRM_CARDS', 'off') === 'on' && env('LARK_LONG_CONNECTION', process.env.LARK_API_BASE ? 'off' : 'on') === 'on',
  },
  /**
   * Google, for apps that save email drafts in Gmail (Google Workspace). Each person connects their own Google account
   * once; the hub asks only for gmail.compose. Endpoint overrides are for tests against a fake Google.
   */
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    authUrl: env('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
    tokenUrl: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    userinfoUrl: env('GOOGLE_USERINFO_URL', 'https://openidconnect.googleapis.com/v1/userinfo'),
    gmailBase: env('GOOGLE_GMAIL_BASE', 'https://gmail.googleapis.com'),
  },
  /**
   * GitHub, so agents can read what someone committed and which pull requests they worked on (e.g. to write their
   * daily report). A read-only GitHub App installed on the organisation does the reading; each person links their
   * GitHub account once so their commits can be told apart. Endpoint overrides are for tests against a fake GitHub.
   */
  github: {
    org: process.env.GITHUB_ORG ?? '',
    appId: process.env.GITHUB_APP_ID ?? '',
    clientId: process.env.GITHUB_CLIENT_ID ?? '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
    /** PEM text, or a path to the .pem file (relative paths are inside the data folder) */
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? '',
    /** optional: with it, GitHub pushes to /hooks/github and work on branches without a pull request is counted too */
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? '',
    apiBase: env('GITHUB_API_BASE', 'https://api.github.com'),
    webBase: env('GITHUB_WEB_BASE', 'https://github.com'),
  },
  /**
   * Linear, for the 项目 page: each person connects their own Linear account (read only) through the hub's Linear
   * OAuth application, so everyone sees only the teams and projects they can see there. Endpoint overrides are for
   * tests against a fake Linear.
   */
  linear: {
    clientId: process.env.LINEAR_CLIENT_ID ?? '',
    clientSecret: process.env.LINEAR_CLIENT_SECRET ?? '',
    authBase: env('LINEAR_AUTH_BASE', 'https://linear.app'),
    apiBase: env('LINEAR_API_BASE', 'https://api.linear.app'),
  },
  /** Where apps save email drafts: the person's Gmail (needs GOOGLE_CLIENT_ID) or Lark Mail; "none" turns it off */
  mailDrafts: env('MAIL_DRAFTS', process.env.GOOGLE_CLIENT_ID ? 'google' : authProvider === 'lark' ? 'lark' : 'none') as 'google' | 'lark' | 'none',
  /** With no sign-in provider configured, a local "pick a user" login is used instead (DEV_LOGIN=1 forces it on plain-http test setups). */
  devLogin: authProvider === 'dev' || (process.env.DEV_LOGIN === '1' && hubUrl.protocol !== 'https:'),
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
    hubContainer: env('HUB_CONTAINER', 'agent-foyer'),
    memory: env('APP_MEMORY_LIMIT', '512m'),
    cpus: env('APP_CPU_LIMIT', '1'),
    /** Host path that maps to dataDir, needed when the hub itself runs in docker and mounts volumes for apps */
    hostDataDir: process.env.HOST_DATA_DIR ?? '',
  },
  maxUploadBytes: Number(env('MAX_UPLOAD_MB', '200')) * 1024 * 1024,
  /** how old rows read through a data connection (Metabase…) may get before a page view refreshes them in the background;
   *  those queries often run on a production database, so not too often */
  /** AIsa's API, the ready-made AI provider (server/ai.ts); changed only for tests */
  aisaApiBase: env('AISA_API_BASE', 'https://api.aisa.one').replace(/\/+$/, ''),
  connectorRefreshMs: Math.max(1, Number(env('CONNECTOR_REFRESH_MINUTES', '30'))) * 60_000,
};

// Dev login lets anyone pick any user. Never allow it on a real (https) deployment.
if (config.devLogin && config.secure) {
  throw new Error('No sign-in provider is configured but HUB_URL is https: refusing to start with the development login. Configure Lark (docs/LARK_SETUP.md) or OIDC (docs/OIDC_SETUP.md).');
}
// Google lets any Google account sign in; without a domain list that would be anyone on the internet.
if (config.auth.provider === 'oidc' && /accounts\.google\.com/.test(config.oidc.issuer) && !config.oidc.allowedDomains.length) {
  throw new Error('OIDC with Google needs OIDC_ALLOWED_DOMAINS (your company email domains), or any Google account could sign in.');
}
if (!['google', 'lark', 'none'].includes(config.mailDrafts)) throw new Error('MAIL_DRAFTS must be google, lark or none');
if (config.mailDrafts === 'google' && !config.google.clientId) throw new Error('MAIL_DRAFTS=google needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (docs/GOOGLE_MAIL.md).');
if (config.mailDrafts === 'lark' && !config.lark.enabled) throw new Error('MAIL_DRAFTS=lark needs Lark sign-in.');

/** Name of the sign-in provider for people: "Lark", "Google"… */
/** This hub's version, from package.json. */
export const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export const loginName = config.auth.provider === 'lark' ? 'Lark' : config.auth.provider === 'oidc' ? config.oidc.name : config.companyName;

export const paths = {
  db: path.join(config.dataDir, 'hub.db'),
  uploads: path.join(config.dataDir, 'uploads'),
  apps: path.join(config.dataDir, 'apps'),
  appData: path.join(config.dataDir, 'app-data'),
  skills: path.join(config.dataDir, 'skills'),
  icons: path.join(config.dataDir, 'icons'),
  /** the last copy of each shared Base snapshot, so a restart doesn't make the first reader wait for Lark */
  snapshots: path.join(config.dataDir, 'snapshots'),
};
for (const p of Object.values(paths)) if (p !== paths.db) mkdirSync(p, { recursive: true });

export function appUrl(slug: string): string {
  return `${config.appsProtocol}://${slug}.${config.appsDomain}`;
}
