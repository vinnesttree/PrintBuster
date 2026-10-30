import { describeError } from './errors.js';

// Uptime monitoring of the two upstream sources, for Uptime Kuma or any
// monitor that checks HTTP status codes. Each source is judged by the
// server's last collection: up when it read that source, down when it
// failed, pending before the first collection and stale when collections
// have stopped. Two ways to use it:
// - Pull: GET /healthz/designhub or /healthz/bambu answers 200 when the
//   source is up and 503 otherwise (an HTTP monitor in Uptime Kuma).
// - Push: after every collection, the server calls each configured Uptime
//   Kuma push URL with status=up or down (a Push monitor in Uptime Kuma).
//   Kuma also marks the monitor down when the pushes stop.

export const SOURCES = {
  designhub: 'Design Hub (Studio Manager)',
  bambu: 'Bambu cloud',
};

// Kuma shows the message in its notifications; keep it short.
const MAX_MESSAGE = 250;
const PUSH_TIMEOUT_MS = 10000;

// Collections count as stopped after two missed runs plus a margin. With
// both schedules off only Refresh collects, so age says nothing.
export function staleAfterMs({ activeMs, idleMs }) {
  const interval = Math.max(activeMs || 0, idleMs || 0);
  return interval ? 2 * interval + 5 * 60000 : 0;
}

// The state of one source, from the last collection. `collected` is
// CompareService#collected.
export function sourceHealth(collected, source, { now, staleMs = 0 }) {
  const base = { source, name: SOURCES[source] };
  if (!collected) return { ...base, ok: false, status: 'pending', checkedAt: null };
  const checkedAt = new Date(collected.at).toISOString();
  const found = collected[source];
  if (staleMs && now - collected.at > staleMs) {
    return { ...base, ok: false, status: 'stale', checkedAt };
  }
  if (!found?.ok) {
    return { ...base, ok: false, status: 'down', checkedAt, code: found?.error?.code || 'error' };
  }
  return { ...base, ok: true, status: 'up', checkedAt, responseMs: found.durationMs ?? null };
}

// The push message for a source: what went wrong, or that it was read.
function pushMessage(collected, source, demo) {
  const found = collected[source];
  if (found.ok) return demo ? 'OK (demo data)' : 'OK';
  const { message, hint } = describeError(found.error);
  const text = [message, hint].filter(Boolean).join(' ');
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

// The push URL with Kuma's status, msg and ping set. The URL copied from
// Kuma already has them as placeholders (?status=up&msg=OK&ping=).
export function pushUrl(base, { up, message, ping }) {
  const url = new URL(base);
  url.searchParams.set('status', up ? 'up' : 'down');
  url.searchParams.set('msg', message);
  if (ping != null) url.searchParams.set('ping', String(Math.round(ping)));
  else url.searchParams.delete('ping');
  return url;
}

export class UptimeKumaPusher {
  // `urls` maps a source ('designhub', 'bambu') to its Kuma push URL.
  constructor(urls, { fetch = globalThis.fetch, demo = false } = {}) {
    this.urls = Object.entries(urls || {}).filter(([source, url]) => SOURCES[source] && url);
    this.fetch = fetch;
    this.demo = demo;
    // The last push failure per source, so it is logged once, not every run.
    this.errors = new Map();
    // The pushes in flight, so shutdown and tests can wait for them.
    this.pending = Promise.resolve();
  }

  get configured() {
    return this.urls.length > 0;
  }

  // Pushes every configured source's state from the last collection. Never
  // throws: a monitor that can't be reached must not affect collection.
  push(collected) {
    if (!collected) return this.pending;
    this.pending = Promise.all(this.urls.map(async ([source, base]) => {
      const found = collected[source];
      const url = pushUrl(base, {
        up: Boolean(found?.ok),
        message: pushMessage(collected, source, this.demo),
        ping: found?.ok ? found.durationMs : null,
      });
      try {
        const res = await this.fetch(url, { signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
        // Kuma answers {"ok":false,"msg":"..."} for an unknown or paused monitor.
        const body = await res.json().catch(() => null);
        if (!res.ok || body?.ok === false) throw new Error(`HTTP ${res.status}${body?.msg ? `: ${body.msg}` : ''}`);
        if (this.errors.has(source)) console.log(`Uptime Kuma push for ${SOURCES[source]} resumed.`);
        this.errors.delete(source);
      } catch (err) {
        const message = err?.cause?.code || err?.message || String(err);
        if (this.errors.get(source) !== message) console.warn(`Uptime Kuma push for ${SOURCES[source]} failed: ${message}`);
        this.errors.set(source, message);
      }
    })).then(() => {});
    return this.pending;
  }
}
