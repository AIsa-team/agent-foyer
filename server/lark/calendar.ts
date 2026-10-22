/**
 * The person's own Lark calendar, read-only and always as them: events in a date range, recurring ones expanded.
 * Reading asks for the calendar scope the first time; Lark itself sends the reminders before events.
 */
import { config } from '../config.ts';
import type { User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { DENIED_CODES, LarkError, SCOPE_CODES } from './client.ts';
import { zonedMidnight } from './okr.ts';
import { asUser } from './userToken.ts';

/** Reading the person's calendars and events; asked for the first time their calendar is read. */
export const CALENDAR_SCOPE = 'calendar:calendar:readonly';

export const calendarConnectUrl = (returnPath = '/me') => `${config.hubUrl}/auth/lark/connect?return=${encodeURIComponent(returnPath)}&calendar=1`;

async function call<T>(user: User, path: string, init?: RequestInit, returnPath?: string): Promise<T> {
  try {
    return await asUser<T>(user, path, init);
  } catch (e) {
    if (e instanceof LarkError && SCOPE_CODES.has(e.code)) throw new UserError('err.calendar.scope', { detail: e.message, url: calendarConnectUrl(returnPath) });
    if (e instanceof LarkError && DENIED_CODES.has(e.code)) throw new UserError('err.calendar.denied');
    throw e;
  }
}

const primaryIds = new Map<string, string>();
async function primaryCalendar(user: User, returnPath?: string): Promise<string> {
  const known = primaryIds.get(user.id);
  if (known) return known;
  const r = await call<{ data: { calendars?: { calendar: { calendar_id: string } }[] } }>(user, '/calendar/v4/calendars/primary', { method: 'POST', body: '{}' }, returnPath);
  const id = r.data.calendars?.[0]?.calendar.calendar_id;
  if (!id) throw new UserError('err.calendar.none');
  primaryIds.set(user.id, id);
  return id;
}

interface Instance {
  event_id: string; summary?: string; description?: string; status?: string; app_link?: string;
  start_time: { date?: string; timestamp?: string }; end_time: { date?: string; timestamp?: string };
  location?: { name?: string; address?: string }; vchat?: { meeting_url?: string };
  event_organizer?: { display_name?: string }; attendees?: { type?: string; display_name?: string }[];
  free_busy_status?: string;
}

export interface CalendarEvent {
  id: string; title: string; allDay: boolean;
  /** epoch ms; an all-day event runs from midnight of its first day to midnight after its last (company time zone) */
  start: number; end: number;
  location: string | null; meetingUrl: string | null; organizer: string | null; rooms: string[];
  link: string | null; description: string; free: boolean;
}

const dateParts = (s: string) => s.split('-').map(Number) as [number, number, number];
const when = (t: { date?: string; timestamp?: string }) => (t.timestamp ? Number(t.timestamp) * 1000 : t.date ? zonedMidnight(...dateParts(t.date)) : 0);

/** Lark's calendar, opened in the app. */
export const calendarAppUrl = () => `https://applink.${config.lark.domain === 'feishu.cn' ? 'feishu.cn' : 'larksuite.com'}/client/calendar/open`;

/** Today's date in the company time zone, as YYYY-MM-DD. */
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());

const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Events from the start of `from` to the end of `to` (dates in the company time zone, at most 31 days), earliest first. */
export async function calendarEvents(user: User, from = today(), to = from, returnPath?: string): Promise<CalendarEvent[]> {
  if (!DATE.test(from) || !DATE.test(to)) throw new UserError('err.calendar.badRange');
  const start = zonedMidnight(...dateParts(from));
  const end = zonedMidnight(...dateParts(to)) + DAY;
  if (end <= start || end - start > 31 * DAY) throw new UserError('err.calendar.badRange');
  const id = await primaryCalendar(user, returnPath);
  const r = await call<{ data: { items?: Instance[] } }>(user,
    `/calendar/v4/calendars/${encodeURIComponent(id)}/events/instance_view?start_time=${Math.floor(start / 1000)}&end_time=${Math.floor(end / 1000)}&user_id_type=open_id`,
    undefined, returnPath);
  return (r.data.items ?? [])
    .filter((e) => e.status !== 'cancelled')
    .map((e) => {
      const allDay = !e.start_time.timestamp && !!e.start_time.date;
      const s = when(e.start_time);
      // Lark gives an all-day event's last day as its end date
      const f = allDay && e.end_time.date ? zonedMidnight(...dateParts(e.end_time.date)) + DAY : when(e.end_time) || s;
      const place = [e.location?.name, e.location?.address].filter(Boolean).join(' · ');
      return {
        id: e.event_id, title: e.summary?.trim() || '', allDay, start: s, end: f,
        location: place || null,
        meetingUrl: e.vchat?.meeting_url ? (/^https?:\/\//.test(e.vchat.meeting_url) ? e.vchat.meeting_url : `https://${e.vchat.meeting_url}`) : null,
        organizer: e.event_organizer?.display_name || null,
        rooms: (e.attendees ?? []).filter((a) => a.type === 'resource' && a.display_name).map((a) => a.display_name!),
        link: e.app_link || null,
        description: (e.description ?? '').trim(),
        free: e.free_busy_status === 'free',
      };
    })
    .filter((e) => e.end > start && e.start < end)
    .sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.end - b.end);
}

/** Wall-clock time in the company time zone, for agents: "2026-10-22 14:30". */
export const localTime = (ms: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));
