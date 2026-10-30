import { describeError, SourceError } from './errors.js';
import { dateList, daysBetween, isIsoDate } from './time.js';

// The admin panel's bulk import: reads every agenda day in a date range from
// Design Hub into the saved reservations, in the background, so past usage
// can be calculated for days before the print log or the collection began.
// One import runs at a time; the page polls its progress.

// A year of agenda pages, one request each.
export const MAX_IMPORT_DAYS = 366;
// Agenda pages read at once, as Recalculate does.
const CONCURRENCY = 2;
// Failures in a row after which Design Hub is taken to be down and the
// import stops, rather than failing every remaining day.
const MAX_FAILURES_IN_A_ROW = 5;

export class ReservationImport {
  constructor(service, { now = () => Date.now() } = {}) {
    this.service = service;
    this.now = now;
    this.job = null;
    this.running = null;
    this.nextId = 1;
  }

  get busy() {
    return Boolean(this.running);
  }

  // Starts importing `from`..`to` (inclusive local dates). `skipFinal` leaves
  // out days already saved as final; otherwise every day is read again, as
  // Recalculate does. `recalculateTotal` recalculates the all-time usage from
  // saved data once the import ends.
  start({ from, to, skipFinal = true, recalculateTotal = false } = {}) {
    const { config } = this.service;
    if (!isIsoDate(from) || !isIsoDate(to)) {
      throw new SourceError('Dates must look like YYYY-MM-DD.', { code: 'bad_date' });
    }
    if (from > to) throw new SourceError('The start date is after the end date.', { code: 'bad_range' });
    if (daysBetween(from, to) + 1 > MAX_IMPORT_DAYS) {
      throw new SourceError(`Pick at most ${MAX_IMPORT_DAYS} days.`, { code: 'bad_range' });
    }
    if (!config.demo && !config.designhub?.configured) {
      throw new SourceError('Design Hub credentials are not configured.', {
        code: 'designhub_not_configured', hint: 'Set DESIGNHUB_USERNAME and DESIGNHUB_PASSWORD (or DESIGNHUB_COOKIE) in .env.',
      });
    }
    if (this.running) {
      throw new SourceError('An import is already running.', { code: 'import_running', hint: 'Wait for it to finish, or stop it.' });
    }

    const dates = dateList(from, to);
    const archive = this.service.reservationArchive;
    const toRead = skipFinal ? dates.filter((d) => !archive?.get(d)?.final) : dates;
    this.job = {
      id: this.nextId++,
      from,
      to,
      skipFinal: Boolean(skipFinal),
      recalculateTotal: Boolean(recalculateTotal),
      state: 'running',
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      days: dates.length,
      // Days already saved as final, left out.
      skipped: dates.length - toRead.length,
      toRead: toRead.length,
      read: 0,
      reservations: 0,
      failed: [],
      stopReason: null,
      totalRecalculation: null,
    };
    this.running = this.run(this.job, toRead).finally(() => { this.running = null; });
    return this.status();
  }

  // Asks the running import to stop after the days already being read.
  stop() {
    if (this.running && !this.job.stopReason) this.job.stopReason = 'stopped';
    return this.status();
  }

  async run(job, dates) {
    const { service } = this;
    let next = 0;
    let failuresInARow = 0;
    const worker = async () => {
      while (next < dates.length && !job.stopReason) {
        const date = dates[next++];
        try {
          // Shares its read with a Refresh or collection of the same day.
          const day = await service.cached(`hubday:${date}`, () => service.fetchAgendaDay(date), true);
          job.read++;
          job.reservations += day.reservations.length;
          failuresInARow = 0;
        } catch (err) {
          job.failed.push({ date, error: describeError(err) });
          if (++failuresInARow >= MAX_FAILURES_IN_A_ROW) job.stopReason ??= 'failing';
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dates.length) }, worker));
    job.failed.sort((a, b) => a.date.localeCompare(b.date));
    await service.reservationArchive?.queue;

    if (job.recalculateTotal && job.read) {
      try {
        const { usageLog } = await service.recalculateTotal();
        job.totalRecalculation = { ok: true, prints: usageLog.prints };
      } catch (err) {
        job.totalRecalculation = { ok: false, error: describeError(err) };
      }
    }
    job.state = job.stopReason ? 'stopped' : 'done';
    job.finishedAt = new Date(this.now()).toISOString();
  }

  status() {
    const archive = this.service.reservationArchive;
    return {
      job: this.job ? { ...this.job, failed: [...this.job.failed] } : null,
      maxDays: MAX_IMPORT_DAYS,
      reservationArchive: archive ? { ...archive.stats(), until: archive.dates().at(-1) || null } : null,
    };
  }
}
