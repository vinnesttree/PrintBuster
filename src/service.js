import { normalizeTask } from './bambu.js';
import { buildComparison, uncoveredSegments } from './compare.js';
import { describeError } from './errors.js';
import { dayBounds } from './time.js';

// Prints longer than this that started before the selected day are missed.
const PRINT_LOOKBACK_MS = 48 * 3600 * 1000;
// A fetch this recent counts as an observation of the present moment.
const FRESH_MS = 10 * 60 * 1000;

export class CompareService {
  constructor(config, { designhub, bambu, printLog = null, now = () => Date.now() }) {
    this.config = config;
    this.designhub = designhub;
    this.bambu = bambu;
    this.printLog = printLog;
    this.now = now;
    this.cache = new Map();
    this.pollTimer = null;
    this.polling = false;
    this.pollError = null;
  }

  cached(key, fn, force) {
    const hit = this.cache.get(key);
    const ttl = this.config.cacheSeconds * 1000;
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
      if (this.printLog) await this.printLog.record({ tasks, devices, fetchedAt: this.now() });
      return { devices, tasks, complete };
    }, force);
  }

  // One background fetch. The first one for an empty log takes everything
  // Bambu still has.
  pollBambu() {
    const now = this.now();
    const sinceMs = this.printLog?.coverage().length ? now - PRINT_LOOKBACK_MS : 0;
    return this.fetchBambu('bambu:poll', { sinceMs, untilMs: now, force: true });
  }

  startPolling(minutes) {
    if (!minutes || !this.printLog) return;
    const run = async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        await this.pollBambu();
        if (this.pollError) console.log('Bambu print logging resumed.');
        this.pollError = null;
      } catch (err) {
        const { message, hint } = describeError(err);
        // Say it once, not every few minutes.
        if (message !== this.pollError) console.warn(`Bambu print logging paused: ${message}${hint ? ` ${hint}` : ''}`);
        this.pollError = message;
      } finally {
        this.polling = false;
      }
    };
    run();
    this.pollTimer = setInterval(run, minutes * 60000);
    this.pollTimer.unref();
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async compare(isoDate, { force = false } = {}) {
    const day = dayBounds(isoDate, this.config.timezone);
    const dayStart = Date.parse(day.start);
    const sinceMs = dayStart - PRINT_LOOKBACK_MS;
    const untilMs = Date.parse(day.end);

    const [hub, cloud] = await Promise.allSettled([
      this.cached(`hub:${isoDate}`, () => this.designhub.getReservations(isoDate), force),
      this.fetchBambu(`bambu:${isoDate}`, { sinceMs, untilMs, force }),
    ]);

    const now = this.now();
    const cloudOk = cloud.status === 'fulfilled';
    const names = new Map(cloudOk ? cloud.value.devices.map((d) => [d.dev_id, d.name]) : []);

    // With a print log, prints come from it (it includes this fetch) and only
    // spans that some fetch observed count as known. Demo mode has no log.
    let tasks;
    let coverage;
    if (this.printLog) {
      tasks = this.printLog.query(sinceMs, untilMs);
      coverage = this.printLog.coverage();
      const last = coverage.at(-1);
      if (last && last[1] < now && now - last[1] <= FRESH_MS) last[1] = now;
    } else {
      tasks = cloudOk ? cloud.value.tasks : [];
      coverage = cloudOk && cloud.value.complete ? [[-Infinity, Infinity]] : [];
    }

    // The part of the day that has already happened but was never observed.
    const pastEnd = Math.min(untilMs, now);
    const gaps = pastEnd > dayStart ? uncoveredSegments(dayStart, pastEnd, coverage) : [];
    const unseenMs = gaps.reduce((sum, [s, e]) => sum + e - s, 0);
    const printsAvailable = pastEnd <= dayStart || unseenMs < pastEnd - dayStart;

    let prints = null;
    if (cloudOk || printsAvailable) {
      const confirmed = new Set(cloudOk ? cloud.value.tasks.map((t) => String(t.id)) : []);
      prints = tasks
        .map((t) => normalizeTask(t, names, now, { confirmed: confirmed.has(String(t.id)) }))
        .filter(Boolean);
    }

    const result = buildComparison({
      day,
      now,
      reservations: hub.status === 'fulfilled' ? hub.value.reservations : null,
      prints,
      devices: cloudOk ? cloud.value.devices : null,
      printerOrder: this.config.printerOrder,
      printerMap: this.config.printerMap,
      graceMinutes: this.config.graceMinutes,
      printCoverage: coverage,
    });

    result.demo = this.config.demo;
    result.printsAvailable = prints !== null && printsAvailable;
    result.printGaps = gaps.map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() }));
    result.sources = {
      designhub: hub.status === 'fulfilled'
        ? { ok: true, skippedRows: hub.value.skipped }
        : { ok: false, error: describeError(hub.reason) },
      bambu: {
        ...(cloudOk
          ? { ok: true, complete: cloud.value.complete, deviceCount: cloud.value.devices.length }
          : { ok: false, error: describeError(cloud.reason), auth: this.bambu.status() }),
        log: this.printLog ? this.printLog.stats() : null,
      },
    };
    return result;
  }
}
