export const normalizeName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const ms = (iso) => Date.parse(iso);
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;
const totalMs = (segments) => segments.reduce((sum, [s, e]) => sum + e - s, 0);

// Time outside reservations shorter than this is ignored.
const TOLERANCE_MS = 60000;
// A print with less than this share of its time inside reservations (grace
// included) has no reservation.
export const MIN_INSIDE_SHARE = 0.1;

// Resolve which Design Hub model (the agenda's "Model" column) a Bambu printer
// is: explicit PRINTER_MAP entry, then identical name, then a name containing
// exactly one known model as a word (e.g. "X1C - Ada" -> "Ada").
export function resolveModel(device, knownModels, printerMap) {
  const explicit = printerMap.get(String(device.id).toLowerCase()) || printerMap.get(String(device.name).toLowerCase());
  if (explicit) return explicit;
  const byNorm = new Map(knownModels.map((m) => [normalizeName(m), m]));
  const exact = byNorm.get(normalizeName(device.name));
  if (exact) return exact;
  const tokens = String(device.name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const hits = [...new Set(tokens.map((t) => byNorm.get(t)).filter(Boolean))];
  return hits.length === 1 ? hits[0] : null;
}

// The parts of [start, end) not covered by any of `intervals`.
export function uncoveredSegments(start, end, intervals) {
  const sorted = intervals
    .map(([s, e]) => [Math.max(s, start), Math.min(e, end)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = start;
  for (const [s, e] of sorted) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (end > cursor) gaps.push([cursor, end]);
  return gaps;
}

export function buildComparison({
  day,
  now,
  reservations,
  prints,
  devices,
  printerOrder = [],
  printerMap = new Map(),
  graceMinutes = 15,
  // A print is "large" above these; 0 disables that flag.
  flagWeightGrams = 0,
  flagDurationHours = 0,
  // Spans of time ([startMs, endMs]) in which Bambu's print list was observed.
  printCoverage = [[-Infinity, Infinity]],
}) {
  const weightLimit = flagWeightGrams > 0 ? flagWeightGrams : Infinity;
  const durationLimitMs = flagDurationHours > 0 ? flagDurationHours * 3600000 : Infinity;
  const dayStart = ms(day.start);
  const dayEnd = ms(day.end);
  const graceMs = graceMinutes * 60000;
  const hubAvailable = Array.isArray(reservations);
  const bambuAvailable = Array.isArray(prints);
  const allReservations = reservations || [];
  const allPrints = prints || [];

  // Every Bambu printer we know of: bound devices plus any seen only in history.
  const deviceById = new Map();
  for (const d of devices || []) {
    deviceById.set(d.dev_id, {
      id: d.dev_id,
      name: d.name || d.dev_id,
      product: d.dev_product_name || d.dev_model_name || '',
      online: typeof d.online === 'boolean' ? d.online : null,
      printStatus: d.print_status || null,
    });
  }
  for (const p of allPrints) {
    if (p.deviceId && !deviceById.has(p.deviceId)) {
      deviceById.set(p.deviceId, { id: p.deviceId, name: p.deviceName, product: p.deviceModel, online: null, printStatus: null });
    }
  }

  const knownModels = [...new Set([
    ...printerOrder,
    ...allReservations.map((r) => r.model).filter(Boolean),
    ...printerMap.values(),
  ])];

  const rows = new Map();
  const rowFor = (key, label) => {
    if (!rows.has(key)) {
      rows.set(key, { key, label, tools: new Set(), devices: [], unmapped: false, reservationCount: 0, printCount: 0, flagged: 0 });
    }
    return rows.get(key);
  };
  for (const m of printerOrder) rowFor(normalizeName(m), m);

  const deviceRow = new Map();
  for (const dev of deviceById.values()) {
    const model = resolveModel(dev, knownModels, printerMap);
    const row = model ? rowFor(normalizeName(model), model) : rowFor(`bambu:${dev.id}`, dev.name);
    if (!model) row.unmapped = true;
    row.devices.push({ ...dev, mappedTo: model });
    deviceRow.set(dev.id, row.key);
  }

  const resByRow = new Map();
  for (const r of allReservations) {
    const label = r.model || r.tool || 'Unknown tool';
    const row = rowFor(normalizeName(label), label);
    row.tools.add(r.tool);
    if (!resByRow.has(row.key)) resByRow.set(row.key, []);
    resByRow.get(row.key).push(r);
  }

  const outPrints = [];
  const printedReservations = new Set();
  for (const p of allPrints) {
    const pStart = ms(p.start);
    const pEnd = ms(p.end);
    const rowKey = deviceRow.get(p.deviceId) || rowFor(`bambu:${p.deviceId}`, p.deviceName).key;
    const row = rows.get(rowKey);
    const candidates = resByRow.get(rowKey) || [];
    // Reservations the print started in: from the grace period before one up
    // to its end. Starting after a reservation ended isn't starting in it.
    const startedIn = candidates.filter((r) => pStart >= ms(r.start) - graceMs - TOLERANCE_MS && pStart < ms(r.end));
    // A print that started before a reservation still belongs to it if the
    // middle of the print falls inside the reservation itself.
    const midMs = pStart + (pEnd - pStart) / 2;
    const midIn = candidates.filter((r) => midMs >= ms(r.start) && midMs < ms(r.end));
    const inReservation = startedIn.length > 0 || midIn.length > 0;
    const matched = candidates.filter((r) => overlaps(pStart, pEnd, ms(r.start), ms(r.end)) || startedIn.includes(r));
    matched.forEach((r) => printedReservations.add(r.id));

    // A print is "partial" (ran outside its reservation) only if it started
    // in one or its middle is in one. Otherwise it has none, even when its
    // end runs into someone's booking; so does one with less than
    // MIN_INSIDE_SHARE of its time inside reservations (grace included).
    let match;
    let gaps = [];
    let noReservationReason = null;
    let insideShare = null;
    if (!hubAvailable) {
      match = 'unknown';
    } else {
      const covered = candidates.map((r) => [ms(r.start) - graceMs, ms(r.end) + graceMs]);
      gaps = uncoveredSegments(pStart, pEnd, covered);
      if (totalMs(gaps) < TOLERANCE_MS) gaps = [];
      const durationMs = Math.max(pEnd - pStart, 1);
      insideShare = Math.max(0, durationMs - totalMs(gaps)) / durationMs;
      if (!inReservation || insideShare < MIN_INSIDE_SHARE) {
        match = 'unreserved';
        if (matched.length) noReservationReason = inReservation ? 'mostly-outside' : 'started-outside';
        gaps = [[pStart, pEnd]];
      } else {
        match = gaps.length ? 'partial' : 'reserved';
      }
    }
    const uncoveredMinutes = Math.round(totalMs(gaps) / 60000);

    if (!overlaps(pStart, pEnd, dayStart, dayEnd)) continue;
    row.printCount++;
    if (match === 'unreserved' || match === 'partial') row.flagged++;
    // Weight is a slice estimate; duration is actual for finished prints and
    // estimated for ones still running.
    // A cancelled or failed print's weight is the slicer's estimate for the
    // whole job, not what it used, so it isn't flagged as heavy.
    const overWeight = p.status !== 'failed' && p.weightGrams != null && p.weightGrams > weightLimit;
    const overTime = pEnd - pStart > durationLimitMs;
    const filaments = p.filaments || [];
    const materialTypes = [...new Set(filaments.map((f) => f.type).filter(Boolean))];
    const multiColor = filaments.length > 1;
    const multiMaterial = materialTypes.length > 1;
    outPrints.push({
      ...p,
      rowKey,
      match,
      uncoveredMinutes,
      // Why a print overlapping a reservation still has none, and the share
      // of it inside reservations (grace included).
      noReservationReason,
      insideShare: insideShare === null ? null : Math.round(insideShare * 1000) / 1000,
      uncovered: gaps.map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() })),
      unmappedPrinter: row.unmapped,
      overWeight,
      overTime,
      large: overWeight || overTime,
      materialTypes,
      multiColor,
      multiMaterial,
      matchedReservations: matched.map((r) => ({ id: r.id, name: r.name, start: r.start, end: r.end, isEvent: Boolean(r.isEvent) })),
    });
  }

  const outReservations = [];
  for (const [rowKey, list] of resByRow) {
    const row = rows.get(rowKey);
    for (const r of list) {
      if (!overlaps(ms(r.start), ms(r.end), dayStart, dayEnd)) continue;
      row.reservationCount++;
      // Only meaningful where the printer reports to Bambu cloud, the
      // reservation has started, and Bambu was observed for all of it so far.
      const noPrint = bambuAvailable && row.devices.length > 0
        && ms(r.start) < now && !printedReservations.has(r.id)
        && uncoveredSegments(ms(r.start), Math.min(ms(r.end), now), printCoverage).length === 0;
      outReservations.push({ ...r, rowKey, noPrint });
    }
  }

  const orderIndex = new Map(printerOrder.map((m, i) => [normalizeName(m), i]));
  const rank = (row) => (orderIndex.has(row.key) ? 0 : row.unmapped ? 2 : 1);
  const outRows = [...rows.values()]
    .map((row) => ({
      key: row.key,
      label: row.label,
      tools: [...row.tools].sort(),
      devices: row.devices,
      isBambu: row.devices.length > 0,
      unmapped: row.unmapped,
      reservationCount: row.reservationCount,
      printCount: row.printCount,
      flaggedCount: row.flagged,
      active: row.reservationCount + row.printCount > 0,
    }))
    .sort((a, b) => rank(a) - rank(b)
      || (orderIndex.get(a.key) ?? 0) - (orderIndex.get(b.key) ?? 0)
      || a.label.localeCompare(b.label));

  outPrints.sort((a, b) => ms(a.start) - ms(b.start));
  outReservations.sort((a, b) => ms(a.start) - ms(b.start));

  const count = (status) => outPrints.filter((p) => p.match === status).length;
  return {
    day,
    now: new Date(now).toISOString(),
    graceMinutes,
    flagWeightGrams,
    flagDurationHours,
    rows: outRows,
    reservations: outReservations,
    prints: outPrints,
    summary: {
      reservations: outReservations.length,
      prints: outPrints.length,
      reserved: count('reserved'),
      partial: count('partial'),
      unreserved: count('unreserved'),
      reservationsWithoutPrint: outReservations.filter((r) => r.noPrint).length,
      overWeight: outPrints.filter((p) => p.overWeight).length,
      overTime: outPrints.filter((p) => p.overTime).length,
      large: outPrints.filter((p) => p.large).length,
      multiColor: outPrints.filter((p) => p.multiColor).length,
      multiMaterial: outPrints.filter((p) => p.multiMaterial).length,
    },
  };
}
