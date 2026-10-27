import { DateTime, IANAZone } from 'luxon';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function assertTimezone(zone) {
  if (!IANAZone.isValidZone(zone)) throw new Error(`TIMEZONE "${zone}" is not a valid IANA time zone`);
}

export function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value).isValid;
}

export function todayIn(zone, now = new Date()) {
  return DateTime.fromJSDate(now, { zone }).toISODate();
}

export function shiftDate(isoDate, days) {
  return DateTime.fromISO(isoDate).plus({ days }).toISODate();
}

// Local midnight to next local midnight. DST days are 23 or 25 hours long.
export function dayBounds(isoDate, zone) {
  const start = DateTime.fromISO(isoDate, { zone }).startOf('day');
  const end = start.plus({ days: 1 });
  return { date: isoDate, start: start.toUTC().toISO(), end: end.toUTC().toISO(), timezone: zone };
}

// Matches the agenda's strftime('%b %-d %l:%M %P') output, e.g. "Oct 27  9:05 am".
export const HUB_TIME_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/gi;

// The agenda omits the year, so pick whichever year puts the timestamp
// closest to the page's date (handles reservations that span New Year's).
export function hubTimeToUtc(match, { pageDate, zone }) {
  const [, mon, day, hh, mm, ap] = match;
  let hour = Number(hh) % 12;
  if (ap.toLowerCase() === 'p') hour += 12;
  const anchor = DateTime.fromISO(pageDate, { zone });
  let best = null;
  for (const year of [anchor.year - 1, anchor.year, anchor.year + 1]) {
    const dt = DateTime.fromObject(
      { year, month: MONTHS[mon.slice(0, 3).toLowerCase()], day: Number(day), hour, minute: Number(mm) },
      { zone },
    );
    if (!dt.isValid) continue;
    const distance = Math.abs(dt.toMillis() - anchor.toMillis());
    if (!best || distance < best.distance) best = { dt, distance };
  }
  return best ? best.dt.toUTC().toISO() : null;
}
