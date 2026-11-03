import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  AccountStore, hashPassword, HashGate, LoginLimiter, SessionStore, verifyPassword,
} from '../src/accounts.js';
import { redactSecrets, safeNext } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createMockUpstream, task } from './helpers/mock-upstream.js';

const FAST = { N: 1024, r: 8, p: 1, keylen: 64 };
const NOW = Date.parse('2026-10-27T23:00:00Z');
const ADMIN_PASSWORD = 'correct horse battery';
// Long, distinctive credentials, to check none of them reaches a browser.
const SECRETS = {
  DESIGNHUB_PASSWORD: 'hub-password-7f3a9c',
  BAMBU_ACCESS_TOKEN: 'bambu-token-81d2e4b6',
  APP_PASSWORD: ADMIN_PASSWORD,
  ACCESS_CODE: 'lan-access-code-5521',
};

const servers = [];
after(() => servers.forEach((s) => s.close()));

function upstream() {
  return createMockUpstream({
    hub: {
      password: SECRETS.DESIGNHUB_PASSWORD,
      reservations: [
        { name: 'Jane Doe', tool: 'Bambu Lab X1 Carbon', model: 'Ada', start: '2026-10-27T09:00', end: '2026-10-27T11:00' },
        { name: 'Event: Sam Lee workshop', tool: 'Bambu Lab X1 Carbon', model: 'Ada', start: '2026-10-27T15:00', end: '2026-10-27T16:00' },
      ],
    },
    bambu: {
      validTokens: new Set([SECRETS.BAMBU_ACCESS_TOKEN]),
      devices: [{ dev_id: '01S00C123456789', name: 'Ada', dev_product_name: 'X1 Carbon', dev_access_code: SECRETS.ACCESS_CODE }],
      tasks: [
        task(1, '01S00C123456789', '2026-10-27T09:10', '2026-10-27T10:40', { title: 'Jane bracket v2', plateName: 'Jane plate', weight: 80 }),
        task(2, '01S00C123456789', '2026-10-27T13:00', '2026-10-27T14:00', {
          title: 'Mystery job', status: 3, weight: 200, costTime: 4 * 3600,
        }),
      ],
    },
  });
}

async function start(extraEnv = {}, { up = upstream(), demo = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-accounts-'));
  const env = demo ? { DEMO_MODE: 'true', ...extraEnv } : {
    DEMO_MODE: 'false',
    DESIGNHUB_BASE_URL: 'https://hub.test',
    DESIGNHUB_USERNAME: 'kiosk',
    DESIGNHUB_PASSWORD: SECRETS.DESIGNHUB_PASSWORD,
    BAMBU_ACCESS_TOKEN: SECRETS.BAMBU_ACCESS_TOKEN,
    PRINT_LOG_PATH: path.join(dir, 'print-log.jsonl'),
    RESERVATION_LOG_PATH: path.join(dir, 'reservations.json'),
    USAGE_LOG_PATH: path.join(dir, 'usage.json'),
    ASSIGNMENT_LOG_PATH: path.join(dir, 'assignments.json'),
    ACCOUNTS_PATH: path.join(dir, 'accounts.json'),
    SESSIONS_PATH: path.join(dir, 'sessions.json'),
    ...extraEnv,
  };
  const app = await createApp(loadConfig(env, ['node', 'server.js']), { fetch: up.fetch, now: () => NOW, scryptParams: FAST });
  await app.locals.collector.runNow();
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (p, { cookie, body, headers = {}, method } = {}) => fetch(base + p, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    redirect: 'manual',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = (username, password, headers) => request('/api/login', { body: { username, password }, headers });
  const signIn = async (username, password) => {
    const res = await login(username, password);
    assert.equal(res.status, 200, `signing in as ${username}`);
    return res.headers.get('set-cookie').split(';')[0];
  };
  return { app, dir, base, up, request, login, signIn };
}

describe('passwords', () => {
  it('stores only a salted scrypt hash and checks against it', async () => {
    const a = await hashPassword('correct horse battery', FAST);
    const b = await hashPassword('correct horse battery', FAST);
    assert.match(a, /^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/);
    assert.notEqual(a, b, 'a fresh salt each time');
    assert.ok(!a.includes('horse'));
    assert.equal(await verifyPassword('correct horse battery', a), true);
    assert.equal(await verifyPassword('correct horse batterY', a), false);
    assert.equal(await verifyPassword('anything', 'not a hash'), false);
    // The same text in another Unicode form matches.
    const accented = await hashPassword('café au lait!', FAST);
    assert.equal(await verifyPassword('café au lait!', accented), true);
  });

  it('hashes with OWASP-strength settings by default', async () => {
    const hash = await hashPassword('correct horse battery');
    assert.match(hash, /^scrypt\$32768\$8\$3\$/);
  });
});

describe('account store', () => {
  it('validates accounts and never removes the last admin', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-accounts-'));
    const file = path.join(dir, 'accounts.json');
    const store = new AccountStore(file, { scryptParams: FAST, now: () => NOW });
    await assert.rejects(store.create({ username: 'ana', password: 'short', role: 'admin' }), /at least 10/);
    await assert.rejects(store.create({ username: 'bad name', password: ADMIN_PASSWORD, role: 'admin' }), /Usernames/);
    await assert.rejects(store.create({ username: 'ana', password: ADMIN_PASSWORD, role: 'root' }), /role/);
    await assert.rejects(store.create({ username: 'ana.lopez', password: 'Ana.Lopez', role: 'admin' }), /at least 10|can.t be the username/);
    await assert.rejects(store.create({ username: 'ana.lopez1', password: 'ANA.LOPEZ1', role: 'admin' }), /can.t be the username/);
    await store.create({ username: 'Ana', password: ADMIN_PASSWORD, role: 'admin' });
    await assert.rejects(store.create({ username: 'ANA', password: ADMIN_PASSWORD, role: 'staff' }), /already an account/);
    await store.create({ username: 'ben', password: 'another long one', role: 'staff' });

    assert.equal((await store.verify('ANA', ADMIN_PASSWORD)).username, 'ana');
    assert.equal(await store.verify('ana', 'wrong password!'), null);
    assert.equal(await store.verify('nobody', ADMIN_PASSWORD), null);

    await assert.rejects(store.remove('ana'), /only admin/);
    await assert.rejects(store.setRole('ana', 'staff'), /only admin/);
    await store.setRole('ben', 'admin');
    await store.setRole('ana', 'staff');
    await store.remove('ana');
    assert.deepEqual(store.list().map((a) => [a.username, a.role]), [['ben', 'admin']]);
    assert.equal('passwordHash' in store.list()[0], false);

    await store.queue;
    const text = await fs.readFile(file, 'utf8');
    assert.ok(!text.includes('another long one'), 'no password in the file');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const again = new AccountStore(file, { scryptParams: FAST });
    await again.load();
    assert.ok(await again.verify('ben', 'another long one'));
  });
});

describe('session store', () => {
  it('keeps only token hashes, slides while used and ends when idle or too old', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-sessions-'));
    const file = path.join(dir, 'sessions.json');
    let clock = NOW;
    const day = 86400000;
    const store = new SessionStore(file, { now: () => clock, idleMs: 7 * day, maxMs: 30 * day });
    const token = await store.create('ana');
    assert.match(token, /^[\w-]{43}$/, '256 random bits');
    await store.queue;
    assert.ok(!(await fs.readFile(file, 'utf8')).includes(token));
    assert.equal(store.lookup(token).username, 'ana');
    assert.equal(store.lookup(`${token}x`), null);

    for (let i = 0; i < 4; i++) {
      clock += 6 * day;
      assert.ok(store.lookup(token), `still signed in after ${(i + 1) * 6} days of use`);
    }
    clock += 6 * day + 1;
    assert.equal(store.lookup(token), null, '30 days after sign-in at most');

    const idle = await store.create('ana');
    clock += 7 * day + 1;
    assert.equal(store.lookup(idle), null, 'a week without use');

    const keep = await store.create('ana');
    const drop = await store.create('ana');
    const other = await store.create('ben');
    await store.revokeUser('ana', { exceptId: store.lookup(keep).id });
    assert.ok(store.lookup(keep));
    assert.equal(store.lookup(drop), null);
    assert.ok(store.lookup(other));
  });
});

describe('sign-in limits', () => {
  const fail = (limiter, who) => limiter.begin(who).finish(false);

  it('refuses a username from one address after 5 failures, and an address after 20, for 15 minutes', () => {
    let clock = NOW;
    const limiter = new LoginLimiter({ now: () => clock });
    const who = { user: 'ana', address: '10.0.0.1' };
    for (let i = 0; i < 4; i++) fail(limiter, who);
    assert.equal(limiter.retryAfter(who), 0);
    fail(limiter, who);
    assert.equal(limiter.retryAfter(who), 15 * 60);
    assert.equal(limiter.begin(who).wait, 15 * 60);
    clock += 15 * 60 * 1000;
    assert.equal(limiter.retryAfter(who), 0);

    for (let i = 0; i < 20; i++) fail(limiter, { user: `u${i}`, address: '10.0.0.2' });
    assert.ok(limiter.retryAfter({ user: 'someone-else', address: '10.0.0.2' }) > 0);
    assert.equal(limiter.retryAfter({ user: 'someone-else', address: '10.0.0.3' }), 0);
  });

  it("doesn't let strangers lock someone out, but bounds guessing spread over many addresses", () => {
    const limiter = new LoginLimiter({ now: () => NOW });
    for (let i = 0; i < 49; i++) fail(limiter, { user: 'ana', address: `10.1.0.${i}` });
    assert.equal(limiter.retryAfter({ user: 'ana', address: '192.168.1.5' }), 0, 'Ana can still sign in from her own address');
    fail(limiter, { user: 'ana', address: '10.1.1.1' });
    assert.ok(limiter.retryAfter({ user: 'ana', address: '10.2.0.1' }) > 0, '50 failures from anywhere stop all guessing');
  });

  it('counts attempts still being checked, so parallel guesses get no more tries', () => {
    const limiter = new LoginLimiter({ now: () => NOW });
    const who = { user: 'ana', address: '10.0.0.1' };
    const started = Array.from({ length: 20 }, () => limiter.begin(who));
    assert.equal(started.filter((a) => !a.wait).length, 5);
    assert.ok(started.slice(5).every((a) => a.wait > 0));
    // Ones turned away unchecked (busy) don't count as failures.
    started[0].finish(null);
    started[0].finish(false);
    assert.equal(limiter.begin(who).wait, 0, 'a slot is free again');
  });

  it('a correct sign-in clears that address\u2019s failures for the username', () => {
    const limiter = new LoginLimiter({ now: () => NOW });
    const who = { user: 'ana', address: '10.0.0.1' };
    for (let i = 0; i < 4; i++) fail(limiter, who);
    limiter.begin(who).finish(true);
    for (let i = 0; i < 4; i++) fail(limiter, who);
    assert.equal(limiter.retryAfter(who), 0);
  });
});

describe('hash gate', () => {
  it('hashes a few passwords at a time and turns the rest away once its queue is full', async () => {
    const gate = new HashGate({ concurrency: 2, queue: 3 });
    let running = 0;
    let most = 0;
    const releases = [];
    const job = () => gate.run(() => new Promise((resolve) => {
      running++;
      most = Math.max(most, running);
      releases.push(() => { running--; resolve('done'); });
    }));
    const jobs = Array.from({ length: 5 }, job);
    await assert.rejects(job(), (err) => err.code === 'busy');
    while (releases.length) {
      releases.shift()();
      await new Promise((r) => setImmediate(r));
    }
    assert.deepEqual(await Promise.all(jobs), Array(5).fill('done'));
    assert.equal(most, 2);
  });
});

describe('auth helpers', () => {
  it('only redirects to PrintBuster pages after sign-in', () => {
    assert.equal(safeNext('/usage.html?from=2026-10-01'), '/usage.html?from=2026-10-01');
    for (const bad of ['https://evil.test/', '//evil.test/usage.html', '/\\evil.test', 'javascript:alert(1)', '/api/config', null]) {
      assert.equal(safeNext(bad), '/', String(bad));
    }
  });

  it('redacts credentials, however they are escaped', () => {
    const text = JSON.stringify({ a: 'token tok"en-1234 here', b: 'https://x.test/?k=tok%22en-1234', c: 'pw' });
    const out = JSON.parse(redactSecrets(text, ['tok"en-1234', 'pw']));
    assert.deepEqual(out, { a: 'token [redacted] here', b: 'https://x.test/?k=[redacted]', c: 'pw' });
  });
});

describe('signing in', () => {
  it('locks live mode until an account exists', async () => {
    const api = await start();
    const session = await (await api.request('/api/session')).json();
    assert.deepEqual([session.user, session.open, session.setupNeeded], [null, false, true]);
    const data = await api.request('/api/compare?date=2026-10-27');
    assert.equal(data.status, 401);
    assert.equal((await data.json()).error.code, 'no_accounts');
    const page = await api.request('/usage.html?from=2026-10-01');
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login.html?next=%2Fusage.html%3Ffrom%3D2026-10-01');
    assert.equal((await api.request('/login.html')).status, 200);
    assert.equal((await api.request('/guest.html')).status, 200);
  });

  it('keeps demo mode open until an account exists', async () => {
    const api = await start({}, { demo: true });
    assert.equal((await api.request('/api/compare?date=2026-10-27')).status, 200);
    assert.equal((await (await api.request('/api/session')).json()).open, true);
  });

  it('creates the first admin from APP_PASSWORD, refusing a weak one', async () => {
    await assert.rejects(start({ APP_PASSWORD: 'p@ss' }), /at least 10 characters/);
    const api = await start({ APP_USERNAME: 'Shop-Admin', APP_PASSWORD: ADMIN_PASSWORD });
    assert.equal((await api.login('shop-admin', 'wrong password')).status, 401);
    assert.equal((await api.login('nobody', ADMIN_PASSWORD)).status, 401);

    const res = await api.login('SHOP-ADMIN', ADMIN_PASSWORD);
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /^pb_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800$/);
    const body = await res.json();
    assert.deepEqual(body.user, { username: 'shop-admin', role: 'admin' });
    assert.ok(!JSON.stringify(body).includes(setCookie.split(';')[0].split('=')[1]), 'the token is only in the cookie');

    const cookie = setCookie.split(';')[0];
    assert.equal((await api.request('/', { cookie })).status, 200);
    assert.equal((await api.request('/api/compare?date=2026-10-27', { cookie })).status, 200);
    const session = await (await api.request('/api/session', { cookie })).json();
    assert.deepEqual(session.user, { username: 'shop-admin', role: 'admin' });

    // Signing out ends the session on the server, not just in the browser.
    const out = await api.request('/api/logout', { cookie, body: {} });
    assert.match(out.headers.get('set-cookie'), /^pb_session=; .*Max-Age=0/);
    assert.equal((await api.request('/api/compare?date=2026-10-27', { cookie })).status, 401);
  });

  it('renews the cookie while the sign-in is in use', async () => {
    let clock = NOW;
    const app = await createApp(loadConfig({ DEMO_MODE: 'true', APP_PASSWORD: ADMIN_PASSWORD }, ['node', 'server.js']), {
      now: () => clock, scryptParams: FAST,
    });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/config`, { headers: { Cookie: cookie } })).headers.get('set-cookie'), null);
    clock += 3 * 86400000;
    const later = await fetch(`${base}/api/config`, { headers: { Cookie: cookie } });
    assert.equal(later.status, 200);
    assert.equal(later.headers.get('set-cookie'), `${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
  });

  it('marks the cookie Secure over HTTPS, trusting the proxy only when told to', async () => {
    const env = { APP_PASSWORD: ADMIN_PASSWORD };
    const https = { 'X-Forwarded-Proto': 'https' };
    const untrusted = await start(env);
    assert.doesNotMatch((await untrusted.login('admin', ADMIN_PASSWORD, https)).headers.get('set-cookie'), /Secure/);
    const trusted = await start({ ...env, TRUST_PROXY: 'loopback' });
    assert.match((await trusted.login('admin', ADMIN_PASSWORD, https)).headers.get('set-cookie'), /; Secure$/);
    const always = await start({ ...env, COOKIE_SECURE: 'true' });
    assert.match((await always.login('admin', ADMIN_PASSWORD)).headers.get('set-cookie'), /; Secure$/);
  });

  it('refuses sign-in after repeated failures, even with the right password', async () => {
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD });
    for (let i = 0; i < 5; i++) assert.equal((await api.login('admin', `wrong ${i}`)).status, 401);
    const limited = await api.login('admin', ADMIN_PASSWORD);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '900');
  });

  it('checks at most 5 parallel guesses from one address', async () => {
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => api.login('admin', `parallel ${i}`)));
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((st) => st === 401).length, 5);
    assert.equal(statuses.filter((st) => st === 429).length, 25);
  });

  it('turns sign-ins away as busy rather than stalling every page', async () => {
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD });
    const gate = api.app.locals.accounts.gate;
    gate.maxQueue = 0;
    gate.running = gate.concurrency;
    try {
      const res = await api.login('admin', ADMIN_PASSWORD);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('retry-after'), '5');
      assert.equal((await api.request('/api/session')).status, 200);
    } finally {
      gate.running = 0;
    }
    assert.equal((await api.login('admin', ADMIN_PASSWORD)).status, 200, 'a busy refusal is not a failed guess');
  });

  it('redirects an encoded page name to sign-in too', async () => {
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD });
    assert.equal((await api.request('/%61dmin.html')).status, 302);
  });

  it('only accepts JSON from this site', async () => {
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD });
    const form = await fetch(`${api.base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `username=admin&password=${ADMIN_PASSWORD}`,
    });
    assert.equal(form.status, 415);
    const cross = await api.login('admin', ADMIN_PASSWORD, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(cross.status, 403);
    assert.equal((await api.request('/api/login', { body: undefined, method: 'POST', headers: { 'Content-Type': 'application/json' } })).status, 400);
  });

  it('only sends you back to PrintBuster pages', async () => {
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD });
    const res = await api.request('/api/login', { body: { username: 'admin', password: ADMIN_PASSWORD, next: '//evil.test/' } });
    assert.equal((await res.json()).next, '/');
  });
});

describe('accounts and roles', () => {
  it('lets admins manage accounts and staff use the pages but not the admin tasks', async () => {
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD });
    const admin = await api.signIn('admin', ADMIN_PASSWORD);

    const created = await api.request('/api/accounts', { cookie: admin, body: { username: 'casey', password: 'staff password 1', role: 'staff' } });
    assert.equal(created.status, 201);
    const list = (await created.json()).accounts;
    assert.deepEqual(list.map((a) => [a.username, a.role]), [['admin', 'admin'], ['casey', 'staff']]);
    assert.ok(list.every((a) => !('passwordHash' in a)));
    assert.equal((await api.request('/api/accounts', { cookie: admin, body: { username: 'dee', password: 'short', role: 'staff' } })).status, 400);

    const staff = await api.signIn('casey', 'staff password 1');
    assert.equal((await api.request('/api/compare?date=2026-10-27', { cookie: staff })).status, 200);
    assert.equal((await api.request('/api/usage?from=2026-10-27&to=2026-10-27', { cookie: staff })).status, 200);
    assert.equal((await api.request('/api/usage/assign', { cookie: staff, body: { printId: 'bb-9', name: 'Jane Doe' } })).status, 200);
    for (const [p, body] of [
      ['/api/admin/status'], ['/api/accounts'], ['/api/admin/collect', {}], ['/api/usage/recalculate-total', {}],
      ['/api/bambu/restart', {}], ['/api/accounts', { username: 'evil', password: 'evil password', role: 'admin' }],
      ['/api/accounts/role', { username: 'casey', role: 'admin' }],
    ]) {
      const res = await api.request(p, { cookie: staff, body });
      assert.equal(res.status, 403, p);
    }

    // A role change applies at once.
    assert.equal((await api.request('/api/accounts/role', { cookie: admin, body: { username: 'casey', role: 'admin' } })).status, 200);
    assert.equal((await api.request('/api/admin/status', { cookie: staff })).status, 200);
    await api.request('/api/accounts/role', { cookie: admin, body: { username: 'casey', role: 'staff' } });

    // An admin resetting a password ends that person's sign-ins.
    assert.equal((await api.request('/api/accounts/password', { cookie: admin, body: { username: 'casey', password: 'new staff password' } })).status, 200);
    assert.equal((await api.request('/api/compare?date=2026-10-27', { cookie: staff })).status, 401);
    assert.equal((await api.login('casey', 'staff password 1')).status, 401);
    const again = await api.signIn('casey', 'new staff password');

    // Deleting an account ends its sign-ins; the last admin stays.
    assert.equal((await api.request('/api/accounts/delete', { cookie: admin, body: { username: 'casey' } })).status, 200);
    assert.equal((await api.request('/api/compare?date=2026-10-27', { cookie: again })).status, 401);
    const last = await api.request('/api/accounts/delete', { cookie: admin, body: { username: 'admin' } });
    assert.equal(last.status, 400);
    assert.equal((await last.json()).error.code, 'last_admin');
  });

  it('changes your own password, ending your other sign-ins', async () => {
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD });
    const here = await api.signIn('admin', ADMIN_PASSWORD);
    const elsewhere = await api.signIn('admin', ADMIN_PASSWORD);
    const wrong = await api.request('/api/account/password', { cookie: here, body: { currentPassword: 'not it at all', newPassword: 'a brand new password' } });
    assert.equal(wrong.status, 400);
    const weak = await api.request('/api/account/password', { cookie: here, body: { currentPassword: ADMIN_PASSWORD, newPassword: 'short' } });
    assert.equal(weak.status, 400);
    const ok = await api.request('/api/account/password', { cookie: here, body: { currentPassword: ADMIN_PASSWORD, newPassword: 'a brand new password' } });
    assert.equal(ok.status, 200);
    assert.equal((await api.request('/api/config', { cookie: here })).status, 200);
    assert.equal((await api.request('/api/config', { cookie: elsewhere })).status, 401);
    assert.equal((await api.login('admin', ADMIN_PASSWORD)).status, 401);
    assert.equal((await api.login('admin', 'a brand new password')).status, 200);
  });

  it('keeps accounts and sessions across restarts without saving passwords or tokens', async () => {
    const first = await start({ APP_PASSWORD: ADMIN_PASSWORD });
    const cookie = await first.signIn('admin', ADMIN_PASSWORD);
    await first.app.locals.accounts.queue;
    await first.app.locals.sessions.queue;
    const files = await Promise.all(['accounts.json', 'sessions.json'].map((f) => fs.readFile(path.join(first.dir, f), 'utf8')));
    for (const text of files) {
      assert.ok(!text.includes(ADMIN_PASSWORD));
      assert.ok(!text.includes(cookie.split('=')[1]));
    }
    const env = {
      ACCOUNTS_PATH: path.join(first.dir, 'accounts.json'), SESSIONS_PATH: path.join(first.dir, 'sessions.json'),
    };
    const second = await start(env);
    assert.equal((await second.request('/api/config', { cookie })).status, 200);
  });
});

describe('guest view', () => {
  const IDENTIFYING = ['Jane', 'Doe', 'Sam Lee', 'bracket', 'Mystery job', '01S00C123456789'];

  it('shows the waterfall to anyone, without names, titles or serial numbers', async () => {
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD });
    const res = await api.request('/api/guest/compare?date=2026-10-27');
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const word of IDENTIFYING) assert.ok(!text.includes(word), `guest view leaks "${word}"`);
    const data = JSON.parse(text);
    assert.equal(data.guest, true);
    assert.deepEqual(data.reservations.map((r) => [r.id, r.name, r.isEvent, r.model]), [['r1', 'Reserved', false, 'Ada'], ['r2', 'Event', true, 'Ada']]);
    assert.deepEqual(data.prints.map((p) => [p.id, p.title, p.plate, p.match, p.deviceName]), [
      ['p1', 'Print', '', 'reserved', 'Ada'], ['p2', 'Print', '', 'unreserved', 'Ada'],
    ]);
    assert.deepEqual(data.prints[0].matchedReservations.map((r) => [r.id, r.name]), [['r1', 'Reserved']]);
    // The estimate for the cancelled print is kept: 1 h of 4 h of 200 g.
    assert.equal(data.prints[1].cancelledUse.grams, 50);
    assert.equal(data.prints[0].weightGrams, 80);
    assert.ok(data.rows.every((r) => /^row\d+$/.test(r.key)));
    assert.deepEqual(Object.keys(data.rows.find((r) => r.label === 'Ada').devices[0]).sort(), ['mappedTo', 'name', 'online', 'printStatus', 'product']);

    const config = await (await api.request('/api/guest/config')).json();
    assert.deepEqual(Object.keys(config).sort(), ['demo', 'flagDurationHours', 'flagWeightGrams', 'graceMinutes', 'guest', 'timezone', 'today']);
    // The signed-in API stays closed.
    assert.equal((await api.request('/api/compare?date=2026-10-27')).status, 401);
    assert.equal((await api.request('/api/config')).status, 401);
  });

  it('gives guests only generic error messages', async () => {
    const up = upstream();
    up.hub.password = 'changed';
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD }, { up });
    const data = await (await api.request('/api/guest/compare?date=2026-10-27')).json();
    assert.deepEqual(data.sources.designhub, { ok: false, error: { code: 'unavailable', message: 'Reservations are unavailable right now.' } });
  });

  it('never makes the server ask Design Hub for a day that isn\u2019t saved', async () => {
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD });
    const agendaReads = () => api.up.calls.filter((c) => c.url.includes('/admin/agenda/')).length;
    const before = agendaReads();
    const data = await (await api.request('/api/guest/compare?date=2026-09-01')).json();
    assert.equal(agendaReads(), before);
    assert.equal(data.sources.designhub.ok, false);
    // A signed-in user's waterfall reads it.
    const cookie = await api.signIn('admin', ADMIN_PASSWORD);
    assert.equal((await (await api.request('/api/compare?date=2026-09-01', { cookie })).json()).sources.designhub.ok, true);
    assert.ok(agendaReads() > before);
  });

  it('can be turned off', async () => {
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD, GUEST_VIEW: 'false' });
    assert.equal((await api.request('/api/guest/compare')).status, 404);
    assert.equal((await api.request('/api/events')).status, 401);
    assert.equal((await (await api.request('/api/session')).json()).guestView, false);
  });
});

describe('credentials', () => {
  it('never sends a Design Hub or Bambu credential, password hash or session token to a browser', async () => {
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD });
    const cookie = await api.signIn('admin', ADMIN_PASSWORD);
    const token = cookie.split('=')[1];
    const hubSession = [...api.up.hub.validSessions][0];
    assert.ok(hubSession, 'signed in to Design Hub');
    const forbidden = [...Object.values(SECRETS), token, hubSession, 'scrypt$', 'passwordHash'];
    const paths = [
      '/api/session', '/api/config', '/api/compare?date=2026-10-27', '/api/usage?from=2026-10-20&to=2026-10-27',
      '/api/admin/status', '/api/admin/import', '/api/accounts', '/api/guest/config', '/api/guest/compare?date=2026-10-27',
    ];
    for (const p of paths) {
      const res = await api.request(p, { cookie });
      assert.equal(res.status, 200, p);
      const text = await res.text();
      for (const secret of forbidden) assert.ok(!text.includes(secret), `${p} contains ${secret}`);
    }
  });

  it('redacts a credential that an upstream error echoes back', async () => {
    const up = upstream();
    const echo = (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/user-service/my/tasks') {
        return Promise.resolve(Response.json({ message: `invalid token ${SECRETS.BAMBU_ACCESS_TOKEN}` }, { status: 500 }));
      }
      return up.fetch(input, init);
    };
    const api = await start({ APP_PASSWORD: ADMIN_PASSWORD }, { up: { ...up, fetch: echo } });
    const cookie = await api.signIn('admin', ADMIN_PASSWORD);
    const status = await (await api.request('/api/admin/status', { cookie })).json();
    assert.equal(status.collected.bambu.error.message, 'Bambu /v1/user-service/my/tasks returned HTTP 500: invalid token [redacted]');
  });
});
