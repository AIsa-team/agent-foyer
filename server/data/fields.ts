/**
 * The hub's model of a table: fields with a type, and cells read as plain values. Every data source (Lark Base and
 * spreadsheets, data apps, Metabase and other connections, combined sources) comes out in this shape, so queries,
 * charts, alerts and data checks treat them alike. The type numbers are the ones Lark Base uses (the first source
 * the hub read), and the richer cell shapes Lark returns (people, rich text, formulas) read as plain values here too.
 */

export interface Field { id: string; name: string; type: number; uiType?: string; /** option names of a select field */ options?: string[] }

/** Field type numbers worth knowing when aggregating (as Lark Base numbers them). */
export const FIELD = { text: 1, number: 2, select: 3, multi: 4, date: 5, checkbox: 7, person: 11, formula: 20, lookup: 19, created: 1001, modified: 1002, autoNumber: 1005 };
export const isDateField = (f: Field) => f.type === FIELD.date || f.type === FIELD.created || f.type === FIELD.modified || f.uiType === 'DateTime';

/** A row filter, as queries, alerts and agents give it. */
export interface Condition { field: string; op: 'is' | 'isNot' | 'contains' | 'doesNotContain' | 'isEmpty' | 'isNotEmpty' | 'isGreater' | 'isLess'; value?: string | number }

// ---------------------------------------------------------------- plain values out of cells (Lark's richer shapes included)
type Plain = string | number | boolean | null;

/** One cell as a list of plain values: text segments joined, people by name, formulas unwrapped, options as-is. */
export function plainValues(v: unknown): Plain[] {
  if (v === null || v === undefined) return [];
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return [v];
  if (Array.isArray(v)) {
    // rich text: [{type:'text', text:'…'}, {type:'mention', text:'@…'}] is one value
    if (v.length && v.every((x) => x && typeof x === 'object' && 'text' in x && !('id' in x && 'name' in x))) {
      return [v.map((x) => String((x as { text: unknown }).text ?? '')).join('')];
    }
    return v.flatMap((x) => plainValues(x));
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('value' in o && 'type' in o) return plainValues(o.value); // formula / lookup
    if ('name' in o && typeof o.name === 'string') return [o.name]; // person, group, created by
    if ('text' in o && typeof o.text === 'string') return [o.text]; // hyperlink, text segment
    if (Array.isArray(o.link_record_ids)) return [o.link_record_ids.length]; // linked records: how many
    if ('full_address' in o) return [String(o.full_address)];
  }
  return [];
}

/** People in a person / created-by cell, with their open_ids. */
export function people(v: unknown): { id: string; name: string }[] {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  return list.filter((x): x is { id: string; name?: string } => !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string')
    .map((x) => ({ id: x.id, name: x.name ?? '' }));
}

/**
 * A moment in time from a cell: Lark date fields (ms), text holding an ISO date ("2026-07-20T06:32:29Z",
 * "2026-07-20"), or a number that is a ms / s timestamp. Tables synced from other systems often store dates as text.
 */
export function timeOf(v: unknown): number | null {
  for (const x of plainValues(v)) {
    if (typeof x === 'number' && Number.isFinite(x)) return x > 1e11 ? x : x > 1e9 ? x * 1000 : null;
    if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x.trim())) {
      const t = Date.parse(x.trim().length === 10 ? `${x.trim()}T00:00:00Z` : x.trim());
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

export function plainNumber(v: unknown): number | null {
  for (const x of plainValues(v)) {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string') {
      const n = Number(x.replace(/[,\s%¥$€]/g, ''));
      if (x.trim() && Number.isFinite(n)) return n;
    }
    if (typeof x === 'boolean') return x ? 1 : 0;
  }
  return null;
}

/** A cell shown as text, e.g. for agents inspecting a table. */
/** An ISO date-time as people read it: the date alone at midnight, else date and time as written (its own offset). */
const readableIso = (x: string) => {
  const m = x.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  return !m ? x : m[2] === '00:00' ? m[1] : `${m[1]} ${m[2]}`;
};

export function plainText(v: unknown, f?: Field): string {
  const vals = plainValues(v);
  if (f && isDateField(f)) return vals.map((x) => (typeof x === 'number' ? new Date(x).toISOString().slice(0, 10) : readableIso(String(x)))).join(', ');
  return vals.map((x) => String(x)).join(', ');
}
