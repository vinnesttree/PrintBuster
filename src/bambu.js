import fs from 'node:fs/promises';
import path from 'node:path';
import { SourceError } from './errors.js';

// Endpoints and headers follow the community-documented Bambu cloud API
// (OpenBambuAPI, ha-bambulab). China accounts use the .cn hosts.
const HOSTS = {
  global: { api: 'https://api.bambulab.com', web: 'https://bambulab.com' },
  china: { api: 'https://api.bambulab.cn', web: 'https://bambulab.cn' },
};

const CLIENT_HEADERS = {
  'User-Agent': 'bambu_network_agent/01.09.05.01',
  'X-BBL-Client-Name': 'OrcaSlicer',
  'X-BBL-Client-Type': 'slicer',
  'X-BBL-Client-Version': '01.09.05.51',
  'X-BBL-Language': 'en-US',
  'X-BBL-OS-Type': 'linux',
  'X-BBL-OS-Version': '6.2.0',
  'X-BBL-Agent-Version': '01.09.05.01',
  'X-BBL-Executable-info': '{}',
  'X-BBL-Agent-OS-Type': 'linux',
  Accept: 'application/json',
};

const CLOUDFLARE_HINT =
  'Bambu\'s Cloudflare protection blocked the request. Sign in at makerworld.com in a browser, copy the value of its "token" cookie into BAMBU_ACCESS_TOKEN, and restart (README: "Finding a Bambu access token").';

const FINISHED = new Set(['finish', 'finished', 'success', 'succeeded', 'completed', 'complete', 'done']);
const FAILED = new Set(['fail', 'failed', 'failure', 'cancel', 'canceled', 'cancelled', 'abort', 'aborted', 'stopped']);
const RUNNING = new Set(['running', 'printing', 'prepare', 'preparing', 'pause', 'paused', 'active']);

// Documented numeric codes: 2 = finished, 3 = failed or cancelled.
export function mapTaskStatus(raw) {
  if (raw === 2 || raw === '2') return 'finished';
  if (raw === 3 || raw === '3') return 'failed';
  const s = String(raw ?? '').toLowerCase();
  if (FINISHED.has(s)) return 'finished';
  if (FAILED.has(s)) return 'failed';
  if (RUNNING.has(s)) return 'running';
  return 'unknown';
}

const MIN_PRINT_MS = 60_000;

// `confirmed` is false for a saved task that the latest Bambu response did
// not include: if it was printing when last seen, its finish is unknown.
export function normalizeTask(task, deviceNames, nowMs, { confirmed = true } = {}) {
  const start = Date.parse(task.startTime);
  if (!Number.isFinite(start)) return null;
  let end = Date.parse(task.endTime);
  let status = mapTaskStatus(task.status);
  const estimateMs = Number(task.costTime) > 0 ? Number(task.costTime) * 1000 : 0;

  // While a job is printing the cloud reports an endTime equal to (or within a
  // minute of) its startTime; the slicer estimate gives the expected finish.
  let estimated = false;
  let finishUnknown = false;
  const open = !Number.isFinite(end) || end - start <= MIN_PRINT_MS;
  if (open && status !== 'finished' && status !== 'failed') {
    estimated = true;
    if (confirmed) {
      status = 'running';
      end = estimateMs ? start + estimateMs : Math.max(nowMs, start + MIN_PRINT_MS);
    } else {
      status = 'unknown';
      finishUnknown = true;
      end = start + (estimateMs || MIN_PRINT_MS);
    }
  }
  // Prints cancelled within a minute still need a non-empty interval.
  end = Math.max(end, start + MIN_PRINT_MS);

  return {
    id: `bb-${task.id}`,
    title: task.title || task.designTitle || 'Untitled print',
    plate: task.plateName || (task.plateIndex ? `Plate ${task.plateIndex}` : ''),
    deviceId: task.deviceId || '',
    deviceName: deviceNames.get(task.deviceId) || task.deviceName || task.deviceId || 'Unknown printer',
    deviceModel: task.deviceModel || '',
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    status,
    rawStatus: task.status ?? null,
    estimated,
    finishUnknown,
    overdue: status === 'running' && end < nowMs,
    estimateMinutes: estimateMs ? Math.round(estimateMs / 60000) : null,
    weightGrams: Number(task.weight) > 0 ? Math.round(Number(task.weight) * 10) / 10 : null,
  };
}

function messageFrom(json, text) {
  const m = json && (json.message || json.error || json.msg || json.detail);
  if (typeof m === 'string' && m && m.toLowerCase() !== 'success') return m;
  return (text || '').slice(0, 200);
}

export class BambuClient {
  constructor(cfg, { fetch = globalThis.fetch, now = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.fetch = fetch;
    this.now = now;
    this.hosts = HOSTS[cfg.region] || HOSTS.global;
    this.token = cfg.accessToken || null;
    this.tokenSource = cfg.accessToken ? 'env' : null;
    this.pending = null;
    this.loginPromise = null;
  }

  async init() {
    if (this.token) return;
    try {
      const saved = JSON.parse(await fs.readFile(this.cfg.tokenCachePath, 'utf8'));
      const sameAccount = !saved.email || !this.cfg.email || saved.email === this.cfg.email;
      const fresh = !saved.expiresAt || Date.parse(saved.expiresAt) > this.now();
      if (saved.accessToken && sameAccount && fresh) {
        this.token = saved.accessToken;
        this.tokenSource = 'cache';
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`Ignoring unreadable Bambu token cache: ${err.message}`);
    }
  }

  status() {
    return {
      configured: this.cfg.configured,
      authenticated: Boolean(this.token),
      pending: this.pending?.kind || null,
      email: this.cfg.email ? this.cfg.email.replace(/^(.).*(@.*)$/, '$1***$2') : null,
    };
  }

  async saveToken(token, expiresInSeconds) {
    this.token = token;
    this.tokenSource = 'cache';
    this.pending = null;
    const expiresAt = Number(expiresInSeconds) > 0
      ? new Date(this.now() + Number(expiresInSeconds) * 1000).toISOString()
      : null;
    try {
      await fs.mkdir(path.dirname(this.cfg.tokenCachePath), { recursive: true });
      await fs.writeFile(
        this.cfg.tokenCachePath,
        JSON.stringify({ email: this.cfg.email, accessToken: token, savedAt: new Date(this.now()).toISOString(), expiresAt }, null, 2),
        { mode: 0o600 },
      );
    } catch (err) {
      console.warn(`Could not save the Bambu token cache: ${err.message}`);
    }
  }

  async clearToken() {
    this.token = null;
    this.tokenSource = null;
    await fs.rm(this.cfg.tokenCachePath, { force: true }).catch(() => {});
  }

  async send(url, { method = 'GET', body, headers = {}, auth = false } = {}) {
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: {
          ...CLIENT_HEADERS,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(auth ? { Authorization: `Bearer ${this.token}` } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      throw new SourceError('Could not reach the Bambu cloud.', { code: 'bambu_unreachable', cause: err });
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if ((res.status === 403 || res.status === 429) && /cloudflare/i.test(text)) {
      throw new SourceError('The Bambu cloud blocked the request (Cloudflare).', {
        code: 'bambu_cloudflare', status: res.status, hint: CLOUDFLARE_HINT,
      });
    }
    return { res, json, text };
  }

  ensureToken() {
    if (this.token) return Promise.resolve();
    if (this.pending) return Promise.reject(this.pendingError());
    if (!this.cfg.email || !this.cfg.password) {
      return Promise.reject(new SourceError('No Bambu credentials are configured.', {
        code: 'bambu_not_configured', hint: 'Set BAMBU_EMAIL and BAMBU_PASSWORD (or BAMBU_ACCESS_TOKEN).',
      }));
    }
    this.loginPromise ??= this.login().finally(() => { this.loginPromise = null; });
    return this.loginPromise;
  }

  pendingError() {
    return this.pending.kind === 'tfa'
      ? new SourceError('Bambu needs the code from your two-factor authenticator app.', { code: 'bambu_tfa_required' })
      : new SourceError(`Bambu emailed a verification code to ${this.status().email}. Enter it to finish signing in.`, { code: 'bambu_code_required' });
  }

  async login() {
    const { res, json, text } = await this.send(`${this.hosts.api}/v1/user-service/user/login`, {
      method: 'POST',
      body: { account: this.cfg.email, password: this.cfg.password, apiError: '' },
    });
    if (json?.accessToken) {
      await this.saveToken(json.accessToken, json.expiresIn);
      return;
    }
    if (json?.loginType === 'verifyCode') {
      await this.sendEmailCode();
      this.pending = { kind: 'verifyCode' };
      throw this.pendingError();
    }
    if (json?.loginType === 'tfa' && json.tfaKey) {
      this.pending = { kind: 'tfa', tfaKey: json.tfaKey };
      throw this.pendingError();
    }
    throw new SourceError(`Bambu sign-in failed (HTTP ${res.status}): ${messageFrom(json, text) || 'no details'}`, {
      code: 'bambu_auth', status: res.status, hint: 'Check BAMBU_EMAIL and BAMBU_PASSWORD.',
    });
  }

  async sendEmailCode() {
    const { res, json, text } = await this.send(`${this.hosts.api}/v1/user-service/user/sendemail/code`, {
      method: 'POST',
      body: { email: this.cfg.email, type: 'codeLogin' },
    });
    if (!res.ok) {
      throw new SourceError(`Bambu could not send a verification email (HTTP ${res.status}): ${messageFrom(json, text)}`, {
        code: 'bambu_auth', status: res.status,
      });
    }
  }

  // Sign in again from the password step, which makes Bambu send a fresh
  // email code (or issue a new two-factor challenge).
  async restartSignIn() {
    this.pending = null;
    try {
      await this.ensureToken();
    } catch (err) {
      if (err.code !== 'bambu_code_required' && err.code !== 'bambu_tfa_required') throw err;
    }
  }

  async submitCode(code) {
    code = String(code || '').trim();
    if (!/^\d{4,8}$/.test(code)) {
      throw new SourceError('Enter the numeric code exactly as Bambu sent it.', { code: 'bambu_bad_code' });
    }
    if (!this.pending) {
      throw new SourceError('No Bambu verification is waiting.', { code: 'bambu_no_pending' });
    }
    if (this.pending.kind === 'verifyCode') {
      const { res, json, text } = await this.send(`${this.hosts.api}/v1/user-service/user/login`, {
        method: 'POST',
        body: { account: this.cfg.email, code },
      });
      if (!json?.accessToken) {
        throw new SourceError(`Bambu did not accept the code (HTTP ${res.status}): ${messageFrom(json, text) || 'no details'}`, {
          code: 'bambu_bad_code', status: res.status,
        });
      }
      await this.saveToken(json.accessToken, json.expiresIn);
      return;
    }

    // Two-factor sign-in goes through the website and returns the access
    // token as a "token" cookie.
    const csrf = await this.send(`${this.hosts.web}/api/csrf`);
    const csrfToken = csrf.res.headers.getSetCookie()
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('bbl_csrf_token='))
      ?.slice('bbl_csrf_token='.length);
    if (!csrfToken) {
      throw new SourceError('Bambu did not return a CSRF token for two-factor sign-in.', { code: 'bambu_auth' });
    }
    const { res, json, text } = await this.send(`${this.hosts.web}/api/sign-in/tfa`, {
      method: 'POST',
      headers: { 'x-bbl-csrf-token': csrfToken, Cookie: `bbl_csrf_token=${csrfToken}` },
      body: { tfaKey: this.pending.tfaKey, tfaCode: code },
    });
    const token = res.headers.getSetCookie()
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('token='))
      ?.slice('token='.length);
    if (!token) {
      throw new SourceError(`Bambu did not accept the two-factor code (HTTP ${res.status}): ${messageFrom(json, text) || 'no details'}`, {
        code: 'bambu_bad_code', status: res.status,
      });
    }
    await this.saveToken(token, null);
  }

  async apiGet(pathname, params = {}) {
    for (let attempt = 0; ; attempt++) {
      await this.ensureToken();
      const url = new URL(pathname, this.hosts.api);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      const { res, json, text } = await this.send(url, { auth: true });
      if (res.status === 401) {
        if (this.tokenSource === 'env') {
          throw new SourceError('Bambu rejected BAMBU_ACCESS_TOKEN.', {
            code: 'bambu_auth', status: 401, hint: 'The token has probably expired. Copy a new one (README: "Finding a Bambu access token"), or remove it and use BAMBU_EMAIL / BAMBU_PASSWORD.',
          });
        }
        await this.clearToken();
        if (attempt === 0) continue;
      }
      if (!res.ok || json === null) {
        throw new SourceError(`Bambu ${pathname} returned HTTP ${res.status}: ${messageFrom(json, text) || 'no details'}`, {
          code: 'bambu_api', status: res.status,
        });
      }
      return json;
    }
  }

  async getDevices() {
    const json = await this.apiGet('/v1/iot-service/api/user/bind');
    return Array.isArray(json.devices) ? json.devices : [];
  }

  // Tasks come back newest first. Page backwards until we pass `sinceMs`.
  async getTasks({ sinceMs }) {
    const { taskPageSize: limit, maxTaskPages } = this.cfg;
    const seen = new Set();
    const tasks = [];
    let after;
    let complete = false;
    for (let page = 0; page < maxTaskPages; page++) {
      const json = await this.apiGet('/v1/user-service/my/tasks', after ? { limit, after } : { limit });
      const hits = Array.isArray(json.hits) ? json.hits : Array.isArray(json.tasks) ? json.tasks : [];
      let fresh = 0;
      for (const t of hits) {
        if (seen.has(String(t.id))) continue;
        seen.add(String(t.id));
        tasks.push(t);
        fresh++;
      }
      // Trust `total` when present: the server may cap the page size below `limit`.
      const lastPage = Number.isFinite(json.total) ? seen.size >= json.total : hits.length < limit;
      const oldest = Math.min(...hits.map((t) => Date.parse(t.startTime)).filter(Number.isFinite));
      if (!fresh || lastPage || oldest < sinceMs) {
        complete = true;
        break;
      }
      after = hits[hits.length - 1].id;
    }
    return { tasks, complete };
  }
}
