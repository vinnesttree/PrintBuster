import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig, loadEnvFile, parsePrinterMap } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createMockUpstream, task } from './helpers/mock-upstream.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));

// Like the real server, collects once at startup unless `collect: false`.
async function start(env, { collect = true, ...opts } = {}) {
  // Keep the saved reservations in the test's own folder, never in data/.
  if (env.PRINT_LOG_PATH && !env.RESERVATION_LOG_PATH) {
    const dir = path.dirname(env.PRINT_LOG_PATH);
    env = { ...env, RESERVATION_LOG_PATH: path.join(dir, 'reservations.json'), USAGE_LOG_PATH: path.join(dir, 'usage.json'), ASSIGNMENT_LOG_PATH: path.join(dir, 'assignments.json') };
  }
  const app = await createApp(loadConfig(env, ['node', 'server.js']), opts);
  if (collect) await app.locals.collector.runNow();
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    base,
    get: (p, headers) => fetch(base + p, { headers }),
    post: (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

describe('config', () => {
  it('parses PRINTER_MAP pairs', () => {
    const map = parsePrinterMap(' X1C-01=Ada , 01S00C123=Archimedes,');
    assert.deepEqual([...map], [['x1c-01', 'Ada'], ['01s00c123', 'Archimedes']]);
    assert.throws(() => parsePrinterMap('Ada'), /PRINTER_MAP/);
  });

  it('uses demo data only when no credentials are set, unless told otherwise', () => {
    assert.equal(loadConfig({}, []).demo, true);
    assert.equal(loadConfig({ BAMBU_EMAIL: 'a', BAMBU_PASSWORD: 'b' }, []).demo, false);
    assert.equal(loadConfig({ DEMO_MODE: 'false' }, []).demo, false);
    assert.equal(loadConfig({ BAMBU_ACCESS_TOKEN: 't' }, ['node', 'x', '--demo']).demo, true);
  });

  it('loads .env without overriding real environment variables', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-env-'));
    assert.equal(loadEnvFile(path.join(dir, '.env')), false);

    const file = path.join(dir, '.env');
    await fs.writeFile(file, "PB_TEST_HOST=127.0.0.1\nPB_TEST_PW='p@ss$word#1'\n");
    process.env.PB_TEST_HOST = '0.0.0.0';
    try {
      assert.equal(loadEnvFile(file), true);
      assert.equal(process.env.PB_TEST_HOST, '0.0.0.0');
      assert.equal(process.env.PB_TEST_PW, 'p@ss$word#1');
    } finally {
      delete process.env.PB_TEST_HOST;
      delete process.env.PB_TEST_PW;
    }
  });

  it('explains a .env folder left behind by a Docker mount', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-env-'));
    await fs.mkdir(path.join(dir, '.env'));
    assert.throws(() => loadEnvFile(path.join(dir, '.env')), /is a folder, not a file/);
  });

  it('rejects bad settings early', () => {
    assert.throws(() => loadConfig({ TIMEZONE: 'Mars/Olympus' }, []), /TIMEZONE/);
    assert.throws(() => loadConfig({ MATCH_GRACE_MINUTES: '-3' }, []), /MATCH_GRACE_MINUTES/);
    assert.throws(() => loadConfig({ BAMBU_REGION: 'eu' }, []), /BAMBU_REGION/);
    assert.throws(() => loadConfig({ FLAG_WEIGHT_GRAMS: '-5' }, []), /FLAG_WEIGHT_GRAMS/);
    assert.throws(() => loadConfig({ FLAG_DURATION_HOURS: 'abc' }, []), /FLAG_DURATION_HOURS/);
    assert.throws(() => loadConfig({ UPTIME_KUMA_PUSH_BAMBU: 'kuma.local/api/push/x' }, []), /UPTIME_KUMA_PUSH_BAMBU/);
    assert.throws(() => loadConfig({ UPTIME_KUMA_PUSH_DESIGNHUB: 'ftp://kuma/api/push/x' }, []), /UPTIME_KUMA_PUSH_DESIGNHUB/);
  });

  it('reads the large-print thresholds, defaulting to 200 g and 12 h', () => {
    const d = loadConfig({}, []);
    assert.equal(d.flagWeightGrams, 200);
    assert.equal(d.flagDurationHours, 12);
    const c = loadConfig({ FLAG_WEIGHT_GRAMS: '500', FLAG_DURATION_HOURS: '8.5' }, []);
    assert.equal(c.flagWeightGrams, 500);
    assert.equal(c.flagDurationHours, 8.5);
  });
});

describe('demo mode', () => {
  it('serves a full comparison and the page', async () => {
    const api = await start({ DEMO_MODE: 'true' }, { now: () => Date.parse('2026-10-27T23:00:00Z') });
    const config = await (await api.get('/api/config')).json();
    assert.equal(config.demo, true);
    assert.equal(config.today, '2026-10-27');

    const data = await (await api.get('/api/compare?date=2026-10-26')).json();
    assert.equal(data.demo, true);
    assert.ok(data.sources.designhub.ok && data.sources.bambu.ok);
    assert.ok(data.summary.unreserved >= 3, 'demo includes unreserved prints');
    assert.ok(data.summary.partial >= 1, 'demo includes a print that overran its reservation');
    assert.ok(data.rows.some((r) => r.unmapped), 'demo includes an unmapped printer');

    const page = await api.get('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await api.get('/api/compare?date=10-26-2026')).status, 400);
    assert.equal((await api.post('/api/bambu/code', { code: '1' })).status, 400);
  });
});

describe('live mode', () => {
  const env = (dir) => ({
    DEMO_MODE: 'false',
    DESIGNHUB_BASE_URL: 'https://hub.test',
    DESIGNHUB_USERNAME: 'kiosk',
    DESIGNHUB_PASSWORD: 'secret',
    BAMBU_EMAIL: 'shop@example.com',
    BAMBU_PASSWORD: 'pw',
    BAMBU_TOKEN_CACHE: path.join(dir, 'token.json'),
    PRINT_LOG_PATH: path.join(dir, 'print-log.jsonl'),
    CACHE_SECONDS: '60',
  });
  const NOW = Date.parse('2026-10-27T23:00:00Z');

  function upstream(mode) {
    return createMockUpstream({
      hub: {
        reservations: [
          { name: 'Jane Doe', tool: 'Bambu Lab X1 Carbon', model: 'Ada', start: '2026-10-27T09:00', end: '2026-10-27T11:00' },
        ],
      },
      bambu: {
        mode,
        devices: [{ dev_id: 'D-ADA', name: 'Ada', dev_product_name: 'X1 Carbon', online: true, print_status: 'SUCCESS' }],
        tasks: [
          task(1, 'D-ADA', '2026-10-27T09:10', '2026-10-27T10:40'),
          task(2, 'D-ADA', '2026-10-27T13:00', '2026-10-27T14:30'),
        ],
      },
    });
  }

  it('compares live data end to end, including the emailed-code sign-in', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-live-'));
    const up = upstream('verifyCode');
    let clock = NOW;
    const api = await start(env(dir), { fetch: up.fetch, now: () => clock });

    let data = await (await api.get('/api/compare?date=2026-10-27')).json();
    assert.equal(data.sources.designhub.ok, true);
    assert.equal(data.sources.bambu.ok, false);
    assert.equal(data.sources.bambu.error.code, 'bambu_code_required');
    assert.equal(data.sources.bambu.auth.email, 's***@example.com');
    assert.equal(data.reservations.length, 1);

    const wrong = await api.post('/api/bambu/code', { code: '999999' });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).error.code, 'bambu_bad_code');

    const ok = await api.post('/api/bambu/code', { code: '123456' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).bambu.authenticated, true);

    data = await (await api.get('/api/compare?date=2026-10-27')).json();
    assert.equal(data.sources.bambu.ok, true);
    assert.deepEqual(data.prints.map((p) => [p.id, p.match]), [['bb-1', 'reserved'], ['bb-2', 'unreserved']]);
    assert.equal(data.summary.unreserved, 1);

    // Pages read what the server collected: more requests (from any number
    // of viewers) inside the collection interval don't reach upstream.
    const before = up.calls.length;
    await api.get('/api/compare?date=2026-10-27');
    await api.get('/api/compare?date=2026-10-27');
    assert.equal(up.calls.length, before);
    // Refresh starts a collection, unless one ran in the last 15 seconds.
    await api.get('/api/compare?date=2026-10-27&refresh=1');
    assert.equal(up.calls.length, before);
    clock += 20000;
    await api.get('/api/compare?date=2026-10-27&refresh=1');
    assert.ok(up.calls.length > before);
    // However old the data, a page load only reads what is saved; the
    // server's schedule and Refresh are what collect.
    const afterRefresh = up.calls.length;
    clock += 60 * 60000;
    await api.get('/api/compare?date=2026-10-27');
    await api.get('/api/usage?from=2026-10-26&to=2026-10-27');
    assert.equal(up.calls.length, afterRefresh);
  });

  it('shows the other source when one fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-live-'));
    const up = upstream('token');
    up.hub.password = 'changed';
    const api = await start(env(dir), { fetch: up.fetch, now: () => NOW });
    const data = await (await api.get('/api/compare?date=2026-10-27')).json();
    assert.equal(data.sources.designhub.ok, false);
    assert.equal(data.sources.designhub.error.code, 'designhub_auth');
    assert.equal(data.sources.bambu.ok, true);
    assert.equal(data.prints.length, 2);
    assert.ok(data.prints.every((p) => p.match === 'unknown'));
  });

  it('requires the app password when one is set', async () => {
    const api = await start({ DEMO_MODE: 'true', APP_USERNAME: 'staff', APP_PASSWORD: 'p@ss' });
    assert.equal((await api.get('/api/config')).status, 401);
    const wrong = `Basic ${Buffer.from('staff:nope').toString('base64')}`;
    assert.equal((await api.get('/api/config', { Authorization: wrong })).status, 401);
    const right = `Basic ${Buffer.from('staff:p@ss').toString('base64')}`;
    assert.equal((await api.get('/api/config', { Authorization: right })).status, 200);
    // The container healthcheck has no credentials.
    const health = await api.get('/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  });

  it('reports whether each source is up for uptime monitors, without a login', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-live-'));
    const up = upstream('token');
    up.hub.password = 'changed';
    const api = await start({ ...env(dir), BAMBU_ACCESS_TOKEN: 'env-token', APP_PASSWORD: 'p@ss' }, { fetch: up.fetch, now: () => NOW });
    const hub = await api.get('/healthz/designhub');
    assert.equal(hub.status, 503);
    assert.deepEqual(await hub.json(), {
      source: 'designhub', name: 'Design Hub (Studio Manager)', ok: false, status: 'down', checkedAt: '2026-10-27T23:00:00.000Z', code: 'designhub_auth',
    });
    const bambu = await api.get('/healthz/bambu');
    assert.equal(bambu.status, 200);
    assert.equal((await bambu.json()).status, 'up');
    const all = await api.get('/healthz/sources');
    assert.equal(all.status, 503);
    assert.deepEqual((await all.json()).sources.map((s) => [s.source, s.ok]), [['designhub', false], ['bambu', true]]);
  });

  it('answers 503 before the first collection and once collections have stopped', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-live-'));
    let clock = NOW;
    const api = await start({ ...env(dir), BAMBU_ACCESS_TOKEN: 'env-token' }, { fetch: upstream('token').fetch, now: () => clock, collect: false });
    assert.equal((await (await api.get('/healthz/bambu')).json()).status, 'pending');
    await api.app.locals.collector.runNow();
    assert.equal((await api.get('/healthz/bambu')).status, 200);
    // The default schedule collects at least every 15 minutes.
    clock += 36 * 60000;
    const stale = await api.get('/healthz/bambu');
    assert.equal(stale.status, 503);
    assert.equal((await stale.json()).status, 'stale');
  });

  it('pushes each source to its Uptime Kuma push URL after every collection', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-live-'));
    const up = upstream('verifyCode');
    const pushes = [];
    const fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== 'kuma.test') return up.fetch(input, init);
      pushes.push([url.pathname, url.searchParams.get('status'), url.searchParams.get('msg')]);
      return Promise.resolve(Response.json({ ok: true }));
    };
    const api = await start({
      ...env(dir),
      UPTIME_KUMA_PUSH_DESIGNHUB: 'https://kuma.test/api/push/hub?status=up&msg=OK&ping=',
      UPTIME_KUMA_PUSH_BAMBU: 'https://kuma.test/api/push/bambu?status=up&msg=OK&ping=',
    }, { fetch, now: () => NOW });
    await api.app.locals.kuma.pending;
    assert.deepEqual(pushes.sort(), [
      ['/api/push/bambu', 'down', 'Bambu emailed a verification code to s***@example.com. Enter it to finish signing in.'],
      ['/api/push/hub', 'up', 'OK'],
    ]);
    pushes.length = 0;
    await api.post('/api/bambu/code', { code: '123456' });
    await api.app.locals.kuma.pending;
    assert.deepEqual(pushes.sort(), [['/api/push/bambu', 'up', 'OK'], ['/api/push/hub', 'up', 'OK']]);
  });
});

describe('print log', () => {
  const at = (iso) => Date.parse(iso);

  async function setup() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-printlog-'));
    const up = createMockUpstream({
      hub: {
        reservations: [
          { name: 'Jane Doe', tool: 'Bambu Lab X1 Carbon', model: 'Ada', start: '2026-10-26T09:00', end: '2026-10-26T11:00' },
          { name: 'No Show', tool: 'Bambu Lab X1 Carbon', model: 'Ada', start: '2026-10-20T09:00', end: '2026-10-20T11:00' },
        ],
      },
      bambu: {
        devices: [{ dev_id: 'D-ADA', name: 'Ada', dev_product_name: 'X1 Carbon' }],
        tasks: [
          task(1, 'D-ADA', '2026-10-26T09:10', '2026-10-26T10:40'),
          task(2, 'D-ADA', '2026-10-26T13:00', '2026-10-26T14:30'),
          // Still printing at the first fetch (the cloud reports end == start).
          task(3, 'D-ADA', '2026-10-26T21:00', null, { status: 1, costTime: 7200 }),
        ],
      },
    });
    const env = {
      DEMO_MODE: 'false',
      DESIGNHUB_BASE_URL: 'https://hub.test',
      DESIGNHUB_USERNAME: 'kiosk',
      DESIGNHUB_PASSWORD: 'secret',
      BAMBU_ACCESS_TOKEN: 'env-token',
      PRINT_LOG_PATH: path.join(dir, 'print-log.jsonl'),
      // Some tests here call createApp directly; keep their saved files in
      // the test's folder too, never in data/.
      RESERVATION_LOG_PATH: path.join(dir, 'reservations.json'),
      USAGE_LOG_PATH: path.join(dir, 'usage.json'),
      ASSIGNMENT_LOG_PATH: path.join(dir, 'assignments.json'),
      CACHE_SECONDS: '0',
    };
    return { dir, up, env };
  }

  it('keeps prints after Bambu has forgotten them, across restarts', async () => {
    const { up, env } = await setup();
    let clock = at('2026-10-26T21:30:00-05:00');
    const first = await createApp(loadConfig(env, []), { fetch: up.fetch, now: () => clock });
    await first.locals.service.collect();

    // Two days later Bambu only returns recent work.
    clock = at('2026-10-28T12:00:00-05:00');
    up.bambu.tasks = [task(9, 'D-ADA', '2026-10-28T08:00', '2026-10-28T09:00')];

    const api = await start(env, { fetch: up.fetch, now: () => clock }); // a fresh process
    const data = await (await api.get('/api/compare?date=2026-10-26')).json();
    assert.equal(data.sources.bambu.ok, true);
    assert.deepEqual(
      data.prints.map((p) => [p.id, p.match, p.status]),
      [['bb-1', 'reserved', 'finished'], ['bb-2', 'unreserved', 'finished'], ['bb-3', 'unreserved', 'unknown']],
    );
    const stale = data.prints.find((p) => p.id === 'bb-3');
    assert.equal(stale.finishUnknown, true, 'was printing when last seen; its finish was never observed');
    assert.equal(data.printsAvailable, true);
    assert.equal(data.sources.bambu.log.prints, 4);
    // Observed from the oldest logged print (9:10) onward on Oct 26, nothing
    // between the 21:30 poll and the restart.
    assert.deepEqual(data.printGaps, [
      { start: '2026-10-26T05:00:00.000Z', end: '2026-10-26T14:10:00.000Z' },
      { start: '2026-10-27T02:30:00.000Z', end: '2026-10-27T05:00:00.000Z' },
    ]);
  });

  it('counts a fresh fetch as observing the present, so today has no trailing gap', async () => {
    const { up, env } = await setup();
    let clock = at('2026-10-26T21:30:00-05:00');
    const api = await start(env, { fetch: up.fetch, now: () => (clock += 1000) }); // time passes on every read
    const data = await (await api.get('/api/compare?date=2026-10-26')).json();
    assert.deepEqual(data.printGaps, [{ start: '2026-10-26T05:00:00.000Z', end: '2026-10-26T14:10:00.000Z' }]);
  });

  it('marks days before logging began as unknown instead of empty', async () => {
    const { up, env } = await setup();
    const clock = at('2026-10-26T21:30:00-05:00');
    const api = await start(env, { fetch: up.fetch, now: () => clock });
    // Oct 20 isn't saved; a page load doesn't read Design Hub, Refresh does.
    const unsaved = await (await api.get('/api/compare?date=2026-10-20')).json();
    assert.deepEqual([unsaved.sources.designhub.ok, unsaved.sources.designhub.error.code], [false, 'not_saved']);
    assert.match(unsaved.sources.designhub.error.hint, /Refresh/);
    const data = await (await api.get('/api/compare?date=2026-10-20&refresh=1')).json();
    assert.equal(data.printsAvailable, false);
    assert.deepEqual(data.printGaps, [{ start: '2026-10-20T05:00:00.000Z', end: '2026-10-21T05:00:00.000Z' }]);
    assert.equal(data.reservations.length, 1);
    assert.equal(data.reservations[0].noPrint, false, 'no Bambu data, so no claim that nothing printed');
  });

  it('shows logged prints when Bambu is unreachable', async () => {
    const { up, env } = await setup();
    let clock = at('2026-10-26T21:30:00-05:00');
    const first = await createApp(loadConfig(env, []), { fetch: up.fetch, now: () => clock });
    await first.locals.service.collect();

    clock = at('2026-10-26T22:00:00-05:00');
    up.bambu.validTokens.clear(); // Bambu now rejects the token
    const api = await start(env, { fetch: up.fetch, now: () => clock });
    const data = await (await api.get('/api/compare?date=2026-10-26')).json();
    assert.equal(data.sources.bambu.ok, false);
    assert.equal(data.printsAvailable, true);
    assert.deepEqual(data.prints.map((p) => p.id), ['bb-1', 'bb-2', 'bb-3']);
    assert.equal(data.prints[2].status, 'unknown', 'cannot confirm it is still printing');
  });
});

describe('material usage and large-print flags', () => {
  const NOW = Date.parse('2026-10-27T23:00:00Z');

  async function go(env = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-mat-'));
    const up = createMockUpstream({
      hub: { reservations: [{ name: 'Jane', tool: 'Bambu Lab X1 Carbon', model: 'Ada', start: '2026-10-27T00:00', end: '2026-10-27T23:00' }] },
      bambu: {
        devices: [{ dev_id: 'D-ADA', name: 'Ada', dev_product_name: 'X1 Carbon' }],
        tasks: [
          task(1, 'D-ADA', '2026-10-27T08:00', '2026-10-27T09:00', { weight: 250,
            length: 84000, amsDetailMapping: [{ filamentType: 'PETG', weight: 250, sourceColor: 'FF0000FF' }] }),
          task(2, 'D-ADA', '2026-10-27T00:00', '2026-10-27T18:00', { weight: 40 }),
          task(3, 'D-ADA', '2026-10-27T20:00', '2026-10-27T21:00', { weight: 40 }),
        ],
      },
    });
    const base = {
      DEMO_MODE: 'false', DESIGNHUB_BASE_URL: 'https://hub.test',
      DESIGNHUB_USERNAME: 'kiosk', DESIGNHUB_PASSWORD: 'secret', BAMBU_ACCESS_TOKEN: 'env-token',
      PRINT_LOG_PATH: path.join(dir, 'print-log.jsonl'), CACHE_SECONDS: '0', ...env,
    };
    const api = await start(base, { fetch: up.fetch, now: () => NOW });
    return api;
  }

  it('surfaces material and flags prints over the thresholds', async () => {
    const api = await go();
    const cfg = await (await api.get('/api/config')).json();
    assert.equal(cfg.flagWeightGrams, 200);
    assert.equal(cfg.flagDurationHours, 12);

    const data = await (await api.get('/api/compare?date=2026-10-27')).json();
    assert.equal(data.flagWeightGrams, 200);
    const by = Object.fromEntries(data.prints.map((p) => [p.id, p]));
    assert.deepEqual([by['bb-1'].overWeight, by['bb-1'].overTime, by['bb-1'].large], [true, false, true]);
    assert.equal(by['bb-1'].weightGrams, 250);
    assert.deepEqual(by['bb-1'].filaments, [{ type: 'PETG', grams: 250, color: '#FF0000' }]);
    assert.deepEqual([by['bb-2'].overWeight, by['bb-2'].overTime, by['bb-2'].large], [false, true, true]);
    assert.deepEqual([by['bb-3'].overWeight, by['bb-3'].overTime, by['bb-3'].large], [false, false, false]);
    assert.deepEqual([data.summary.overWeight, data.summary.overTime, data.summary.large], [1, 1, 2]);
  });

  it('disables a flag when its threshold is 0', async () => {
    const api = await go({ FLAG_WEIGHT_GRAMS: '0', FLAG_DURATION_HOURS: '0' });
    const data = await (await api.get('/api/compare?date=2026-10-27')).json();
    assert.equal(data.summary.large, 0);
    assert.ok(data.prints.every((p) => !p.large));
  });
});

describe('filament usage by user', () => {
  const NOW = Date.parse('2026-10-27T23:00:00Z');

  it('defaults to the last 30 days and validates the range', async () => {
    const api = await start({ DEMO_MODE: 'true' }, { now: () => NOW });
    const data = await (await api.get('/api/usage')).json();
    assert.deepEqual([data.from, data.to, data.available], ['2026-09-28', '2026-10-27', true]);
    assert.ok(data.users.some((u) => u.prints > 0), 'demo members have usage');
    assert.equal(data.maxOutsideShare, 0.5);
    assert.ok(data.allTime.countedGrams > 0, 'demo keeps usage in memory');
    // A range inside the first one adds no prints to the all-time total.
    const week = await (await api.get('/api/usage?from=2026-10-21&to=2026-10-27')).json();
    assert.deepEqual(
      [week.allTime.countedPrints, week.allTime.countedGrams],
      [data.totals.countedPrints, data.totals.countedGrams],
    );
    const total = await api.post('/api/usage/recalculate-total', {});
    assert.equal(total.status, 200);
    // The server's collection keeps tomorrow's agenda too.
    assert.equal((await total.json()).allTime.lastTotalRecalculation.to, '2026-10-28');

    for (const [q, msg] of [['from=2026-10-27&to=2026-10-01', /after the end/], ['from=2026-01-01&to=2026-10-27', /at most 92/], ['from=nope', /YYYY-MM-DD/]]) {
      const r = await api.get(`/api/usage?${q}`);
      assert.equal(r.status, 400);
      assert.match((await r.json()).error.message, msg);
    }
  });

  async function live(hubOverrides = {}, dir = null, startOpts = {}) {
    dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pb-usage-'));
    const up = createMockUpstream({
      hub: {
        reservations: [{ name: 'Jane Doe', tool: 'Bambu Lab X1 Carbon', model: 'Ada', start: '2026-10-26T09:00', end: '2026-10-26T12:00' }],
        ...hubOverrides,
      },
      bambu: {
        devices: [{ dev_id: 'D-ADA', name: 'Ada', dev_product_name: 'X1 Carbon' }],
        tasks: [
          task(1, 'D-ADA', '2026-10-26T09:10', '2026-10-26T10:40', { weight: 100 }),
          // Cancelled after 30 of a planned 120 minutes.
          task(2, 'D-ADA', '2026-10-26T11:00', '2026-10-26T11:30', { status: 3, costTime: 7200, weight: 80 }),
          // No reservation at all.
          task(3, 'D-ADA', '2026-10-26T15:00', '2026-10-26T16:00', { weight: 40 }),
        ],
      },
    });
    const api = await start({
      DEMO_MODE: 'false', DESIGNHUB_BASE_URL: 'https://hub.test', DESIGNHUB_USERNAME: 'kiosk', DESIGNHUB_PASSWORD: 'secret',
      BAMBU_ACCESS_TOKEN: 'env-token', PRINT_LOG_PATH: path.join(dir, 'print-log.jsonl'),
    }, { fetch: up.fetch, now: () => NOW, ...startOpts });
    return { api, up, dir };
  }

  it('charges each user for prints in their reservations, prorating cancelled ones', async () => {
    const { api, up } = await live();
    const data = await (await api.get('/api/usage?from=2026-10-26&to=2026-10-26')).json();
    assert.equal(data.available, true);
    const jane = data.users.find((u) => u.name === 'Jane Doe');
    assert.deepEqual([jane.prints, jane.grams, jane.reservations], [2, 120, 1]); // 100 + 80 x 30/120
    assert.deepEqual(jane.list.map((p) => [p.method, p.usedGrams]), [['finished', 100], ['cancelled', 20]]);
    assert.deepEqual([data.unattributed.prints, data.unattributed.grams], [1, 40]);

    // Only the server's collection read Design Hub: yesterday, today and
    // tomorrow, then the day before the print log began. The page read none.
    const agendaCalls = () => up.calls.filter((c) => c.url.includes('/admin/agenda/')).map((c) => new URL(c.url).searchParams.get('date'));
    assert.deepEqual(agendaCalls(), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-25']);
    // Refresh inside 15 seconds of a collection, with every day saved, reads nothing.
    await api.get('/api/usage?from=2026-10-26&to=2026-10-26&refresh=1');
    assert.equal(agendaCalls().length, 4);
  });

  it('keeps reservations on disk and uses them after a restart when Design Hub is down', async () => {
    const { api, dir } = await live();
    const before = await (await api.get('/api/usage?from=2026-10-26&to=2026-10-26')).json();
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'reservations.json'), 'utf8'));
    assert.deepEqual(Object.entries(saved.days).map(([d, v]) => [d, v.final]), [['2026-10-25', true], ['2026-10-26', true], ['2026-10-27', false], ['2026-10-28', false]]);
    assert.equal(saved.days['2026-10-26'].reservations[0].name, 'Jane Doe');

    // A new app on the same folder, with the Design Hub login now failing.
    const { api: restarted } = await live({ password: 'changed' }, dir);
    const after = await (await restarted.get('/api/usage?from=2026-10-26&to=2026-10-26')).json();
    assert.equal(after.available, true);
    assert.deepEqual(
      [after.sources.designhub.ok, after.sources.designhub.savedDays, after.sources.designhub.staleDays],
      [true, 2, 1],
    );
    assert.deepEqual(after.users, before.users);
  });

  it('saves the calculated usage of every print to the volume', async () => {
    const { api, dir } = await live();
    await api.get('/api/usage?from=2026-10-26&to=2026-10-26');
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'usage.json'), 'utf8'));
    const byId = Object.fromEntries(Object.values(saved.prints).map((p) => [p.id, p]));
    assert.deepEqual(
      ['bb-1', 'bb-2', 'bb-3'].map((id) => [byId[id].usedGrams, byId[id].counted, byId[id].reservation?.name ?? null]),
      [[100, true, 'Jane Doe'], [20, true, 'Jane Doe'], [40, false, null]],
    );
    assert.equal(saved.lastRecalculation, null);
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dir, 'usage.json'))).mode & 0o777, 0o600);
  });

  it('recalculates from freshly read reservations and saves the new results', async () => {
    const { api, up, dir } = await live();
    const first = await (await api.get('/api/usage?from=2026-10-26&to=2026-10-26')).json();
    assert.equal(first.users.find((u) => u.name === 'Jane Doe').grams, 120);

    // Design Hub is corrected afterwards: the booking was Sam's.
    up.hub.reservations = [{ name: 'Sam Lee', tool: 'Bambu Lab X1 Carbon', model: 'Ada', start: '2026-10-26T09:00', end: '2026-10-26T12:00' }];
    const agendaCalls = () => up.calls.filter((c) => c.url.includes('/admin/agenda/')).length;
    const callsBefore = agendaCalls();

    // A normal load keeps using the saved, final day.
    const cached = await (await api.get('/api/usage?from=2026-10-26&to=2026-10-26')).json();
    assert.ok(cached.users.some((u) => u.name === 'Jane Doe'));

    // Only JSON is accepted, so a plain cross-site form post can't trigger it.
    const form = await fetch(`${api.base}/api/usage/recalculate`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'from=2026-10-26&to=2026-10-26',
    });
    assert.equal(form.status, 415);
    assert.equal(agendaCalls(), callsBefore);

    const recalc = await api.post('/api/usage/recalculate', { from: '2026-10-26', to: '2026-10-26' });
    assert.equal(recalc.status, 200);
    const data = await recalc.json();
    assert.equal(data.recalculated, true);
    assert.equal(agendaCalls() - callsBefore, 3, 'every day re-read, final ones too');
    assert.deepEqual(data.users.map((u) => [u.name, u.grams]), [['Sam Lee', 120]]);

    const reservations = JSON.parse(await fs.readFile(path.join(dir, 'reservations.json'), 'utf8'));
    assert.equal(reservations.days['2026-10-26'].reservations[0].name, 'Sam Lee');
    const usage = JSON.parse(await fs.readFile(path.join(dir, 'usage.json'), 'utf8'));
    assert.equal(Object.values(usage.prints).find((p) => p.id === 'bb-1').reservation.name, 'Sam Lee');
    assert.deepEqual(usage.lastRecalculation, { at: new Date(NOW).toISOString(), from: '2026-10-26', to: '2026-10-26' });

    // Later normal loads use the corrected copy.
    const after = await (await api.get('/api/usage?from=2026-10-26&to=2026-10-26')).json();
    assert.deepEqual(after.users.map((u) => u.name), ['Sam Lee']);
  });

  it('charges a print with no reservation to the member staff assign it to', async () => {
    const { api, dir } = await live();
    const first = await (await api.get('/api/usage?from=2026-10-26&to=2026-10-26')).json();
    assert.deepEqual(first.unattributed.list.map((p) => p.id), ['bb-3']);

    // JSON only, so another site can't assign prints with a plain form post.
    const form = await fetch(`${api.base}/api/usage/assign`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'printId=bb-3&name=Sam',
    });
    assert.equal(form.status, 415);
    const bad = await api.post('/api/usage/assign', { printId: '../x', name: 'Sam' });
    assert.equal(bad.status, 400);

    const r = await api.post('/api/usage/assign', { printId: 'bb-3', name: 'Sam Lee' });
    assert.equal(r.status, 200);
    const assigned = await r.json();
    assert.equal(assigned.assignment.name, 'Sam Lee');
    // The all-time totals take it in at once, before any recalculation.
    assert.deepEqual(assigned.allTime.members.map((m) => [m.name, m.prints, m.grams, m.assignedGrams]).sort(),
      [['Jane Doe', 2, 120, 0], ['Sam Lee', 1, 40, 40]]);
    assert.equal(assigned.allTime.unattributedPrints, 0);

    const data = await (await api.get('/api/usage?from=2026-10-26&to=2026-10-26')).json();
    const sam = data.users.find((u) => u.name === 'Sam Lee');
    assert.deepEqual([sam.prints, sam.grams, sam.assignedPrints, sam.reservations], [1, 40, 1, 0]);
    assert.deepEqual([data.unattributed.prints, data.totals.assignedGrams], [0, 40]);
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'assignments.json'), 'utf8'));
    assert.equal(saved.prints['bb-3'].name, 'Sam Lee');
    const usage = JSON.parse(await fs.readFile(path.join(dir, 'usage.json'), 'utf8'));
    const rec = Object.values(usage.prints).find((p) => p.id === 'bb-3');
    assert.deepEqual([rec.counted, rec.assignedTo.name, rec.reservation], [true, 'Sam Lee', null]);

    // Kept across restarts, and used by Recalculate total.
    const { api: restarted } = await live({}, dir);
    const total = await (await restarted.post('/api/usage/recalculate-total', {})).json();
    assert.ok(total.allTime.members.some((m) => m.name === 'Sam Lee' && m.grams === 40));

    // An empty name removes the assignment.
    const removed = await (await restarted.post('/api/usage/assign', { printId: 'bb-3', name: '' })).json();
    assert.equal(removed.assignment, null);
    assert.ok(!removed.allTime.members.some((m) => m.name === 'Sam Lee'));
    const after = await (await restarted.get('/api/usage?from=2026-10-26&to=2026-10-26')).json();
    assert.deepEqual(after.unattributed.list.map((p) => p.id), ['bb-3']);
  });

  it('recalculates the all-time total from saved data only', async () => {
    const { api, up } = await live({}, null, { collect: false });
    // Nothing saved yet.
    const empty = await api.post('/api/usage/recalculate-total', {});
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error.message, /No reservations are saved/);
    await api.app.locals.collector.runNow();

    const first = await (await api.get('/api/usage?from=2026-10-26&to=2026-10-26')).json();
    assert.deepEqual(first.allTime.members.map((m) => [m.name, m.prints, m.grams]), [['Jane Doe', 2, 120]]);
    assert.deepEqual([first.allTime.countedGrams, first.allTime.unattributedGrams], [120, 40]);

    // A print logged on a day whose reservations were never saved.
    const { service } = api.app.locals;
    await service.printLog.record({ tasks: [task(9, 'D-ADA', '2026-10-20T12:00', '2026-10-20T13:00', { weight: 55 })], fetchedAt: NOW });
    // Design Hub now says the booking was Sam's; the total must not ask it.
    up.hub.reservations = [{ name: 'Sam Lee', tool: 'Bambu Lab X1 Carbon', model: 'Ada', start: '2026-10-26T09:00', end: '2026-10-26T12:00' }];
    const before = up.calls.length;

    const form = await fetch(`${api.base}/api/usage/recalculate-total`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
    assert.equal(form.status, 415);

    const r = await api.post('/api/usage/recalculate-total', {});
    assert.equal(r.status, 200);
    const { allTime } = await r.json();
    assert.equal(up.calls.length, before, 'no Design Hub or Bambu requests');
    assert.deepEqual(allTime.members.map((m) => [m.name, m.prints, m.grams]), [['Jane Doe', 2, 120]]);
    assert.deepEqual(allTime.lastTotalRecalculation, {
      at: new Date(NOW).toISOString(), from: '2026-10-25', to: '2026-10-28', prints: 3, skippedPrints: 1,
    });
  });

  it('leaves out prints on days with no saved reservations, without asking Design Hub', async () => {
    const { api, up } = await live();
    await api.app.locals.service.printLog.record({
      tasks: [task(9, 'D-ADA', '2026-10-22T12:00', '2026-10-22T13:00', { weight: 55 })], fetchedAt: NOW,
    });
    const before = up.calls.length;
    const data = await (await api.get('/api/usage?from=2026-10-21&to=2026-10-26')).json();
    assert.equal(up.calls.length, before);
    assert.deepEqual(data.sources.designhub.missingDays, ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
    assert.ok(!data.unattributed.list.some((p) => p.id === 'bb-9'), 'not counted as unreserved either');
    assert.deepEqual(data.users.map((u) => [u.name, u.grams]), [['Jane Doe', 120]]);

    // Refresh reads them.
    const refreshed = await (await api.get('/api/usage?from=2026-10-21&to=2026-10-26&refresh=1')).json();
    assert.deepEqual(refreshed.sources.designhub.missingDays, []);
    assert.ok(refreshed.unattributed.list.some((p) => p.id === 'bb-9'));
  });

  it('rejects a recalculation without valid dates', async () => {
    const { api } = await live();
    const r = await api.post('/api/usage/recalculate', { from: 'yesterday' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error.message, /YYYY-MM-DD/);
  });

  it('saves finished agenda days in the background, newest first', async () => {
    const { api, up } = await live();
    const { service } = api.app.locals;
    // The print log started on Oct 20 (Chicago); yesterday is Oct 26.
    await service.printLog.record({ tasks: [task(9, 'D-ADA', '2026-10-20T12:00', '2026-10-20T13:00')], fetchedAt: Date.parse('2026-10-20T19:00:00Z') });
    // Startup's collection already saved Oct 25 (the day before the log
    // began then) through tomorrow.
    const startup = up.calls.length;
    const agendaDates = () => up.calls.slice(startup).filter((c) => c.url.includes('/admin/agenda/')).map((c) => new URL(c.url).searchParams.get('date'));
    await service.archiveAgenda();
    assert.deepEqual(agendaDates(), ['2026-10-24', '2026-10-23', '2026-10-22']);
    await service.archiveAgenda();
    assert.deepEqual(agendaDates().slice(3), ['2026-10-21', '2026-10-20', '2026-10-19']);
    assert.ok(['2026-10-19', '2026-10-26'].every((d) => service.reservationArchive.get(d)?.final));
    await service.archiveAgenda();
    assert.equal(agendaDates().length, 6, 'nothing left to save');
  });

  it('adds the interpolated share of cancelled prints to the member, in the range and all time', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-usage-'));
    const up = createMockUpstream({
      hub: { reservations: [{ name: 'Cara', tool: 'Bambu Lab X1 Carbon', model: 'Ada', start: '2026-10-26T09:00', end: '2026-10-26T17:00' }] },
      bambu: {
        devices: [{ dev_id: 'D-ADA', name: 'Ada', dev_product_name: 'X1 Carbon' }],
        tasks: [
          // Cancelled after 45 of a planned 180 minutes: a quarter of 120 g.
          task(1, 'D-ADA', '2026-10-26T09:15', '2026-10-26T10:00', { status: 3, costTime: 10800, weight: 120,
            amsDetailMapping: [{ filamentType: 'PLA', weight: 80 }, { filamentType: 'PETG', weight: 40 }] }),
          // Cancelled 30 seconds into a 90-second job: a third of 9 g.
          task(2, 'D-ADA', '2026-10-26T11:00:00', '2026-10-26T11:00:30', { status: 3, costTime: 90, weight: 9 }),
          // Cancelled with no end time recorded: charged in full.
          { ...task(3, 'D-ADA', '2026-10-26T13:00', null, { status: 3, costTime: 3600, weight: 20 }), endTime: null },
        ],
      },
    });
    const api = await start({
      DEMO_MODE: 'false', DESIGNHUB_BASE_URL: 'https://hub.test', DESIGNHUB_USERNAME: 'kiosk', DESIGNHUB_PASSWORD: 'secret',
      BAMBU_ACCESS_TOKEN: 'env-token', PRINT_LOG_PATH: path.join(dir, 'print-log.jsonl'),
    }, { fetch: up.fetch, now: () => NOW });

    const r = await api.get('/api/usage?from=2026-10-26&to=2026-10-26');
    assert.equal(r.status, 200);
    const data = await r.json();
    const cara = data.users.find((u) => u.name === 'Cara');
    assert.deepEqual(cara.list.map((p) => [p.id, p.method, p.fraction, p.usedGrams]), [
      ['bb-1', 'cancelled', 0.25, 30], ['bb-2', 'cancelled', 0.333, 3], ['bb-3', 'cancelled-end-unknown', 1, 20],
    ]);
    assert.deepEqual([cara.prints, cara.grams, cara.excludedPrints], [3, 53, 0]);
    assert.deepEqual(cara.materials, { PLA: 20, PETG: 10, Unknown: 23 });
    assert.deepEqual(data.allTime.members.map((m) => [m.name, m.prints, m.grams]), [['Cara', 3, 53]]);

    // The waterfall draws them too, instead of failing on the missing end.
    const day = await api.get('/api/compare?date=2026-10-26');
    assert.equal(day.status, 200);
    const noEnd = (await day.json()).prints.find((p) => p.id === 'bb-3');
    assert.deepEqual([noEnd.status, noEnd.finishUnknown, noEnd.end], ['failed', true, '2026-10-26T19:00:00.000Z']);
  });

  it('attributes nothing when the agenda cannot be read', async () => {
    const { api } = await live({ password: 'changed' });
    const data = await (await api.get('/api/usage?from=2026-10-26&to=2026-10-26')).json();
    assert.equal(data.available, false);
    assert.equal(data.sources.designhub.ok, false);
    assert.deepEqual(data.users, []);
  });
});

describe('server-side collection and live updates', () => {
  const NOW = Date.parse('2026-10-27T23:00:00Z');

  // Reads server-sent events from a streaming response.
  function eventReader(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    return async function next() {
      for (;;) {
        const i = buf.indexOf('\n\n');
        if (i >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (raw.startsWith(':')) continue;
          const fields = Object.fromEntries(raw.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
          return { event: fields.event, data: JSON.parse(fields.data) };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream closed');
        buf += decoder.decode(value, { stream: true });
      }
    };
  }

  async function viewersSoon(api, n) {
    for (let i = 0; i < 50; i++) {
      const { collector } = await (await api.get('/api/config')).json();
      if (collector.viewers === n) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`viewers never reached ${n}`);
  }

  it('counts open pages and tells them when new data is in', async () => {
    let clock = NOW;
    const api = await start({ DEMO_MODE: 'true', POLL_ACTIVE_MINUTES: '2', POLL_IDLE_MINUTES: '15' }, { now: () => clock });
    const config = await (await api.get('/api/config')).json();
    assert.deepEqual([config.collector.viewers, config.collector.activeMinutes, config.collector.idleMinutes], [0, 2, 15]);

    const pages = [new AbortController(), new AbortController()];
    const streams = await Promise.all(pages.map((c) => fetch(`${api.base}/api/events`, { signal: c.signal })));
    assert.match(streams[0].headers.get('content-type'), /^text\/event-stream/);
    const next = streams.map(eventReader);
    assert.equal((await next[0]()).event, 'hello');
    assert.equal((await next[1]()).event, 'hello');
    await viewersSoon(api, 2);

    // A collection (here started by Refresh) is announced to every page.
    clock += 20000;
    await api.get('/api/compare?refresh=1');
    const updates = await Promise.all(next.map((n) => n()));
    assert.deepEqual(updates.map((u) => u.event), ['update', 'update']);
    assert.equal(updates[0].data.lastRunAt, new Date(clock).toISOString());

    pages[0].abort();
    await viewersSoon(api, 1);
    pages[1].abort();
    await viewersSoon(api, 0);
  });

  it('reports when the data was collected with every response', async () => {
    const api = await start({ DEMO_MODE: 'true' }, { now: () => NOW });
    const compare = await (await api.get('/api/compare?date=2026-10-27')).json();
    const usage = await (await api.get('/api/usage?from=2026-10-27&to=2026-10-27')).json();
    for (const data of [compare, usage]) assert.equal(data.collector.lastRunAt, new Date(NOW).toISOString());
  });
});
