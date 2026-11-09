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

// Every ISO date from `from` to `to`, inclusive.
export function dateList(from, to) {
  const out = [];
  for (let d = DateTime.fromISO(from), end = DateTime.fromISO(to); d <= end; d = d.plus({ days: 1 })) out.push(d.toISODate());
  return out;
}

export function daysBetween(from, to) {
  return Math.round(DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days);
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
function hubDateTime(match, { pageDate, zone }) {
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
  return best?.dt || null;
}

// Every instant a wall-clock time can mean, earliest first: two in the hour
// the clocks fall back (1:30 am happens twice), one otherwise.
function instants(dt) {
  const all = dt.getPossibleOffsets ? dt.getPossibleOffsets() : [dt];
  return [...new Set(all.map((d) => d.toUTC().toISO()))].sort();
}

// A reservation's start and end, as UTC ISO times. When the clocks fall
// back, a time in the repeated hour could mean either; the shortest
// reservation the two times can describe is taken (from the first 1:30 am
// to the second 1:15 am is 45 minutes, not an end before the start).
// Null when either time can't be read.
export function hubSpanToUtc(startMatch, endMatch, opts) {
  const start = startMatch && hubDateTime(startMatch, opts);
  const end = endMatch && hubDateTime(endMatch, opts);
  if (!start || !end) return null;
  let best = null;
  for (const s of instants(start)) {
    for (const e of instants(end)) {
      const length = Date.parse(e) - Date.parse(s);
      if (length > 0 && (!best || length < best.length)) best = { start: s, end: e, length };
    }
  }
  // No reading has the end after the start: left for the caller to report.
  return best ? { start: best.start, end: best.end } : { start: start.toUTC().toISO(), end: end.toUTC().toISO() };
}
