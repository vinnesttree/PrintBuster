import { JsonFileStore } from './files.js';

// Every agenda day the app reads is saved here, so the reservations behind
// past filament usage survive restarts and container rebuilds and don't
// depend on Design Hub still showing them. A day read after it ended is
// final: it is served from this file and only read from Design Hub again
// when usage is recalculated.

export class ReservationArchive extends JsonFileStore {
  constructor(file) {
    super(file, 'reservation archive');
    this.days = new Map();
  }

  async load() {
    const saved = await this.readJson();
    for (const [date, day] of Object.entries(saved?.days || {})) {
      if (Array.isArray(day?.reservations)) this.days.set(date, day);
    }
  }

  get(date) {
    return this.days.get(date);
  }

  dates() {
    return [...this.days.keys()].sort();
  }

  // Saves one day's reservations. `final` marks a day read after it ended.
  save(date, reservations, { fetchedAt, final }) {
    const prev = this.days.get(date);
    if (prev?.final && !final) return this.queue;
    const day = { fetchedAt: new Date(fetchedAt).toISOString(), final: Boolean(final), reservations };
    this.days.set(date, day);
    // Rewriting the file for an unchanged day would only churn it.
    if (prev && prev.final === day.final && JSON.stringify(prev.reservations) === JSON.stringify(reservations)) return this.queue;
    return this.persist(() => ({ days: Object.fromEntries([...this.days.entries()].sort(([a], [b]) => a.localeCompare(b))) }));
  }

  stats() {
    const dates = [...this.days.keys()].sort();
    return { days: dates.length, since: dates[0] || null, writeError: this.writeError };
  }
}
