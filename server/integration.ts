/**
 * What an outside service the hub has its own code for brings to the hub, as one module (see integrations.ts for the
 * list): linking a person's account, its API and browser routes, tools for agents, a mailbox for apps' drafts, a
 * paragraph telling agents about them, and background work. The core walks the list instead of importing a service's
 * module; Lark is the exception where it is the company's platform (channels.ts, and features built on Lark such as
 * Base data sources and app links). Services reached through their own MCP server need none of this (services/).
 */
import type { Hono } from 'hono';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from './db.ts';
import type { HubEnv } from './http.ts';
import type { MessageKey } from './i18n/index.ts';
import type { Draft } from './eml.ts';
import type { Answer } from './mcp.ts';

/** What a group of tools needs from the server being built: the person, their language and the result wrapper. */
export interface ToolKit {
  server: McpServer;
  user: User;
  locale: string;
  /** Wraps a tool; it may ask the person a yes or no in their agent's app (null: that app cannot show it). */
  guard: <A>(fn: (args: A, ask: (message: string) => Promise<Answer>) => Promise<unknown> | unknown) => (args: A) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
  resolveColleagues: (refs: string[]) => string[];
}

/**
 * Linking a person's account in the service (OAuth in the browser): the hub runs /auth/<id>/connect and
 * /auth/<id>/callback for it, with its pages titled from the `<id>.connect.*` messages.
 */
export interface Connect {
  /** Whether the hub can link accounts now (the service is configured). */
  available(): boolean;
  /** Where to send the person, for this state; a verifier is kept for the callback (PKCE). */
  authorize(user: User, state: string): { url: string; verifier?: string };
  /** Turns the code the service sent back into the person's link. */
  finish(user: User, code: string, verifier?: string): Promise<void>;
  /** How long the person has to finish there (minutes; default 10). */
  minutes?: number;
  /** When the person says no there: go back quietly ('return'), or show this message (default: try again). */
  denied?: 'return' | MessageKey;
}

/** A mailbox apps save email drafts in, as the person (never sent); the company picks one with MAIL_DRAFTS=<id>. */
export interface Mailbox {
  name: string;
  /** Where to send the person before drafts can be saved for them, or null when they are ready. */
  connectUrl(user: User, returnPath: string): string | null;
  saveDraft(user: User, d: Draft): Promise<{ draftId: string; url?: string }>;
}

export interface Integration {
  /** Short name, also its paths: /auth/<id>/connect, /api/<id>/… */
  id: string;
  /** Whether the hub is set up for it; tools, the agents' paragraph and background work only run then. */
  enabled(): boolean;
  connect?: Connect;
  /** Routes under /api for signed-in people (they say themselves when the service is not set up). */
  api?(r: Hono<HubEnv>): void;
  /** Other browser routes: webhooks, consent pages, short-lived file links. */
  web?(r: Hono): void;
  tools?(kit: ToolKit): void;
  mailbox?: Mailbox;
  /** A paragraph for the instructions agents get when they connect. */
  instructions?(): string;
  start?(): void;
}
