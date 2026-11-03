// The guest view: the waterfall with nothing that identifies anyone.
// Reservation names, print titles and plate names are replaced, and every
// other field is copied only if it is listed here, so a field added to the
// comparison later stays out of the guest view until it is added below.
// Ids are replaced by ones that only mean something within one response,
// and source errors by generic messages (upstream errors can hold names
// and account details).

const GUEST_ERRORS = {
  designhub: 'Reservations are unavailable right now.',
  bambu: 'Bambu print data is unavailable right now.',
};

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

const ROW_KEYS = ['label', 'tools', 'isBambu', 'unmapped', 'reservationCount', 'printCount', 'flaggedCount', 'active'];
const DEVICE_KEYS = ['name', 'product', 'online', 'printStatus', 'mappedTo'];
const RESERVATION_KEYS = ['start', 'end', 'model', 'tool', 'isEvent', 'noPrint'];
const PRINT_KEYS = [
  'deviceName', 'deviceModel', 'start', 'end', 'status', 'rawStatus', 'estimated', 'finishUnknown', 'overdue',
  'estimateMinutes', 'estimateSeconds', 'ranSeconds', 'weightGrams', 'lengthMeters', 'filaments', 'match',
  'uncoveredMinutes', 'noReservationReason', 'insideShare', 'uncovered', 'unmappedPrinter', 'overWeight', 'overTime',
  'large', 'materialTypes', 'cancelledUse', 'multiColor', 'multiMaterial',
];
const SUMMARY_KEYS = [
  'reservations', 'prints', 'reserved', 'partial', 'unreserved', 'reservationsWithoutPrint',
  'overWeight', 'overTime', 'large', 'multiColor', 'multiMaterial',
];

export const guestName = (r) => (r.isEvent ? 'Event' : 'Reserved');
export const GUEST_PRINT_TITLE = 'Print';

// Gives each distinct original id the next short id.
function aliases(prefix) {
  const map = new Map();
  return (id) => {
    if (!map.has(id)) map.set(id, `${prefix}${map.size + 1}`);
    return map.get(id);
  };
}

function guestSource(source, name, extra) {
  if (!source?.ok) return { ok: false, error: { code: 'unavailable', message: GUEST_ERRORS[name] } };
  return { ok: true, ...extra(source) };
}

export function guestComparison(result) {
  const rowId = aliases('row');
  const resId = aliases('r');
  const printId = aliases('p');
  return {
    guest: true,
    demo: Boolean(result.demo),
    day: pick(result.day, ['date', 'start', 'end', 'timezone']),
    now: result.now,
    graceMinutes: result.graceMinutes,
    flagWeightGrams: result.flagWeightGrams,
    flagDurationHours: result.flagDurationHours,
    printsAvailable: Boolean(result.printsAvailable),
    printGaps: (result.printGaps || []).map((g) => pick(g, ['start', 'end'])),
    collector: result.collector ? pick(result.collector, ['lastRunAt', 'activeMinutes', 'idleMinutes', 'viewers']) : null,
    rows: result.rows.map((row) => ({
      key: rowId(row.key),
      ...pick(row, ROW_KEYS),
      devices: row.devices.map((d) => pick(d, DEVICE_KEYS)),
    })),
    reservations: result.reservations.map((r) => ({
      id: resId(r.id),
      rowKey: rowId(r.rowKey),
      name: guestName(r),
      ...pick(r, RESERVATION_KEYS),
    })),
    prints: result.prints.map((p) => ({
      id: printId(p.id),
      rowKey: rowId(p.rowKey),
      title: GUEST_PRINT_TITLE,
      plate: '',
      ...pick(p, PRINT_KEYS),
      matchedReservations: p.matchedReservations.map((r) => ({
        id: resId(r.id), name: guestName(r), start: r.start, end: r.end, isEvent: Boolean(r.isEvent),
      })),
    })),
    summary: pick(result.summary, SUMMARY_KEYS),
    sources: {
      designhub: guestSource(result.sources.designhub, 'designhub', (s) => ({
        skippedRows: [], savedAt: s.savedAt || null, ...(s.stale ? { stale: true, error: { code: 'stale', message: '' } } : {}),
      })),
      bambu: {
        ...guestSource(result.sources.bambu, 'bambu', (s) => ({ complete: Boolean(s.complete), deviceCount: s.deviceCount })),
        log: result.sources.bambu.log ? { since: result.sources.bambu.log.since } : null,
      },
    },
  };
}

// The settings the guest page needs: no source details.
export function guestConfig(config, today) {
  return {
    guest: true,
    demo: config.demo,
    timezone: config.timezone,
    today,
    graceMinutes: config.graceMinutes,
    flagWeightGrams: config.flagWeightGrams,
    flagDurationHours: config.flagDurationHours,
  };
}
