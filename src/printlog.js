import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from './files.js';

// Bambu's cloud only keeps about a day of print history, so every task we see
// is kept here. One JSON object per line; a task gets a new line only when it
// first appears or changes (for example when it finishes), and the last line
// for an id wins. A separate small file records which time spans were
// actually observed, so gaps (app offline, history already gone) are known.

// The task fields needed to redraw and re-check a print later.
const FIELDS = ['startTime', 'endTime', 'status', 'deviceId', 'deviceName', 'deviceModel', 'title', 'designTitle', 'plateName', 'plateIndex', 'costTime', 'weight', 'length', 'amsDetailMapping'];

// Two successful fetches this close together are assumed to have seen
// everything in between. Must stay well below Bambu's history window.
export const BRIDGE_MS = 6 * 3600 * 1000;

const iso = (ms) => new Date(ms).toISOString();
const withoutRecordedAt = ({ recordedAt, ...rest }) => rest;

export function mergeIntervals(intervals) {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export class PrintLog {
  constructor(file) {
    this.file = file;
    this.coverageFile = `${file.replace(/\.jsonl$/, '')}.coverage.json`;
    this.records = new Map();
    this.intervals = [];
    this.lineCount = 0;
    this.pendingLines = [];
    this.needsNewline = false;
    this.writeError = null;
    this.queue = Promise.resolve();
  }

  async load() {
    let text = '';
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      // Missing (or under a path that is not a folder): start empty; writes
      // will report the problem. Anything else, such as no permission, stops
      // startup rather than appending to a log we cannot read.
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
        throw new Error(`Cannot read the print log ${this.file}: ${err.message}`);
      }
    }
    let unreadable = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      this.lineCount++;
      try {
        const rec = JSON.parse(line);
        if (rec && rec.id !== undefined && Number.isFinite(Date.parse(rec.startTime))) this.records.set(String(rec.id), rec);
        else unreadable++;
      } catch {
        unreadable++;
      }
    }
    // A crash mid-write can leave a partial last line; start the next on its own.
    this.needsNewline = text.length > 0 && !text.endsWith('\n');
    if (unreadable) console.warn(`Print log: ignored ${unreadable} unreadable line(s) in ${this.file}`);

    try {
      const saved = JSON.parse(await fs.readFile(this.coverageFile, 'utf8'));
      this.intervals = mergeIntervals((saved.intervals || []).map(([s, e]) => [Date.parse(s), Date.parse(e)]));
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') console.warn(`Print log: ignoring unreadable ${this.coverageFile} (${err.message})`);
    }

    if (this.lineCount > 1000 && this.lineCount > 2 * this.records.size) await this.compact();
  }

  // Saves tasks from one successful fetch, and the span of time it observed.
  record({ tasks, devices = [], fetchedAt }) {
    const names = new Map(devices.map((d) => [d.dev_id, d.name]));
    const recordedAt = iso(fetchedAt);
    let earliest = fetchedAt;
    for (const task of tasks) {
      const start = Date.parse(task.startTime);
      if (task.id === undefined || task.id === null || !Number.isFinite(start)) continue;
      earliest = Math.min(earliest, start);
      const id = String(task.id);
      const prev = this.records.get(id);
      const merged = { ...task, deviceName: names.get(task.deviceId) || task.deviceName || prev?.deviceName };
      const rec = { id };
      for (const f of FIELDS) {
        if (merged[f] !== undefined && merged[f] !== null && merged[f] !== '') rec[f] = merged[f];
      }
      if (prev && JSON.stringify(withoutRecordedAt(prev)) === JSON.stringify(rec)) continue;
      const stored = { ...rec, recordedAt };
      this.records.set(id, stored);
      this.pendingLines.push(JSON.stringify(stored));
    }
    this.addCoverage(earliest, fetchedAt);
    return this.persist();
  }

  addCoverage(start, end) {
    const last = this.intervals.at(-1);
    if (last && end >= last[1] && end - last[1] <= BRIDGE_MS) start = Math.min(start, last[1]);
    this.intervals = mergeIntervals([...this.intervals, [start, end]]);
  }

  persist() {
    this.queue = this.queue.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        if (this.pendingLines.length) {
          // Copy: record() may queue more lines while this write is in flight.
          const lines = this.pendingLines.slice();
          await fs.appendFile(this.file, `${this.needsNewline ? '\n' : ''}${lines.join('\n')}\n`);
          this.pendingLines.splice(0, lines.length);
          this.needsNewline = false;
          this.lineCount += lines.length;
        }
        await writeAtomic(this.coverageFile, `${JSON.stringify({ intervals: this.intervals.map(([s, e]) => [iso(s), iso(e)]) }, null, 2)}\n`);
        this.writeError = null;
      } catch (err) {
        // Keep unsaved lines in memory and try again with the next fetch.
        if (this.writeError !== err.message) console.error(`Could not save the print log: ${err.message}`);
        this.writeError = err.message;
      }
    });
    return this.queue;
  }

  compact() {
    this.queue = this.queue.then(async () => {
      const lines = [...this.records.values()]
        .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
        .map((r) => JSON.stringify(r));
      await writeAtomic(this.file, lines.length ? `${lines.join('\n')}\n` : '');
      this.lineCount = lines.length;
      this.needsNewline = false;
    });
    return this.queue;
  }

  // Raw task records that started in [sinceMs, untilMs).
  query(sinceMs, untilMs) {
    return [...this.records.values()].filter((r) => {
      const start = Date.parse(r.startTime);
      return start >= sinceMs && start < untilMs;
    });
  }

  coverage() {
    return this.intervals.map(([s, e]) => [s, e]);
  }

  stats() {
    return {
      prints: this.records.size,
      since: this.intervals.length ? iso(this.intervals[0][0]) : null,
      writeError: this.writeError,
    };
  }
}
