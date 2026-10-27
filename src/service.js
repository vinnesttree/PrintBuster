import { normalizeTask } from './bambu.js';
import { buildComparison } from './compare.js';
import { describeError } from './errors.js';
import { dayBounds } from './time.js';

// Prints longer than this that started before the selected day are missed.
const PRINT_LOOKBACK_MS = 48 * 3600 * 1000;

export class CompareService {
  constructor(config, { designhub, bambu, now = () => Date.now() }) {
    this.config = config;
    this.designhub = designhub;
    this.bambu = bambu;
    this.now = now;
    this.cache = new Map();
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

  async compare(isoDate, { force = false } = {}) {
    const day = dayBounds(isoDate, this.config.timezone);
    const sinceMs = Date.parse(day.start) - PRINT_LOOKBACK_MS;
    const untilMs = Date.parse(day.end);

    const [hub, cloud] = await Promise.allSettled([
      this.cached(`hub:${isoDate}`, () => this.designhub.getReservations(isoDate), force),
      this.cached(`bambu:${isoDate}`, async () => {
        const devices = await this.bambu.getDevices();
        const { tasks, complete } = await this.bambu.getTasks({ sinceMs, untilMs });
        return { devices, tasks, complete };
      }, force),
    ]);

    const now = this.now();
    let prints = null;
    if (cloud.status === 'fulfilled') {
      const names = new Map(cloud.value.devices.map((d) => [d.dev_id, d.name]));
      prints = cloud.value.tasks.map((t) => normalizeTask(t, names, now)).filter(Boolean);
    }

    const result = buildComparison({
      day,
      now,
      reservations: hub.status === 'fulfilled' ? hub.value.reservations : null,
      prints,
      devices: cloud.status === 'fulfilled' ? cloud.value.devices : null,
      printerOrder: this.config.printerOrder,
      printerMap: this.config.printerMap,
      graceMinutes: this.config.graceMinutes,
      bambuComplete: cloud.status === 'fulfilled' && cloud.value.complete,
    });

    result.demo = this.config.demo;
    result.sources = {
      designhub: hub.status === 'fulfilled'
        ? { ok: true, skippedRows: hub.value.skipped }
        : { ok: false, error: describeError(hub.reason) },
      bambu: cloud.status === 'fulfilled'
        ? { ok: true, complete: cloud.value.complete, deviceCount: cloud.value.devices.length }
        : { ok: false, error: describeError(cloud.reason), auth: this.bambu.status() },
    };
    return result;
  }
}
