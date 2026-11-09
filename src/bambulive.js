import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import mqtt from 'mqtt';
import { ensureDir, PRIVATE_FILE_MODE, restrictFile, writeAtomic } from './files.js';
import { FIELDS, mergeIntervals } from './printlog.js';

// Bambu's cloud print history (/my/tasks) only lists jobs sent through the
// cloud. A printer connected to the cloud also streams its live status to
// Bambu's MQTT broker, whatever started the print: the SD card, the touch
// screen, or a file sent over LAN. This watches that stream and logs the
// prints the history leaves out, so they can at least be drawn. The stream
// carries no slicer weight, so these prints have no filament amount.
//
// Broker, login and messages follow the community documentation
// (OpenBambuAPI mqtt.md, ha-bambulab): mqtts on port 8883, username
// "u_<uid>", the access token as password, reports on
// device/<serial>/report and requests on device/<serial>/request. It only
// reads: the one request it sends is "pushall", which asks a printer for its
// full status once after subscribing.
//
// Only prints seen while connected are known. A print that starts and ends
// while PrintBuster is off or disconnected is missed, and nothing can read
// it back later.

const BROKERS = {
  global: 'mqtts://us.mqtt.bambulab.com:8883',
  china: 'mqtts://cn.mqtt.bambulab.com:8883',
};

// The print log's task fields, plus where each print was seen.
export const LIVE_FIELDS = [...FIELDS, 'source', 'printType', 'gcodeFile'];
// A pause, saved per printer (a PrintLog of these): when the printer was
// seen paused, and whether each end is when it actually paused or resumed
// (`startSeen`, `endSeen`) or only where the feed's view began or ended.
export const PAUSE_FIELDS = ['startTime', 'endTime', 'deviceId', 'deviceName', 'title', 'printType', 'startSeen', 'endSeen'];

// gcode_state values (upper case on the wire).
const ACTIVE = new Set(['PREPARE', 'SLICING', 'RUNNING', 'PAUSE']);
const ENDED = { FINISH: 2, FAILED: 3 }; // Bambu's task status codes
// gcode_start_time is trusted only within this long before now.
const START_MAX_AGE_MS = 7 * 86400_000;
// An open print is picked up again after a restart only if it started this
// recently (or matches the printer's own start time).
const RESUME_MAX_AGE_MS = 3 * 86400_000;
const RESUME_START_TOLERANCE_MS = 30 * 60_000;
// The P1 series asks for pushall no more often than every 5 minutes.
const PUSHALL_MIN_MS = 5 * 60_000;
// A running print's estimated finish is saved at most this often.
const ESTIMATE_SAVE_MS = 15 * 60_000;
// After the broker rejects the sign-in, wait this long (or for a new token).
const AUTH_RETRY_MS = 10 * 60_000;
// While connected, the saved coverage is extended this often, so a crash
// loses at most this much of it.
const COVERAGE_TICK_MS = 60_000;
const PUSHALL = JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall', version: 1, push_target: 1 } });

const iso = (ms) => new Date(ms).toISOString();

// The numeric user id from a Bambu access token, which is a JWT whose
// "username" claim is "u_<uid>". Null for any other token.
export function uidFromToken(token) {
  const part = String(token || '').split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const m = /^u_(\d+)$/.exec(String(payload?.username ?? ''));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// What the printer calls the job: the project name, else the file name
// without its extension.
export function jobTitle(report) {
  const name = String(report.subtask_name ?? '').trim();
  if (name) return name;
  const file = String(report.gcode_file ?? '').split('/').pop().replace(/(\.gcode)?(\.3mf)?$/i, '').trim();
  return file || 'Untitled print';
}

// What the printer said about its last job. The P1 series sends only what
// changed, so these would otherwise carry over to the next job until it
// replaces them: a print started without a project name would be logged
// under the previous member's.
const JOB_FIELDS = ['subtask_name', 'gcode_file', 'gcode_start_time', 'print_type', 'mc_remaining_time'];

// Forgets the finished job, once the printer has left it, keeping anything
// the report that ended it already says about the next.
function forgetJob(report, delta) {
  for (const field of JOB_FIELDS) if (!(field in delta)) delete report[field];
}

// An id not yet in `records`: `base`, else `base-2`, `base-3`, ...
function freshId(records, base) {
  if (!records?.has(base)) return base;
  let n = 2;
  while (records.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// The printer's own start time for the job, when it is believable: in the
// last week, not in the future, and not before the printer's last finish
// (a value left over from the previous job).
export function plausibleStart(value, nowMs, lastEndMs = null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const at = n * 1000;
  if (at > nowMs + 10 * 60_000 || at < nowMs - START_MAX_AGE_MS) return null;
  if (lastEndMs != null && at < lastEndMs - 60_000) return null;
  return at;
}

// The times the live feed was connected, saved to a small JSON file, so
// pages can say when prints started from the SD card or sent over LAN may
// be missing.
export class FeedCoverage {
  constructor(file) {
    this.file = file;
    this.intervals = [];
    this.writeError = null;
    this.queue = Promise.resolve();
  }

  async load() {
    await restrictFile(this.file);
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.intervals = mergeIntervals((saved.intervals || []).map(([s, e]) => [Date.parse(s), Date.parse(e)]));
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') console.warn(`Live feed: ignoring unreadable ${this.file} (${err.message})`);
    }
  }

  // Records that the feed was connected from `start` to `end`.
  extend(start, end) {
    if (!(end > start)) return this.queue;
    this.intervals = mergeIntervals([...this.intervals, [start, end]]);
    this.queue = this.queue.then(async () => {
      try {
        await ensureDir(this.file);
        await writeAtomic(this.file, `${JSON.stringify({ intervals: this.intervals.map(([s, e]) => [iso(s), iso(e)]) }, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
        this.writeError = null;
      } catch (err) {
        if (this.writeError !== err.message) console.error(`Could not save the live feed coverage: ${err.message}`);
        this.writeError = err.message;
      }
    });
    return this.queue;
  }

  coverage() {
    return this.intervals.map(([s, e]) => [s, e]);
  }
}

const isAuthError = (err) => err?.code === 4 || err?.code === 5 || err?.code === 134 || err?.code === 135
  || /not authori[sz]ed|bad user ?name or password/i.test(String(err?.message || ''));

export class LivePrintWatcher {
  // `store` is a PrintLog without coverage. `devices()` returns the printers
  // from the latest Bambu collection. `connect` is mqtt.connect (tests pass
  // a stand-in). `onChange` runs when a printer starts, finishes, pauses or
  // resumes a print, so open pages can redraw at once. `pauses` (a PrintLog
  // of PAUSE_FIELDS) and `coverage` (a FeedCoverage) are optional.
  constructor(cfg, {
    bambu, store, devices = () => [], connect = mqtt.connect, now = () => Date.now(), onChange = () => {},
    pauses = null, coverage = null, timers = globalThis,
  }) {
    this.cfg = cfg;
    this.onChange = onChange;
    this.pauses = pauses;
    this.feedCoverage = coverage;
    this.timers = timers;
    this.coverageTimer = null;
    this.bambu = bambu;
    this.store = store;
    this.devices = devices;
    this.connectFn = connect;
    this.now = now;
    this.url = BROKERS[cfg.region] || BROKERS.global;
    this.started = false;
    this.client = null;
    this.connected = false;
    this.token = null;
    this.uid = null;
    this.uidToken = null;
    this.subscribed = new Set();
    this.printers = new Map();
    this.syncing = null;
    this.blocked = null;
    this.error = null;
    this.lastMessageAt = null;
    this.connectedAt = null;
    // Counts connections, so a print's finish is known to be seen only when
    // the feed stayed connected since the print was last reported active.
    this.epoch = 0;
  }

  start() {
    this.started = true;
    return this.sync();
  }

  stop() {
    this.started = false;
    this.disconnect();
  }

  disconnect() {
    const client = this.client;
    const wasConnected = this.connected;
    this.client = null;
    this.connected = false;
    this.subscribed.clear();
    if (wasConnected) this.lostFeed();
    client?.end(true);
  }

  // The feed stopped: save how long it was connected, and end the pauses it
  // was watching where its view of them ends.
  lostFeed() {
    const now = this.now();
    this.timers.clearInterval(this.coverageTimer);
    this.coverageTimer = null;
    if (this.connectedAt != null) this.feedCoverage?.extend(this.connectedAt, now);
    for (const p of this.printers.values()) this.endPause(p, now, false);
  }

  // Extends the saved coverage to now while connected.
  tickCoverage() {
    if (this.connected && this.connectedAt != null) return this.feedCoverage?.extend(this.connectedAt, this.now());
    return null;
  }

  // Pauses left open by a previous run (it stopped without saying when they
  // ended) end where the saved coverage last saw the feed connected.
  recover() {
    if (!this.pauses) return null;
    const lastSeen = this.feedCoverage?.coverage().at(-1)?.[1] ?? null;
    const open = [...this.pauses.records.values()].filter((r) => !r.endTime);
    if (!open.length) return null;
    const tasks = open.map(({ recordedAt, ...r }) => {
      const start = Date.parse(r.startTime);
      return { ...r, endTime: iso(lastSeen != null && lastSeen > start ? lastSeen : start), endSeen: false };
    });
    return this.pauses.record({ tasks, devices: this.devices() || [], fetchedAt: this.now() });
  }

  // Times the feed was connected, as [start, end] ms pairs, including the
  // current connection up to now.
  coverage() {
    const saved = this.feedCoverage ? this.feedCoverage.coverage() : [];
    if (!this.connected || this.connectedAt == null) return saved;
    return mergeIntervals([...saved, [this.connectedAt, Math.max(this.now(), this.connectedAt + 1)]]);
  }

  status() {
    return {
      enabled: true,
      started: this.started,
      connected: this.connected,
      printers: this.subscribed.size,
      connectedAt: this.connectedAt ? iso(this.connectedAt) : null,
      lastMessageAt: this.lastMessageAt ? iso(this.lastMessageAt) : null,
      error: this.error,
    };
  }

  // What each printer is doing now, by serial, for printers the feed shows
  // printing (cloud prints included): its state, whether it is paused and
  // since when (null when it was already paused as the feed connected), the
  // printer's own estimate of minutes left, and the finish that gives. While
  // paused, the finish is the time left counted from now.
  printerStates() {
    const out = new Map();
    if (!this.connected) return out;
    const now = this.now();
    for (const [serial, p] of this.printers) {
      const s = p.live;
      // Only what was reported since the feed last connected.
      if (!s || s.epoch !== this.epoch || !ACTIVE.has(s.state)) continue;
      let finishAt = null;
      if (s.remainingMinutes != null && (s.state === 'RUNNING' || s.state === 'PAUSE' || s.remainingMinutes > 0)) {
        const left = s.remainingMinutes * 60_000;
        finishAt = s.paused ? now + left : Math.max(now, s.remainingAt + left);
      }
      out.set(serial, {
        state: s.state,
        paused: s.paused,
        pausedSince: s.pausedSince != null ? iso(s.pausedSince) : null,
        remainingMinutes: s.remainingMinutes,
        finishAt,
        printType: s.printType,
      });
    }
    return out;
  }

  // Ids of the prints the feed currently shows printing.
  activeIds() {
    const ids = new Set();
    if (!this.connected) return ids;
    for (const p of this.printers.values()) if (p.job) ids.add(p.job.id);
    return ids;
  }

  // Connects, or follows a new token or new printers. Called at start and
  // after every collection, so it also retries after a failure.
  sync() {
    if (!this.started) return Promise.resolve();
    this.syncing ??= this.syncNow()
      .catch((err) => { this.error = err.message || String(err); })
      .finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async syncNow() {
    const token = this.bambu.token;
    if (!token) {
      this.disconnect();
      this.error = 'Waiting for the Bambu sign-in.';
      return;
    }
    if (this.client && token !== this.token) this.disconnect();
    if (this.blocked && this.blocked.token === token && this.now() < this.blocked.until) return;
    const serials = this.serials();
    if (!serials.length) {
      if (!this.client) this.error = 'Waiting for the list of printers from Bambu.';
      return;
    }
    if (!this.client) await this.connect(token);
    else if (this.connected) this.subscribeAll();
  }

  serials() {
    return (this.devices() || []).map((d) => d?.dev_id).filter(Boolean).map(String);
  }

  async resolveUid(token) {
    if (this.uidToken === token && this.uid) return this.uid;
    let uid = uidFromToken(token);
    if (!uid) {
      const json = await this.bambu.apiGet('/v1/design-user-service/my/preference');
      uid = json?.uid != null ? String(json.uid) : null;
    }
    if (!uid) throw new Error('Bambu did not return the user id the live feed signs in with.');
    this.uid = uid;
    this.uidToken = token;
    return uid;
  }

  async connect(token) {
    const uid = await this.resolveUid(token);
    if (!this.started || this.client) return;
    this.token = token;
    this.blocked = null;
    const client = this.connectFn(this.url, {
      username: `u_${uid}`,
      password: token,
      clientId: `printbuster_${crypto.randomBytes(6).toString('hex')}`,
      protocolVersion: 4,
      keepalive: 60,
      clean: true,
      // Subscriptions are made again on every connect, below.
      resubscribe: false,
      reconnectPeriod: 30_000,
      connectTimeout: 30_000,
    });
    this.client = client;
    client.on('connect', () => {
      if (this.client !== client) return;
      this.epoch++;
      this.connected = true;
      this.connectedAt = this.now();
      this.error = null;
      this.subscribed.clear();
      this.timers.clearInterval(this.coverageTimer);
      this.coverageTimer = this.timers.setInterval(() => this.tickCoverage(), COVERAGE_TICK_MS);
      this.coverageTimer?.unref?.();
      this.subscribeAll();
    });
    client.on('message', (topic, payload) => {
      if (this.client === client) this.onMessage(topic, payload);
    });
    client.on('close', () => {
      if (this.client !== client) return;
      if (this.connected) this.lostFeed();
      this.connected = false;
      this.subscribed.clear();
      // Whatever is printing when the feed comes back may have started
      // while it was away.
      for (const p of this.printers.values()) p.sawIdle = false;
    });
    client.on('error', (err) => {
      if (this.client !== client) return;
      this.error = `Bambu's live feed: ${err.message || err}`;
      if (isAuthError(err)) {
        this.blocked = { token, until: this.now() + AUTH_RETRY_MS };
        this.disconnect();
      }
    });
  }

  subscribeAll() {
    const client = this.client;
    if (!client || !this.connected) return;
    for (const serial of this.serials()) {
      if (this.subscribed.has(serial)) continue;
      this.subscribed.add(serial);
      client.subscribe(`device/${serial}/report`, { qos: 0 }, (err) => {
        if (err) {
          this.subscribed.delete(serial);
          this.error = `Bambu's live feed refused printer ${serial}: ${err.message || err}`;
          return;
        }
        this.requestFullStatus(serial);
      });
    }
  }

  requestFullStatus(serial) {
    if (!this.cfg.pushall || !this.client) return;
    const p = this.printer(serial);
    if (p.lastPushall && this.now() - p.lastPushall < PUSHALL_MIN_MS) return;
    p.lastPushall = this.now();
    this.client.publish(`device/${serial}/request`, PUSHALL, { qos: 0 });
  }

  printer(serial) {
    let p = this.printers.get(serial);
    if (!p) {
      // report: the printer's state so far (the P1 series sends only what
      // changed). job: the print the feed shows running. pause: the pause
      // under way, as saved.
      p = { report: {}, job: null, activeEpoch: null, lastEnd: null, sawIdle: false, lastPushall: null, pause: null };
      this.printers.set(serial, p);
    }
    return p;
  }

  onMessage(topic, payload) {
    const m = /^device\/([^/]+)\/report$/.exec(topic);
    if (!m) return null;
    this.lastMessageAt = this.now();
    let json;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch {
      return null;
    }
    return this.update(m[1], json);
  }

  // Applies one report from printer `serial`. Returns the print log write,
  // if it made one.
  update(serial, json) {
    const p = this.printer(serial);
    // The broker says when the printer drops off; anything it was printing
    // finished unseen.
    if (json?.event?.event === 'client.disconnected') {
      p.job = null;
      p.sawIdle = false;
      this.endPause(p, this.now(), false);
      if (p.live) {
        p.live = null;
        this.onChange();
      }
      return null;
    }
    const delta = json?.print;
    if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return null;
    const wasActive = ACTIVE.has(String(p.report.gcode_state ?? '').toUpperCase());
    // A new file without a project name: the old job's name no longer applies.
    if ('gcode_file' in delta && !('subtask_name' in delta) && delta.gcode_file !== p.report.gcode_file) {
      delete p.report.subtask_name;
    }
    Object.assign(p.report, delta);
    const r = p.report;
    const state = String(r.gcode_state ?? '').toUpperCase();
    const now = this.now();
    this.track(p, delta, state, now);
    this.trackPause(serial, p, now);
    if (ACTIVE.has(state)) return this.active(serial, p, r, now);
    let written = null;
    if (state in ENDED) written = this.ended(serial, p, r, now, ENDED[state]);
    else if (state) {
      // Idle (or a state not known here): nothing is printing now.
      p.job = null;
      p.sawIdle = true;
    }
    if (wasActive && state) forgetJob(r, delta);
    return written;
  }

  // Keeps what the printer is doing now (see printerStates), for every
  // print, cloud ones included.
  track(p, delta, state, now) {
    const r = p.report;
    const prev = p.live;
    const sameRun = Boolean(prev) && prev.epoch === this.epoch;
    const paused = state === 'PAUSE';
    // Seen pausing: now. Already paused when first seen: unknown.
    let pausedSince = null;
    if (paused && sameRun) pausedSince = prev.paused ? prev.pausedSince : (prev.state ? now : null);
    const remaining = r.mc_remaining_time == null || r.mc_remaining_time === '' ? NaN : Number(r.mc_remaining_time);
    p.live = {
      epoch: this.epoch,
      state,
      paused,
      pausedSince,
      remainingMinutes: Number.isFinite(remaining) && remaining >= 0 ? remaining : null,
      // When the time left was reported (the P1 series repeats it only when it changes).
      remainingAt: 'mc_remaining_time' in delta || !prev ? now : prev.remainingAt,
      printType: String(r.print_type ?? '').toLowerCase() || null,
    };
    if (!sameRun || prev.state !== state) this.onChange();
  }

  // Saves pauses as they start and end: a pause seen starting begins then,
  // one already under way when first seen begins there (startSeen false).
  trackPause(serial, p, now) {
    const live = p.live;
    if (live.paused && !p.pause) {
      const startSeen = live.pausedSince != null;
      p.pause = {
        // Two pauses can start within one second.
        id: freshId(this.pauses?.records, `pause-${serial}-${Math.floor(now / 1000)}`),
        startTime: iso(startSeen ? live.pausedSince : now),
        deviceId: serial,
        title: jobTitle(p.report),
        printType: live.printType || undefined,
        startSeen,
      };
      this.savePause(p.pause, now);
    } else if (!live.paused && p.pause) {
      this.endPause(p, now, true);
    }
  }

  endPause(p, now, seen) {
    if (!p.pause) return;
    const done = { ...p.pause, endTime: iso(Math.max(now, Date.parse(p.pause.startTime))), endSeen: seen };
    p.pause = null;
    this.savePause(done, now);
  }

  savePause(pause, now) {
    if (!this.pauses) return;
    this.pauses.record({ tasks: [pause], devices: this.devices() || [], fetchedAt: now });
  }

  // Cloud prints are in Bambu's print history already.
  isCloud(r) {
    return String(r.print_type ?? '').toLowerCase() === 'cloud';
  }

  active(serial, p, r, now) {
    const title = jobTitle(r);
    if (this.isCloud(r)) {
      // The P1 series sends only what changed, so a new job can show the
      // last one's print_type for a moment. A print logged that way turns
      // out to be a cloud print: mark it so it is left out.
      const job = p.job;
      p.job = null;
      return job ? this.save({ ...job, printType: 'cloud' }, now) : null;
    }
    // While the printer stays active it is the same print, even if its name
    // arrives after the state changed.
    let job = p.job || this.resume(serial, r, title, now);
    let changed = false;
    if (!job) {
      // Seen starting: now. Joined part way: the printer's start time.
      let start = p.sawIdle ? now : (plausibleStart(r.gcode_start_time, now, p.lastEnd) ?? now);
      let id = `live-${serial}-${Math.floor(start / 1000)}`;
      // A start time left over from a print already logged.
      if (this.store.records.has(id)) {
        start = now;
        // A print that ended and another that started within one second.
        id = freshId(this.store.records, `live-${serial}-${Math.floor(start / 1000)}`);
      }
      job = { id, source: 'live', startTime: iso(start), status: 'running', deviceId: serial, title };
      changed = true;
    }
    for (const [field, value] of [['title', title], ['gcodeFile', r.gcode_file], ['printType', r.print_type]]) {
      const v = value == null ? '' : String(value);
      if (v && job[field] !== v) {
        job = { ...job, [field]: v };
        changed = true;
      }
    }
    const remaining = Number(r.mc_remaining_time);
    if (String(r.gcode_state).toUpperCase() === 'RUNNING' && Number.isFinite(remaining) && remaining >= 0
      && (!job.costTime || !p.estimateSavedAt || now - p.estimateSavedAt >= ESTIMATE_SAVE_MS)) {
      const costTime = Math.round((now - Date.parse(job.startTime)) / 1000 + remaining * 60);
      if (costTime > 0 && costTime !== job.costTime) {
        job = { ...job, costTime };
        p.estimateSavedAt = now;
        changed = true;
      }
    }
    p.job = job;
    p.activeEpoch = this.epoch;
    return changed ? this.save(job, now) : null;
  }

  ended(serial, p, r, now, status) {
    const current = p.job;
    const seen = Boolean(current) && this.connected && p.activeEpoch === this.epoch;
    p.job = null;
    p.sawIdle = true;
    if (this.isCloud(r)) return current ? this.save({ ...current, printType: 'cloud' }, now) : null;
    if (seen) {
      p.lastEnd = now;
      return this.save({ ...current, status, endTime: iso(now) }, now);
    }
    // It ended while the feed was away, so when is unknown. A failed or
    // cancelled print can say so; a finished one stays "finish not recorded".
    const job = current || this.resume(serial, r, jobTitle(r), now);
    return job && status === ENDED.FAILED ? this.save({ ...job, status }, now) : null;
  }

  // An open print on this printer from before a restart or a dropped feed,
  // with the same title (and the printer's start time, when it has one).
  resume(serial, r, title, now) {
    const known = plausibleStart(r.gcode_start_time, now);
    let best = null;
    for (const rec of this.store.records.values()) {
      if (rec.deviceId !== serial || rec.status !== 'running' || rec.title !== title) continue;
      const start = Date.parse(rec.startTime);
      if (known != null ? Math.abs(start - known) > RESUME_START_TOLERANCE_MS : now - start > RESUME_MAX_AGE_MS) continue;
      if (!best || start > Date.parse(best.startTime)) best = rec;
    }
    if (!best) return null;
    const { recordedAt, ...job } = best;
    return job;
  }

  save(job, now) {
    const devices = this.devices() || [];
    const device = devices.find((d) => String(d?.dev_id) === job.deviceId);
    const task = { ...job, deviceModel: job.deviceModel || device?.dev_product_name || undefined };
    const written = this.store.record({ tasks: [task], devices, fetchedAt: now });
    this.onChange();
    return written;
  }
}
