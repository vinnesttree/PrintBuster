// How much of a print's estimated filament it actually used. Bambu's weight
// and length are the slicer's estimates for the whole job, so a cancelled or
// failed print (one status in Bambu's data) is prorated by how long it ran.
// Shared by the waterfall (compare.js) and the usage rules (usage.js).

const ms = (iso) => Date.parse(iso);
export const round1 = (n) => Math.round(n * 10) / 10;

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

// Per-filament grams scaled to what was used. Weight with no breakdown is
// listed as "Unknown".
export function usedMaterials(p, fraction) {
  const filaments = (p.filaments || []).filter((f) => f.grams != null);
  if (filaments.length) {
    return filaments.map((f) => ({ type: f.type || 'Unknown', color: f.color || null, grams: round1(f.grams * fraction) }));
  }
  return p.weightGrams != null ? [{ type: 'Unknown', color: null, grams: round1(p.weightGrams * fraction) }] : [];
}

// The waterfall's estimate of what a cancelled or failed print used, or null
// for any other print (whose slicer estimate is shown as is).
// `upperBound` is true when how long it ran is unknown (no end time or no
// time estimate): the amount is then the whole job's, the most it can have
// used, as the usage page charges it.
export function cancelledUse(p, nowMs) {
  if (p.status !== 'failed') return null;
  const { fraction, method } = usedFraction(p, nowMs);
  const scale = (v) => (v == null ? null : round1(v * fraction));
  return {
    method,
    fraction: Math.round(fraction * 1000) / 1000,
    upperBound: method !== 'cancelled',
    grams: scale(p.weightGrams),
    lengthMeters: scale(p.lengthMeters),
    filaments: (p.filaments || []).map((f) => ({ ...f, grams: scale(f.grams) })),
  };
}
