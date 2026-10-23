/**
 * A connector brings data from another system into the hub as data sources. The hub owns everything around it —
 * who may see a source, caching, queries, charts, alerts, data checks and the agent tools — so a connector only
 * knows how to talk to its system:
 *
 * - test: are the address and key right, and who does the key act as
 * - browse: what can be connected (Metabase questions, database tables…), searchable
 * - fetch: one item's rows, as plain JSON objects (with optional field types)
 *
 * `identity` says who reads: 'service' connectors read with one key an admin set, so the hub decides who may see each
 * source (its audience); 'person' connectors would read as the viewer, leaving access to the other system.
 * Lark Base tables and data apps are the hub's two older kinds of source and are not (yet) written as connectors.
 */
export interface ConnectorField { name: string; secret?: boolean; placeholder?: string }
export interface ConnectionConfig { [name: string]: string }
export interface Item { id: string; name: string; group?: string; url?: string; kind?: string }
export interface Fetched { rows: Record<string, unknown>[]; fields?: { name: string; type: 'text' | 'number' | 'date' | 'checkbox' }[] }

/**
 * A dashboard of the other system in the hub's terms, so every connector's dashboards import the same way: tabs of
 * cards in reading order, each a chart over one item (with what the other system draws and, when it says, which
 * columns are the axis and which the values) or a piece of text.
 */
export interface BoardCard {
  kind: 'chart' | 'text';
  item?: string;
  name?: string;
  chart?: 'number' | 'line' | 'area' | 'bar' | 'row' | 'pie' | 'funnel' | 'table' | 'other';
  dims?: string[];
  metrics?: string[];
  /** what the other system calls the columns on this chart, e.g. sum_2 → 用户消费金额 */
  labels?: Record<string, string>;
  /** series stacked into one bar (or area) per step, so the total shows */
  stacked?: boolean;
  /** the values are money in this currency (e.g. USD) */
  currency?: string;
  /** what the chart says about itself beyond its name: axis titles, caveats */
  note?: string;
  text?: string;
  /** share of the row it takes, 0–1 */
  width: number;
}
export interface BoardDef { id: string; name: string; url: string; tabs: { name?: string; cards: BoardCard[] }[] }

export interface Connector {
  type: string;
  /** shown as is: a product name, never translated */
  label: string;
  identity: 'service' | 'person';
  /** what an admin fills in; secret ones are stored encrypted and never shown again */
  fields: ConnectorField[];
  test(cfg: ConnectionConfig): Promise<{ as: string }>;
  browse(cfg: ConnectionConfig, q?: string): Promise<Item[]>;
  fetch(cfg: ConnectionConfig, item: string): Promise<Fetched>;
  /** where an item lives in its own system, for "open in …" links */
  link(cfg: ConnectionConfig, item: string): string;
  /** optional: an item's name and what it counts, as written in the other system */
  info?(cfg: ConnectionConfig, item: string): Promise<{ name: string; description?: string }>;
  /** optional: the system's dashboards, and one of them in the hub's terms (see importBoard) */
  boards?(cfg: ConnectionConfig, q?: string): Promise<Item[]>;
  board?(cfg: ConnectionConfig, id: string): Promise<BoardDef>;
  /** optional: when a dashboard or any question on it last changed (ms), to sync imported boards when it does */
  boardChangedAt?(cfg: ConnectionConfig, id: string): Promise<number>;
  /** optional: the databases a read-only SQL query can run on, and how such a query is written down as an item */
  databases?(cfg: ConnectionConfig): Promise<Item[]>;
  sqlItem?(database: string, sql: string): string;
  /** optional: the system's own MCP server, reached with this connection's key (one identity for everyone) */
  mcp?(cfg: ConnectionConfig): { url: string; headers: Record<string, string> };
}
