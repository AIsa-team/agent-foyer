/**
 * The platforms the company works in, each brought in as a channel: Lark today. A channel can give the hub its
 * directory (people and departments), kinds of data source read as each viewer (Lark Base), and it adds its own agent
 * tools and API routes (server/lark/tools.ts, server/lark/routes.ts). Sign-in, messages and mail drafts choose their
 * provider in their own modules (auth, notify.ts, mail.ts). This is the one place the core learns which channels a
 * hub has; adding another platform means another entry here.
 */
import { config } from './config.ts';
import type { DirectoryProvider } from './directory.ts';
import type { SourceKind } from './data/kinds.ts';
import { larkChannel } from './lark/channel.ts';

export interface Channel {
  name: string;
  directory?: DirectoryProvider;
  sources?: SourceKind[];
}

export const channels: Channel[] = [...(config.lark.enabled ? [larkChannel] : [])];

/** Kinds of data source the channels bring. */
export const sourceKinds = (): SourceKind[] => channels.flatMap((c) => c.sources ?? []);
export const sourceKind = (kind: string): SourceKind | undefined => sourceKinds().find((k) => k.kind === kind);
