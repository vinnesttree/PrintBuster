// Filament usage per reservation holder, built from a comparison that covers
// a whole date range (see CompareService#usage).
//
// Rules:
// - A print belongs to the period its start time falls in, so adjacent
//   ranges never count the same print twice.
// - A print the comparison found to have no reservation (it started outside
//   every reservation, or less than 10% of it was inside) is charged to
//   nobody.
// - It is charged to the reservation on its printer that it started in, if it
//   started in the first half of that reservation (midpoint included) or in
//   the grace period before it. Otherwise it is charged to the reservation on
//   its printer that the middle of the print falls in, else the one it
//   overlaps most.
// - It is not counted when more than half of its time is outside the
//   holder's own reservations on that printer (with the grace period before
//   and after each). This wins over the start rule: a print started in
//   someone's slot that mostly runs in the next person's isn't counted.
// - Bambu's weight is the slicer's estimate for the whole job. A cancelled or
//   failed print is charged in proportion to how long it ran against the
//   estimated print time; a print still running, for the time so far.
// - A print with no reservation that staff assigned to a member (see
//   assignments.js) is charged to that member and counted. A reservation
//   always wins over an assignment.

import { reservationIndex, reservationsNear, uncoveredSegments } from './compare.js';

const ms = (iso) => Date.parse(iso);
const round1 = (n) => Math.round(n * 10) / 10;

export const MAX_OUTSIDE_SHARE = 0.5;

// The share of the estimated filament that was actually used, and why. A
// cancelled or failed print is interpolated linearly: the share of its
// estimated print time that it ran.
export function usedFraction(p, nowMs) {
  const estimateMs = p.estimateSeconds ? p.estimateSeconds * 1000 : p.estimateMinutes ? p.estimateMinutes * 60000 : 0;
  if (p.status === 'failed') {
    // Bambu reports failed and cancelled prints with the same status.
    if (p.finishUnknown) return { fraction: 1, method: 'cancelled-end-unknown' };
    if (!estimateMs) return { fraction: 1, method: 'cancelled-no-estimate' };
    // The time it actually ran, not the one-minute minimum it is drawn with.
    const ranMs = p.ranSeconds != null ? p.ranSeconds * 1000 : ms(p.end) - ms(p.start);
    return { fraction: Math.min(1, Math.max(0, ranMs) / estimateMs), method: 'cancelled' };
  }
  if (p.status === 'running') {
    if (!estimateMs) return { fraction: 1, method: 'running-no-estimate' };
    return { fraction: Math.min(1, Math.max(0, nowMs - ms(p.start)) / estimateMs), method: 'running' };
  }
  if (p.finishUnknown) return { fraction: 1, method: 'finish-unknown' };
  return { fraction: 1, method: 'finished' };
}

const overlapMs = (aStart, aEnd, bStart, bEnd) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

// The reservation (among those on the print's printer) a print is charged to,
// or null when it started in none and overlaps none.
export function chooseReservation(p, candidates, graceMs) {
  const start = ms(p.start);
  const end = ms(p.end);
  const overlap = (r) => overlapMs(start, end, ms(r.start), ms(r.end));
  const startedIn = candidates.filter((r) => {
    const rStart = ms(r.start);
    return start >= rStart - graceMs && start <= rStart + (ms(r.end) - rStart) / 2;
  });
  if (!startedIn.length) {
    // Then the reservation the middle of the print falls in, then the one
    // it overlaps most.
    const mid = start + (end - start) / 2;
    const midIn = candidates.filter((r) => mid >= ms(r.start) && mid < ms(r.end));
    const pool = midIn.length ? midIn : candidates.filter((r) => overlap(r) > 0);
    return pool.reduce((best, r) => (!best || overlap(r) > overlap(best) ? r : best), null);
  }
  // A start inside a reservation beats one in the grace period before the
  // next; then the larger overlap wins.
  const rank = (r) => [start >= ms(r.start) ? 1 : 0, overlap(r)];
  return startedIn.reduce((best, r) => {
    if (!best) return r;
    const [a, b] = [rank(r), rank(best)];
    return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) ? r : best;
  }, null);
}

// Share of the print outside the holder's reservations on that printer, each
// widened by the grace period. Under a minute outside counts as none, as on
// the waterfall.
function outsideShareOf(p, holderReservations, graceMs) {
  const start = ms(p.start);
  const end = ms(p.end);
  const covered = holderReservations.map((r) => [ms(r.start) - graceMs, ms(r.end) + graceMs]);
  let outsideMs = uncoveredSegments(start, end, covered).reduce((sum, [s, e]) => sum + e - s, 0);
  if (outsideMs < 60000) outsideMs = 0;
  return Math.min(1, outsideMs / Math.max(end - start, 1));
}

function addMaterials(into, materials) {
  for (const m of materials) into[m.type] = round1((into[m.type] || 0) + m.grams);
}

// Per-filament grams scaled to what was used. Weight with no breakdown is
// listed as "Unknown".
function usedMaterials(p, fraction) {
  const filaments = (p.filaments || []).filter((f) => f.grams != null);
  if (filaments.length) {
    return filaments.map((f) => ({ type: f.type || 'Unknown', color: f.color || null, grams: round1(f.grams * fraction) }));
  }
  return p.weightGrams != null ? [{ type: 'Unknown', color: null, grams: round1(p.weightGrams * fraction) }] : [];
}

// `assignments` maps a print id to { name, at } for prints with no
// reservation that staff charged to a member.
export function attributeUsage({ comparison, rangeStart, rangeEnd, now, maxOutsideShare = MAX_OUTSIDE_SHARE, assignments = null }) {
  const rowLabel = new Map(comparison.rows.map((r) => [r.key, r.label]));
  const bambuRows = new Set(comparison.rows.filter((r) => r.isBambu).map((r) => r.key));
  const graceMs = (comparison.graceMinutes || 0) * 60000;
  const resIndex = reservationIndex(comparison.reservations, (r) => r.rowKey);

  const users = new Map();
  const userFor = (name, isEvent) => {
    if (!users.has(name)) {
      users.set(name, {
        name, isEvent: Boolean(isEvent), reservations: 0,
        prints: 0, grams: 0, excludedPrints: 0, excludedGrams: 0, assignedPrints: 0, assignedGrams: 0,
        materials: {}, list: [], bookings: new Map(),
      });
    }
    return users.get(name);
  };
  // Each reservation keeps its own tally, so several prints in one booking
  // are all tracked against it.
  const bookingFor = (user, r) => {
    if (!user.bookings.has(r.id)) {
      user.bookings.set(r.id, {
        id: r.id, start: r.start, end: r.end, printer: rowLabel.get(r.rowKey) || r.model || r.tool,
        prints: 0, grams: 0, excludedPrints: 0, excludedGrams: 0,
      });
    }
    return user.bookings.get(r.id);
  };

  // Everyone with a reservation on a Bambu printer in the range is listed,
  // even with nothing printed, so a search for them finds a row.
  for (const r of comparison.reservations) {
    if (!bambuRows.has(r.rowKey) || ms(r.start) < rangeStart || ms(r.start) >= rangeEnd) continue;
    const user = userFor(r.name, r.isEvent);
    user.reservations++;
    bookingFor(user, r);
  }

  const unattributed = { prints: 0, grams: 0, list: [] };
  let weightMissing = 0;

  for (const p of comparison.prints) {
    const start = ms(p.start);
    if (start < rangeStart || start >= rangeEnd) continue;

    const { fraction, method } = usedFraction(p, now);
    const usedGrams = p.weightGrams != null ? round1(p.weightGrams * fraction) : null;
    if (usedGrams == null) weightMissing++;
    // Reservations farther than the grace period from the print can't be
    // chosen or cover any of it.
    const candidates = reservationsNear(resIndex, p.rowKey, start, ms(p.end), graceMs + 60000);
    const holder = p.match === 'unreserved' ? null : chooseReservation(p, candidates, graceMs);
    const outsideShare = holder
      ? outsideShareOf(p, candidates.filter((r) => r.name === holder.name), graceMs)
      : 1;

    const record = {
      id: p.id,
      title: p.title,
      printer: rowLabel.get(p.rowKey) || p.deviceName,
      deviceName: p.deviceName,
      start: p.start,
      end: p.end,
      status: p.status,
      finishUnknown: Boolean(p.finishUnknown),
      method,
      fraction: Math.round(fraction * 1000) / 1000,
      estimateGrams: p.weightGrams,
      usedGrams,
      outsideShare: Math.round(outsideShare * 1000) / 1000,
      materials: usedMaterials(p, fraction),
      excluded: false,
      reservation: null,
      assignedTo: null,
      noReservationReason: p.noReservationReason || null,
    };

    const assigned = holder ? null : assignments?.get(p.id);
    if (assigned) {
      // Charged by hand: counted for the member, outside any booking.
      record.assignedTo = { name: assigned.name, at: assigned.at };
      const user = userFor(assigned.name, false);
      user.prints++;
      user.grams = round1(user.grams + (usedGrams || 0));
      user.assignedPrints++;
      user.assignedGrams = round1(user.assignedGrams + (usedGrams || 0));
      addMaterials(user.materials, record.materials);
      user.list.push(record);
      continue;
    }

    if (!holder) {
      unattributed.prints++;
      unattributed.grams = round1(unattributed.grams + (usedGrams || 0));
      unattributed.list.push(record);
      continue;
    }

    record.reservation = { id: holder.id, name: holder.name, start: holder.start, end: holder.end, isEvent: Boolean(holder.isEvent) };
    const user = userFor(holder.name, holder.isEvent);
    const booking = bookingFor(user, holder);
    if (outsideShare > maxOutsideShare) {
      record.excluded = true;
      for (const tally of [user, booking]) {
        tally.excludedPrints++;
        tally.excludedGrams = round1(tally.excludedGrams + (usedGrams || 0));
      }
    } else {
      for (const tally of [user, booking]) {
        tally.prints++;
        tally.grams = round1(tally.grams + (usedGrams || 0));
      }
      addMaterials(user.materials, record.materials);
    }
    user.list.push(record);
  }

  const list = [...users.values()].map((u) => ({
    ...u,
    bookings: [...u.bookings.values()].sort((a, b) => ms(a.start) - ms(b.start)),
  }));
  for (const u of list) u.list.sort((a, b) => ms(a.start) - ms(b.start));
  unattributed.list.sort((a, b) => ms(a.start) - ms(b.start));

  return {
    users: list,
    unattributed,
    totals: {
      users: list.filter((u) => !u.isEvent).length,
      countedGrams: round1(list.reduce((s, u) => s + u.grams, 0)),
      countedPrints: list.reduce((s, u) => s + u.prints, 0),
      excludedGrams: round1(list.reduce((s, u) => s + u.excludedGrams, 0)),
      excludedPrints: list.reduce((s, u) => s + u.excludedPrints, 0),
      assignedGrams: round1(list.reduce((s, u) => s + u.assignedGrams, 0)),
      assignedPrints: list.reduce((s, u) => s + u.assignedPrints, 0),
      unattributedGrams: unattributed.grams,
      unattributedPrints: unattributed.prints,
      printsWithoutWeight: weightMissing,
    },
  };
}
