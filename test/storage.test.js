import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ReservationArchive } from '../src/reservations.js';
import { UsageLog } from '../src/usagelog.js';

const AT = Date.parse('2026-10-28T06:00:00Z');
const booking = (id, name) => ({ id, name, model: 'Ada', tool: 'Bambu Lab P1S', start: '2026-10-27T14:00:00.000Z', end: '2026-10-27T16:00:00.000Z', isEvent: false });

async function tempArchive() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-res-'));
  const file = path.join(dir, 'nested', 'reservations.json');
  const archive = new ReservationArchive(file);
  await archive.load();
  return { dir, file, archive };
}

describe('ReservationArchive', () => {
  it('saves days to disk, readable only by the owner, and reloads them', async () => {
    const { file, archive } = await tempArchive();
    await archive.save('2026-10-27', [booking('r1', 'Jane Doe')], { fetchedAt: AT, final: true });
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

    const again = new ReservationArchive(file);
    await again.load();
    assert.deepEqual(again.get('2026-10-27'), { fetchedAt: new Date(AT).toISOString(), final: true, reservations: [booking('r1', 'Jane Doe')] });
    assert.deepEqual(again.stats(), { days: 1, since: '2026-10-27', writeError: null });
  });

  it('never replaces a final day with an earlier, open copy', async () => {
    const { archive } = await tempArchive();
    await archive.save('2026-10-27', [booking('r1', 'Jane Doe')], { fetchedAt: AT, final: true });
    await archive.save('2026-10-27', [], { fetchedAt: AT + 1, final: false });
    assert.equal(archive.get('2026-10-27').reservations.length, 1);
  });

  it('does not rewrite the file for an unchanged open day', async () => {
    const { file, archive } = await tempArchive();
    await archive.save('2026-10-28', [booking('r2', 'Bob')], { fetchedAt: AT, final: false });
    const first = (await fs.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await archive.save('2026-10-28', [booking('r2', 'Bob')], { fetchedAt: AT + 60000, final: false });
    assert.equal((await fs.stat(file)).mtimeMs, first);
    // Turning final is a change worth saving.
    await archive.save('2026-10-28', [booking('r2', 'Bob')], { fetchedAt: AT + 86400000, final: true });
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).days['2026-10-28'].final, true);
  });

  it('moves an unreadable file aside instead of overwriting it', async () => {
    const { dir, file } = await tempArchive();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ not json');
    const archive = new ReservationArchive(file);
    const warn = console.warn;
    console.warn = () => {};
    try {
      await archive.load();
    } finally {
      console.warn = warn;
    }
    assert.equal(archive.stats().days, 0);
    const kept = (await fs.readdir(path.join(dir, 'nested'))).filter((f) => f.startsWith('reservations.json.unreadable-'));
    assert.equal(kept.length, 1);
    assert.equal(await fs.readFile(path.join(dir, 'nested', kept[0]), 'utf8'), '{ not json');
  });
});

describe('UsageLog', () => {
  const rec = (id, usedGrams) => ({
    id, start: '2026-10-27T14:00:00.000Z', usedGrams, counted: true, reservation: { id: 'r1', name: 'Jane Doe' },
    materials: [{ type: 'PLA', color: null, grams: usedGrams }],
  });

  it('saves per-print results, re-stamping only the ones that changed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-usage-log-'));
    const file = path.join(dir, 'usage.json');
    const log = new UsageLog(file);
    await log.load();
    await log.save([rec('1', 10), rec('2', 20)], { at: AT });
    await log.save([rec('1', 10), rec('2', 25)], { at: AT + 60000, recalculation: { from: '2026-10-27', to: '2026-10-27' } });

    const again = new UsageLog(file);
    await again.load();
    assert.deepEqual([again.get('1').usedGrams, again.get('1').calculatedAt], [10, new Date(AT).toISOString()]);
    assert.deepEqual([again.get('2').usedGrams, again.get('2').calculatedAt], [25, new Date(AT + 60000).toISOString()]);
    assert.deepEqual(again.stats(), {
      prints: 2, writeError: null, lastTotalRecalculation: null,
      lastRecalculation: { at: new Date(AT + 60000).toISOString(), from: '2026-10-27', to: '2026-10-27' },
    });
  });

  it('sums all-time totals per member from the saved results', () => {
    const log = new UsageLog(null);
    log.save([
      { ...rec('1', 10), start: '2026-10-20T14:00:00.000Z' },
      rec('2', 20.05),
      { ...rec('3', 7), counted: false },
      { id: '4', start: '2026-10-27T18:00:00.000Z', usedGrams: 5, counted: false, reservation: null },
      { id: '5', start: '2026-10-27T19:00:00.000Z', usedGrams: 3, counted: true, reservation: { id: 'r9', name: 'Event: Open house', isEvent: true } },
    ], { at: AT, totalRecalculation: { from: '2026-10-20', to: '2026-10-27', prints: 5, skippedPrints: 0 } });
    const t = log.totals();
    assert.deepEqual(t.members, [
      {
        name: 'Jane Doe', isEvent: false, prints: 2, grams: 30.1, excludedPrints: 1, excludedGrams: 7,
        materials: { PLA: 30.1 }, lastPrint: '2026-10-27T14:00:00.000Z',
      },
      {
        name: 'Event: Open house', isEvent: true, prints: 1, grams: 3, excludedPrints: 0, excludedGrams: 0,
        materials: {}, lastPrint: '2026-10-27T19:00:00.000Z',
      },
    ]);
    assert.deepEqual(
      [t.since, t.countedPrints, t.countedGrams, t.excludedPrints, t.excludedGrams, t.unattributedPrints, t.unattributedGrams],
      ['2026-10-20T14:00:00.000Z', 3, 33.1, 1, 7, 1, 5],
    );
    assert.equal(t.lastTotalRecalculation.from, '2026-10-20');
  });

  it('keeps everything in memory when it has no file', async () => {
    const log = new UsageLog(null);
    await log.load();
    await log.save([rec('1', 10)], { at: AT });
    assert.deepEqual([log.get('1').usedGrams, log.stats().writeError], [10, null]);
  });
});
