import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createMockUpstream, task } from './helpers/mock-upstream.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));

const NOW = Date.parse('2026-10-27T23:00:00Z');

// A live-mode app on the mock upstreams, keeping its files in a fresh folder.
async function live(hubOverrides = {}, { collect = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-admin-'));
  const up = createMockUpstream({
    hub: {
      reservations: [
        { name: 'Jane Doe', tool: 'Bambu Lab X1 Carbon', model: 'Ada', start: '2026-10-10T09:00', end: '2026-10-10T12:00' },
        { name: 'Sam Lee', tool: 'Bambu Lab X1 Carbon', model: 'Ada', start: '2026-10-12T13:00', end: '2026-10-12T15:00' },
      ],
      ...hubOverrides,
    },
    bambu: {
      devices: [{ dev_id: 'D-ADA', name: 'Ada', dev_product_name: 'X1 Carbon' }],
      tasks: [task(1, 'D-ADA', '2026-10-10T09:10', '2026-10-10T10:40', { weight: 100 })],
    },
  });
  const env = {
    DEMO_MODE: 'false', DESIGNHUB_BASE_URL: 'https://hub.test', DESIGNHUB_USERNAME: 'kiosk', DESIGNHUB_PASSWORD: 'secret',
    BAMBU_ACCESS_TOKEN: 'env-token', PRINT_LOG_PATH: path.join(dir, 'print-log.jsonl'),
    RESERVATION_LOG_PATH: path.join(dir, 'reservations.json'), USAGE_LOG_PATH: path.join(dir, 'usage.json'),
    ASSIGNMENT_LOG_PATH: path.join(dir, 'assignments.json'), ACCOUNTS_PATH: path.join(dir, 'accounts.json'),
    SESSIONS_PATH: path.join(dir, 'sessions.json'), APP_USERNAME: 'admin', APP_PASSWORD: 'correct horse battery',
  };
  const app = await createApp(loadConfig(env, ['node', 'server.js']), {
    fetch: up.fetch, now: () => NOW, scryptParams: { N: 1024, r: 8, p: 1, keylen: 64 },
  });
  if (collect) await app.locals.collector.runNow();
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: env.APP_USERNAME, password: env.APP_PASSWORD }),
  });
  const auth = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const agendaDates = () => up.calls.filter((c) => c.url.includes('/admin/agenda/')).map((c) => new URL(c.url).searchParams.get('date'));
  return {
    app,
    up,
    dir,
    base,
    agendaDates,
    get: (p) => fetch(base + p, { headers: auth }),
    post: (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(body) }),
    // Waits for the running import, then returns its status.
    finished: async () => {
      await app.locals.importer.running;
      return (await fetch(`${base}/api/admin/import`, { headers: auth })).json();
    },
  };
}

describe('admin: bulk reservation import', () => {
  it('reads every day in the range that is not saved as final, saves it and recalculates the total', async () => {
    const api = await live();
    // Startup's collection saved yesterday (Oct 26) to tomorrow, and three
    // finished days before them: Oct 23 to 26 are final.
    const before = api.agendaDates().length;
    const idle = await (await api.get('/api/admin/import')).json();
    assert.deepEqual([idle.job, idle.maxDays, idle.reservationArchive.since], [null, 366, '2026-10-23']);

    const r = await api.post('/api/admin/import', { from: '2026-10-09', to: '2026-10-26', recalculateTotal: true });
    assert.equal(r.status, 202);
    assert.equal((await r.json()).job.state, 'running');
    const { job, reservationArchive } = await api.finished();

    assert.deepEqual(
      [job.state, job.days, job.skipped, job.toRead, job.read, job.reservations, job.failed],
      ['done', 18, 4, 14, 14, 2, []],
    );
    const read = api.agendaDates().slice(before).sort();
    assert.equal(read.length, 14);
    assert.deepEqual([read[0], read.at(-1)], ['2026-10-09', '2026-10-22']);
    assert.deepEqual([reservationArchive.days, reservationArchive.since, reservationArchive.until], [20, '2026-10-09', '2026-10-28']);

    const saved = JSON.parse(await fs.readFile(path.join(api.dir, 'reservations.json'), 'utf8'));
    assert.equal(saved.days['2026-10-10'].final, true);
    assert.equal(saved.days['2026-10-10'].reservations[0].name, 'Jane Doe');
    assert.equal(saved.days['2026-10-12'].reservations[0].name, 'Sam Lee');

    // The total was recalculated from the imported days.
    assert.equal(job.totalRecalculation.ok, true);
    const usage = JSON.parse(await fs.readFile(path.join(api.dir, 'usage.json'), 'utf8'));
    assert.equal(Object.values(usage.prints).find((p) => p.id === 'bb-1').reservation.name, 'Jane Doe');
    assert.equal(usage.lastTotalRecalculation.from, '2026-10-09');

    // The usage page now finds those days saved, without asking Design Hub.
    const callsBefore = api.up.calls.length;
    const data = await (await api.get('/api/usage?from=2026-10-10&to=2026-10-10')).json();
    assert.equal(api.up.calls.length, callsBefore);
    assert.deepEqual(data.sources.designhub.missingDays, []);
    assert.deepEqual(data.users.map((u) => [u.name, u.grams]), [['Jane Doe', 100]]);

    // Run again: everything is final, so nothing is read.
    await api.post('/api/admin/import', { from: '2026-10-09', to: '2026-10-26' });
    const again = await api.finished();
    assert.deepEqual([again.job.toRead, again.job.read, again.job.totalRecalculation], [0, 0, null]);
    assert.equal(api.agendaDates().length, before + 14);
  });

  it('re-reads final days too when told not to skip them, picking up corrections', async () => {
    const api = await live();
    await api.post('/api/admin/import', { from: '2026-10-10', to: '2026-10-10' });
    await api.finished();
    api.up.hub.reservations[0].name = 'Corrected Name';

    await api.post('/api/admin/import', { from: '2026-10-10', to: '2026-10-10' });
    assert.equal((await api.finished()).job.read, 0);
    await api.post('/api/admin/import', { from: '2026-10-10', to: '2026-10-10', skipFinal: false });
    const { job } = await api.finished();
    assert.deepEqual([job.skipped, job.read], [0, 1]);
    assert.equal(api.app.locals.service.reservationArchive.get('2026-10-10').reservations[0].name, 'Corrected Name');
  });

  it('validates the range and accepts only JSON', async () => {
    const api = await live();
    for (const [body, msg] of [
      [{ from: 'nope', to: '2026-10-10' }, /YYYY-MM-DD/],
      [{ from: '2026-10-10', to: '2026-10-01' }, /after the end/],
      [{ from: '2025-01-01', to: '2026-10-10' }, /at most 366/],
    ]) {
      const r = await api.post('/api/admin/import', body);
      assert.equal(r.status, 400);
      assert.match((await r.json()).error.message, msg);
    }
    const form = await fetch(`${api.base}/api/admin/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'from=2026-10-01&to=2026-10-10',
    });
    assert.equal(form.status, 415);
    assert.equal((await (await api.get('/api/admin/import')).json()).job, null);
  });

  it('runs one import at a time, and stops when asked', async () => {
    const api = await live();
    const first = await api.post('/api/admin/import', { from: '2026-01-01', to: '2026-10-25' });
    assert.equal(first.status, 202);
    const second = await api.post('/api/admin/import', { from: '2026-10-01', to: '2026-10-02' });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, 'import_running');

    const stopped = await (await api.post('/api/admin/import/stop', {})).json();
    assert.equal(stopped.job.stopReason, 'stopped');
    const { job } = await api.finished();
    assert.equal(job.state, 'stopped');
    assert.ok(job.read < job.toRead, `stopped early (${job.read} of ${job.toRead})`);
  });

  it('gives up after several days in a row fail, and lists them', async () => {
    const api = await live({ password: 'changed' });
    await api.post('/api/admin/import', { from: '2026-09-01', to: '2026-09-30', recalculateTotal: true });
    const { job } = await api.finished();
    assert.deepEqual([job.state, job.stopReason, job.read, job.totalRecalculation], ['stopped', 'failing', 0, null]);
    assert.ok(job.failed.length >= 5 && job.failed.length < 30);
    assert.equal(job.failed[0].date, '2026-09-01');
    assert.ok(job.failed[0].error.message);
  });

  it('refuses to start without Design Hub credentials', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-admin-'));
    const up = createMockUpstream();
    const app = await createApp(loadConfig({
      DEMO_MODE: 'false', BAMBU_ACCESS_TOKEN: 'env-token', PRINT_LOG_PATH: path.join(dir, 'print-log.jsonl'),
      RESERVATION_LOG_PATH: path.join(dir, 'reservations.json'), USAGE_LOG_PATH: path.join(dir, 'usage.json'),
      ASSIGNMENT_LOG_PATH: path.join(dir, 'assignments.json'), ACCOUNTS_PATH: path.join(dir, 'accounts.json'),
      SESSIONS_PATH: path.join(dir, 'sessions.json'), APP_USERNAME: 'admin', APP_PASSWORD: 'correct horse battery',
    }, ['node', 'server.js']), { fetch: up.fetch, now: () => NOW, scryptParams: { N: 1024, r: 8, p: 1, keylen: 64 } });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }),
    });
    const r = await fetch(`${base}/api/admin/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: login.headers.get('set-cookie').split(';')[0] },
      body: JSON.stringify({ from: '2026-10-01', to: '2026-10-02' }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'designhub_not_configured');
  });

  it('imports the generated agenda in demo mode', async () => {
    const app = await createApp(loadConfig({ DEMO_MODE: 'true' }, ['node', 'server.js']), { now: () => NOW });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/admin/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: '2026-10-20', to: '2026-10-22' }),
    });
    await app.locals.importer.running;
    const { job, reservationArchive } = await (await fetch(`${base}/api/admin/import`)).json();
    assert.deepEqual([job.state, job.read], ['done', 3]);
    assert.ok(job.reservations > 0);
    assert.equal(reservationArchive.days, 3);

    // The admin page is served and linked from the other pages.
    assert.equal((await fetch(`${base}/admin.html`)).status, 200);
    assert.match(await (await fetch(`${base}/usage.html`)).text(), /href="admin.html"/);
  });
});

// 120 prints on Ada, two a day from May 1 to June 29, 2026 (Chicago time).
function olderPrints() {
  const out = [];
  for (let i = 0; i < 120; i++) {
    const day = new Date(Date.UTC(2026, 4, 1 + Math.floor(i / 2))).toISOString().slice(0, 10);
    const [start, end] = i % 2 ? ['14:00', '15:00'] : ['09:10', '10:40'];
    out.push(task(1000 + i, 'D-ADA', `${day}T${start}`, `${day}T${end}`, { weight: 10 }));
  }
  return out;
}

describe('admin: Bambu history import', () => {
  it('reads prints older than the collection reaches into the print log', async () => {
    const api = await live({
      reservations: [{ name: 'Old Timer', tool: 'Bambu Lab X1 Carbon', model: 'Ada', start: '2026-05-01T09:00', end: '2026-05-01T12:00' }],
    });
    api.app.locals.bambuHistory.pauseMs = 0;
    const idle = await (await api.get('/api/admin/bambu-history')).json();
    assert.deepEqual([idle.job, idle.maxPages, idle.pageSize, idle.printLog.prints], [null, 400, 50, 1]);

    // Bambu has months of prints the log never saw (as when the log began
    // with paging that stopped after one page). Collections only look back
    // two days, so they stop after the first page of them.
    api.up.bambu.tasks.push(...olderPrints());
    await api.app.locals.collector.runNow();
    assert.equal((await (await api.get('/api/admin/bambu-history')).json()).printLog.prints, 50);

    const r = await api.post('/api/admin/bambu-history', { recalculateTotal: true });
    assert.equal(r.status, 202);
    assert.equal((await r.json()).job.state, 'running');
    await api.app.locals.bambuHistory.running;
    const { job, printLog } = await (await api.get('/api/admin/bambu-history')).json();
    assert.deepEqual(
      [job.state, job.complete, job.pages, job.prints, job.total, job.added, job.oldest, job.error],
      ['done', true, 3, 121, 121, 71, '2026-05-01T14:10:00.000Z', null],
    );
    assert.equal(printLog.prints, 121);
    assert.equal(printLog.since, '2026-05-01T14:10:00.000Z');
    const offsets = api.up.calls.filter((c) => c.url.includes('/my/tasks')).slice(-3).map((c) => new URL(c.url).searchParams.get('offset'));
    assert.deepEqual(offsets, ['0', '50', '100']);

    // Saved to disk, with the time it covers, so it survives a restart.
    const lines = (await fs.readFile(path.join(api.dir, 'print-log.jsonl'), 'utf8')).trim().split('\n');
    assert.ok(lines.some((l) => JSON.parse(l).id === '1000' && JSON.parse(l).deviceName === 'Ada'));
    const coverage = JSON.parse(await fs.readFile(path.join(api.dir, 'print-log.coverage.json'), 'utf8'));
    assert.equal(coverage.intervals[0][0], '2026-05-01T14:10:00.000Z');

    // With that day's reservations imported, the old print is charged.
    assert.equal(job.totalRecalculation.ok, true);
    await api.post('/api/admin/import', { from: '2026-05-01', to: '2026-05-01', recalculateTotal: true });
    await api.finished();
    const usage = await (await api.get('/api/usage?from=2026-05-01&to=2026-05-01')).json();
    assert.deepEqual(usage.users.map((u) => [u.name, u.grams]), [['Old Timer', 10]]);

    // Run again: everything is already in the log.
    await api.post('/api/admin/bambu-history', {});
    await api.app.locals.bambuHistory.running;
    const again = (await (await api.get('/api/admin/bambu-history')).json()).job;
    assert.deepEqual([again.state, again.prints, again.added, again.totalRecalculation], ['done', 121, 0, null]);
  });

  it('runs one at a time, stops when asked and keeps the pages read', async () => {
    const api = await live();
    api.up.bambu.tasks.push(...olderPrints(), ...olderPrints().map((t) => ({ ...t, id: t.id + 1000 })));
    api.app.locals.bambuHistory.pauseMs = 300;
    assert.equal((await api.post('/api/admin/bambu-history', {})).status, 202);
    const second = await api.post('/api/admin/bambu-history', {});
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, 'import_running');

    const stopped = await (await api.post('/api/admin/bambu-history/stop', {})).json();
    assert.equal(stopped.job.stopReason, 'stopped');
    await api.app.locals.bambuHistory.running;
    const { job, printLog } = await (await api.get('/api/admin/bambu-history')).json();
    assert.deepEqual([job.state, job.complete], ['stopped', false]);
    assert.ok(job.prints < 241, `stopped early (${job.prints} of 241)`);
    assert.equal(printLog.prints, job.prints);
  });

  it('stops at the page limit and says so', async () => {
    const api = await live();
    api.up.bambu.tasks.push(...olderPrints());
    api.app.locals.bambuHistory.pauseMs = 0;
    api.app.locals.service.config.bambu.maxHistoryPages = 2;
    await api.post('/api/admin/bambu-history', {});
    await api.app.locals.bambuHistory.running;
    const { job } = await (await api.get('/api/admin/bambu-history')).json();
    assert.deepEqual([job.state, job.stopReason, job.complete, job.pages, job.prints], ['stopped', 'page_limit', false, 2, 100]);
  });

  it('reports a Bambu failure', async () => {
    const api = await live();
    api.up.bambu.validTokens.clear();
    await api.post('/api/admin/bambu-history', { recalculateTotal: true });
    await api.app.locals.bambuHistory.running;
    const { job } = await (await api.get('/api/admin/bambu-history')).json();
    assert.deepEqual([job.state, job.error.code, job.added, job.totalRecalculation], ['failed', 'bambu_auth', 0, null]);
  });

  it('refuses in demo mode, which keeps no print log', async () => {
    const app = await createApp(loadConfig({ DEMO_MODE: 'true' }, ['node', 'server.js']), { now: () => NOW });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/admin/bambu-history`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'demo');
    assert.deepEqual(await (await fetch(`${base}/api/admin/bambu-history`)).json(), { job: null, maxPages: 400, pageSize: 50, printLog: null });
  });
});

describe('admin: collection and status', () => {
  it('reports the last collection and Bambu sign-in, and collects on request', async () => {
    const api = await live({}, { collect: false });
    const before = await (await api.get('/api/admin/status')).json();
    assert.deepEqual([before.demo, before.collected, before.bambu.configured], [false, null, true]);
    assert.equal(before.usageLog.prints, 0);

    // JSON only, so another site can't start collections with a form post.
    const form = await fetch(`${api.base}/api/admin/collect`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '',
    });
    assert.equal(form.status, 415);
    assert.equal(api.agendaDates().length, 0);

    const r = await api.post('/api/admin/collect', {});
    assert.equal(r.status, 200);
    const after = await r.json();
    assert.equal(after.collected.at, new Date(NOW).toISOString());
    assert.deepEqual([after.collected.designhub, after.collected.bambu], [{ ok: true }, { ok: true }]);
    assert.equal(after.bambu.authenticated, true);
    assert.ok(api.agendaDates().includes('2026-10-27'));
  });

  it('says which source failed, without the raw error object', async () => {
    const api = await live({ password: 'changed' });
    const { collected } = await (await api.get('/api/admin/status')).json();
    assert.equal(collected.bambu.ok, true);
    assert.equal(collected.designhub.ok, false);
    assert.match(collected.designhub.error.message, /rejected the username or password/);
  });
});
