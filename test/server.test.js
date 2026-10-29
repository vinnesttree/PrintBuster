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

async function start(env, opts) {
  const app = await createApp(loadConfig(env, ['node', 'server.js']), opts);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
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
    const api = await start(env(dir), { fetch: up.fetch, now: () => NOW });

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

    // Cached: a second request inside CACHE_SECONDS does not hit upstream.
    const before = up.calls.length;
    await api.get('/api/compare?date=2026-10-27');
    assert.equal(up.calls.length, before);
    await api.get('/api/compare?date=2026-10-27&refresh=1');
    assert.ok(up.calls.length > before);
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
      CACHE_SECONDS: '0',
    };
    return { dir, up, env };
  }

  it('keeps prints after Bambu has forgotten them, across restarts', async () => {
    const { up, env } = await setup();
    let clock = at('2026-10-26T21:30:00-05:00');
    const first = await createApp(loadConfig(env, []), { fetch: up.fetch, now: () => clock });
    await first.locals.service.pollBambu();

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
    const data = await (await api.get('/api/compare?date=2026-10-20')).json();
    assert.equal(data.printsAvailable, false);
    assert.deepEqual(data.printGaps, [{ start: '2026-10-20T05:00:00.000Z', end: '2026-10-21T05:00:00.000Z' }]);
    assert.equal(data.reservations.length, 1);
    assert.equal(data.reservations[0].noPrint, false, 'no Bambu data, so no claim that nothing printed');
  });

  it('shows logged prints when Bambu is unreachable', async () => {
    const { up, env } = await setup();
    let clock = at('2026-10-26T21:30:00-05:00');
    const first = await createApp(loadConfig(env, []), { fetch: up.fetch, now: () => clock });
    await first.locals.service.pollBambu();

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

    for (const [q, msg] of [['from=2026-10-27&to=2026-10-01', /after the end/], ['from=2026-01-01&to=2026-10-27', /at most 92/], ['from=nope', /YYYY-MM-DD/]]) {
      const r = await api.get(`/api/usage?${q}`);
      assert.equal(r.status, 400);
      assert.match((await r.json()).error.message, msg);
    }
  });

  async function live(hubOverrides = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-usage-'));
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
    }, { fetch: up.fetch, now: () => NOW });
    return { api, up };
  }

  it('charges each user for prints in their reservations, prorating cancelled ones', async () => {
    const { api, up } = await live();
    const data = await (await api.get('/api/usage?from=2026-10-26&to=2026-10-26')).json();
    assert.equal(data.available, true);
    const jane = data.users.find((u) => u.name === 'Jane Doe');
    assert.deepEqual([jane.prints, jane.grams, jane.reservations], [2, 120, 1]); // 100 + 80 x 30/120
    assert.deepEqual(jane.list.map((p) => [p.method, p.usedGrams]), [['finished', 100], ['cancelled', 20]]);
    assert.deepEqual([data.unattributed.prints, data.unattributed.grams], [1, 40]);

    // One agenda page per day (the day before too), then served from cache.
    const agendaCalls = () => up.calls.filter((c) => c.url.includes('/admin/agenda/')).map((c) => new URL(c.url).searchParams.get('date'));
    assert.deepEqual(agendaCalls(), ['2026-10-25', '2026-10-26']);
    await api.get('/api/usage?from=2026-10-26&to=2026-10-26');
    assert.equal(agendaCalls().length, 2);
  });

  it('attributes nothing when the agenda cannot be read', async () => {
    const { api } = await live({ password: 'changed' });
    const data = await (await api.get('/api/usage?from=2026-10-26&to=2026-10-26')).json();
    assert.equal(data.available, false);
    assert.equal(data.sources.designhub.ok, false);
    assert.deepEqual(data.users, []);
  });
});
