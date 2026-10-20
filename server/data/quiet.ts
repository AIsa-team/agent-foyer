/** Quiet hours for alert messages, e.g. "22-9" (wraps past midnight) or "off". */
export function isQuietHour(hour: number, spec: string): boolean {
  const m = spec.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** The current hour in a time zone. */
export function hourIn(timeZone: string, at = Date.now()): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(at)));
}
