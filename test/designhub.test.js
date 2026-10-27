import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { DesignHubClient, parseAgendaHtml } from '../src/designhub.js';
import { createMockUpstream } from './helpers/mock-upstream.js';

const ZONE = 'America/Chicago';
const fixture = fs.readFileSync(new URL('./fixtures/agenda.html', import.meta.url), 'utf8');

function agendaWith(rowsHtml, heading = 'October 27, 2026') {
  return `<h1 class="dcf-txt-h3">Today's Agenda <span class="dcf-subhead">${heading}</h1>
<h2 class="dcf-txt-h4" id="todays-reservations">Today's Reservations</h2>
<table class="dcf-w-100% dcf-table dcf-table-bordered" aria-describedby="todays-reservations">
<thead><tr><th>Name</th><th>Tool</th><th>Model</th><th>Time</th><th>Actions</th></tr></thead>
<tbody>${rowsHtml}</tbody></table>`;
}
const row = (name, model, time, id = 1) => `<tr><td>${name}</td><td>Bambu Lab P1S</td><td>${model}</td><td>${time}<br>60 minutes</td>
<td><form method="POST" action="/admin/agenda/reservations/${id}/remove/"></form></td></tr>`;

describe('parseAgendaHtml', () => {
  const parsed = parseAgendaHtml(fixture, { zone: ZONE, requestedDate: '2026-10-27' });

  it('reads every well-formed row of the reservations table', () => {
    assert.equal(parsed.date, '2026-10-27');
    assert.deepEqual(parsed.reservations.map((r) => r.id), ['dh-4101', 'dh-4102', 'dh-4103', 'dh-4104']);
    const [jane] = parsed.reservations;
    assert.deepEqual(jane, {
      id: 'dh-4101',
      name: 'Jane Doe',
      isEvent: false,
      expiredMember: false,
      tool: 'Bambu Lab X1 Carbon',
      model: 'Ada',
      start: '2026-10-27T14:00:00.000Z', // 9:00 am CDT
      end: '2026-10-27T16:30:00.000Z',
    });
  });

  it('flags expired members and events like the agenda does', () => {
    const byId = Object.fromEntries(parsed.reservations.map((r) => [r.id, r]));
    assert.equal(byId['dh-4102'].expiredMember, true);
    assert.equal(byId['dh-4102'].name, 'Sam Expired');
    assert.equal(byId['dh-4103'].isEvent, true);
    assert.equal(byId['dh-4103'].name, 'Event: Intro to 3D Printing');
  });

  it('handles reservations that run past midnight', () => {
    const late = parsed.reservations.find((r) => r.id === 'dh-4104');
    assert.equal(late.start, '2026-10-28T03:00:00.000Z');
    assert.equal(late.end, '2026-10-28T07:00:00.000Z');
  });

  it('reports rows it cannot read instead of dropping them silently', () => {
    assert.deepEqual(parsed.skipped, [{ name: 'Broken Row', time: 'TBD' }]);
  });

  it('does not mistake the events table for reservations on an empty day', () => {
    const empty = fixture.replace(/<table[^>]*aria-describedby="todays-reservations">[\s\S]*?<\/table>/,
      'No reservations today. Hopefully someone will still come in to use the space!<br>');
    const result = parseAgendaHtml(empty, { zone: ZONE, requestedDate: '2026-10-27' });
    assert.deepEqual(result.reservations, []);
    assert.deepEqual(result.skipped, []);
  });

  it('picks the right year for reservations that cross New Year', () => {
    const html = agendaWith(row('Night Owl', 'Ada', 'Dec 31 10:00 pm – Jan 1  2:00 am'), 'December 31, 2026');
    const [r] = parseAgendaHtml(html, { zone: ZONE, requestedDate: '2026-12-31' }).reservations;
    assert.equal(r.start, '2027-01-01T04:00:00.000Z');
    assert.equal(r.end, '2027-01-01T08:00:00.000Z');
  });

  it('converts wall-clock times across the fall-back DST change', () => {
    const html = agendaWith(row('DST', 'Ada', 'Nov 1 12:00 am – Nov 1  3:00 am'), 'November 01, 2026');
    const [r] = parseAgendaHtml(html, { zone: ZONE, requestedDate: '2026-11-01' }).reservations;
    assert.equal(r.start, '2026-11-01T05:00:00.000Z'); // CDT
    assert.equal(r.end, '2026-11-01T09:00:00.000Z'); // CST: four real hours
  });

  it('uses the page heading date, including zero-padded days', () => {
    const html = agendaWith(row('A', 'Ada', 'Oct 7  9:00 am – Oct 7 10:00 am'), 'October 07, 2026');
    const result = parseAgendaHtml(html, { zone: ZONE, requestedDate: '2026-01-01' });
    assert.equal(result.date, '2026-10-07');
    assert.equal(result.reservations[0].start, '2026-10-07T14:00:00.000Z');
  });

  it('rejects pages that are not the agenda', () => {
    assert.throws(
      () => parseAgendaHtml('<h1>Login</h1><form></form>', { zone: ZONE, requestedDate: '2026-10-27' }),
      { code: 'designhub_unexpected_page' },
    );
  });
});

describe('DesignHubClient', () => {
  const cfg = {
    baseUrl: 'https://hub.test',
    username: 'kiosk',
    password: 'secret',
    cookie: '',
    loginPath: '/login/',
    agendaPath: '/admin/agenda/',
    workshopCategory: '',
  };
  const reservations = [
    { name: 'Jane Doe', tool: 'Bambu Lab P1S', model: 'Faraday', start: '2026-10-27T09:00', end: '2026-10-27T10:00' },
    { name: 'Late Larry', tool: 'Bambu Lab P1S', model: 'Ohm', start: '2026-10-26T22:00', end: '2026-10-26T23:30' },
  ];

  it('logs in through the form and fetches the requested day and the day before', async () => {
    const up = createMockUpstream({ hub: { reservations } });
    const client = new DesignHubClient(cfg, { zone: ZONE, fetch: up.fetch });
    const result = await client.getReservations('2026-10-27');

    const login = up.calls[0];
    assert.equal(login.method, 'POST');
    assert.equal(login.url, 'https://hub.test/login/');
    assert.equal(login.headers.get('content-type'), 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(login.body)), { username: 'kiosk', password: 'secret', next_page: '' });
    assert.equal(login.headers.get('origin'), null, 'no Origin header, so Sinatra HttpOrigin protection passes');

    const agendaCalls = up.calls.slice(1);
    assert.deepEqual(agendaCalls.map((c) => new URL(c.url).search), ['?date=2026-10-26', '?date=2026-10-27']);
    assert.ok(agendaCalls.every((c) => c.headers.get('cookie') === 'rack.session=sess-1'));
    assert.deepEqual(result.reservations.map((r) => r.model).sort(), ['Faraday', 'Ohm']);
  });

  it('reports a rejected password', async () => {
    const up = createMockUpstream({ hub: { password: 'other' } });
    const client = new DesignHubClient(cfg, { zone: ZONE, fetch: up.fetch });
    await assert.rejects(client.getReservations('2026-10-27'), { code: 'designhub_auth' });
  });

  it('logs in again once when the session has expired', async () => {
    const up = createMockUpstream({ hub: { reservations } });
    const client = new DesignHubClient(cfg, { zone: ZONE, fetch: up.fetch });
    await client.getReservations('2026-10-27');
    up.hub.validSessions.clear();
    const result = await client.getReservations('2026-10-27');
    assert.equal(result.reservations.length, 2);
    assert.equal(up.calls.filter((c) => c.url.endsWith('/login/')).length, 2);
  });

  it('explains when the account is not an admin', async () => {
    const up = createMockUpstream({ hub: { isAdmin: false } });
    const client = new DesignHubClient(cfg, { zone: ZONE, fetch: up.fetch });
    await assert.rejects(client.getReservations('2026-10-27'), { code: 'designhub_forbidden', status: 404 });
  });

  it('can use a pasted session cookie instead of a password', async () => {
    const up = createMockUpstream({ hub: { reservations, validSessions: new Set(['pasted']) } });
    const client = new DesignHubClient({ ...cfg, username: '', password: '', cookie: 'rack.session=pasted' }, { zone: ZONE, fetch: up.fetch });
    const result = await client.getReservations('2026-10-27');
    assert.equal(result.reservations.length, 2);
    assert.ok(up.calls.every((c) => c.method === 'GET'));

    up.hub.validSessions.clear();
    await assert.rejects(client.getReservations('2026-10-28'), { code: 'designhub_auth' });
  });

  it('reports an unreachable server', async () => {
    const client = new DesignHubClient(cfg, { zone: ZONE, fetch: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(client.getReservations('2026-10-27'), { code: 'designhub_unreachable' });
  });
});
