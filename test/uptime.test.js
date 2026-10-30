import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SourceError } from '../src/errors.js';
import { pushUrl, sourceHealth, staleAfterMs, UptimeKumaPusher } from '../src/uptime.js';

const AT = Date.parse('2026-10-27T23:00:00Z');
const collected = (designhub, bambu) => ({ at: AT, days: new Set(), designhub, bambu });
const down = (code, message = 'Broken.', hint = '') => ({ ok: false, error: new SourceError(message, { code, hint }) });

describe('source health', () => {
  it('is pending before the first collection', () => {
    assert.deepEqual(sourceHealth(null, 'bambu', { now: AT }),
      { source: 'bambu', name: 'Bambu cloud', ok: false, status: 'pending', checkedAt: null });
  });

  it('reports each source from the last collection, with only an error code when down', () => {
    const c = collected({ ok: true, durationMs: 840 }, down('bambu_code_required', 'Bambu emailed a code to s***@example.com.'));
    assert.deepEqual(sourceHealth(c, 'designhub', { now: AT }), {
      source: 'designhub', name: 'Design Hub (Studio Manager)', ok: true, status: 'up', checkedAt: '2026-10-27T23:00:00.000Z', responseMs: 840,
    });
    const bambu = sourceHealth(c, 'bambu', { now: AT });
    assert.equal(bambu.ok, false);
    assert.equal(bambu.status, 'down');
    assert.equal(bambu.code, 'bambu_code_required');
    assert.ok(!JSON.stringify(bambu).includes('example.com'), 'no messages on the unauthenticated endpoint');
  });

  it('is stale once collections stop, unless no schedule is set', () => {
    const c = collected({ ok: true }, { ok: true });
    const staleMs = staleAfterMs({ activeMs: 2 * 60000, idleMs: 15 * 60000 });
    assert.equal(staleMs, 35 * 60000);
    assert.equal(sourceHealth(c, 'designhub', { now: AT + staleMs, staleMs }).status, 'up');
    assert.equal(sourceHealth(c, 'designhub', { now: AT + staleMs + 1, staleMs }).status, 'stale');
    assert.equal(staleAfterMs({ activeMs: 0, idleMs: 0 }), 0);
    assert.equal(sourceHealth(c, 'designhub', { now: AT + 86400000, staleMs: 0 }).status, 'up');
  });
});

describe('Uptime Kuma push', () => {
  it('sets status, msg and ping on the URL copied from Kuma', () => {
    const base = 'https://kuma.test/api/push/abc123?status=up&msg=OK&ping=';
    assert.equal(pushUrl(base, { up: true, message: 'OK', ping: 812.4 }).href, 'https://kuma.test/api/push/abc123?status=up&msg=OK&ping=812');
    assert.equal(pushUrl(base, { up: false, message: 'Login failed.', ping: null }).href, 'https://kuma.test/api/push/abc123?status=down&msg=Login+failed.');
    assert.equal(pushUrl('http://kuma.test:3001/api/push/x', { up: true, message: 'OK' }).href, 'http://kuma.test:3001/api/push/x?status=up&msg=OK');
  });

  function fakeKuma(respond = () => Response.json({ ok: true })) {
    const calls = [];
    return {
      calls,
      fetch: async (url) => {
        calls.push(new URL(String(url)));
        return respond(url);
      },
    };
  }

  it('pushes each configured source after a collection, with the error message when down', async () => {
    const kuma = fakeKuma();
    const pusher = new UptimeKumaPusher({
      designhub: 'https://kuma.test/api/push/hub?status=up&msg=OK&ping=',
      bambu: 'https://kuma.test/api/push/bambu?status=up&msg=OK&ping=',
    }, { fetch: kuma.fetch });
    assert.equal(pusher.configured, true);
    await pusher.push(collected(down('designhub_auth', 'Design Hub rejected the login.', 'Check DESIGNHUB_PASSWORD.'), { ok: true, durationMs: 1200 }));
    const byPath = Object.fromEntries(kuma.calls.map((u) => [u.pathname, Object.fromEntries(u.searchParams)]));
    assert.deepEqual(byPath['/api/push/hub'], { status: 'down', msg: 'Design Hub rejected the login. Check DESIGNHUB_PASSWORD.' });
    assert.deepEqual(byPath['/api/push/bambu'], { status: 'up', msg: 'OK', ping: '1200' });
  });

  it('pushes only the sources that have a URL', async () => {
    const kuma = fakeKuma();
    const pusher = new UptimeKumaPusher({ designhub: '', bambu: 'https://kuma.test/api/push/bambu' }, { fetch: kuma.fetch, demo: true });
    await pusher.push(collected({ ok: true }, { ok: true, durationMs: 5 }));
    assert.deepEqual(kuma.calls.map((u) => [u.pathname, u.searchParams.get('msg')]), [['/api/push/bambu', 'OK (demo data)']]);
    assert.equal(new UptimeKumaPusher({ designhub: '', bambu: '' }).configured, false);
  });

  it('never throws when Kuma is unreachable or rejects the push, and logs each failure once', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const log = t.mock.method(console, 'log', () => {});
    let mode = 'offline';
    const kuma = fakeKuma(() => {
      if (mode === 'offline') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      if (mode === 'unknown') return Response.json({ ok: false, msg: 'Monitor not found or not active.' }, { status: 404 });
      return Response.json({ ok: true });
    });
    const pusher = new UptimeKumaPusher({ bambu: 'https://kuma.test/api/push/bambu' }, { fetch: kuma.fetch });
    const c = collected({ ok: true }, { ok: true });
    await pusher.push(c);
    await pusher.push(c);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /Bambu cloud failed: ECONNREFUSED/);
    mode = 'unknown';
    await pusher.push(c);
    assert.equal(warn.mock.callCount(), 2);
    assert.match(warn.mock.calls[1].arguments[0], /HTTP 404: Monitor not found/);
    mode = 'ok';
    await pusher.push(c);
    assert.equal(log.mock.callCount(), 1);
    assert.match(log.mock.calls[0].arguments[0], /resumed/);
  });
});
