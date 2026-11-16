import { SourceError } from './errors.js';
import { dayBounds, isIsoDate } from './time.js';

// Everything PrintBuster has saved, for an admin to download: the print
// log, the live feed's prints and pauses, the saved reservations, the
// calculated usage and the prints charged to members by hand. `from` and
// `to` are inclusive local dates; leave either out for no limit that side.
// Accounts, sign-ins and credentials are never included.

export const EXPORT_VERSION = 1;

const iso = (ms) => new Date(ms).toISOString();

// The range in ms: [start, end). Open ends are -Infinity and Infinity.
export function exportRange(from, to, zone) {
  for (const [name, value] of [['from', from], ['to', to]]) {
    if (value != null && value !== '' && !isIsoDate(value)) {
      throw new SourceError(`${name} must look like YYYY-MM-DD.`, { code: 'bad_date' });
    }
  }
  const f = from || null;
  const t = to || null;
  if (f && t && f > t) throw new SourceError('The start date is after the end date.', { code: 'bad_range' });
  return {
    from: f,
    to: t,
    start: f ? Date.parse(dayBounds(f, zone).start) : -Infinity,
    end: t ? Date.parse(dayBounds(t, zone).end) : Infinity,
  };
}

const startsIn = (value, { start, end }) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= start && ms < end;
};

const byStart = (key) => (a, b) => Date.parse(a[key]) - Date.parse(b[key]);

// Observed spans clipped to the range, as ISO times.
function clipCoverage(intervals, { start, end }) {
  return intervals
    .filter(([s, e]) => e > start && s < end)
    .map(([s, e]) => [iso(Math.max(s, start)), iso(Math.min(e, end))]);
}

function logRecords(log, range) {
  if (!log) return null;
  return [...log.records.values()].filter((r) => startsIn(r.startTime, range)).sort(byStart('startTime'));
}

export function buildExport({
  service, live = null, config, from, to, now,
}) {
  const range = exportRange(from, to, config.timezone);
  const { printLog, liveLog, pauseLog, reservationArchive, usageLog, assignments } = service;

  const prints = logRecords(printLog, range);
  const livePrints = logRecords(liveLog, range);
  const pauses = logRecords(pauseLog, range);

  const reservationDays = reservationArchive
    ? reservationArchive.dates()
      .filter((d) => (!range.from || d >= range.from) && (!range.to || d <= range.to))
      .map((date) => ({ date, ...reservationArchive.get(date) }))
    : null;

  const usage = usageLog
    ? [...usageLog.prints.values()].filter((r) => startsIn(r.start, range)).sort(byStart('start'))
    : null;

  // A hand assignment belongs to the range its print started in. One whose
  // print is in none of the logs goes by when it was made.
  let assigned = null;
  if (assignments) {
    const printStart = (id) => usageLog?.get(id)?.start
      || printLog?.records.get(id)?.startTime
      || liveLog?.records.get(id)?.startTime;
    assigned = [...assignments.prints.entries()]
      .filter(([id, a]) => startsIn(printStart(id) ?? a.at, range))
      .map(([printId, a]) => ({ printId, ...a }))
      .sort((a, b) => a.printId.localeCompare(b.printId));
  }

  return {
    exportVersion: EXPORT_VERSION,
    exportedAt: iso(now),
    demo: Boolean(config.demo),
    timezone: config.timezone,
    range: {
      from: range.from,
      to: range.to,
      start: Number.isFinite(range.start) ? iso(range.start) : null,
      end: Number.isFinite(range.end) ? iso(range.end) : null,
    },
    counts: {
      prints: prints?.length ?? null,
      livePrints: livePrints?.length ?? null,
      pauses: pauses?.length ?? null,
      reservationDays: reservationDays?.length ?? null,
      reservations: reservationDays ? reservationDays.reduce((n, d) => n + d.reservations.length, 0) : null,
      usage: usage?.length ?? null,
      assignments: assigned?.length ?? null,
    },
    // Bambu cloud tasks, as saved in the print log.
    prints,
    // When the print log was reading Bambu: prints outside these spans may be missing.
    printLogCoverage: printLog ? clipCoverage(printLog.coverage(), range) : null,
    // SD card and LAN prints seen on the printers' live feed.
    livePrints,
    liveFeedCoverage: live ? clipCoverage(live.coverage(), range) : null,
    pauses,
    // Design Hub agenda days, with each day's reservations.
    reservationDays,
    // The latest calculated filament usage of each print.
    usage,
    // Prints with no reservation charged to a member by hand.
    assignments: assigned,
    usageRecalculation: usageLog
      ? { last: usageLog.lastRecalculation, lastTotal: usageLog.lastTotalRecalculation }
      : null,
  };
}

export function exportFilename({ from, to }, today) {
  return `printbuster-export-${from || 'beginning'}-to-${to || today}.json`;
}
