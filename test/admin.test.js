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
    ASSIGNMENT_LOG_PATH: path.join(dir, 'assignments.json'),
  };
  const app = await createApp(loadConfig(env, ['node', 'server.js']), { fetch: up.fetch, now: () => NOW });
  if (collect) await app.locals.collector.runNow();
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const agendaDates = () => up.calls.filter((c) => c.url.includes('/admin/agenda/')).map((c) => new URL(c.url).searchParams.get('date'));
  return {
    app,
    up,
    dir,
    base,
    agendaDates,
    get: (p) => fetch(base + p),
    post: (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    // Waits for the running import, then returns its status.
    finished: async () => {
      await app.locals.importer.running;
      return (await fetch(`${base}/api/admin/import`)).json();
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
      ASSIGNMENT_LOG_PATH: path.join(dir, 'assignments.json'),
    }, ['node', 'server.js']), { fetch: up.fetch, now: () => NOW });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: '2026-10-01', to: '2026-10-02' }),
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
