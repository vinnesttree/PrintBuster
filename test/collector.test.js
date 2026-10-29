import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Collector } from '../src/collector.js';

const MIN = 60000;
const flush = () => new Promise((r) => setImmediate(r));

// A clock and setTimeout the test moves by hand.
function fakeClock() {
  let t = 0;
  const pending = [];
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => { const h = { fn, at: t + ms }; pending.push(h); return h; },
      clearTimeout: (h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
    },
    async advance(ms) {
      const until = t + ms;
      for (;;) {
        const due = pending.filter((h) => h.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        pending.splice(pending.indexOf(due), 1);
        t = due.at;
        due.fn();
        await flush();
      }
      t = until;
    },
  };
}

function setup({ idle = 15, active = 2, run } = {}) {
  const clock = fakeClock();
  const runs = [];
  const results = [];
  const collector = new Collector({
    run: run || (async () => { runs.push(clock.now()); }),
    idleMs: idle * MIN,
    activeMs: active * MIN,
    now: clock.now,
    timers: clock.timers,
    onRun: (r) => results.push(r),
  });
  return { clock, runs, results, collector };
}

describe('Collector', () => {
  it('collects at start, then every 15 minutes while no page is open', async () => {
    const { clock, runs, collector } = setup();
    collector.start();
    await flush();
    assert.deepEqual(runs, [0]);
    await clock.advance(14 * MIN);
    assert.equal(runs.length, 1);
    await clock.advance(MIN);
    await clock.advance(15 * MIN);
    assert.deepEqual(runs, [0, 15 * MIN, 30 * MIN]);
    assert.equal(collector.status().nextRunAt, new Date(45 * MIN).toISOString());
  });

  it('collects every 2 minutes while a page is open, and catches up when the first one opens', async () => {
    const { clock, runs, collector } = setup();
    collector.start();
    await flush();
    await clock.advance(5 * MIN);
    collector.addViewer('a');
    await flush();
    assert.deepEqual(runs, [0, 5 * MIN], 'data was 5 minutes old, so it collected at once');
    collector.addViewer('b');
    await clock.advance(6 * MIN);
    assert.deepEqual(runs, [0, 5 * MIN, 7 * MIN, 9 * MIN, 11 * MIN]);
    assert.equal(collector.status().viewers, 2);

    collector.removeViewer('a');
    await clock.advance(2 * MIN);
    assert.equal(runs.at(-1), 13 * MIN, 'one page is still open');
    collector.removeViewer('b');
    await clock.advance(14 * MIN);
    assert.equal(runs.at(-1), 13 * MIN);
    await clock.advance(MIN);
    assert.equal(runs.at(-1), 28 * MIN, 'back to every 15 minutes from the last run');
  });

  it("doesn't collect again when a page opens right after a collection", async () => {
    const { clock, runs, collector } = setup();
    collector.start();
    await flush();
    await clock.advance(MIN);
    collector.addViewer('a');
    await flush();
    assert.deepEqual(runs, [0]);
    await clock.advance(MIN);
    assert.deepEqual(runs, [0, 2 * MIN]);
  });

  it('shares one collection between everyone asking at once', async () => {
    let release;
    let count = 0;
    const { collector } = setup({ run: () => { count++; return new Promise((r) => { release = r; }); } });
    const a = collector.runNow();
    const b = collector.ensureFresh();
    const c = collector.runNow();
    assert.equal(count, 1);
    assert.equal(collector.status().running, true);
    release();
    await Promise.all([a, b, c]);
    assert.equal(count, 1);
    await collector.ensureFresh();
    assert.equal(count, 1, 'fresh enough');
  });

  it('keeps its schedule after a failed collection and reports the error', async () => {
    const { clock, results, collector } = setup({ run: async () => { throw new Error('offline'); } });
    collector.start();
    await flush();
    await clock.advance(15 * MIN);
    assert.deepEqual(results.map((r) => [r.at, r.error?.message]), [[0, 'offline'], [15 * MIN, 'offline']]);
  });

  it('turns a schedule off with an interval of 0', async () => {
    const { clock, runs, collector } = setup({ idle: 0 });
    collector.start();
    await flush();
    await clock.advance(60 * MIN);
    assert.deepEqual(runs, [0], 'nothing while no page is open');
    collector.addViewer('a');
    await flush();
    await clock.advance(4 * MIN);
    assert.deepEqual(runs, [0, 60 * MIN, 62 * MIN, 64 * MIN]);
    collector.stop();
    await clock.advance(10 * MIN);
    assert.equal(runs.length, 4);
  });
});
