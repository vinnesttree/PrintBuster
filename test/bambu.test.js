import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach } from 'node:test';
import { BambuClient, mapTaskStatus, normalizeTask, parseFilaments } from '../src/bambu.js';
import { createMockUpstream, task } from './helpers/mock-upstream.js';

const NOW = Date.parse('2026-10-27T20:00:00Z'); // 3:00 pm CDT

describe('mapTaskStatus', () => {
  it('maps the documented numeric codes and common strings', () => {
    assert.equal(mapTaskStatus(2), 'finished');
    assert.equal(mapTaskStatus('2'), 'finished');
    assert.equal(mapTaskStatus(3), 'failed');
    assert.equal(mapTaskStatus('failed'), 'failed');
    assert.equal(mapTaskStatus('completed'), 'finished');
    assert.equal(mapTaskStatus('RUNNING'), 'running');
    assert.equal(mapTaskStatus(1), 'unknown');
    assert.equal(mapTaskStatus(undefined), 'unknown');
  });
});

describe('normalizeTask', () => {
  const names = new Map([['DEV1', 'Ada']]);

  it('keeps the actual times of a finished job', () => {
    const p = normalizeTask(task(7, 'DEV1', '2026-10-27T09:00', '2026-10-27T10:30', { title: 'Bracket', plateIndex: 2, weight: 12.34 }), names, NOW);
    assert.equal(p.id, 'bb-7');
    assert.equal(p.deviceName, 'Ada');
    assert.equal(p.status, 'finished');
    assert.equal(p.start, '2026-10-27T14:00:00.000Z');
    assert.equal(p.end, '2026-10-27T15:30:00.000Z');
    assert.equal(p.estimated, false);
    assert.equal(p.plate, 'Plate 2');
    assert.equal(p.weightGrams, 12.3);
  });

  it('treats endTime == startTime as still printing and uses the slicer estimate', () => {
    const raw = task(8, 'DEV1', '2026-10-27T14:00', null, { status: 1, costTime: 7200 });
    const p = normalizeTask(raw, names, NOW);
    assert.equal(p.status, 'running');
    assert.equal(p.estimated, true);
    assert.equal(p.overdue, false);
    assert.equal(p.end, '2026-10-27T21:00:00.000Z');
  });

  it('does not claim a saved job is still printing once Bambu stops reporting it', () => {
    const raw = task(8, 'DEV1', '2026-10-27T14:00', null, { status: 1, costTime: 7200 });
    const p = normalizeTask(raw, names, NOW, { confirmed: false });
    assert.equal(p.status, 'unknown');
    assert.equal(p.finishUnknown, true);
    assert.equal(p.overdue, false);
    assert.equal(p.end, '2026-10-27T21:00:00.000Z'); // drawn to its estimated finish
    // A finished job is the same either way.
    const done = normalizeTask(task(9, 'DEV1', '2026-10-27T09:00', '2026-10-27T10:00'), names, NOW, { confirmed: false });
    assert.equal(done.status, 'finished');
    assert.equal(done.finishUnknown, false);
  });

  it('marks running jobs past their estimate as overdue', () => {
    const p = normalizeTask(task(9, 'DEV1', '2026-10-27T10:00', null, { status: 1, costTime: 3600 }), names, NOW);
    assert.equal(p.overdue, true);
  });

  it('extracts material usage: weight, length, and per-filament breakdown', () => {
    const raw = task(20, 'DEV1', '2026-10-27T09:00', '2026-10-27T11:00', {
      weight: 245.37, length: 81234,
      amsDetailMapping: [
        { ams: 1, filamentType: 'PETG', weight: 163.83, sourceColor: 'FF5500FF' },
        { ams: 2, filamentType: 'PLA', weight: 81.5, sourceColor: 'FFFFFFFF' },
      ],
    });
    const p = normalizeTask(raw, names, NOW);
    assert.equal(p.weightGrams, 245.4);
    assert.equal(p.lengthMeters, 81.2);
    assert.deepEqual(p.filaments, [
      { type: 'PETG', grams: 163.8, color: '#FF5500' },
      { type: 'PLA', grams: 81.5, color: '#FFFFFF' },
    ]);
  });

  it('handles tasks with no material data', () => {
    const p = normalizeTask(task(21, 'DEV1', '2026-10-27T09:00', '2026-10-27T10:00'), names, NOW);
    assert.equal(p.weightGrams, null);
    assert.equal(p.lengthMeters, null);
    assert.deepEqual(p.filaments, []);
    assert.deepEqual(parseFilaments(undefined), []);
    assert.deepEqual(parseFilaments([{ filamentType: '', weight: 0 }]), []);
  });

  it('gives jobs cancelled immediately a one-minute footprint', () => {
    const p = normalizeTask(task(10, 'DEV1', '2026-10-27T09:00', '2026-10-27T09:00', { status: 3 }), names, NOW);
    assert.equal(p.status, 'failed');
    assert.equal(Date.parse(p.end) - Date.parse(p.start), 60000);
    assert.equal(p.ranSeconds, 0, 'prorated from the time it actually ran');
  });

  it('keeps how long a cancelled print ran, and its exact estimate', () => {
    const p = normalizeTask(task(12, 'DEV1', '2026-10-27T09:00:00', '2026-10-27T09:00:30', { status: 3, costTime: 90 }), names, NOW);
    assert.deepEqual([p.ranSeconds, p.estimateSeconds, p.estimateMinutes], [30, 90, 2]);
  });

  it('draws a cancelled print with no end time to its estimated end instead of failing', () => {
    for (const endTime of [undefined, null, '', 'not a date']) {
      const p = normalizeTask({ ...task(13, 'DEV1', '2026-10-27T09:00', null, { status: 3, costTime: 5400 }), endTime }, names, NOW);
      assert.deepEqual([p.status, p.finishUnknown, p.estimated, p.ranSeconds], ['failed', true, true, null]);
      assert.equal(Date.parse(p.end) - Date.parse(p.start), 5400 * 1000);
    }
  });

  it('falls back to the task\'s device name and skips unusable tasks', () => {
    const p = normalizeTask(task(11, 'GONE', '2026-10-27T09:00', '2026-10-27T10:00', { deviceName: 'Old printer' }), names, NOW);
    assert.equal(p.deviceName, 'Old printer');
    assert.equal(normalizeTask({ id: 12, startTime: 'garbage' }, names, NOW), null);
  });
});

describe('BambuClient', () => {
  let dir;
  let cfg;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-bambu-'));
    cfg = {
      region: 'global',
      email: 'shop@example.com',
      password: 'pw',
      accessToken: '',
      tokenCachePath: path.join(dir, 'token.json'),
      taskPageSize: 2,
      maxTaskPages: 10,
      configured: true,
    };
  });
  const client = (up, overrides = {}) => new BambuClient({ ...cfg, ...overrides }, { fetch: up.fetch, now: () => NOW });

  it('signs in with a password, sends slicer headers, and caches the token', async () => {
    const up = createMockUpstream({ bambu: { devices: [{ dev_id: 'DEV1', name: 'Ada' }] } });
    const c = client(up);
    await c.init();
    assert.deepEqual(await c.getDevices(), [{ dev_id: 'DEV1', name: 'Ada' }]);

    const [login, bind] = up.calls;
    assert.equal(login.url, 'https://api.bambulab.com/v1/user-service/user/login');
    assert.deepEqual(JSON.parse(login.body), { account: 'shop@example.com', password: 'pw', apiError: '' });
    assert.equal(login.headers.get('x-bbl-client-type'), 'slicer');
    assert.equal(bind.headers.get('authorization'), 'Bearer pw-token');

    const saved = JSON.parse(await fs.readFile(cfg.tokenCachePath, 'utf8'));
    assert.equal(saved.accessToken, 'pw-token');
    assert.equal(saved.expiresAt, new Date(NOW + 7776000 * 1000).toISOString());
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(cfg.tokenCachePath)).mode & 0o777, 0o600);
    }

    // A restart reuses the cached token without signing in again.
    const up2 = createMockUpstream({ bambu: { validTokens: new Set(['pw-token']) } });
    const c2 = client(up2);
    await c2.init();
    await c2.getDevices();
    assert.equal(up2.calls.length, 1);
  });

  it('handles the emailed verification code flow', async () => {
    const up = createMockUpstream({ bambu: { mode: 'verifyCode' } });
    const c = client(up);
    await assert.rejects(c.getDevices(), { code: 'bambu_code_required' });
    assert.ok(up.calls.some((x) => x.url.endsWith('/sendemail/code') && JSON.parse(x.body).type === 'codeLogin'));
    assert.equal(c.status().pending, 'verifyCode');

    // Waiting for the code does not trigger more sign-in attempts.
    const before = up.calls.length;
    await assert.rejects(c.getDevices(), { code: 'bambu_code_required' });
    assert.equal(up.calls.length, before);

    await assert.rejects(c.submitCode('000000'), { code: 'bambu_bad_code' });
    await assert.rejects(c.submitCode('abc'), { code: 'bambu_bad_code' });
    await c.submitCode(' 123456 ');
    assert.equal(c.status().pending, null);
    assert.deepEqual(await c.getDevices(), []);
    assert.equal(up.calls.at(-1).headers.get('authorization'), 'Bearer code-token');
  });

  it('handles two-factor sign-in through the website', async () => {
    const up = createMockUpstream({ bambu: { mode: 'tfa' } });
    const c = client(up);
    await assert.rejects(c.getDevices(), { code: 'bambu_tfa_required' });
    await c.submitCode('654321');
    const tfa = up.calls.find((x) => x.url === 'https://bambulab.com/api/sign-in/tfa');
    assert.deepEqual(JSON.parse(tfa.body), { tfaKey: 'tfa-key-1', tfaCode: '654321' });
    assert.equal(tfa.headers.get('x-bbl-csrf-token'), 'csrf-abc');
    await c.getDevices();
    assert.equal(up.calls.at(-1).headers.get('authorization'), 'Bearer tfa-token');
  });

  it('can restart a stalled sign-in', async () => {
    const up = createMockUpstream({ bambu: { mode: 'verifyCode' } });
    const c = client(up);
    await assert.rejects(c.getDevices(), { code: 'bambu_code_required' });
    await c.restartSignIn();
    assert.equal(up.calls.filter((x) => x.url.endsWith('/sendemail/code')).length, 2);
    assert.equal(c.status().pending, 'verifyCode');
  });

  it('signs in again when a cached token is rejected', async () => {
    await fs.writeFile(cfg.tokenCachePath, JSON.stringify({ email: cfg.email, accessToken: 'stale' }));
    const up = createMockUpstream();
    const c = client(up);
    await c.init();
    await c.getDevices();
    assert.deepEqual(up.calls.map((x) => new URL(x.url).pathname), [
      '/v1/iot-service/api/user/bind', '/v1/user-service/user/login', '/v1/iot-service/api/user/bind',
    ]);
  });

  it('does not overwrite a configured access token', async () => {
    const up = createMockUpstream();
    const ok = client(up, { accessToken: 'env-token' });
    await ok.getDevices();
    assert.equal(up.calls.length, 1);
    const bad = client(up, { accessToken: 'expired' });
    await assert.rejects(bad.getDevices(), { code: 'bambu_auth', status: 401 });
  });

  it('reports a wrong password with Bambu\'s message', async () => {
    const up = createMockUpstream({ bambu: { password: 'different' } });
    await assert.rejects(client(up).getDevices(), (err) => err.code === 'bambu_auth' && /Incorrect password/.test(err.message));
  });

  it('recognises Cloudflare blocks', async () => {
    const fetch = async () => new Response('<html><title>Attention Required! | Cloudflare</title></html>', { status: 403 });
    await assert.rejects(new BambuClient(cfg, { fetch }).getDevices(), { code: 'bambu_cloudflare' });
  });

  it('pages back through the task history until it passes the window', async () => {
    const tasks = [1, 2, 3, 4, 5, 6].map((n) => task(n, 'DEV1', `2026-10-${20 + n}T10:00`, `2026-10-${20 + n}T11:00`));
    const up = createMockUpstream({ bambu: { tasks } });
    const c = client(up, { accessToken: 'env-token' });
    const { tasks: got, complete } = await c.getTasks({ sinceMs: Date.parse('2026-10-24T00:00:00Z') });
    // Newest first, two per page; the second page reaches Oct 23, so it stops.
    assert.deepEqual(got.map((t) => t.id), [6, 5, 4, 3]);
    assert.equal(complete, true);
    assert.deepEqual(up.calls.map((x) => new URL(x.url).search), ['?limit=2', '?limit=2&after=5']);
  });

  it('keeps paging when the server returns smaller pages than requested', async () => {
    const tasks = [1, 2, 3, 4].map((n) => task(n, 'DEV1', `2026-10-${20 + n}T10:00`, `2026-10-${20 + n}T11:00`));
    const up = createMockUpstream({ bambu: { tasks, maxPageSize: 1 } });
    const c = client(up, { accessToken: 'env-token', taskPageSize: 50 });
    const { tasks: got } = await c.getTasks({ sinceMs: 0 });
    assert.deepEqual(got.map((t) => t.id), [4, 3, 2, 1]);
  });

  it('says when the page limit cut the history short', async () => {
    const tasks = [1, 2, 3, 4, 5, 6].map((n) => task(n, 'DEV1', `2026-10-${20 + n}T10:00`, `2026-10-${20 + n}T11:00`));
    const up = createMockUpstream({ bambu: { tasks } });
    const c = client(up, { accessToken: 'env-token', maxTaskPages: 2 });
    const { tasks: got, complete } = await c.getTasks({ sinceMs: 0 });
    assert.equal(got.length, 4);
    assert.equal(complete, false);
  });

  it('stops if the server ignores the cursor', async () => {
    const tasks = [1, 2, 3].map((n) => task(n, 'DEV1', `2026-10-${20 + n}T10:00`, `2026-10-${20 + n}T11:00`));
    const fetch = async () => Response.json({ hits: tasks.slice(0, 2) });
    const c = new BambuClient({ ...cfg, accessToken: 'env-token' }, { fetch });
    const { tasks: got } = await c.getTasks({ sinceMs: 0 });
    assert.equal(got.length, 2);
  });
});
