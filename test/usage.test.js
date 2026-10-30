import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildComparison } from '../src/compare.js';
import { attributeUsage, usedFraction } from '../src/usage.js';

// Chicago wall clock on Oct 26-28 2026 (CDT, UTC-5) to ISO UTC.
const t = (local) => new Date(Date.parse(`${local}:00-05:00`)).toISOString();
const rangeStart = Date.parse('2026-10-27T00:00:00-05:00');
const rangeEnd = Date.parse('2026-10-28T00:00:00-05:00');
const NOW = Date.parse('2026-10-27T20:00:00-05:00');

const devices = [
  { dev_id: 'D-ADA', name: 'Ada' }, { dev_id: 'D-OHM', name: 'Ohm' }, { dev_id: 'D-ARC', name: 'Archimedes' },
  { dev_id: 'D-EUL', name: 'Euler' }, { dev_id: 'D-FAR', name: 'Faraday' },
];
const res = (id, name, model, start, end) => ({
  id, name, model, tool: 'Bambu Lab P1S', start: t(start), end: t(end), isEvent: /^event:/i.test(name), expiredMember: false,
});
const print = (id, deviceId, start, end, extra = {}) => ({
  id, title: `Print ${id}`, deviceId, deviceName: deviceId, start: t(start), end: t(end),
  status: 'finished', estimated: false, finishUnknown: false, estimateMinutes: null, weightGrams: 100, filaments: [], ...extra,
});

function usage(reservations, prints, { graceMinutes = 0, now = NOW, assignments = null } = {}) {
  const comparison = buildComparison({
    day: { date: '2026-10-27', start: new Date(rangeStart).toISOString(), end: new Date(rangeEnd).toISOString(), timezone: 'America/Chicago' },
    now, reservations, prints, devices, printerOrder: [], graceMinutes,
  });
  const out = attributeUsage({ comparison, rangeStart, rangeEnd, now, assignments });
  out.byName = Object.fromEntries(out.users.map((u) => [u.name, u]));
  return out;
}

describe('usedFraction', () => {
  it('charges a cancelled print for the share of its estimated time it ran', () => {
    const p = print('c', 'D-ADA', '2026-10-27T14:00', '2026-10-27T14:30', { status: 'failed', estimateMinutes: 120 });
    assert.deepEqual(usedFraction(p, NOW), { fraction: 0.25, method: 'cancelled' });
  });
  it('never charges a cancelled print more than its full estimate', () => {
    const p = print('c', 'D-ADA', '2026-10-27T14:00', '2026-10-27T18:00', { status: 'failed', estimateMinutes: 120 });
    assert.equal(usedFraction(p, NOW).fraction, 1);
  });
  it('charges the full estimate when there is no estimated time to compare against', () => {
    const p = print('c', 'D-ADA', '2026-10-27T14:00', '2026-10-27T14:30', { status: 'failed', estimateMinutes: null });
    assert.deepEqual(usedFraction(p, NOW), { fraction: 1, method: 'cancelled-no-estimate' });
  });
  it('interpolates from the exact estimate and the time it actually ran', () => {
    // A 90-second job cancelled after 30 seconds: drawn as a minute, and
    // its estimate shown as 2 minutes, but a third of it was used.
    const p = print('c', 'D-ADA', '2026-10-27T14:00', '2026-10-27T14:01', {
      status: 'failed', estimateMinutes: 2, estimateSeconds: 90, ranSeconds: 30,
    });
    assert.deepEqual(usedFraction(p, NOW), { fraction: 1 / 3, method: 'cancelled' });
  });
  it('charges the full estimate when a cancelled print has no recorded end', () => {
    const p = print('c', 'D-ADA', '2026-10-27T14:00', '2026-10-27T16:00', {
      status: 'failed', estimateMinutes: 120, estimateSeconds: 7200, ranSeconds: null, finishUnknown: true, estimated: true,
    });
    assert.deepEqual(usedFraction(p, NOW), { fraction: 1, method: 'cancelled-end-unknown' });
  });
  it('charges a running print for the time so far', () => {
    const p = print('r', 'D-ADA', '2026-10-27T19:00', '2026-10-27T21:00', { status: 'running', estimated: true, estimateMinutes: 120 });
    assert.deepEqual(usedFraction(p, NOW), { fraction: 0.5, method: 'running' });
  });
  it('charges the full estimate for finished prints and unknown finishes', () => {
    assert.equal(usedFraction(print('f', 'D-ADA', '2026-10-27T09:00', '2026-10-27T10:00'), NOW).method, 'finished');
    const u = print('u', 'D-ADA', '2026-10-27T09:00', '2026-10-27T10:00', { status: 'unknown', finishUnknown: true });
    assert.deepEqual(usedFraction(u, NOW), { fraction: 1, method: 'finish-unknown' });
  });
});

describe('attributeUsage', () => {
  it('charges a finished print inside a reservation to its holder, by material', () => {
    const out = usage(
      [res('r1', 'Jane Doe', 'Ada', '2026-10-27T09:00', '2026-10-27T11:00')],
      [print('p1', 'D-ADA', '2026-10-27T09:10', '2026-10-27T10:40', {
        filaments: [{ type: 'PLA', grams: 60, color: '#FFFFFF' }, { type: 'PETG', grams: 40, color: '#00FF00' }],
      })],
    );
    const jane = out.byName['Jane Doe'];
    assert.equal(jane.grams, 100);
    assert.equal(jane.prints, 1);
    assert.equal(jane.reservations, 1);
    assert.deepEqual(jane.materials, { PLA: 60, PETG: 40 });
    assert.equal(jane.list[0].method, 'finished');
  });

  it('prorates a cancelled print and its materials', () => {
    const out = usage(
      [res('r1', 'Cara', 'Faraday', '2026-10-27T14:00', '2026-10-27T16:00')],
      [print('p1', 'D-FAR', '2026-10-27T14:00', '2026-10-27T14:30', {
        status: 'failed', estimateMinutes: 120, weightGrams: 80, filaments: [{ type: 'PLA', grams: 80, color: null }],
      })],
    );
    const cara = out.byName.Cara;
    assert.equal(cara.grams, 20);
    assert.deepEqual(cara.materials, { PLA: 20 });
    assert.deepEqual([cara.list[0].estimateGrams, cara.list[0].usedGrams, cara.list[0].fraction], [80, 20, 0.25]);
  });

  it('does not count a print more than half outside the reservation', () => {
    const out = usage(
      [res('r1', 'Bob', 'Ada', '2026-10-27T13:00', '2026-10-27T14:00')],
      [print('p1', 'D-ADA', '2026-10-27T13:00', '2026-10-27T16:00', { weightGrams: 90 })],
    );
    const bob = out.byName.Bob;
    assert.deepEqual([bob.grams, bob.prints, bob.excludedPrints, bob.excludedGrams], [0, 0, 1, 90]);
    assert.equal(bob.list[0].excluded, true);
    assert.equal(bob.list[0].outsideShare, 0.667);
    assert.deepEqual([out.totals.excludedPrints, out.totals.excludedGrams], [1, 90]);
  });

  it('still counts a print exactly half outside', () => {
    const out = usage(
      [res('r1', 'Eve', 'Euler', '2026-10-27T10:00', '2026-10-27T11:00')],
      [print('p1', 'D-EUL', '2026-10-27T10:00', '2026-10-27T12:00', { weightGrams: 50 })],
    );
    assert.deepEqual([out.byName.Eve.grams, out.byName.Eve.list[0].outsideShare], [50, 0.5]);
  });

  it('counts the grace period as inside the reservation', () => {
    // 13:00-15:00 against a 13:00-14:00 booking: 60 min outside, but 15 of
    // them are grace, so 45/120 = 37.5% outside.
    const out = usage(
      [res('r1', 'Bob', 'Ada', '2026-10-27T13:00', '2026-10-27T14:00')],
      [print('p1', 'D-ADA', '2026-10-27T13:00', '2026-10-27T15:00')],
      { graceMinutes: 15 },
    );
    assert.equal(out.byName.Bob.grams, 100);
    assert.equal(out.byName.Bob.list[0].outsideShare, 0.375);
  });

  it('charges the reservation a print started in during its first half, over the one it overlaps most', () => {
    // Amy 8-10 (+15 min grace to 10:15). The print starts 8:55, before Amy's
    // 9:00 midpoint, and overlaps Ben more (70 min vs 65), but only
    // 55 of 135 min (41%) are outside Amy's booking, so it counts for Amy.
    const out = usage(
      [res('r1', 'Amy', 'Archimedes', '2026-10-27T08:00', '2026-10-27T10:00'),
        res('r2', 'Ben', 'Archimedes', '2026-10-27T10:00', '2026-10-27T14:00')],
      [print('p1', 'D-ARC', '2026-10-27T08:55', '2026-10-27T11:10')],
      { graceMinutes: 15 },
    );
    assert.deepEqual([out.byName.Amy.grams, out.byName.Ben.grams], [100, 0]);
    assert.equal(out.byName.Amy.list[0].reservation.id, 'r1');
    assert.equal(out.byName.Amy.list[0].outsideShare, 0.407);
  });

  it('counts the reservation midpoint as the first half', () => {
    const out = usage(
      [res('r1', 'Amy', 'Archimedes', '2026-10-27T08:00', '2026-10-27T10:00'),
        res('r2', 'Ben', 'Archimedes', '2026-10-27T10:00', '2026-10-27T14:00')],
      [print('p1', 'D-ARC', '2026-10-27T09:00', '2026-10-27T10:50')],
    );
    assert.equal(out.byName.Amy.list[0]?.id, 'p1');
    assert.equal(out.byName.Amy.list[0].excluded, false, '50 of 110 min outside');
  });

  it('lets the 50% rule win over the start rule', () => {
    // Started in Amy's first half but 80% of it ran in Ben's slot: Amy's
    // print, not counted, and not charged to Ben either.
    const out = usage(
      [res('r1', 'Amy', 'Archimedes', '2026-10-27T08:00', '2026-10-27T09:00'),
        res('r2', 'Ben', 'Archimedes', '2026-10-27T09:00', '2026-10-27T12:00')],
      [print('p1', 'D-ARC', '2026-10-27T08:30', '2026-10-27T11:00')],
    );
    const amy = out.byName.Amy;
    assert.deepEqual([amy.grams, amy.excludedPrints, amy.excludedGrams, amy.list[0].outsideShare], [0, 1, 100, 0.8]);
    assert.deepEqual([out.byName.Ben.grams, out.byName.Ben.list.length], [0, 0]);
    assert.equal(out.byName.Ben.reservations, 1, 'Ben is still listed');
  });

  it('charges a print started in the grace period before a reservation', () => {
    // A short print entirely in the 15 minutes before the booking overlaps
    // nothing, but started in its grace period.
    const out = usage(
      [res('r1', 'Dee', 'Ada', '2026-10-27T10:00', '2026-10-27T12:00')],
      [print('p1', 'D-ADA', '2026-10-27T09:47', '2026-10-27T09:58', { weightGrams: 7 }),
        print('p2', 'D-ADA', '2026-10-27T09:40', '2026-10-27T09:44', { weightGrams: 3 })],
      { graceMinutes: 15 },
    );
    assert.deepEqual([out.byName.Dee.prints, out.byName.Dee.grams, out.byName.Dee.list[0].outsideShare], [1, 7, 0]);
    assert.deepEqual(out.unattributed.list.map((p) => p.id), ['p2'], 'started before the grace period');
  });

  it("prefers the reservation a print started inside over the next one's grace period", () => {
    // 9:08 is in the first half of Amy's 9:00-9:20 slot and in the 15 minutes
    // before Ben's 9:20 slot.
    const out = usage(
      [res('r1', 'Amy', 'Archimedes', '2026-10-27T09:00', '2026-10-27T09:20'),
        res('r2', 'Ben', 'Archimedes', '2026-10-27T09:20', '2026-10-27T11:00')],
      [print('p1', 'D-ARC', '2026-10-27T09:08', '2026-10-27T09:18')],
      { graceMinutes: 15 },
    );
    assert.deepEqual([out.byName.Amy.grams, out.byName.Ben.grams], [100, 0]);
  });

  it('charges nobody for a print that started outside every reservation and ran into one', () => {
    // Middle at 9:50, before Ben's 10:00 booking.
    const out = usage(
      [res('r1', 'Ben', 'Archimedes', '2026-10-27T10:00', '2026-10-27T12:00')],
      [print('p1', 'D-ARC', '2026-10-27T09:00', '2026-10-27T10:40', { weightGrams: 60 })],
      { graceMinutes: 15 },
    );
    assert.deepEqual([out.byName.Ben.grams, out.byName.Ben.excludedPrints, out.byName.Ben.list.length], [0, 0, 0]);
    assert.deepEqual(out.unattributed.list.map((p) => [p.id, p.noReservationReason, p.usedGrams]), [['p1', 'started-outside', 60]]);
  });

  it('charges the reservation the middle of an early-started print falls in', () => {
    // Started an hour before Ben's booking, middle at 10:15; 45 of 150
    // minutes outside it with grace, so it counts.
    const out = usage(
      [res('r0', 'Amy', 'Archimedes', '2026-10-27T07:00', '2026-10-27T08:00'),
        res('r1', 'Ben', 'Archimedes', '2026-10-27T10:00', '2026-10-27T12:00')],
      [print('p1', 'D-ARC', '2026-10-27T09:00', '2026-10-27T11:30', { weightGrams: 60 })],
      { graceMinutes: 15 },
    );
    assert.deepEqual([out.byName.Ben.grams, out.byName.Ben.list[0].reservation.id, out.byName.Ben.list[0].outsideShare], [60, 'r1', 0.3]);
    assert.equal(out.unattributed.prints, 0);
  });

  it('charges nobody for a print with less than 10% inside a reservation', () => {
    const out = usage(
      [res('r1', 'Amy', 'Archimedes', '2026-10-27T08:00', '2026-10-27T09:00')],
      [print('p1', 'D-ARC', '2026-10-27T08:58', '2026-10-27T13:00')],
      { graceMinutes: 15 },
    );
    assert.deepEqual([out.byName.Amy.excludedPrints, out.unattributed.list[0]?.noReservationReason], [0, 'mostly-outside']);
  });

  it('falls back to the reservation overlapped most for a print started in the second half', () => {
    const out = usage(
      [res('r1', 'Amy', 'Archimedes', '2026-10-27T08:00', '2026-10-27T10:00'),
        res('r2', 'Ben', 'Archimedes', '2026-10-27T10:00', '2026-10-27T12:00')],
      [print('p1', 'D-ARC', '2026-10-27T09:30', '2026-10-27T11:30')],
    );
    assert.deepEqual([out.byName.Amy.grams, out.byName.Ben.grams], [0, 100]);
    assert.equal(out.byName.Ben.list[0].outsideShare, 0.25);
  });

  it('tracks every print in a reservation against that reservation', () => {
    const out = usage(
      [res('r1', 'Jane Doe', 'Ada', '2026-10-27T09:00', '2026-10-27T13:00'),
        res('r2', 'Jane Doe', 'Ohm', '2026-10-27T15:00', '2026-10-27T16:00'),
        res('r3', 'Jane Doe', 'Euler', '2026-10-27T17:00', '2026-10-27T18:00')],
      [print('p1', 'D-ADA', '2026-10-27T09:05', '2026-10-27T10:00', { weightGrams: 30 }),
        print('p2', 'D-ADA', '2026-10-27T10:10', '2026-10-27T11:00', { weightGrams: 40 }),
        // Cancelled 30 min into a 60 min job: 10 of 20 g.
        print('p3', 'D-ADA', '2026-10-27T11:30', '2026-10-27T12:00', { status: 'failed', estimateMinutes: 60, weightGrams: 20 }),
        // Starts in the second half and runs 75% past the booking.
        print('p4', 'D-ADA', '2026-10-27T12:30', '2026-10-27T14:30', { weightGrams: 50 }),
        print('p5', 'D-OHM', '2026-10-27T15:00', '2026-10-27T15:30', { weightGrams: 5 })],
    );
    const jane = out.byName['Jane Doe'];
    assert.deepEqual([jane.reservations, jane.prints, jane.grams, jane.excludedPrints], [3, 4, 85, 1]);
    assert.deepEqual(jane.bookings.map((b) => [b.id, b.printer, b.prints, b.grams, b.excludedPrints, b.excludedGrams]), [
      ['r1', 'Ada', 3, 80, 1, 50],
      ['r2', 'Ohm', 1, 5, 0, 0],
      ['r3', 'Euler', 0, 0, 0, 0],
    ]);
    assert.deepEqual(jane.list.map((p) => p.reservation.id), ['r1', 'r1', 'r1', 'r1', 'r2']);
  });

  it("measures time outside against the holder's own back-to-back reservations", () => {
    const out = usage(
      [res('r1', 'Jane Doe', 'Ada', '2026-10-27T09:00', '2026-10-27T10:00'),
        res('r2', 'Jane Doe', 'Ada', '2026-10-27T10:00', '2026-10-27T11:00')],
      [print('p1', 'D-ADA', '2026-10-27T09:20', '2026-10-27T11:00')],
    );
    const jane = out.byName['Jane Doe'];
    assert.deepEqual([jane.grams, jane.list[0].outsideShare, jane.list[0].reservation.id], [100, 0, 'r1']);
    assert.deepEqual(jane.bookings.map((b) => b.prints), [1, 0]);
  });

  it('charges a running print for the time so far, and tags event bookings', () => {
    const out = usage(
      [res('r1', 'Event: Intro to 3D Printing', 'Ohm', '2026-10-27T18:00', '2026-10-27T22:00')],
      [print('p1', 'D-OHM', '2026-10-27T19:00', '2026-10-27T21:00', { status: 'running', estimated: true, estimateMinutes: 120, weightGrams: 60 })],
    );
    const ev = out.byName['Event: Intro to 3D Printing'];
    assert.deepEqual([ev.isEvent, ev.grams, ev.list[0].method], [true, 30, 'running']);
    assert.equal(out.totals.users, 0, 'events are not counted as users');
  });

  it('keeps prints with no reservation separate', () => {
    const out = usage([], [print('p1', 'D-ADA', '2026-10-27T09:00', '2026-10-27T10:00', { weightGrams: 42 })]);
    assert.deepEqual([out.unattributed.prints, out.unattributed.grams], [1, 42]);
    assert.equal(out.users.length, 0);
  });

  it('counts a print in the period it started in', () => {
    const out = usage(
      [res('r0', 'Night Owl', 'Ada', '2026-10-26T22:00', '2026-10-27T02:00')],
      [print('p1', 'D-ADA', '2026-10-26T23:00', '2026-10-27T01:00')],
    );
    assert.equal(out.totals.countedPrints, 0);
    assert.equal(out.byName['Night Owl'], undefined, 'the booking started the day before too');
  });

  it('lists reservation holders on Bambu printers who printed nothing', () => {
    const out = usage([res('r1', 'Zed', 'Ada', '2026-10-27T18:00', '2026-10-27T19:00')], []);
    assert.deepEqual([out.byName.Zed.reservations, out.byName.Zed.grams, out.byName.Zed.prints], [1, 0, 0]);
  });

  it('notes prints that have no weight data', () => {
    const out = usage(
      [res('r1', 'Jane Doe', 'Ada', '2026-10-27T09:00', '2026-10-27T11:00')],
      [print('p1', 'D-ADA', '2026-10-27T09:10', '2026-10-27T10:00', { weightGrams: null })],
    );
    assert.deepEqual([out.byName['Jane Doe'].prints, out.byName['Jane Doe'].grams, out.totals.printsWithoutWeight], [1, 0, 1]);
  });
});

describe('assigned prints', () => {
  const AT = '2026-10-28T09:00:00.000Z';

  it('charges a print with no reservation to the member staff assigned it to', () => {
    const out = usage(
      [res('r1', 'Jane Doe', 'Ada', '2026-10-27T09:00', '2026-10-27T11:00')],
      [
        print('p1', 'D-ADA', '2026-10-27T09:10', '2026-10-27T10:40'),
        print('p2', 'D-ADA', '2026-10-27T15:00', '2026-10-27T16:00', { weightGrams: 40, filaments: [{ type: 'PETG', grams: 40, color: null }] }),
        print('p3', 'D-OHM', '2026-10-27T15:00', '2026-10-27T16:00', { weightGrams: 25 }),
      ],
      { assignments: new Map([['p2', { name: 'Jane Doe', at: AT }], ['p3', { name: 'Sam Lee', at: AT }]]) },
    );
    const jane = out.byName['Jane Doe'];
    assert.deepEqual([jane.prints, jane.grams, jane.assignedPrints, jane.assignedGrams, jane.reservations], [2, 140, 1, 40, 1]);
    assert.deepEqual(jane.materials, { Unknown: 100, PETG: 40 });
    const p2 = jane.list.find((p) => p.id === 'p2');
    assert.deepEqual([p2.reservation, p2.assignedTo, p2.excluded], [null, { name: 'Jane Doe', at: AT }, false]);
    // Someone with no reservation at all gets a row of their own.
    const sam = out.byName['Sam Lee'];
    assert.deepEqual([sam.prints, sam.grams, sam.reservations, sam.bookings.length, sam.isEvent], [1, 25, 0, 0, false]);
    assert.deepEqual([out.unattributed.prints, out.unattributed.list.length], [0, 0]);
    assert.deepEqual([out.totals.countedPrints, out.totals.countedGrams, out.totals.assignedPrints, out.totals.assignedGrams], [3, 165, 2, 65]);
  });

  it('prorates an assigned cancelled print like any other', () => {
    const out = usage([], [print('p1', 'D-ADA', '2026-10-27T14:00', '2026-10-27T14:30', { status: 'failed', estimateMinutes: 120, weightGrams: 80 })],
      { assignments: new Map([['p1', { name: 'Cara', at: AT }]]) });
    assert.deepEqual([out.byName.Cara.grams, out.byName.Cara.list[0].method], [20, 'cancelled']);
  });

  it('ignores an assignment once the print has a reservation', () => {
    const out = usage(
      [res('r1', 'Jane Doe', 'Ada', '2026-10-27T09:00', '2026-10-27T11:00')],
      [print('p1', 'D-ADA', '2026-10-27T09:10', '2026-10-27T10:40')],
      { assignments: new Map([['p1', { name: 'Sam Lee', at: AT }]]) },
    );
    assert.deepEqual(out.users.map((u) => [u.name, u.prints]), [['Jane Doe', 1]]);
    assert.equal(out.byName['Jane Doe'].list[0].assignedTo, null);
  });
});
