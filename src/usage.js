// Filament usage per reservation holder, built from a comparison that covers
// a whole date range (see CompareService#usage).
//
// Rules:
// - A print belongs to the period its start time falls in, so adjacent
//   ranges never count the same print twice.
// - It is charged to the reservation it overlaps most on the same printer.
// - It is not counted when more than half of its time is outside that
//   printer's reservations (with the grace period), the same "outside" the
//   waterfall shows in amber.
// - Bambu's weight is the slicer's estimate for the whole job. A cancelled or
//   failed print is charged in proportion to how long it ran against the
//   estimated print time; a print still running, for the time so far.

const ms = (iso) => Date.parse(iso);
const round1 = (n) => Math.round(n * 10) / 10;

export const MAX_OUTSIDE_SHARE = 0.5;

// The share of the estimated filament that was actually used, and why.
export function usedFraction(p, nowMs) {
  const estimateMs = p.estimateMinutes ? p.estimateMinutes * 60000 : 0;
  if (p.status === 'failed') {
    // Bambu reports failed and cancelled prints with the same status.
    if (!estimateMs) return { fraction: 1, method: 'cancelled-no-estimate' };
    return { fraction: Math.min(1, (ms(p.end) - ms(p.start)) / estimateMs), method: 'cancelled' };
  }
  if (p.status === 'running') {
    if (!estimateMs) return { fraction: 1, method: 'running-no-estimate' };
    return { fraction: Math.min(1, Math.max(0, nowMs - ms(p.start)) / estimateMs), method: 'running' };
  }
  if (p.finishUnknown) return { fraction: 1, method: 'finish-unknown' };
  return { fraction: 1, method: 'finished' };
}

const overlapMs = (aStart, aEnd, bStart, bEnd) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

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

export function attributeUsage({ comparison, rangeStart, rangeEnd, now, maxOutsideShare = MAX_OUTSIDE_SHARE }) {
  const rowLabel = new Map(comparison.rows.map((r) => [r.key, r.label]));
  const bambuRows = new Set(comparison.rows.filter((r) => r.isBambu).map((r) => r.key));
  const users = new Map();
  const userFor = (name, isEvent) => {
    if (!users.has(name)) {
      users.set(name, {
        name, isEvent: Boolean(isEvent), reservations: 0,
        prints: 0, grams: 0, excludedPrints: 0, excludedGrams: 0, materials: {}, list: [],
      });
    }
    return users.get(name);
  };

  // Everyone with a reservation on a Bambu printer in the range is listed,
  // even with nothing printed, so a search for them finds a row.
  for (const r of comparison.reservations) {
    if (!bambuRows.has(r.rowKey) || ms(r.start) < rangeStart || ms(r.start) >= rangeEnd) continue;
    userFor(r.name, r.isEvent).reservations++;
  }

  const unattributed = { prints: 0, grams: 0, list: [] };
  let weightMissing = 0;

  for (const p of comparison.prints) {
    const start = ms(p.start);
    const end = ms(p.end);
    if (start < rangeStart || start >= rangeEnd) continue;

    const { fraction, method } = usedFraction(p, now);
    const usedGrams = p.weightGrams != null ? round1(p.weightGrams * fraction) : null;
    if (usedGrams == null) weightMissing++;
    const durationMs = Math.max(end - start, 1);
    const outsideMs = (p.uncovered || []).reduce((sum, g) => sum + ms(g.end) - ms(g.start), 0);
    const outsideShare = Math.min(1, outsideMs / durationMs);

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
    };

    if (!p.matchedReservations.length) {
      unattributed.prints++;
      unattributed.grams = round1(unattributed.grams + (usedGrams || 0));
      unattributed.list.push(record);
      continue;
    }

    // Charge the reservation this print overlaps most.
    const holder = p.matchedReservations.reduce((best, r) => {
      const o = overlapMs(start, end, ms(r.start), ms(r.end));
      return !best || o > best.o ? { r, o } : best;
    }, null).r;
    record.reservation = { name: holder.name, start: holder.start, end: holder.end };

    const user = userFor(holder.name, holder.isEvent);
    if (outsideShare > maxOutsideShare) {
      record.excluded = true;
      user.excludedPrints++;
      user.excludedGrams = round1(user.excludedGrams + (usedGrams || 0));
    } else {
      user.prints++;
      user.grams = round1(user.grams + (usedGrams || 0));
      addMaterials(user.materials, record.materials);
    }
    user.list.push(record);
  }

  const list = [...users.values()];
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
      unattributedGrams: unattributed.grams,
      unattributedPrints: unattributed.prints,
      printsWithoutWeight: weightMissing,
    },
  };
}
