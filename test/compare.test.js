import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildComparison, resolveModel, uncoveredSegments } from '../src/compare.js';
import { dayBounds } from '../src/time.js';

const ZONE = 'America/Chicago';
const day = dayBounds('2026-10-27', ZONE); // 05:00Z to 05:00Z next day (CDT)
const NOW = Date.parse('2026-10-27T23:00:00Z'); // 6 pm CDT
// Chicago wall clock on Oct 26-28 2026 (CDT, UTC-5) to ISO UTC.
const t = (local) => new Date(Date.parse(`${local}:00-05:00`)).toISOString();

const res = (id, model, start, end, extra = {}) => ({ id, name: `Person ${id}`, tool: 'Bambu Lab P1S', model, start: t(start), end: t(end), isEvent: false, expiredMember: false, ...extra });
const print = (id, deviceId, start, end, extra = {}) => ({ id, title: `Print ${id}`, deviceId, deviceName: deviceId, start: t(start), end: t(end), status: 'finished', estimated: false, ...extra });
const devices = [
  { dev_id: 'D-ADA', name: 'Ada', dev_product_name: 'X1 Carbon' },
  { dev_id: 'D-OHM', name: 'P1S - Ohm', dev_product_name: 'P1S' },
  { dev_id: 'D-SPARE', name: 'Spare', dev_product_name: 'P1S' },
];

function compare(reservations, prints, extra = {}) {
  return buildComparison({
    day, now: NOW, reservations, prints, devices, printerOrder: ['Ada', 'Ohm', 'Hull'], graceMinutes: 15, ...extra,
  });
}
const byId = (result) => Object.fromEntries(result.prints.map((p) => [p.id, p]));

describe('resolveModel', () => {
  const known = ['Ada', 'Ohm', 'Archimedes'];
  it('prefers explicit PRINTER_MAP entries by serial or name', () => {
    const map = new Map([['d-1', 'Ohm'], ['shop printer', 'Archimedes']]);
    assert.equal(resolveModel({ id: 'D-1', name: 'x' }, known, map), 'Ohm');
    assert.equal(resolveModel({ id: 'D-2', name: 'Shop Printer' }, known, map), 'Archimedes');
  });
  it('matches identical names ignoring case and punctuation', () => {
    assert.equal(resolveModel({ id: 'x', name: 'ADA' }, known, new Map()), 'Ada');
  });
  it('matches a name that contains exactly one known model', () => {
    assert.equal(resolveModel({ id: 'x', name: 'X1C - Archimedes' }, known, new Map()), 'Archimedes');
    assert.equal(resolveModel({ id: 'x', name: 'Ada and Ohm' }, known, new Map()), null);
    assert.equal(resolveModel({ id: 'x', name: 'Adams' }, known, new Map()), null);
  });
});

describe('uncoveredSegments', () => {
  it('merges overlapping coverage and returns the gaps', () => {
    assert.deepEqual(uncoveredSegments(0, 100, [[10, 30], [20, 40], [60, 70]]), [[0, 10], [40, 60], [70, 100]]);
    assert.deepEqual(uncoveredSegments(0, 100, [[-5, 200]]), []);
  });
});

describe('buildComparison', () => {
  it('classifies prints against reservations on the same printer', () => {
    const result = compare(
      [
        res('r1', 'Ada', '2026-10-27T09:00', '2026-10-27T11:00'),
        res('r2', 'Ohm', '2026-10-27T13:00', '2026-10-27T14:00'),
        res('r3', 'Ohm', '2026-10-27T09:00', '2026-10-27T10:00'),
      ],
      [
        print('in', 'D-ADA', '2026-10-27T08:50', '2026-10-27T11:10'), // within 15 min grace both ends
        print('late', 'D-OHM', '2026-10-27T13:10', '2026-10-27T15:00'), // runs 45 min past grace
        print('none', 'D-ADA', '2026-10-27T13:00', '2026-10-27T14:00'), // nobody reserved Ada then
        print('other', 'D-OHM', '2026-10-27T11:00', '2026-10-27T12:00'), // Ohm free at 11
      ],
    );
    const p = byId(result);
    assert.equal(p.in.match, 'reserved');
    assert.equal(p.in.uncoveredMinutes, 0);
    assert.equal(p.late.match, 'partial');
    assert.equal(p.late.uncoveredMinutes, 45);
    assert.deepEqual(p.late.uncovered, [{ start: t('2026-10-27T14:15'), end: t('2026-10-27T15:00') }]);
    assert.deepEqual(p.late.matchedReservations.map((r) => r.id), ['r2']);
    assert.equal(p.none.match, 'unreserved');
    assert.equal(p.none.uncoveredMinutes, 60);
    assert.equal(p.other.match, 'unreserved');
    assert.deepEqual(result.summary, { reservations: 3, prints: 4, reserved: 1, partial: 1, unreserved: 2, reservationsWithoutPrint: 1, overWeight: 0, overTime: 0, large: 0 });
  });

  it('does not count a print that starts after a reservation ended as reserved', () => {
    const result = compare([res('r1', 'Ada', '2026-10-27T09:00', '2026-10-27T10:00')], [print('p', 'D-ADA', '2026-10-27T10:05', '2026-10-27T11:00')]);
    assert.equal(result.prints[0].match, 'unreserved');
  });

  it('treats back-to-back reservations as continuous coverage', () => {
    const result = compare(
      [res('a', 'Ada', '2026-10-27T09:00', '2026-10-27T10:00'), res('b', 'Ada', '2026-10-27T10:00', '2026-10-27T12:00')],
      [print('p', 'D-ADA', '2026-10-27T09:10', '2026-10-27T11:50')],
    );
    assert.equal(result.prints[0].match, 'reserved');
    assert.deepEqual(result.prints[0].matchedReservations.map((r) => r.id), ['a', 'b']);
  });

  it('matches overnight prints against the previous day\'s reservations', () => {
    const result = compare(
      [res('y', 'Ada', '2026-10-26T21:00', '2026-10-26T23:00')],
      [print('p', 'D-ADA', '2026-10-26T21:30', '2026-10-27T02:00')],
    );
    assert.equal(result.prints.length, 1);
    assert.equal(result.prints[0].match, 'partial');
    assert.equal(result.prints[0].uncoveredMinutes, 165); // 23:15 to 02:00
    assert.equal(result.reservations.length, 0, 'yesterday\'s reservation is not drawn on today');
  });

  it('flags every print on a Bambu printer it cannot map', () => {
    const result = compare([res('r', 'Spare', '2026-10-27T09:00', '2026-10-27T10:00')], [print('p', 'D-SPARE', '2026-10-27T12:00', '2026-10-27T13:00')]);
    // "Spare" is on the agenda, so it maps by name.
    assert.equal(result.rows.find((r) => r.key === 'spare').unmapped, false);

    const unmapped = compare([], [print('p', 'D-SPARE', '2026-10-27T12:00', '2026-10-27T13:00')]);
    const row = unmapped.rows.find((r) => r.key === 'bambu:D-SPARE');
    assert.equal(row.unmapped, true);
    assert.equal(unmapped.prints[0].match, 'unreserved');
    assert.equal(unmapped.prints[0].unmappedPrinter, true);
  });

  it('marks started reservations on Bambu printers that produced no print', () => {
    const result = compare(
      [
        res('past', 'Ada', '2026-10-27T09:00', '2026-10-27T10:00'),
        res('future', 'Ada', '2026-10-27T20:00', '2026-10-27T21:00'),
        res('resin', 'GoldenBee', '2026-10-27T09:00', '2026-10-27T10:00', { tool: 'Formlabs Form 3+' }),
      ],
      [],
    );
    const flags = Object.fromEntries(result.reservations.map((r) => [r.id, r.noPrint]));
    assert.deepEqual(flags, { past: true, future: false, resin: false });
  });

  it('does not claim missing prints when Bambu data is unavailable or incomplete', () => {
    const r = [res('past', 'Ada', '2026-10-27T09:00', '2026-10-27T10:00')];
    assert.equal(compare(r, null, { devices: null }).reservations[0].noPrint, false);
    assert.equal(compare(r, [], { printCoverage: [] }).reservations[0].noPrint, false);
  });

  it('only claims a missing print where Bambu was observed for the whole reservation', () => {
    const r = [res('am', 'Ada', '2026-10-27T09:00', '2026-10-27T10:00'), res('pm', 'Ada', '2026-10-27T13:00', '2026-10-27T14:00')];
    // Observed from 9:30 onwards: the 9:00 reservation is only partly covered.
    const flags = compare(r, [], { printCoverage: [[Date.parse(t('2026-10-27T09:30')), NOW]] }).reservations.map((x) => [x.id, x.noPrint]);
    assert.deepEqual(flags, [['am', false], ['pm', true]]);
  });

  it('marks prints as not compared when the agenda is unavailable', () => {
    const result = compare(null, [print('p', 'D-ADA', '2026-10-27T09:00', '2026-10-27T10:00')]);
    assert.equal(result.prints[0].match, 'unknown');
    assert.equal(result.summary.unreserved, 0);
  });

  it('orders rows by PRINTER_ORDER, then other agenda models, then unmapped printers', () => {
    const result = compare(
      [res('r', 'Zeta', '2026-10-27T09:00', '2026-10-27T10:00'), res('s', 'Ohm', '2026-10-27T09:00', '2026-10-27T10:00')],
      [print('p', 'D-SPARE', '2026-10-27T12:00', '2026-10-27T13:00')],
    );
    assert.deepEqual(result.rows.map((r) => r.label), ['Ada', 'Ohm', 'Hull', 'Zeta', 'Spare']);
    assert.deepEqual(result.rows.map((r) => r.active), [false, true, false, true, true]);
    assert.equal(result.rows.find((r) => r.label === 'Ohm').devices[0].name, 'P1S - Ohm');
  });

  it('leaves out prints that do not touch the selected day', () => {
    const result = compare([], [print('old', 'D-ADA', '2026-10-26T09:00', '2026-10-26T10:00')]);
    assert.equal(result.prints.length, 0);
  });

  it('flags prints over the weight and duration thresholds', () => {
    const prints = [
      print('heavy', 'D-ADA', '2026-10-27T09:00', '2026-10-27T10:00', { weightGrams: 250 }),
      print('long', 'D-ADA', '2026-10-27T00:00', '2026-10-27T18:00', { weightGrams: 50 }),
      print('both', 'D-OHM', '2026-10-27T00:00', '2026-10-27T20:00', { weightGrams: 900 }),
      print('small', 'D-OHM', '2026-10-27T09:00', '2026-10-27T10:00', { weightGrams: 50 }),
      print('noweight', 'D-OHM', '2026-10-27T11:00', '2026-10-27T12:00', { weightGrams: null }),
    ];
    const r = compare([], prints, { flagWeightGrams: 200, flagDurationHours: 12 });
    const by = Object.fromEntries(r.prints.map((p) => [p.id, p]));
    assert.deepEqual([by.heavy.overWeight, by.heavy.overTime, by.heavy.large], [true, false, true]);
    assert.deepEqual([by.long.overWeight, by.long.overTime, by.long.large], [false, true, true]);
    assert.deepEqual([by.both.overWeight, by.both.overTime, by.both.large], [true, true, true]);
    assert.deepEqual([by.small.overWeight, by.small.overTime, by.small.large], [false, false, false]);
    assert.equal(by.noweight.overWeight, false, 'no weight data cannot exceed the weight limit');
    assert.deepEqual([r.summary.overWeight, r.summary.overTime, r.summary.large], [2, 2, 3]);
    assert.equal(r.flagWeightGrams, 200);
    assert.equal(r.flagDurationHours, 12);
  });

  it('a threshold of 0 disables that flag', () => {
    const prints = [print('heavy', 'D-ADA', '2026-10-27T00:00', '2026-10-27T20:00', { weightGrams: 900 })];
    const r = compare([], prints, { flagWeightGrams: 0, flagDurationHours: 0 });
    assert.deepEqual([r.prints[0].overWeight, r.prints[0].overTime, r.prints[0].large], [false, false, false]);
    assert.equal(r.summary.large, 0);
  });
});
