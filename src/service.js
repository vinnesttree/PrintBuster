import { normalizeTask } from './bambu.js';
import { buildComparison, uncoveredSegments } from './compare.js';
import { describeError, SourceError } from './errors.js';
import { dateList, dayBounds, daysBetween, isIsoDate, shiftDate, todayIn } from './time.js';
import { attributeUsage, MAX_OUTSIDE_SHARE } from './usage.js';

// Prints longer than this that started before the selected day are missed.
const PRINT_LOOKBACK_MS = 48 * 3600 * 1000;
// A fetch this recent counts as an observation of the present moment.
const FRESH_MS = 10 * 60 * 1000;
// The usage page fetches one agenda page per day, so ranges are capped.
export const MAX_USAGE_DAYS = 92;
// Finished agenda days each collection saves, newest first.
const ARCHIVE_DAYS_PER_POLL = 3;
// The Refresh buttons start a new collection unless one ran this recently.
const REFRESH_MIN_AGE_MS = 15 * 1000;

// The per-print results of attributeUsage, as saved in the usage log.
const usageRecords = (usage) => [...usage.users.flatMap((u) => u.list), ...usage.unattributed.list]
  .map((r) => ({ ...r, counted: Boolean(r.reservation) && !r.excluded }));

// Logs when a collected source starts failing (once per distinct message)
// and when it recovers. Returns the failure message to remember, or null.
function logChange(what, previous, settled) {
  if (settled.status === 'fulfilled') {
    if (previous) console.log(`${what} resumed.`);
    return null;
  }
  const { message, hint } = describeError(settled.reason);
  if (message !== previous) console.warn(`${what} paused: ${message}${hint ? ` ${hint}` : ''}`);
  return message;
}

// Runs `fn` over `items` with at most `limit` in flight, keeping order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class CompareService {
  constructor(config, { designhub, bambu, printLog = null, reservationArchive = null, usageLog = null, now = () => Date.now() }) {
    this.config = config;
    this.designhub = designhub;
    this.bambu = bambu;
    this.printLog = printLog;
    this.reservationArchive = reservationArchive;
    this.usageLog = usageLog;
    this.archiveError = null;
    this.now = now;
    this.cache = new Map();
    this.pollError = null;
    this.hubError = null;
    this.lastFetch = null;
    // The latest server-side collection: what it found and which agenda days
    // it keeps current. Set the collector with attachCollector().
    this.collected = null;
    this.collector = null;
  }

  attachCollector(collector) {
    this.collector = collector;
  }

  // The Refresh buttons: collect now, unless a collection ran in the last
  // few seconds; any number of presses share one run. Page loads never
  // collect; they read what is saved.
  async refreshNow() {
    if (this.collector) await this.collector.ensureFresh(REFRESH_MIN_AGE_MS);
  }

  cached(key, fn, force, ttlMs = this.config.cacheSeconds * 1000) {
    const hit = this.cache.get(key);
    const ttl = ttlMs;
    if (!force && hit && this.now() - hit.at < ttl) return hit.promise;
    const promise = fn();
    this.cache.set(key, { at: this.now(), promise });
    promise.catch(() => {
      if (this.cache.get(key)?.promise === promise) this.cache.delete(key);
    });
    return promise;
  }

  clearCache(prefix = '') {
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
  }

  // Fetches Bambu's devices and recent tasks, saving them to the print log.
  fetchBambu(key, { sinceMs, untilMs, force = false }) {
    return this.cached(key, async () => {
      const devices = await this.bambu.getDevices();
      const { tasks, complete } = await this.bambu.getTasks({ sinceMs, untilMs });
      const fetchedAt = this.now();
      if (this.printLog) await this.printLog.record({ tasks, devices, fetchedAt });
      this.lastFetch = { at: fetchedAt, devices, ids: new Set(tasks.map((t) => String(t.id))) };
      return { devices, tasks, complete };
    }, force);
  }

  // One server-side collection, run by the Collector: Bambu's devices and
  // recent prints into the print log (everything Bambu still has when the
  // log is empty), yesterday's (until final), today's and tomorrow's agenda
  // into the saved reservations, then a few finished days still missing a
  // final copy.
  // Failures are recorded for the pages and logged once, not every run.
  async collect() {
    const now = this.now();
    const today = todayIn(this.config.timezone, new Date(now));
    const collectDays = [shiftDate(today, -1), today, shiftDate(today, 1)];
    const days = collectDays.filter((d) => !this.reservationArchive?.get(d)?.final);
    const sinceMs = this.printLog && !this.printLog.coverage().length ? 0 : now - PRINT_LOOKBACK_MS;
    const [cloud, hub] = await Promise.allSettled([
      this.fetchBambu('bambu:collect', { sinceMs, untilMs: now, force: true }),
      Promise.all(days.map((d) => this.cached(`hubday:${d}`, () => this.fetchAgendaDay(d), true))),
    ]);
    this.collected = {
      at: now,
      days: new Set(collectDays),
      bambu: cloud.status === 'fulfilled'
        ? { ok: true, complete: cloud.value.complete, deviceCount: cloud.value.devices.length }
        : { ok: false, error: cloud.reason },
      designhub: hub.status === 'fulfilled' ? { ok: true } : { ok: false, error: hub.reason },
    };
    this.pollError = logChange('Bambu print logging', this.pollError, cloud);
    this.hubError = logChange('Reading the Design Hub agenda', this.hubError, hub);
    try {
      await this.archiveAgenda();
      if (this.archiveError) console.log('Saving reservations resumed.');
      this.archiveError = null;
    } catch (err) {
      const { message, hint } = describeError(err);
      if (message !== this.archiveError) console.warn(`Saving reservations paused: ${message}${hint ? ` ${hint}` : ''}`);
      this.archiveError = message;
    }
  }

  // Reads one agenda day from Design Hub and saves it to the archive. A day
  // read after it ended is final.
  async fetchAgendaDay(date) {
    const { reservations, skipped = [] } = await this.designhub.getAgenda(date);
    const fetchedAt = this.now();
    const final = fetchedAt >= Date.parse(dayBounds(date, this.config.timezone).end);
    if (this.reservationArchive) await this.reservationArchive.save(date, reservations, { fetchedAt, final, skipped });
    return { reservations, skipped };
  }

  // One agenda day, from the saved reservations. Pages never make Design Hub
  // requests: a day that isn't saved yet throws `not_saved` (or the error
  // that kept the collection from saving it). Only Refresh (`force`) and
  // Recalculate read Design Hub here, for days the server's collection
  // doesn't keep current (Recalculate re-reads every day). Demo mode, whose
  // agenda is generated locally, makes any day on request.
  async agendaDay(date, { force = false, recalculate = false }) {
    const saved = this.reservationArchive?.get(date);
    const fromSaved = (from, error) => ({
      reservations: saved.reservations, skipped: saved.skipped || [], fetchedAt: saved.fetchedAt, from, error,
    });
    if (saved?.final && !recalculate) return fromSaved('archive');
    if (saved && !recalculate && this.collected?.days.has(date)) {
      return this.collected.designhub.ok ? fromSaved('collected') : fromSaved('stale', this.collected.designhub.error);
    }
    if (!force && !recalculate && !this.config.demo) {
      if (saved) return fromSaved('saved');
      if (this.collected?.days.has(date) && !this.collected.designhub.ok) throw this.collected.designhub.error;
      throw new SourceError(`The reservations for ${date} haven't been saved yet.`, {
        code: 'not_saved', hint: 'Press Refresh to read them from Design Hub.',
      });
    }
    try {
      // Presses within a few seconds of each other share one read.
      const day = await this.cached(`hubday:${date}`, () => this.fetchAgendaDay(date), recalculate, REFRESH_MIN_AGE_MS);
      return { ...day, fetchedAt: new Date(this.now()).toISOString(), from: 'designhub' };
    } catch (err) {
      if (saved) return fromSaved('stale', err);
      throw err;
    }
  }

  // Saves finished agenda days that have logged prints (and the day before
  // the log began) but no final copy yet, so the reservations are kept even
  // if nobody opens the usage page. Newest first, a few per run.
  async archiveAgenda() {
    const since = this.printLog?.stats().since;
    if (!this.reservationArchive || !since || this.config.demo || !this.config.designhub?.configured) return;
    const zone = this.config.timezone;
    const today = todayIn(zone, new Date(this.now()));
    const yesterday = shiftDate(today, -1);
    const first = [shiftDate(todayIn(zone, new Date(since)), -1), shiftDate(today, -MAX_USAGE_DAYS)].sort()[1];
    if (first > yesterday) return;
    const missing = dateList(first, yesterday).filter((d) => !this.reservationArchive.get(d)?.final).reverse();
    for (const d of missing.slice(0, ARCHIVE_DAYS_PER_POLL)) await this.fetchAgendaDay(d);
  }

  // Bambu's state for a page: with a print log, what the last collection
  // found (pages never ask Bambu themselves); demo mode, which keeps no log,
  // asks its generated client for the window instead.
  async bambuFor(key, { sinceMs, untilMs, force }) {
    if (this.printLog) {
      const found = this.collected?.bambu;
      if (!found) return { ok: false, error: new SourceError('Bambu has not been checked yet.', { code: 'bambu_pending' }) };
      const fresh = this.lastFetch && this.now() - this.lastFetch.at <= FRESH_MS;
      return { ...found, devices: this.lastFetch?.devices || [], confirmed: fresh ? this.lastFetch.ids : new Set() };
    }
    try {
      const got = await this.fetchBambu(key, { sinceMs, untilMs, force });
      return { ok: true, ...got, deviceCount: got.devices.length, confirmed: new Set(got.tasks.map((t) => String(t.id))) };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  async compare(isoDate, { force = false } = {}) {
    if (force) await this.refreshNow();
    const day = dayBounds(isoDate, this.config.timezone);
    const dayStart = Date.parse(day.start);
    const sinceMs = dayStart - PRINT_LOOKBACK_MS;
    const untilMs = Date.parse(day.end);

    // This day's agenda page plus the day before, for bookings that started
    // the previous evening.
    const hubDays = [shiftDate(isoDate, -1), isoDate];
    const [hub, cloud] = await Promise.all([
      Promise.all(hubDays.map((d) => this.agendaDay(d, { force })))
        .then((got) => ({ ok: true, got }), (error) => ({ ok: false, error })),
      this.bambuFor(`bambu:${isoDate}`, { sinceMs, untilMs, force }),
    ]);
    let reservations = null;
    if (hub.ok) {
      const byId = new Map();
      for (const d of hub.got) for (const r of d.reservations) byId.set(r.id, r);
      reservations = [...byId.values()];
    }

    const now = this.now();
    const cloudOk = cloud.ok;
    const names = new Map((cloud.devices || []).map((d) => [d.dev_id, d.name]));

    // With a print log, prints come from it and only spans that some fetch
    // observed count as known. Demo mode has no log.
    let tasks;
    let coverage;
    if (this.printLog) {
      tasks = this.printLog.query(sinceMs, untilMs);
      coverage = this.printLog.coverage();
      const last = coverage.at(-1);
      if (last && last[1] < now && now - last[1] <= FRESH_MS) last[1] = now;
    } else {
      tasks = cloudOk ? cloud.tasks : [];
      coverage = cloudOk && cloud.complete ? [[-Infinity, Infinity]] : [];
    }

    // The part of the day that has already happened but was never observed.
    const pastEnd = Math.min(untilMs, now);
    const gaps = pastEnd > dayStart ? uncoveredSegments(dayStart, pastEnd, coverage) : [];
    const unseenMs = gaps.reduce((sum, [s, e]) => sum + e - s, 0);
    const printsAvailable = pastEnd <= dayStart || unseenMs < pastEnd - dayStart;

    let prints = null;
    if (cloudOk || printsAvailable) {
      const confirmed = cloud.confirmed || new Set();
      prints = tasks
        .map((t) => normalizeTask(t, names, now, { confirmed: confirmed.has(String(t.id)) }))
        .filter(Boolean);
    }

    const result = buildComparison({
      day,
      now,
      reservations,
      prints,
      devices: cloudOk ? cloud.devices : null,
      printerOrder: this.config.printerOrder,
      printerMap: this.config.printerMap,
      graceMinutes: this.config.graceMinutes,
      flagWeightGrams: this.config.flagWeightGrams,
      flagDurationHours: this.config.flagDurationHours,
      printCoverage: coverage,
    });

    result.demo = this.config.demo;
    result.printsAvailable = prints !== null && printsAvailable;
    result.printGaps = gaps.map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() }));
    const stale = hub.ok ? hub.got.find((d) => d.from === 'stale') : null;
    result.sources = {
      designhub: hub.ok
        ? {
          ok: true,
          skippedRows: hub.got[1].skipped,
          // When this day's reservations were saved, for days the server's
          // collection doesn't keep current.
          savedAt: hub.got[1].from === 'saved' ? hub.got[1].fetchedAt : null,
          ...(stale ? { stale: true, error: describeError(stale.error) } : {}),
        }
        : { ok: false, error: describeError(hub.error) },
      bambu: {
        ...(cloudOk
          ? { ok: true, complete: cloud.complete, deviceCount: cloud.deviceCount }
          : { ok: false, error: describeError(cloud.error), auth: this.bambu.status() }),
        log: this.printLog ? this.printLog.stats() : null,
      },
    };
    result.collector = this.collector ? this.collector.status() : null;
    return result;
  }

  // Filament used per reservation holder for prints that started between
  // `from` and `to` (inclusive local dates). The results are saved to the
  // usage log. `recalculate` first re-reads every day's reservations from
  // Design Hub, including days already saved as final.
  async usage(from, to, { force = false, recalculate = false } = {}) {
    const zone = this.config.timezone;
    if (!isIsoDate(from) || !isIsoDate(to)) {
      throw new SourceError('Dates must look like YYYY-MM-DD.', { code: 'bad_date' });
    }
    if (from > to) throw new SourceError('The start date is after the end date.', { code: 'bad_range' });
    if (daysBetween(from, to) + 1 > MAX_USAGE_DAYS) {
      throw new SourceError(`Pick at most ${MAX_USAGE_DAYS} days.`, { code: 'bad_range' });
    }
    if (force) await this.refreshNow();

    const now = this.now();
    const today = todayIn(zone, new Date(now));
    const rangeStart = Date.parse(dayBounds(from, zone).start);
    const rangeEnd = Date.parse(dayBounds(to, zone).end);

    // One agenda page per day, plus the day before `from` for bookings that
    // started the previous evening, and the day after `to` once a print
    // could have started in the grace period before its first bookings.
    const graceMs = this.config.graceMinutes * 60000;
    const lastDay = rangeEnd - graceMs <= now ? shiftDate(to, 1) : to < today ? to : today;
    const days = shiftDate(from, -1) <= lastDay ? dateList(shiftDate(from, -1), lastDay) : [];
    // Days in the range with no saved reservations (not read: pages only
    // read saved data; Refresh reads them) leave their prints out.
    let reservations = null;
    let hubError = null;
    const daysFrom = { designhub: 0, archive: 0, stale: 0, collected: 0, saved: 0 };
    const missingDays = [];
    const perDay = await mapLimit(days, 2, (d) => this.agendaDay(d, { force, recalculate })
      .catch((error) => ({ missing: true, error })));
    const byId = new Map();
    perDay.forEach((day, i) => {
      if (day.missing) {
        if (days[i] >= from && days[i] <= to) missingDays.push(days[i]);
        hubError ??= day.error;
        return;
      }
      daysFrom[day.from]++;
      for (const r of day.reservations) byId.set(r.id, r);
    });
    const inRange = days.filter((d) => d >= from && d <= to);
    if (missingDays.length < inRange.length) {
      reservations = [...byId.values()];
      hubError = null;
    }

    // Prints come from the print log, which the server's collection keeps
    // filling; report Bambu as the last collection found it.
    let bambuError = null;
    if (this.printLog) {
      const found = this.collected?.bambu;
      if (!found) bambuError = new SourceError('Bambu has not been checked yet.', { code: 'bambu_pending' });
      else if (!found.ok) bambuError = found.error;
    }

    let tasks;
    let coverage;
    let devices = this.lastFetch?.devices || null;
    let confirmed = this.lastFetch && now - this.lastFetch.at <= FRESH_MS ? this.lastFetch.ids : new Set();
    if (this.printLog) {
      tasks = this.printLog.query(rangeStart, rangeEnd);
      coverage = this.printLog.coverage();
      const last = coverage.at(-1);
      if (last && last[1] < now && now - last[1] <= FRESH_MS) last[1] = now;
    } else {
      // Demo mode keeps no log; ask the client for the whole range.
      try {
        devices = await this.bambu.getDevices();
        const got = await this.bambu.getTasks({ sinceMs: rangeStart, untilMs: Math.min(rangeEnd, now + 1) });
        tasks = got.tasks;
        coverage = got.complete ? [[-Infinity, Infinity]] : [];
        confirmed = new Set(tasks.map((t) => String(t.id)));
      } catch (err) {
        bambuError = err;
        tasks = [];
        coverage = [];
      }
    }

    const pastEnd = Math.min(rangeEnd, now);
    const gaps = pastEnd > rangeStart ? uncoveredSegments(rangeStart, pastEnd, coverage) : [];

    const base = {
      from,
      to,
      timezone: zone,
      now: new Date(now).toISOString(),
      demo: this.config.demo,
      graceMinutes: this.config.graceMinutes,
      maxOutsideShare: MAX_OUTSIDE_SHARE,
      printGaps: gaps.map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() })),
      collector: this.collector ? this.collector.status() : null,
      sources: {
        designhub: hubError
          ? { ok: false, error: describeError(hubError) }
          : {
            ok: true, days: days.length, savedDays: daysFrom.archive + daysFrom.saved, collectedDays: daysFrom.collected,
            staleDays: daysFrom.stale, missingDays,
          },
        reservationArchive: this.reservationArchive ? this.reservationArchive.stats() : null,
        usageLog: this.usageLog ? this.usageLog.stats() : null,
        bambu: {
          ok: !bambuError,
          ...(bambuError ? { error: describeError(bambuError), auth: this.bambu.status() } : {}),
          log: this.printLog ? this.printLog.stats() : null,
        },
      },
    };
    // Without the agenda nothing can be attributed; say so instead of
    // showing every print as unreserved.
    const allTime = () => (this.usageLog ? this.usageLog.totals() : null);
    if (!reservations) {
      return { ...base, available: false, users: [], unattributed: { prints: 0, grams: 0, list: [] }, totals: null, allTime: allTime() };
    }

    const names = new Map((devices || []).map((d) => [d.dev_id, d.name]));
    const missing = new Set(missingDays);
    const prints = tasks
      .map((t) => normalizeTask(t, names, now, { confirmed: confirmed.has(String(t.id)) }))
      .filter((p) => p && !missing.has(todayIn(zone, new Date(p.start))));
    // Runs past the range by the grace period, for bookings just after it
    // that a print in the range started in the grace period of.
    const comparison = buildComparison({
      day: { date: from, start: new Date(rangeStart).toISOString(), end: new Date(rangeEnd + graceMs).toISOString(), timezone: zone },
      now,
      reservations,
      prints,
      devices,
      printerOrder: this.config.printerOrder,
      printerMap: this.config.printerMap,
      graceMinutes: this.config.graceMinutes,
      printCoverage: coverage,
    });
    const usage = attributeUsage({ comparison, rangeStart, rangeEnd, now });
    if (this.usageLog) {
      await this.usageLog.save(usageRecords(usage), { at: now, recalculation: recalculate ? { from, to } : null });
      base.sources.usageLog = this.usageLog.stats();
    }
    return { ...base, available: true, recalculated: recalculate, ...usage, allTime: allTime() };
  }

  // Recalculates the usage of every print from saved data only: the print
  // log and the saved reservations. Nothing is read from Design Hub or
  // Bambu. Prints that started on a day with no saved reservations are
  // left as they were.
  async recalculateTotal() {
    if (!this.usageLog || !this.reservationArchive) {
      throw new SourceError('Usage is not being saved, so there is no total to recalculate.', { code: 'not_saved' });
    }
    const zone = this.config.timezone;
    const now = this.now();
    const dates = this.reservationArchive.dates();
    if (!dates.length) {
      throw new SourceError('No reservations are saved yet.', {
        code: 'nothing_saved', hint: 'Load or recalculate a date range first; its reservations are saved as they are read.',
      });
    }
    const savedDays = new Set(dates);
    const rangeStart = Date.parse(dayBounds(dates[0], zone).start);
    const rangeEnd = Date.parse(dayBounds(dates.at(-1), zone).end);
    const byId = new Map();
    for (const d of dates) for (const r of this.reservationArchive.get(d).reservations) byId.set(r.id, r);

    let tasks;
    let confirmed;
    if (this.printLog) {
      tasks = this.printLog.query(-Infinity, Infinity);
      confirmed = this.lastFetch && now - this.lastFetch.at <= FRESH_MS ? this.lastFetch.ids : new Set();
    } else {
      // Demo mode keeps no print log; its generated prints stand in for it.
      tasks = (await this.bambu.getTasks({ sinceMs: rangeStart, untilMs: Math.min(rangeEnd, now + 1) })).tasks;
      confirmed = new Set(tasks.map((t) => String(t.id)));
    }
    const devices = this.lastFetch?.devices || null;
    const names = new Map((devices || []).map((d) => [d.dev_id, d.name]));
    const all = tasks
      .map((t) => normalizeTask(t, names, now, { confirmed: confirmed.has(String(t.id)) }))
      .filter(Boolean);
    const prints = all.filter((p) => savedDays.has(todayIn(zone, new Date(p.start))));

    const graceMs = this.config.graceMinutes * 60000;
    const comparison = buildComparison({
      day: { date: dates[0], start: new Date(rangeStart).toISOString(), end: new Date(rangeEnd + graceMs).toISOString(), timezone: zone },
      now,
      reservations: [...byId.values()],
      prints,
      devices,
      printerOrder: this.config.printerOrder,
      printerMap: this.config.printerMap,
      graceMinutes: this.config.graceMinutes,
    });
    const records = usageRecords(attributeUsage({ comparison, rangeStart, rangeEnd, now }));
    await this.usageLog.save(records, {
      at: now,
      totalRecalculation: { from: dates[0], to: dates.at(-1), prints: records.length, skippedPrints: all.length - prints.length },
    });
    return { allTime: this.usageLog.totals(), usageLog: this.usageLog.stats() };
  }
}
