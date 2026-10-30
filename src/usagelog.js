import { JsonFileStore } from './files.js';

// The latest calculated filament usage of every print, saved next to the
// print log and reservations it was calculated from. Each calculation
// replaces the entries for the prints it covered; an entry's calculatedAt
// changes only when its result does. All-time totals are summed from it.

const iso = (ms) => new Date(ms).toISOString();
const round1 = (n) => Math.round(n * 10) / 10;

export class UsageLog extends JsonFileStore {
  constructor(file) {
    super(file, 'usage log');
    this.prints = new Map();
    this.lastRecalculation = null;
    this.lastTotalRecalculation = null;
  }

  async load() {
    const saved = await this.readJson();
    for (const [id, rec] of Object.entries(saved?.prints || {})) this.prints.set(id, rec);
    this.lastRecalculation = saved?.lastRecalculation || null;
    this.lastTotalRecalculation = saved?.lastTotalRecalculation || null;
  }

  get(id) {
    return this.prints.get(String(id));
  }

  // Saves one calculation's per-print results. A recalculation (of a date
  // range, or of everything from saved data) also records when it ran.
  save(records, { at, recalculation = null, totalRecalculation = null }) {
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
    if (totalRecalculation) {
      this.lastTotalRecalculation = { at: iso(at), ...totalRecalculation };
      changed = true;
    }
    if (!changed) return this.queue;
    return this.persist(() => ({
      lastRecalculation: this.lastRecalculation,
      lastTotalRecalculation: this.lastTotalRecalculation,
      prints: Object.fromEntries([...this.prints.entries()].sort(([, a], [, b]) => Date.parse(a.start) - Date.parse(b.start))),
    }));
  }

  // Usage per member over every saved print.
  totals() {
    const members = new Map();
    const out = {
      since: null, countedPrints: 0, countedGrams: 0, excludedPrints: 0, excludedGrams: 0,
      unattributedPrints: 0, unattributedGrams: 0, lastTotalRecalculation: this.lastTotalRecalculation,
    };
    for (const r of this.prints.values()) {
      if (!out.since || Date.parse(r.start) < Date.parse(out.since)) out.since = r.start;
      const grams = r.usedGrams || 0;
      // A print with no reservation counts for the member staff assigned it to.
      const name = r.reservation?.name ?? r.assignedTo?.name;
      if (!name) {
        out.unattributedPrints++;
        out.unattributedGrams += grams;
        continue;
      }
      if (!members.has(name)) {
        members.set(name, {
          name, isEvent: Boolean(r.reservation?.isEvent), prints: 0, grams: 0, excludedPrints: 0, excludedGrams: 0,
          assignedPrints: 0, assignedGrams: 0, materials: {}, lastPrint: null,
        });
      }
      const m = members.get(name);
      if (!m.lastPrint || Date.parse(r.start) > Date.parse(m.lastPrint)) m.lastPrint = r.start;
      if (r.counted) {
        m.prints++;
        m.grams += grams;
        if (!r.reservation) {
          m.assignedPrints++;
          m.assignedGrams += grams;
        }
        for (const f of r.materials || []) m.materials[f.type] = (m.materials[f.type] || 0) + f.grams;
      } else {
        m.excludedPrints++;
        m.excludedGrams += grams;
      }
    }
    const list = [...members.values()].map((m) => ({
      ...m,
      grams: round1(m.grams),
      excludedGrams: round1(m.excludedGrams),
      assignedGrams: round1(m.assignedGrams),
      materials: Object.fromEntries(Object.entries(m.materials).map(([type, g]) => [type, round1(g)])),
    }));
    for (const m of list) {
      out.countedPrints += m.prints;
      out.countedGrams += m.grams;
      out.excludedPrints += m.excludedPrints;
      out.excludedGrams += m.excludedGrams;
    }
    for (const k of ['countedGrams', 'excludedGrams', 'unattributedGrams']) out[k] = round1(out[k]);
    return { ...out, members: list };
  }

  stats() {
    return {
      prints: this.prints.size, lastRecalculation: this.lastRecalculation,
      lastTotalRecalculation: this.lastTotalRecalculation, writeError: this.writeError,
    };
  }
}
