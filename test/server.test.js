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
