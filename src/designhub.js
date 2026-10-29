import * as cheerio from 'cheerio';
import { DateTime } from 'luxon';
import { SourceError } from './errors.js';
import { HUB_TIME_RE, hubTimeToUtc, shiftDate } from './time.js';

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

// Find the "Today's Reservations" table the same way the design-hub-waterfall
// userscript does, without falling through to the "Today's Events" table
// (which is the first .dcf-table on days with no reservations).
function findReservationTable($) {
  let table = $('table[aria-describedby="todays-reservations"]').first();
  if (table.length) return table;
  table = $('#todays-reservations').next('table');
  if (table.length) return table;
  return $('table').filter((_, el) => {
    const heads = $(el).find('thead th').map((__, th) => collapse($(th).text()).toLowerCase()).get();
    return heads.includes('model') && heads.includes('time');
  }).first();
}

function columnIndexes($, table) {
  const idx = { name: 0, tool: 1, model: 2, time: 3 };
  table.find('thead th').each((i, th) => {
    const key = collapse($(th).text()).toLowerCase();
    if (key in idx) idx[key] = i;
  });
  return idx;
}

export function parseAgendaHtml(html, { zone, requestedDate }) {
  const $ = cheerio.load(html);
  const heading = $('h1').filter((_, el) => /agenda/i.test($(el).text())).first();
  if (!heading.length) {
    throw new SourceError('Design Hub returned a page that is not the admin agenda.', {
      code: 'designhub_unexpected_page',
      hint: 'The session may have expired or the account lacks the "See Agenda" permission.',
    });
  }

  // <h1>Today's Agenda <span class="dcf-subhead">October 27, 2026</h1>
  let pageDate = requestedDate;
  const m = collapse(heading.text()).match(/([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (m) {
    const parsed = DateTime.fromFormat(`${m[1]} ${m[2]} ${m[3]}`, 'LLLL d yyyy');
    if (parsed.isValid) pageDate = parsed.toISODate();
  }

  const reservations = [];
  const skipped = [];
  const table = findReservationTable($);
  if (table.length) {
    const col = columnIndexes($, table);
    table.find('tbody tr').each((_, tr) => {
      const cells = $(tr).children('td');
      if (cells.length < 4) return;
      const nameCell = cells.eq(col.name);
      const name = collapse(nameCell.text());
      const timeText = collapse(cells.eq(col.time).text());
      const times = [...timeText.matchAll(HUB_TIME_RE)];
      const start = times[0] && hubTimeToUtc(times[0], { pageDate, zone });
      const end = times[1] && hubTimeToUtc(times[1], { pageDate, zone });
      if (!start || !end || end <= start) {
        skipped.push({ name, time: timeText });
        return;
      }
      const action = $(tr).find('form[action*="/reservations/"]').attr('action') || '';
      const id = action.match(/\/reservations\/(\d+)\//)?.[1];
      const tool = collapse(cells.eq(col.tool).text());
      const model = collapse(cells.eq(col.model).text());
      reservations.push({
        id: id ? `dh-${id}` : `dh-${model}-${start}-${end}-${name}`,
        name,
        isEvent: /^event:/i.test(name),
        // The agenda highlights members whose access has expired in scarlet.
        expiredMember: nameCell.find('.unl-bg-scarlet').length > 0,
        tool,
        model,
        start,
        end,
      });
    });
  }
  return { date: pageDate, reservations, skipped };
}

const SESSION_COOKIE = 'rack.session';

// DESIGNHUB_COOKIE accepts what people copy out of a browser: the
// rack.session value alone, "rack.session=<value>", or a whole Cookie
// request header (with or without the "Cookie:" prefix).
export function parseCookieString(raw) {
  const text = raw.trim().replace(/^cookie:\s*/i, '');
  const jar = new Map();
  if (/(^|;\s*)rack\.session=/.test(text) || text.includes(';')) {
    for (const part of text.split(';')) {
      const idx = part.indexOf('=');
      const name = part.slice(0, idx).trim();
      // Like Rack, the first cookie with a given name wins.
      if (idx > 0 && !jar.has(name)) jar.set(name, part.slice(idx + 1).trim());
    }
  } else if (text) {
    jar.set(SESSION_COOKIE, text);
  }
  // Browser dev tools can show the value URL-decoded. The server URL-decodes
  // cookies (turning "+" into a space), so send it encoded.
  const value = jar.get(SESSION_COOKIE);
  if (value && !/%[0-9A-Fa-f]{2}/.test(value)) jar.set(SESSION_COOKIE, encodeURIComponent(value));
  return jar;
}

export class DesignHubClient {
  constructor(cfg, { zone, fetch = globalThis.fetch } = {}) {
    this.cfg = cfg;
    this.zone = zone;
    this.fetch = fetch;
    this.jar = cfg.cookie ? parseCookieString(cfg.cookie) : new Map();
    this.loggedIn = this.jar.size > 0;
    this.loginPromise = null;
  }

  get canLogin() {
    return Boolean(this.cfg.username && this.cfg.password);
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      const expired = attrs.some((a) => {
        const [k, v = ''] = a.split('=').map((s) => s.trim().toLowerCase());
        return (k === 'max-age' && Number(v) <= 0) || (k === 'expires' && Date.parse(v) < Date.now());
      });
      if (expired || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async request(path, init = {}) {
    const url = new URL(path, `${this.cfg.baseUrl}/`);
    let res;
    try {
      res = await this.fetch(url, {
        ...init,
        redirect: 'manual',
        headers: {
          'User-Agent': 'PrintBuster/1.0 (+print reservation checker)',
          Accept: 'text/html,application/xhtml+xml',
          ...(this.jar.size ? { Cookie: this.cookieHeader() } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      throw new SourceError(`Could not reach the Design Hub at ${this.cfg.baseUrl}.`, {
        code: 'designhub_unreachable',
        cause: err,
      });
    }
    this.storeCookies(res);
    return res;
  }

  login() {
    // Concurrent requests share one login.
    this.loginPromise ??= this.doLogin().finally(() => { this.loginPromise = null; });
    return this.loginPromise;
  }

  async doLogin() {
    if (!this.canLogin) {
      throw new SourceError('The Design Hub session cookie is no longer valid.', {
        code: 'designhub_auth',
        hint: 'Copy a fresh rack.session cookie into DESIGNHUB_COOKIE (README: "Finding the Design Hub session cookie"), or set DESIGNHUB_USERNAME and DESIGNHUB_PASSWORD.',
      });
    }
    this.jar.clear();
    // Studio Manager's login form: POST username/password/next_page, which
    // answers with a redirect to /home/ on success or back to /login/.
    const res = await this.request(this.cfg.loginPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: this.cfg.username,
        password: this.cfg.password,
        next_page: '',
      }).toString(),
    });
    await res.arrayBuffer().catch(() => {});
    const location = res.headers.get('location') || '';
    if (res.status >= 300 && res.status < 400) {
      if (/\/login\b/.test(new URL(location, `${this.cfg.baseUrl}/`).pathname)) {
        throw new SourceError('The Design Hub rejected the username or password.', {
          code: 'designhub_auth',
          hint: 'Check DESIGNHUB_USERNAME and DESIGNHUB_PASSWORD. SSO-only accounts cannot use the login form; use DESIGNHUB_COOKIE instead.',
        });
      }
      if (!this.jar.size) {
        throw new SourceError('The Design Hub login did not return a session cookie.', { code: 'designhub_auth' });
      }
      this.loggedIn = true;
      return;
    }
    throw new SourceError(`The Design Hub login returned HTTP ${res.status}.`, {
      code: 'designhub_auth',
      status: res.status,
      hint: 'Check DESIGNHUB_BASE_URL and DESIGNHUB_LOGIN_PATH.',
    });
  }

  async fetchAgendaHtml(isoDate) {
    const params = new URLSearchParams({ date: isoDate });
    if (this.cfg.workshopCategory) params.set('workshop_category', this.cfg.workshopCategory);
    const res = await this.request(`${this.cfg.agendaPath}?${params}`);
    const body = await res.text();
    // Studio Manager answers 404 for /admin/* when the session is not an admin,
    // and redirects when it has no session at all.
    if (res.status === 200 && /<h1[^>]*>[^<]*Agenda/i.test(body)) return { ok: true, body };
    return { ok: false, status: res.status };
  }

  async getAgenda(isoDate) {
    let justLoggedIn = false;
    if (!this.loggedIn) {
      await this.login();
      justLoggedIn = true;
    }
    let result = await this.fetchAgendaHtml(isoDate);
    if (!result.ok && !justLoggedIn) {
      this.loggedIn = false;
      await this.login();
      result = await this.fetchAgendaHtml(isoDate);
    }
    if (!result.ok) {
      throw new SourceError(`Logged in, but the agenda page returned HTTP ${result.status}.`, {
        code: 'designhub_forbidden',
        status: result.status,
        hint: 'The account must be a Studio Manager admin with the "See Agenda" permission.',
      });
    }
    return parseAgendaHtml(result.body, { zone: this.zone, requestedDate: isoDate });
  }

  // Fetch the requested day plus the day before, so prints that started
  // yesterday can be matched against yesterday's reservations.
  // One agenda page: the reservations that overlap that day.
  async getDay(isoDate) {
    return (await this.getAgenda(isoDate)).reservations;
  }

  async getReservations(isoDate) {
    const days = [shiftDate(isoDate, -1), isoDate];
    const byId = new Map();
    const skipped = [];
    for (const day of days) {
      const agenda = await this.getAgenda(day);
      for (const r of agenda.reservations) byId.set(r.id, r);
      if (day === isoDate) skipped.push(...agenda.skipped);
    }
    return { reservations: [...byId.values()], skipped };
  }
}
