// Demo data for trying the app without credentials. Everything is produced in
// the upstream formats (agenda HTML, Bambu API JSON) and goes through the
// same parser and normalizer as live data. Tool types and names are made up.
import { DateTime } from 'luxon';
import { parseAgendaHtml } from './designhub.js';
import { shiftDate } from './time.js';

const DEVICES = [
  { dev_id: '00M09A350100001', name: 'Ada', dev_product_name: 'X1 Carbon', dev_model_name: 'BL-P001' },
  { dev_id: '00M09A350100002', name: 'Archimedes', dev_product_name: 'X1 Carbon', dev_model_name: 'BL-P001' },
  { dev_id: '01P00A350100003', name: 'Faraday', dev_product_name: 'P1S', dev_model_name: 'C12' },
  { dev_id: '01P00A350100004', name: 'Pearlman', dev_product_name: 'P1S', dev_model_name: 'C12' },
  { dev_id: '01P00A350100005', name: 'Bernouli', dev_product_name: 'P1S', dev_model_name: 'C12' },
  { dev_id: '03919A350100006', name: 'Clarke', dev_product_name: 'A1', dev_model_name: 'N2S' },
  { dev_id: '03919A350100007', name: 'Euler', dev_product_name: 'A1', dev_model_name: 'N2S' },
  { dev_id: '00M09A350100008', name: 'Johnson', dev_product_name: 'X1 Carbon', dev_model_name: 'BL-P001' },
  { dev_id: '01P00A350100009', name: 'Ohm', dev_product_name: 'P1S', dev_model_name: 'C12' },
  { dev_id: '01P00A350100010', name: 'Lab Spare P1S', dev_product_name: 'P1S', dev_model_name: 'C12' },
];

const TOOL_FOR = {
  'X1 Carbon': 'Bambu Lab X1 Carbon',
  P1S: 'Bambu Lab P1S',
  A1: 'Bambu Lab A1',
};
const FILAMENT_BY_PRODUCT = { 'X1 Carbon': 'PLA', P1S: 'PETG', A1: 'PLA' };
const FILAMENT_COLOR = { 'X1 Carbon': '1BA1E2FF', P1S: 'E8603CFF', A1: '22D47BFF' };

const OTHER_TOOLS = [
  { model: 'GoldenBee', tool: 'Formlabs Form 3+' },
  { model: 'TangibleRabbit', tool: 'Formlabs Form 3+' },
];

const FIRST = ['Jordan', 'Priya', 'Mateo', 'Hannah', 'Wei', 'Olivia', 'Marcus', 'Aisha', 'Ethan', 'Sofia', 'Noah', 'Grace', 'Liam', 'Zoe', 'Caleb', 'Maya'];
const LAST = ['Nguyen', 'Patel', 'Garcia', 'Schmidt', 'Chen', 'Johnson', 'Okafor', 'Larsen', 'Rivera', 'Kowalski', 'Haddad', 'Brooks'];
// A fixed roster, so the same members come back day after day.
const MEMBERS = FIRST.map((f, i) => `${f} ${LAST[(i * 5) % LAST.length]}`);
const TITLES = ['Drone arm bracket', 'Gear housing v3', 'Capstone enclosure', 'Phone stand', 'Bridge truss joint', 'Sensor mount', 'Robot chassis plate', 'Calibration cube', 'Wind tunnel airfoil', 'Prosthetic finger', 'Cable clips x12', 'Motor coupler'];

function rng(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

// Reservations and print jobs for one local day. Anomalies are fixed so every
// past day shows each case the app detects.
const round1 = (n) => Math.round(n * 10) / 10;

function daySchedule(date, zone) {
  const rand = rng(`printbuster-${date}`);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const at = (h, m = 0) => DateTime.fromISO(date, { zone }).set({ hour: h, minute: m });
  const reservations = [];
  const prints = [];
  const person = () => pick(MEMBERS);

  // Printers that host an anomaly below only take regular bookings until noon.
  const anomalyPrinters = new Set(['Faraday', 'Bernouli', 'Johnson']);
  for (const dev of DEVICES.slice(0, 9)) {
    const closing = at(anomalyPrinters.has(dev.name) ? 12 : 20);
    let cursor = at(8, Math.floor(rand() * 4) * 15);
    const slots = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < slots; i++) {
      const start = cursor.plus({ minutes: Math.floor(rand() * 8) * 15 });
      const end = start.plus({ minutes: 60 + Math.floor(rand() * 10) * 15 });
      if (end > closing) break;
      reservations.push({ name: person(), tool: TOOL_FOR[dev.dev_product_name], model: dev.name, start, end });
      if (rand() < 0.85) {
        const pStart = start.plus({ minutes: 4 + Math.floor(rand() * 15) });
        const pEnd = DateTime.min(end.minus({ minutes: Math.floor(rand() * 20) }), pStart.plus({ minutes: 40 + Math.floor(rand() * 200) }));
        prints.push({ dev, title: pick(TITLES), start: pStart, end: pEnd, failed: rand() < 0.08 });
      }
      cursor = end.plus({ minutes: 15 + Math.floor(rand() * 6) * 15 });
    }
  }
  for (const { model, tool } of OTHER_TOOLS) {
    const start = at(9 + Math.floor(rand() * 6));
    reservations.push({ name: person(), tool, model, start, end: start.plus({ hours: 2 + Math.floor(rand() * 4) }) });
  }

  const dev = Object.fromEntries(DEVICES.map((d) => [d.name, d]));
  // A print on a printer nobody reserved at that time.
  prints.push({ dev: dev.Faraday, title: 'Bracket batch', start: at(13, 10), end: at(15, 40) });
  // A print that started inside a reservation and ran well past it.
  const r = { name: person(), tool: TOOL_FOR.P1S, model: 'Bernouli', start: at(13, 0), end: at(14, 0) };
  reservations.push(r);
  prints.push({ dev: dev.Bernouli, title: 'Long infill test', start: r.start.plus({ minutes: 10 }), end: r.end.plus({ minutes: 95 }) });
  // Overnight print started without a reservation.
  prints.push({ dev: dev.Clarke, title: 'Overnight lattice', start: at(22, 15), end: at(22, 15).plus({ hours: 6, minutes: 20 }) });
  // A long, heavy print that trips both the weight and duration flags.
  prints.push({ dev: dev.Johnson, title: 'Full-bed marathon', start: at(18, 0), end: at(18, 0).plus({ hours: 14, minutes: 30 }) });
  // A two-colour PLA print (multi-colour, one material).
  prints.push({ dev: dev.Ada, title: 'Two-tone nameplate', start: at(13, 0), end: at(14, 30),
    filaments: [{ type: 'PLA', color: 'E8603CFF' }, { type: 'PLA', color: '1BA1E2FF' }] });
  // A PLA + PETG print (multi-material).
  prints.push({ dev: dev.Euler, title: 'Hinged box', start: at(14, 0), end: at(16, 0),
    filaments: [{ type: 'PLA', color: 'F2F2F2FF' }, { type: 'PETG', color: '22D47BFF' }] });
  // A reservation that never produced a cloud print job.
  reservations.push({ name: person(), tool: TOOL_FOR['X1 Carbon'], model: 'Johnson', start: at(14, 0), end: at(16, 0) });
  // A printer whose Bambu name matches no Design Hub model.
  prints.push({ dev: dev['Lab Spare P1S'], title: 'Spare printer job', start: at(11, 0), end: at(12, 30) });

  return { reservations, prints };
}

const fmtHub = (dt) => `${dt.toFormat('LLL')} ${dt.day} ${String(dt.toFormat('h')).padStart(2, ' ')}:${dt.toFormat('mm')} ${dt.hour < 12 ? 'am' : 'pm'}`;
// Stable numeric reservation id, like Studio Manager's database ids.
const reservationId = (r) => {
  let h = 0;
  for (const c of `${r.model}|${r.start.toMillis()}`) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return h % 1000000;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Mirrors views/admin/agenda.erb from Studio Manager.
export function renderAgendaHtml(date, reservations, zone) {
  const day = DateTime.fromISO(date, { zone });
  const rows = reservations.map((r) => `
        <tr>
            <td>
                ${r.name.startsWith('Event:') ? `<strong>Event:</strong> ${esc(r.name.slice(6).trim())}` : esc(r.name)}
            </td>
            <td>
                ${esc(r.tool)}
            </td>
            <td>
                ${esc(r.model)}
            </td>
            <td>
                ${fmtHub(r.start)}
                –
                ${fmtHub(r.end)}
                <br>
                ${Math.round(r.end.diff(r.start, 'minutes').minutes)} minutes
            </td>
            <td>
                <form class="dcf-form delete-form" method="POST" action="/admin/agenda/reservations/${reservationId(r)}/remove/">
                <button class="dcf-btn dcf-btn-primary" type="submit">Remove</button>
                </form>
            </td>
        </tr>`).join('');
  const table = reservations.length
    ? `<table class="dcf-w-100% dcf-table dcf-table-bordered" aria-describedby="todays-reservations">
    <thead><tr><th>Name</th><th>Tool</th><th>Model</th><th>Time</th><th>Actions</th></tr></thead>
    <tbody>${rows}
    </tbody>
</table>`
    : 'No reservations today. Hopefully someone will still come in to use the space!<br>';
  return `<!DOCTYPE html><html><body>
<h1 class="dcf-txt-h3">Today's Agenda <span class="dcf-subhead">${day.toFormat('MMMM dd, yyyy')}</h1>
<h2 class="dcf-txt-h4" id="todays-reservations">Today's Reservations</h2>
${table}
<h2 class="dcf-txt-h4 dcf-mt-4" id="todays-events">Today's Events</h4>
No events today. Perhaps you'd like to create one?<br>
</body></html>`;
}

export class DemoDesignHub {
  constructor({ zone, now = () => Date.now() }) {
    this.zone = zone;
    this.now = now;
  }

  // One agenda page, with the real agenda's overlapping-the-day semantics.
  async getDay(day) {
    const list = [...daySchedule(shiftDate(day, -1), this.zone).reservations, ...daySchedule(day, this.zone).reservations]
      .filter((r) => r.start < DateTime.fromISO(day, { zone: this.zone }).plus({ days: 1 })
        && r.end > DateTime.fromISO(day, { zone: this.zone }));
    return parseAgendaHtml(renderAgendaHtml(day, list, this.zone), { zone: this.zone, requestedDate: day }).reservations;
  }

  async getAgenda(day) {
    return { date: day, reservations: await this.getDay(day), skipped: [] };
  }

  async getReservations(isoDate) {
    const byId = new Map();
    for (const day of [shiftDate(isoDate, -1), isoDate]) {
      for (const res of await this.getDay(day)) byId.set(res.id, res);
    }
    return { reservations: [...byId.values()], skipped: [] };
  }
}

export class DemoBambu {
  constructor({ zone, now = () => Date.now() }) {
    this.zone = zone;
    this.now = now;
  }

  status() {
    return { configured: true, authenticated: true, pending: null, email: 'demo@example.com' };
  }

  async getDevices() {
    const now = this.now();
    const running = new Set((await this.tasksAround(DateTime.fromMillis(now, { zone: this.zone }).toISODate()))
      .filter((t) => t.endTime === t.startTime).map((t) => t.deviceId));
    return DEVICES.map((d, i) => ({
      ...d,
      online: i !== 6,
      print_status: running.has(d.dev_id) ? 'RUNNING' : 'SUCCESS',
      dev_access_code: '00000000',
    }));
  }

  async tasksAround(isoDate, daysBack = 2) {
    const now = this.now();
    const out = [];
    for (let back = daysBack; back >= 0; back--) {
      const day = shiftDate(isoDate, -back);
      for (const [index, p] of daySchedule(day, this.zone).prints.entries()) {
        const start = p.start.toMillis();
        if (start > now) continue;
        const end = p.end.toMillis();
        const running = end > now;
        // A failed or cancelled job stopped about a third of the way through
        // the time it was sliced for; Bambu keeps the full-job estimates.
        const plannedMs = p.failed ? (end - start) * 3 : end - start;
        const weight = Math.round((plannedMs / 60000) * 0.35 * 10) / 10;
        out.push({
          // Stable for a given print whatever range is asked for.
          id: Number(`${day.replaceAll('-', '')}${String(index).padStart(4, '0')}`),
          title: p.title,
          designTitle: '',
          plateIndex: 1,
          plateName: '',
          deviceId: p.dev.dev_id,
          deviceName: p.dev.name,
          deviceModel: p.dev.dev_product_name,
          startTime: new Date(start).toISOString(),
          // The cloud reports endTime == startTime while a job is printing.
          endTime: new Date(running ? start : end).toISOString(),
          // 2 = finished, 3 = failed; the running code is undocumented.
          status: running ? 1 : p.failed ? 3 : 2,
          costTime: Math.round(plannedMs / 1000),
          weight,
          length: Math.round((weight / 2.98) * 1000), // ~2.98 g/m for 1.75 mm filament
          amsDetailMapping: (p.filaments
            ? p.filaments.map((f, i) => ({ ams: i, filamentType: f.type, sourceColor: f.color, weight: round1(weight / p.filaments.length), nozzleId: 0 }))
            : [{ ams: 0, filamentType: FILAMENT_BY_PRODUCT[p.dev.dev_product_name] || 'PLA',
                 sourceColor: FILAMENT_COLOR[p.dev.dev_product_name] || '1BA1E2FF', weight, nozzleId: 0 }]),
        });
      }
    }
    return out;
  }

  async getTasks({ sinceMs, untilMs }) {
    const first = DateTime.fromMillis(sinceMs, { zone: this.zone }).startOf('day');
    const last = DateTime.fromMillis(untilMs, { zone: this.zone }).startOf('day');
    const days = Math.round(last.diff(first, 'days').days);
    const tasks = (await this.tasksAround(last.toISODate(), days))
      .filter((t) => Date.parse(t.startTime) >= sinceMs && Date.parse(t.startTime) < untilMs)
      .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
    return { tasks, complete: true };
  }
}
