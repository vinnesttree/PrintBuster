// A fake `fetch` that behaves like Studio Manager (designhub-manager) and the
// Bambu cloud API, so the clients can be tested without network access.
import { DateTime } from 'luxon';
import { renderAgendaHtml } from '../../src/demo.js';

const ZONE = 'America/Chicago';

function response(status, body = '', headers = {}) {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    for (const item of [].concat(v)) h.append(k, item);
  }
  return new Response(status === 204 || status === 304 ? null : body, { status, headers: h });
}

const json = (status, obj, headers = {}) => response(status, JSON.stringify(obj), { 'Content-Type': 'application/json', ...headers });

function cookies(init) {
  const raw = new Headers(init?.headers).get('cookie') || '';
  return Object.fromEntries(raw.split(';').map((c) => c.trim().split('=')).filter(([k]) => k));
}

export function createMockUpstream({
  hub = {},
  bambu = {},
} = {}) {
  const hubState = {
    username: 'kiosk',
    password: 'secret',
    isAdmin: true,
    // [{ model, tool, name, start: 'YYYY-MM-DDTHH:mm', end }] in Chicago time
    reservations: [],
    validSessions: new Set(),
    ...hub,
  };
  const bambuState = {
    email: 'shop@example.com',
    password: 'pw',
    mode: 'token', // 'token' | 'verifyCode' | 'tfa'
    code: '123456',
    tfaCode: '654321',
    validTokens: new Set(['env-token']),
    devices: [],
    tasks: [],
    maxPageSize: Infinity,
    ...bambu,
  };
  const calls = [];

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : init.body ? String(init.body) : '';
    calls.push({ method, url: url.href, headers: new Headers(init.headers), body });

    // ---------------- Design Hub (Studio Manager, Sinatra) ----------------
    if (url.hostname === 'hub.test') {
      if (method === 'POST' && url.pathname === '/login/') {
        const form = new URLSearchParams(body);
        if (form.get('username') === hubState.username && form.get('password') === hubState.password) {
          const sid = `sess-${hubState.validSessions.size + 1}`;
          hubState.validSessions.add(sid);
          return response(302, '', { Location: 'https://hub.test/home/', 'Set-Cookie': `rack.session=${sid}; domain=.hub.test; path=/; HttpOnly` });
        }
        return response(302, '', { Location: 'https://hub.test/login/', 'Set-Cookie': 'rack.session=flash-only; path=/; HttpOnly' });
      }
      if (method === 'GET' && url.pathname === '/admin/agenda/') {
        const sid = cookies(init)['rack.session'];
        if (!hubState.validSessions.has(sid) || !hubState.isAdmin) return response(404, '<h1>Not Found</h1>');
        const date = url.searchParams.get('date');
        const dayStart = DateTime.fromISO(date, { zone: ZONE });
        const list = hubState.reservations
          .map((r) => ({ ...r, start: DateTime.fromISO(r.start, { zone: ZONE }), end: DateTime.fromISO(r.end, { zone: ZONE }) }))
          .filter((r) => r.start < dayStart.plus({ days: 1 }) && r.end > dayStart);
        return response(200, renderAgendaHtml(date, list, ZONE), { 'Content-Type': 'text/html' });
      }
      return response(404, 'Not Found');
    }

    // ---------------- Bambu cloud ----------------
    if (url.hostname === 'api.bambulab.com') {
      const payload = body ? JSON.parse(body) : {};
      if (method === 'POST' && url.pathname === '/v1/user-service/user/login') {
        if ('code' in payload) {
          if (payload.account === bambuState.email && payload.code === bambuState.code) {
            bambuState.validTokens.add('code-token');
            return json(200, { accessToken: 'code-token', refreshToken: 'code-token', expiresIn: 7776000, loginType: '' });
          }
          return json(400, { code: 4, error: 'Incorrect verification code' });
        }
        if (payload.account !== bambuState.email || payload.password !== bambuState.password) {
          return json(400, { code: 1, error: 'Incorrect password' });
        }
        if (bambuState.mode === 'verifyCode') return json(200, { accessToken: '', loginType: 'verifyCode' });
        if (bambuState.mode === 'tfa') return json(200, { accessToken: '', loginType: 'tfa', tfaKey: 'tfa-key-1' });
        bambuState.validTokens.add('pw-token');
        return json(200, { accessToken: 'pw-token', refreshToken: 'pw-token', expiresIn: 7776000, loginType: '' });
      }
      if (method === 'POST' && url.pathname === '/v1/user-service/user/sendemail/code') {
        return json(200, {});
      }
      const auth = new Headers(init.headers).get('authorization') || '';
      if (!bambuState.validTokens.has(auth.replace(/^Bearer /, ''))) return json(401, { message: 'Unauthorized' });
      if (url.pathname === '/v1/iot-service/api/user/bind') {
        return json(200, { message: 'success', code: null, error: null, devices: bambuState.devices });
      }
      if (url.pathname === '/v1/user-service/my/tasks') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 20), bambuState.maxPageSize);
        const after = url.searchParams.get('after');
        const sorted = [...bambuState.tasks].sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
        const from = after ? sorted.findIndex((t) => String(t.id) === after) + 1 : 0;
        return json(200, { total: sorted.length, hits: sorted.slice(from, from + limit) });
      }
      return json(404, { message: 'not found' });
    }
    if (url.hostname === 'bambulab.com') {
      if (url.pathname === '/api/csrf') {
        return json(200, {}, { 'Set-Cookie': 'bbl_csrf_token=csrf-abc; Path=/; HttpOnly' });
      }
      if (method === 'POST' && url.pathname === '/api/sign-in/tfa') {
        const h = new Headers(init.headers);
        const payload = JSON.parse(body);
        if (h.get('x-bbl-csrf-token') !== 'csrf-abc' || cookies(init).bbl_csrf_token !== 'csrf-abc') {
          return json(403, { error: 'missing_cookie' });
        }
        if (payload.tfaKey === 'tfa-key-1' && payload.tfaCode === bambuState.tfaCode) {
          bambuState.validTokens.add('tfa-token');
          return json(200, {}, { 'Set-Cookie': ['token=tfa-token; Path=/; HttpOnly', 'refreshToken=tfa-token; Path=/'] });
        }
        return json(400, { error: 'Invalid code' });
      }
    }
    throw new TypeError(`fetch failed: no route for ${method} ${url.href}`);
  }

  return { fetch, calls, hub: hubState, bambu: bambuState };
}

// A Bambu task in API format, given Chicago local times.
export function task(id, deviceId, start, end, extra = {}) {
  const s = DateTime.fromISO(start, { zone: ZONE }).toUTC();
  const e = end ? DateTime.fromISO(end, { zone: ZONE }).toUTC() : s;
  return {
    id,
    title: `Job ${id}`,
    deviceId,
    startTime: s.toISO({ suppressMilliseconds: true }),
    endTime: e.toISO({ suppressMilliseconds: true }),
    status: 2,
    costTime: Math.round((e - s) / 1000) || 3600,
    ...extra,
  };
}
