/**
 * Data sources that live in another platform the company works in (Lark Base today) and are read as each viewer,
 * with their own access there. A channel (see ../channels.ts) brings its kinds; the hub's data layer handles
 * everything around them (who registered what, caches, queries, charts, alerts, checks) and asks the kind only how
 * to recognise, check and read one. Data read with one shared key (Metabase…) are connectors instead (./connectors).
 */
import type { User } from '../db.ts';
import type { Field } from './fields.ts';

export interface SourceRow {
  id: string; title_i18n: string; url: string;
  /** 'app' | 'connector' | 'combined', or a channel's kind (Lark Base: 'base') */
  kind: string;
  app_token: string; table_id: string; view_id: string | null;
  app_slug: string | null; app_path: string | null; connection_id: string | null; item: string | null; audience: string | null;
  description_i18n: string | null; description_manual: number;
  owner_id: string; created_at: number; updated_at: number;
}
export interface Row { id: string; url?: string; fields: Record<string, unknown> }
export interface Table { fields: Field[]; rows: Row[] }

export interface SourceKind {
  /** stored in data_sources.kind */
  kind: string;
  /** where the data lives, for "open in …" links */
  label: string;
  /** whether a link given by the person points at one of these */
  matches(url: string): boolean;
  /** checks the person can open it and returns where it is (url, container, table, view) */
  register(user: User, input: { url: string; table?: string }): Promise<Pick<SourceRow, 'url' | 'app_token' | 'table_id' | 'view_id'>>;
  /** false while the person has not connected this platform yet: pages offer to connect instead of hiding the data */
  connected(user: User): boolean;
  canRead(user: User, s: SourceRow): Promise<boolean>;
  /** fields and rows as `user` sees them; `fresh` skips any shared copy */
  load(user: User, s: SourceRow, fresh: boolean): Promise<Table>;
  /** where to open one record, if the platform has such links */
  recordUrl?(s: SourceRow, recordId: string): string;
  /** drop what is kept about a source that changed or went away */
  forget?(id: string): void;
  /** background work, e.g. keeping shared copies fresh */
  start?(): void;
}
