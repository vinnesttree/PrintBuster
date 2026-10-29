import { JsonFileStore } from './files.js';

// The latest calculated filament usage of every print, saved next to the
// print log and reservations it was calculated from. Each calculation
// replaces the entries for the prints it covered; an entry's calculatedAt
// changes only when its result does.

const iso = (ms) => new Date(ms).toISOString();

export class UsageLog extends JsonFileStore {
  constructor(file) {
    super(file, 'usage log');
    this.prints = new Map();
    this.lastRecalculation = null;
  }

  async load() {
    const saved = await this.readJson();
    for (const [id, rec] of Object.entries(saved?.prints || {})) this.prints.set(id, rec);
    this.lastRecalculation = saved?.lastRecalculation || null;
  }

  get(id) {
    return this.prints.get(String(id));
  }

  // Saves one calculation's per-print results. A recalculation also records
  // when it ran and for which dates.
  save(records, { at, recalculation = null }) {
    let changed = false;
    for (const rec of records) {
      const id = String(rec.id);
      const prev = this.prints.get(id);
      if (prev) {
        const { calculatedAt, ...rest } = prev;
        if (JSON.stringify(rest) === JSON.stringify(rec)) continue;
      }
      this.prints.set(id, { ...rec, calculatedAt: iso(at) });
      changed = true;
    }
    if (recalculation) {
      this.lastRecalculation = { at: iso(at), ...recalculation };
      changed = true;
    }
    if (!changed) return this.queue;
    return this.persist(() => ({
      lastRecalculation: this.lastRecalculation,
      prints: Object.fromEntries([...this.prints.entries()].sort(([, a], [, b]) => Date.parse(a.start) - Date.parse(b.start))),
    }));
  }

  stats() {
    return { prints: this.prints.size, lastRecalculation: this.lastRecalculation, writeError: this.writeError };
  }
}
