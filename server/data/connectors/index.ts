/**
 * The connectors this hub knows, and the connections admins set up with them (address and key, the key encrypted).
 * Add a connector by writing one more `Connector` and listing it here.
 */
import { decrypt, encrypt } from '../../crypto.ts';
import { all, get, now, run, type User } from '../../db.ts';
import { UserError } from '../../i18n/index.ts';
import { metabase } from './metabase.ts';
import type { ConnectionConfig, Connector } from './types.ts';

export const CONNECTORS: Connector[] = [metabase];
export const connectorOf = (type: string) => {
  const c = CONNECTORS.find((x) => x.type === type);
  if (!c) throw new UserError('err.conn.unknownType', { type });
  return c;
};

interface ConnRow { id: string; type: string; config: string; secret: string | null; status: string | null; checked_at: number | null; created_by: string; updated_at: number }

/** The connection's settings with its secrets, for talking to the other system (never sent to a browser). */
export function connectionConfig(id: string): { connector: Connector; cfg: ConnectionConfig } {
  const row = get<ConnRow>('SELECT * FROM connections WHERE id = ?', id);
  if (!row) throw new UserError('err.conn.notFound', { id });
  return { connector: connectorOf(row.type), cfg: { ...JSON.parse(row.config), ...(row.secret ? JSON.parse(decrypt(row.secret)) : {}) } };
}

/** For the admin page: settings without secrets, which secrets are set, the last test, and how many sources use it. */
export function listConnections() {
  return all<ConnRow & { sources: number }>('SELECT c.*, (SELECT COUNT(*) FROM data_sources d WHERE d.connection_id = c.id) AS sources FROM connections c ORDER BY c.id')
    .map((r) => {
      const connector = connectorOf(r.type);
      const secrets = r.secret ? Object.keys(JSON.parse(decrypt(r.secret))) : [];
      return { id: r.id, type: r.type, label: connector.label, config: JSON.parse(r.config) as ConnectionConfig, secretsSet: secrets, status: r.status, checkedAt: r.checked_at, sources: r.sources };
    });
}

/**
 * Creates or updates a connection after testing it. Secret fields left empty keep their stored value, so an admin can
 * change the address without retyping the key. Returns who the key acts as.
 */
export async function saveConnection(user: User, input: { id?: string; type: string; config: ConnectionConfig }) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  const connector = connectorOf(input.type);
  const id = input.id ?? connector.type;
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new UserError('err.conn.badId', { id });
  const existing = get<ConnRow>('SELECT * FROM connections WHERE id = ?', id);
  if (existing && existing.type !== input.type) throw new UserError('err.conn.badId', { id });
  const oldSecrets = existing?.secret ? (JSON.parse(decrypt(existing.secret)) as ConnectionConfig) : {};
  const plain: ConnectionConfig = {};
  const secrets: ConnectionConfig = {};
  for (const f of connector.fields) {
    const v = (input.config[f.name] ?? '').trim();
    if (f.secret) secrets[f.name] = v || oldSecrets[f.name] || '';
    else plain[f.name] = v;
    if (!(f.secret ? secrets : plain)[f.name]) throw new UserError('err.conn.missing', { field: f.name });
  }
  const who = await connector.test({ ...plain, ...secrets });
  run(`INSERT INTO connections (id, type, config, secret, status, checked_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config = excluded.config, secret = excluded.secret, status = excluded.status, checked_at = excluded.checked_at, updated_at = excluded.updated_at`,
    id, connector.type, JSON.stringify(plain), encrypt(JSON.stringify(secrets)), `ok:${who.as}`, now(), user.id, now(), now());
  return { id, as: who.as };
}

export async function testConnection(user: User, id: string) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  const { connector, cfg } = connectionConfig(id);
  try {
    const who = await connector.test(cfg);
    run('UPDATE connections SET status = ?, checked_at = ? WHERE id = ?', `ok:${who.as}`, now(), id);
    return { ok: true, as: who.as };
  } catch (e) {
    run('UPDATE connections SET status = ?, checked_at = ? WHERE id = ?', `error:${(e as Error).message}`, now(), id);
    throw e;
  }
}

export function deleteConnection(user: User, id: string) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM data_sources WHERE connection_id = ?', id)!.n;
  if (n) throw new UserError('err.conn.inUse', { n });
  run('DELETE FROM connections WHERE id = ?', id);
  return { deleted: true };
}

/** What can be connected (admins pick from it when adding a data source). */
export async function browseConnection(user: User, id: string, q?: string) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  const { connector, cfg } = connectionConfig(id);
  return { items: await connector.browse(cfg, q) };
}

/** The other system's dashboards, to import one (connectors that have them). */
export async function browseBoards(user: User, id: string, q?: string) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  const { connector, cfg } = connectionConfig(id);
  if (!connector.boards) throw new UserError('err.conn.noBoards', { name: connector.label });
  return { items: await connector.boards(cfg, q) };
}
