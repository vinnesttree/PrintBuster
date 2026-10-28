import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BRIDGE_MS, PrintLog, mergeIntervals } from '../src/printlog.js';

const H = 3600 * 1000;
const T0 = Date.parse('2026-10-27T12:00:00Z');
const at = (h) => new Date(T0 + h * H).toISOString();
const task = (id, startH, endH, extra = {}) => ({ id, deviceId: 'D1', startTime: at(startH), endTime: at(endH), status: 2, title: `Job ${id}`, costTime: 3600, ...extra });

async function tempLog() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-log-'));
  const file = path.join(dir, 'print-log.jsonl');
  const log = new PrintLog(file);
  await log.load();
  return { dir, file, log };
}
const lines = async (file) => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('mergeIntervals', () => {
  it('sorts, merges overlaps and drops empty spans', () => {
    assert.deepEqual(mergeIntervals([[5, 9], [1, 3], [2, 4], [7, 7]]), [[1, 4], [5, 9]]);
  });
});

describe('PrintLog', () => {
  it('appends a line only when a print is new or changed', async () => {
    const { file, log } = await tempLog();
    const devices = [{ dev_id: 'D1', name: 'Ada' }];
    const running = task(1, 0, 0, { status: 1 });

    await log.record({ tasks: [running, task(2, -3, -2)], devices, fetchedAt: T0 });
    await log.record({ tasks: [running, task(2, -3, -2)], devices, fetchedAt: T0 + 0.25 * H });
    assert.equal((await lines(file)).length, 2, 'unchanged tasks are not written again');

    await log.record({ tasks: [task(1, 0, 1.5), task(2, -3, -2)], devices, fetchedAt: T0 + 2 * H });
    const all = await lines(file);
    assert.equal(all.length, 3);
    assert.deepEqual(all[2], {
      id: '1', startTime: at(0), endTime: at(1.5), status: 2, deviceId: 'D1', deviceName: 'Ada', title: 'Job 1', costTime: 3600, recordedAt: at(2),
    });
  });

  it('persists material fields (length and amsDetailMapping)', async () => {
    const { file, log } = await tempLog();
    const ams = [{ ams: 1, filamentType: 'PETG', weight: 50, sourceColor: 'FF0000FF' }];
    await log.record({ tasks: [task(1, 0, 1, { weight: 50, length: 16800, amsDetailMapping: ams })], fetchedAt: T0 });
    const again = new PrintLog(file);
    await again.load();
    const [r] = again.query(0, Infinity);
    assert.equal(r.length, 16800);
    assert.deepEqual(r.amsDetailMapping, ams);
  });

  it('reloads the latest version of every print and the observed spans', async () => {
    const { file, log } = await tempLog();
    await log.record({ tasks: [task(1, 0, 0, { status: 1 })], fetchedAt: T0 });
    await log.record({ tasks: [task(1, 0, 1)], fetchedAt: T0 + H });

    const again = new PrintLog(file);
    await again.load();
    assert.equal(again.query(T0 - H, T0 + H).length, 1);
    assert.equal(again.query(T0 - H, T0 + H)[0].endTime, at(1));
    assert.deepEqual(again.coverage(), [[T0, T0 + H]]);
    assert.deepEqual(again.stats(), { prints: 1, since: at(0), writeError: null });
  });

  it('keeps a device name when the printer is no longer on the account', async () => {
    const { log } = await tempLog();
    await log.record({ tasks: [task(1, 0, 1)], devices: [{ dev_id: 'D1', name: 'Ada' }], fetchedAt: T0 + H });
    await log.record({ tasks: [task(1, 0, 1)], devices: [], fetchedAt: T0 + 2 * H });
    assert.equal(log.query(0, Infinity)[0].deviceName, 'Ada');
  });

  it('bridges fetches close together and leaves real gaps open', async () => {
    const { log } = await tempLog();
    await log.record({ tasks: [task(1, -5, -4)], fetchedAt: T0 });
    // A quiet fetch an hour later: Bambu returned nothing, but nothing was missed.
    await log.record({ tasks: [], fetchedAt: T0 + H });
    assert.deepEqual(log.coverage(), [[T0 - 5 * H, T0 + H]]);

    // The app was off for longer than the bridge window.
    const later = T0 + H + BRIDGE_MS + H;
    await log.record({ tasks: [task(2, (later - T0) / H - 2, (later - T0) / H - 1)], fetchedAt: later });
    assert.deepEqual(log.coverage(), [[T0 - 5 * H, T0 + H], [later - 2 * H, later]]);
  });

  it('survives a partial last line from a crash', async () => {
    const { file } = await tempLog();
    await fs.writeFile(file, `${JSON.stringify({ id: '1', startTime: at(0), endTime: at(1), status: 2 })}\n{"id":"2","startTi`);
    const log = new PrintLog(file);
    await log.load();
    assert.equal(log.stats().prints, 1);
    await log.record({ tasks: [task(3, 1, 2)], fetchedAt: T0 + 3 * H });

    const reloaded = new PrintLog(file);
    await reloaded.load();
    assert.deepEqual(reloaded.query(0, Infinity).map((r) => r.id).sort(), ['1', '3']);
  });

  it('keeps unsaved prints in memory and writes them once the folder is usable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-log-'));
    const blocker = path.join(dir, 'data');
    await fs.writeFile(blocker, 'not a folder');
    const file = path.join(blocker, 'print-log.jsonl');
    const log = new PrintLog(file);
    await log.load();

    await log.record({ tasks: [task(1, 0, 1)], fetchedAt: T0 + H });
    assert.match(log.stats().writeError, /ENOTDIR|EEXIST|not a directory/i);
    assert.equal(log.query(0, Infinity).length, 1, 'still usable from memory');

    await fs.rm(blocker);
    await log.record({ tasks: [task(2, 1, 2)], fetchedAt: T0 + 2 * H });
    assert.equal(log.stats().writeError, null);
    assert.deepEqual((await lines(file)).map((l) => l.id), ['1', '2']);
  });

  it('compacts a log with many superseded lines on load', async () => {
    const { file } = await tempLog();
    const body = Array.from({ length: 1200 }, (_, i) => JSON.stringify({ id: String(i % 3), startTime: at(i % 3), endTime: at(1 + (i % 3)), status: 2, weight: i })).join('\n');
    await fs.writeFile(file, `${body}\n`);
    const log = new PrintLog(file);
    await log.load();
    await log.queue;
    const kept = await lines(file);
    assert.deepEqual(kept.map((l) => [l.id, l.weight]), [['0', 1197], ['1', 1198], ['2', 1199]]);
  });
});
