import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { normalizeTask } from '../src/bambu.js';
import { jobTitle, LIVE_FIELDS, LivePrintWatcher, plausibleStart, uidFromToken } from '../src/bambulive.js';
import { PrintLog } from '../src/printlog.js';
import { CompareService, sameAsCloudPrint } from '../src/service.js';

const NOW = Date.parse('2026-10-27T19:00:00Z'); // 2:00 pm CDT
const MIN = 60_000;
const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const TOKEN = jwt({ username: 'u_42' });
const DEVICES = [
  { dev_id: 'SN-ADA', name: 'Ada', dev_product_name: 'X1 Carbon' },
  { dev_id: 'SN-OHM', name: 'Ohm', dev_product_name: 'P1S' },
];

// Stands in for mqtt.connect: records the options, subscriptions and
// requests, and lets a test deliver reports.
function fakeMqtt() {
  const clients = [];
  const connect = (url, opts) => {
    const c = new EventEmitter();
    Object.assign(c, {
      url,
      opts,
      subs: [],
      published: [],
      ended: false,
      subscribe(topic, o, cb) { this.subs.push(topic); cb?.(null); },
      publish(topic, msg) { this.published.push({ topic, msg: JSON.parse(msg) }); },
      end() { this.ended = true; this.emit('close'); },
    });
    clients.push(c);
    return c;
  };
  return { connect, clients, get last() { return clients.at(-1); } };
}

async function setup({ token = TOKEN, devices = DEVICES, pushall = true, dir } = {}) {
  dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pb-livefeed-'));
  const store = new PrintLog(path.join(dir, 'live-prints.jsonl'), { coverage: false, fields: LIVE_FIELDS });
  await store.load();
  const mq = fakeMqtt();
  const clock = { now: NOW };
  const bambu = { token, apiGet: async () => ({ uid: 777 }) };
  const watcher = new LivePrintWatcher({ region: 'global', pushall }, {
    bambu, store, devices: () => devices, connect: mq.connect, now: () => clock.now,
  });
  // Delivers a report from a printer, then waits for the print log write.
  const report = async (serial, print) => {
    mq.last.emit('message', `device/${serial}/report`, Buffer.from(JSON.stringify({ print })));
    await store.queue;
  };
  const records = () => [...store.records.values()];
  return { dir, store, mq, clock, bambu, watcher, report, records };
}

async function connected(opts) {
  const t = await setup(opts);
  await t.watcher.start();
  t.mq.last.emit('connect');
  return t;
}

describe('live feed helpers', () => {
  it('reads the user id from a Bambu access token', () => {
    assert.equal(uidFromToken(TOKEN), '42');
    assert.equal(uidFromToken('not-a-jwt'), null);
    assert.equal(uidFromToken(jwt({ username: 'someone' })), null);
    assert.equal(uidFromToken(''), null);
  });

  it('names a job from its project, else its file', () => {
    assert.equal(jobTitle({ subtask_name: 'Bracket', gcode_file: 'x.3mf' }), 'Bracket');
    assert.equal(jobTitle({ subtask_name: '', gcode_file: '/sdcard/36mm.gcode.3mf' }), '36mm');
    assert.equal(jobTitle({}), 'Untitled print');
  });

  it('trusts the printer’s start time only when it is believable', () => {
    const sec = (ms) => String(Math.floor(ms / 1000));
    assert.equal(plausibleStart(sec(NOW - 30 * MIN), NOW), NOW - 30 * MIN);
    assert.equal(plausibleStart('0', NOW), null);
    assert.equal(plausibleStart('', NOW), null);
    assert.equal(plausibleStart(sec(NOW + 3600_000), NOW), null); // in the future
    assert.equal(plausibleStart(sec(NOW - 8 * 86400_000), NOW), null); // over a week old
    // Left over from before the printer's last finish.
    assert.equal(plausibleStart(sec(NOW - 30 * MIN), NOW, NOW - 10 * MIN), null);
  });
});

describe('LivePrintWatcher', () => {
  it('signs in to the broker with the user id and token, and subscribes to each printer', async () => {
    const t = await connected();
    const c = t.mq.last;
    assert.equal(c.url, 'mqtts://us.mqtt.bambulab.com:8883');
    assert.equal(c.opts.username, 'u_42');
    assert.equal(c.opts.password, TOKEN);
    assert.deepEqual(c.subs, ['device/SN-ADA/report', 'device/SN-OHM/report']);
    assert.deepEqual(c.published.map((p) => p.topic), ['device/SN-ADA/request', 'device/SN-OHM/request']);
    assert.equal(c.published[0].msg.pushing.command, 'pushall');
    assert.equal(t.watcher.status().connected, true);
    assert.equal(t.watcher.status().printers, 2);

    // Reconnecting soon after doesn't ask again (the P1 limit is 5 minutes).
    c.emit('close');
    c.emit('connect');
    assert.equal(c.published.length, 2);
    t.clock.now += 6 * MIN;
    c.emit('close');
    c.emit('connect');
    assert.equal(c.published.length, 4);
  });

  it('asks Bambu for the user id when the token is not a JWT', async () => {
    const t = await connected({ token: 'opaque-token' });
    assert.equal(t.mq.last.opts.username, 'u_777');
  });

  it('can leave out the full-status request', async () => {
    const t = await connected({ pushall: false });
    assert.equal(t.mq.last.published.length, 0);
  });

  it('waits for a token and for the printer list before connecting', async () => {
    const t = await setup({ token: null });
    await t.watcher.start();
    assert.equal(t.mq.clients.length, 0);
    assert.match(t.watcher.status().error, /sign-in/);

    const u = await setup({ devices: [] });
    await u.watcher.start();
    assert.equal(u.mq.clients.length, 0);
    assert.match(u.watcher.status().error, /printers/);
  });

  it('does nothing until started, so createApp never connects by itself', async () => {
    const t = await setup();
    await t.watcher.sync();
    assert.equal(t.mq.clients.length, 0);
  });

  it('logs an SD-card print from start to finish', async () => {
    const t = await connected();
    await t.report('SN-ADA', { gcode_state: 'IDLE', print_type: 'idle' });
    t.clock.now += MIN;
    const started = t.clock.now;
    await t.report('SN-ADA', {
      gcode_state: 'RUNNING', print_type: 'local', subtask_name: 'Bracket', gcode_file: '/sdcard/Bracket.gcode.3mf',
      gcode_start_time: String(Math.floor((NOW - 3600_000) / 1000)), mc_remaining_time: 90,
    });
    let [rec] = t.records();
    assert.equal(rec.source, 'live');
    assert.equal(rec.title, 'Bracket');
    assert.equal(rec.deviceId, 'SN-ADA');
    assert.equal(rec.deviceName, 'Ada');
    assert.equal(rec.deviceModel, 'X1 Carbon');
    assert.equal(rec.printType, 'local');
    assert.equal(rec.status, 'running');
    // Seen starting, so the start is when it was seen, not a leftover value.
    assert.equal(rec.startTime, new Date(started).toISOString());
    assert.equal(rec.costTime, 90 * 60);
    assert.deepEqual([...t.watcher.activeIds()], [rec.id]);

    t.clock.now += 89 * MIN;
    await t.report('SN-ADA', { mc_remaining_time: 1 });
    t.clock.now += MIN;
    await t.report('SN-ADA', { gcode_state: 'FINISH', mc_remaining_time: 0 });
    [rec] = t.records();
    assert.equal(rec.status, 2);
    assert.equal(rec.endTime, new Date(t.clock.now).toISOString());
    assert.equal(t.watcher.activeIds().size, 0);

    const p = normalizeTask(rec, new Map(), t.clock.now);
    assert.equal(p.status, 'finished');
    assert.equal(p.title, 'Bracket');
    assert.equal(p.weightGrams, null);
    assert.equal(Date.parse(p.end) - Date.parse(p.start), 90 * MIN);

    // Saved to disk, and read back by a new log.
    const again = new PrintLog(t.store.file, { coverage: false, fields: LIVE_FIELDS });
    await again.load();
    assert.equal(again.records.get(rec.id).status, 2);
    // A live log keeps no coverage file.
    await assert.rejects(fs.stat(path.join(t.dir, 'live-prints.coverage.json')), { code: 'ENOENT' });
  });

  it('writes a running print only when something about it changes', async () => {
    const t = await connected();
    await t.report('SN-ADA', { gcode_state: 'RUNNING', print_type: 'local', subtask_name: 'Box', mc_remaining_time: 60 });
    const lines = () => t.store.lineCount + t.store.pendingLines.length;
    const before = lines();
    for (let i = 0; i < 10; i++) {
      t.clock.now += MIN;
      await t.report('SN-ADA', { mc_remaining_time: 59 - i, mc_percent: i });
    }
    assert.equal(lines(), before);
    // The estimate is refreshed every 15 minutes.
    t.clock.now += 6 * MIN;
    await t.report('SN-ADA', { mc_remaining_time: 40 });
    assert.equal(lines(), before + 1);
  });

  it('records a cancelled print as failed, with the time it stopped', async () => {
    const t = await connected();
    await t.report('SN-OHM', { gcode_state: 'IDLE' });
    await t.report('SN-OHM', { gcode_state: 'PREPARE', print_type: 'local', subtask_name: 'Vase' });
    t.clock.now += 20 * MIN;
    await t.report('SN-OHM', { gcode_state: 'FAILED', print_error: 50348044 });
    const [rec] = t.records();
    assert.equal(rec.status, 3);
    const p = normalizeTask(rec, new Map(), t.clock.now);
    assert.equal(p.status, 'failed');
    assert.equal(p.ranSeconds, 20 * 60);
  });

  it('leaves cloud prints to the cloud history', async () => {
    const t = await connected();
    await t.report('SN-ADA', { gcode_state: 'RUNNING', print_type: 'cloud', subtask_name: 'From Studio', mc_remaining_time: 30 });
    t.clock.now += 30 * MIN;
    await t.report('SN-ADA', { gcode_state: 'FINISH' });
    assert.equal(t.records().length, 0);
  });

  it('marks a print that turns out to be a cloud print, so it is left out', async () => {
    const t = await connected();
    await t.report('SN-OHM', { gcode_state: 'IDLE', print_type: 'local' });
    // The P1 series sends only what changed: the state first, the type after.
    await t.report('SN-OHM', { gcode_state: 'PREPARE', subtask_name: 'Gear' });
    assert.equal(t.records()[0].printType, 'local');
    await t.report('SN-OHM', { print_type: 'cloud' });
    assert.equal(t.records()[0].printType, 'cloud');
    assert.equal(t.watcher.activeIds().size, 0);
  });

  it('keeps one print when its name arrives after its state', async () => {
    const t = await connected();
    await t.report('SN-OHM', { gcode_state: 'FINISH', print_type: 'local', subtask_name: 'Old job' });
    await t.report('SN-OHM', { gcode_state: 'PREPARE' });
    await t.report('SN-OHM', { subtask_name: 'New job' });
    const recs = t.records();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].title, 'New job');
  });

  it('merges partial reports, as the P1 series sends them', async () => {
    const t = await connected();
    await t.report('SN-OHM', { gcode_state: 'IDLE', print_type: 'local', subtask_name: 'Clip', gcode_file: 'Clip.gcode.3mf' });
    await t.report('SN-OHM', { gcode_state: 'RUNNING' });
    t.clock.now += 10 * MIN;
    await t.report('SN-OHM', { gcode_state: 'FINISH' });
    const [rec] = t.records();
    assert.equal(rec.title, 'Clip');
    assert.equal(rec.status, 2);
  });

  it('uses the printer’s start time for a print already running when it connects', async () => {
    const t = await connected();
    const startSec = Math.floor((NOW - 45 * MIN) / 1000);
    await t.report('SN-ADA', {
      gcode_state: 'RUNNING', print_type: 'local', subtask_name: 'Hinge', gcode_start_time: String(startSec), mc_remaining_time: 15,
    });
    const [rec] = t.records();
    assert.equal(rec.startTime, new Date(startSec * 1000).toISOString());
    assert.equal(rec.id, `live-SN-ADA-${startSec}`);
    assert.equal(rec.costTime, 60 * 60);
  });

  it('does not invent a finish time for a print that ended while disconnected', async () => {
    const t = await connected();
    await t.report('SN-ADA', { gcode_state: 'IDLE' });
    await t.report('SN-ADA', { gcode_state: 'RUNNING', print_type: 'local', subtask_name: 'Long', mc_remaining_time: 600 });
    t.mq.last.emit('close');
    assert.equal(t.watcher.activeIds().size, 0, 'not confirmed as printing while disconnected');
    t.clock.now += 3 * 3600_000;
    t.mq.last.emit('connect');
    await t.report('SN-ADA', { gcode_state: 'FINISH' });
    const [rec] = t.records();
    assert.equal(rec.status, 'running');
    assert.equal(rec.endTime, undefined);
    const p = normalizeTask(rec, new Map(), t.clock.now, { confirmed: false });
    assert.equal(p.status, 'unknown');
    assert.equal(p.finishUnknown, true);

    // A cancelled one says so, still with no end time.
    await t.report('SN-ADA', { gcode_state: 'RUNNING', subtask_name: 'Other', mc_remaining_time: 600 });
    t.mq.last.emit('close');
    t.clock.now += 3 * 3600_000;
    t.mq.last.emit('connect');
    await t.report('SN-ADA', { gcode_state: 'FAILED' });
    const other = t.records().find((r) => r.title === 'Other');
    assert.equal(other.status, 3);
    assert.equal(other.endTime, undefined);
    assert.equal(normalizeTask(other, new Map(), t.clock.now).finishUnknown, true);
  });

  it('picks up an open print again after a restart', async () => {
    const t = await connected();
    const startSec = Math.floor((NOW - 10 * MIN) / 1000);
    const running = { gcode_state: 'RUNNING', print_type: 'local', subtask_name: 'Lid', gcode_start_time: String(startSec), mc_remaining_time: 50 };
    await t.report('SN-ADA', running);
    t.watcher.stop();

    // A new process with the same log.
    t.clock.now += 5 * MIN;
    const u = await setup({ dir: t.dir });
    u.clock.now = t.clock.now;
    await u.watcher.start();
    u.mq.last.emit('connect');
    await u.report('SN-ADA', { ...running, mc_remaining_time: 45 });
    t.clock.now += 45 * MIN;
    u.clock.now = t.clock.now;
    await u.report('SN-ADA', { gcode_state: 'FINISH' });
    const recs = u.records();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].status, 2);
    assert.equal(recs[0].startTime, new Date(startSec * 1000).toISOString());
  });

  it('stops retrying a rejected sign-in until the token changes', async () => {
    const t = await connected();
    const first = t.mq.last;
    first.emit('error', Object.assign(new Error('Connection refused: Not authorized'), { code: 5 }));
    assert.equal(first.ended, true);
    assert.match(t.watcher.status().error, /Not authorized/);
    await t.watcher.sync();
    assert.equal(t.mq.clients.length, 1);
    t.bambu.token = jwt({ username: 'u_42', n: 2 });
    await t.watcher.sync();
    assert.equal(t.mq.clients.length, 2);
  });

  it('reconnects with a new token', async () => {
    const t = await connected();
    t.bambu.token = jwt({ username: 'u_42', n: 3 });
    await t.watcher.sync();
    assert.equal(t.mq.clients[0].ended, true);
    assert.equal(t.mq.last.opts.password, t.bambu.token);
  });

  it('subscribes to printers added later', async () => {
    const devices = [DEVICES[0]];
    const t = await connected({ devices });
    devices.push(DEVICES[1]);
    await t.watcher.sync();
    assert.deepEqual(t.mq.last.subs, ['device/SN-ADA/report', 'device/SN-OHM/report']);
  });
});

describe('live prints in the comparison', () => {
  const live = (start, end, extra = {}) => ({
    id: 'bb-live', deviceId: 'SN-ADA', start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...extra,
  });

  it('treats a live print that mostly overlaps a cloud print on the same printer as the same print', () => {
    const cloud = live(NOW, NOW + 60 * MIN);
    assert.equal(sameAsCloudPrint(live(NOW - 2 * MIN, NOW + 61 * MIN), cloud), true);
    // Back to back, overlapping by seconds: two prints.
    assert.equal(sameAsCloudPrint(live(NOW + 59.5 * MIN, NOW + 90 * MIN), cloud), false);
    // Another printer.
    assert.equal(sameAsCloudPrint(live(NOW, NOW + 60 * MIN, { deviceId: 'SN-OHM' }), cloud), false);
  });

  it('adds live prints, marked, and leaves out cloud ones and duplicates', async () => {
    const t = await setup();
    const at = (ms) => new Date(ms).toISOString();
    t.store.record({
      fetchedAt: NOW,
      tasks: [
        { id: 'live-SN-ADA-1', source: 'live', deviceId: 'SN-ADA', title: 'SD print', startTime: at(NOW - 3 * 3600_000), endTime: at(NOW - 2 * 3600_000), status: 2 },
        { id: 'live-SN-ADA-2', source: 'live', deviceId: 'SN-ADA', title: 'Dup', startTime: at(NOW - 60 * MIN), endTime: at(NOW - 10 * MIN), status: 2 },
        { id: 'live-SN-ADA-3', source: 'live', deviceId: 'SN-ADA', title: 'Was cloud', printType: 'cloud', startTime: at(NOW - 5 * MIN), status: 'running' },
      ],
    });
    await t.store.queue;
    const service = new CompareService({}, { designhub: null, bambu: null, liveLog: t.store, live: null });
    const cloud = [{ id: 'bb-9', deviceId: 'SN-ADA', start: at(NOW - 61 * MIN), end: at(NOW - 9 * MIN) }];
    const prints = service.livePrints(-Infinity, Infinity, cloud, new Map([['SN-ADA', 'Ada']]), NOW);
    assert.deepEqual(prints.map((p) => p.title), ['SD print']);
    assert.equal(prints[0].source, 'live');
    assert.equal(prints[0].deviceName, 'Ada');
    assert.equal(prints[0].weightGrams, null);
  });
});
