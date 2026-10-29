// Runs the server's data collection on a schedule: every `activeMs` while at
// least one page is open, every `idleMs` while none is. Pages only read what
// the server already has, so any number of viewers adds no requests to
// Design Hub or Bambu, and collection carries on when nobody is watching.
// An interval of 0 turns that schedule off.

export class Collector {
  constructor({ run, idleMs, activeMs, now = () => Date.now(), timers = globalThis, onRun = () => {} }) {
    this.run = run;
    this.idleMs = idleMs;
    this.activeMs = activeMs;
    this.now = now;
    this.timers = timers;
    this.onRun = onRun;
    this.viewers = new Set();
    this.lastRunAt = null;
    this.nextRunAt = null;
    this.running = null;
    this.timer = null;
    this.started = false;
  }

  get intervalMs() {
    return this.viewers.size ? this.activeMs : this.idleMs;
  }

  start() {
    this.started = true;
    if (this.lastRunAt === null) this.runNow();
    else this.schedule();
  }

  stop() {
    this.started = false;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  // Arms the next run, counted from the last one.
  schedule() {
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    if (!this.started || this.running || !this.intervalMs) return;
    this.nextRunAt = (this.lastRunAt ?? this.now()) + this.intervalMs;
    this.timer = this.timers.setTimeout(() => this.runNow(), Math.max(0, this.nextRunAt - this.now()));
    this.timer.unref?.();
  }

  // Runs a collection now, or joins the one already running.
  runNow() {
    if (this.running) return this.running;
    this.timers.clearTimeout(this.timer);
    this.running = (async () => {
      let error = null;
      try {
        await this.run();
      } catch (err) {
        error = err;
      } finally {
        this.lastRunAt = this.now();
        this.running = null;
        this.schedule();
      }
      this.onRun({ at: this.lastRunAt, error });
    })();
    return this.running;
  }

  // Waits for a collection if the data is older than `maxAgeMs`.
  ensureFresh(maxAgeMs = this.activeMs) {
    if (this.running) return this.running;
    if (this.lastRunAt === null || this.now() - this.lastRunAt > maxAgeMs) return this.runNow();
    return Promise.resolve();
  }

  // A page opened. The first one brings stale data up to date at once.
  addViewer(id) {
    this.viewers.add(id);
    if (this.viewers.size === 1 && this.started && this.activeMs
      && (this.lastRunAt === null || this.now() - this.lastRunAt >= this.activeMs)) {
      this.runNow();
    } else {
      this.schedule();
    }
  }

  removeViewer(id) {
    if (this.viewers.delete(id)) this.schedule();
  }

  status() {
    const iso = (t) => (t === null ? null : new Date(t).toISOString());
    return {
      viewers: this.viewers.size,
      activeMinutes: this.activeMs / 60000,
      idleMinutes: this.idleMs / 60000,
      lastRunAt: iso(this.lastRunAt),
      nextRunAt: iso(this.nextRunAt),
      running: Boolean(this.running),
    };
  }
}
