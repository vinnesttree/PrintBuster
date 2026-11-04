import { setTimeout as sleep } from 'node:timers/promises';
import { describeError, SourceError } from './errors.js';

// The admin panel's Bambu history import: reads everything the Bambu cloud
// still keeps of the print history (about 90 days) into the print log, in
// the background. The server's collection only reads the last two days of
// prints each time, so this is how prints from before PrintBuster started
// are added. One import runs at a time; the page polls its progress.

// A short pause between pages, so a long history isn't read in one burst.
const PAGE_PAUSE_MS = 250;

export class BambuHistoryImport {
  constructor(service, { now = () => Date.now(), pauseMs = PAGE_PAUSE_MS } = {}) {
    this.service = service;
    this.now = now;
    this.pauseMs = pauseMs;
    this.job = null;
    this.running = null;
    this.nextId = 1;
  }

  get busy() {
    return Boolean(this.running);
  }

  get maxPages() {
    return this.service.config.bambu?.maxHistoryPages ?? 400;
  }

  // Starts reading the history. `recalculateTotal` recalculates the
  // all-time usage from saved data once it ends.
  start({ recalculateTotal = false } = {}) {
    const { config } = this.service;
    if (config.demo || !this.service.printLog) {
      throw new SourceError('Demo mode keeps no print log, so there is no Bambu history to import.', { code: 'demo' });
    }
    if (!config.bambu?.configured) {
      throw new SourceError('No Bambu credentials are configured.', {
        code: 'bambu_not_configured', hint: 'Set BAMBU_EMAIL and BAMBU_PASSWORD (or BAMBU_ACCESS_TOKEN) in .env.',
      });
    }
    if (this.running) {
      throw new SourceError('A Bambu history import is already running.', { code: 'import_running', hint: 'Wait for it to finish, or stop it.' });
    }
    this.job = {
      id: this.nextId++,
      recalculateTotal: Boolean(recalculateTotal),
      state: 'running',
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      pages: 0,
      // Prints read, and how many Bambu says it has.
      prints: 0,
      total: null,
      // Prints the print log didn't have before.
      added: 0,
      oldest: null,
      complete: false,
      error: null,
      stopReason: null,
      totalRecalculation: null,
    };
    this.running = this.run(this.job).finally(() => { this.running = null; });
    return this.status();
  }

  // Asks the running import to stop after the page being read.
  stop() {
    if (this.running && !this.job.stopReason) this.job.stopReason = 'stopped';
    return this.status();
  }

  async run(job) {
    const { service } = this;
    const log = service.printLog;
    const before = log.stats().prints;
    try {
      const got = await service.importBambuHistory({
        maxPages: this.maxPages,
        onPage: async ({ hits, tasks, total }) => {
          job.pages++;
          job.prints = tasks;
          job.total = total;
          job.added = log.stats().prints - before;
          for (const t of hits) {
            if (!job.oldest || Date.parse(t.startTime) < Date.parse(job.oldest)) job.oldest = new Date(Date.parse(t.startTime)).toISOString();
          }
          if (job.stopReason) return false;
          if (this.pauseMs) await sleep(this.pauseMs);
          return !job.stopReason;
        },
      });
      job.complete = got.complete;
      if (got.complete) job.stopReason = null;
      else if (!job.stopReason) job.stopReason = job.pages >= this.maxPages ? 'page_limit' : 'incomplete';
    } catch (err) {
      job.error = describeError(err);
    }
    job.added = log.stats().prints - before;
    await log.queue;

    if (job.recalculateTotal && job.added) {
      try {
        const { usageLog } = await service.recalculateTotal();
        job.totalRecalculation = { ok: true, prints: usageLog.prints };
      } catch (err) {
        job.totalRecalculation = { ok: false, error: describeError(err) };
      }
    }
    job.state = job.error ? 'failed' : job.stopReason ? 'stopped' : 'done';
    job.finishedAt = new Date(this.now()).toISOString();
  }

  status() {
    const log = this.service.printLog;
    return {
      job: this.job ? { ...this.job } : null,
      maxPages: this.maxPages,
      pageSize: this.service.config.bambu?.taskPageSize ?? null,
      printLog: log ? log.stats() : null,
    };
  }
}
