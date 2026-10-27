'use strict';

const LANE_H = 44;      // px per lane in a printer row
const RES_TOP = 4;      // reservation band offset inside a lane
const RES_H = 34;
const PRINT_TOP = 24;   // print bar sits in the lower part of the band
const AUTO_REFRESH_MS = 2 * 60 * 1000;

const $ = (sel) => document.querySelector(sel);
const state = { config: null, data: null, date: null, loading: false, timer: null };

// ---------------------------------------------------------------- helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const ms = (iso) => Date.parse(iso);
let fmtCache = {};
function formatter(key, opts) {
  fmtCache[key] ??= new Intl.DateTimeFormat('en-US', { timeZone: state.config.timezone, ...opts });
  return fmtCache[key];
}
const localDate = (t) => formatter('isoDate', { year: 'numeric', month: '2-digit', day: '2-digit' })
  .formatToParts(new Date(t)).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
const isoDateOf = (t) => { const p = localDate(t); return `${p.year}-${p.month}-${p.day}`; };
const fmtClock = (t) => formatter('clock', { hour: 'numeric', minute: '2-digit' }).format(new Date(t));
const fmtDayShort = (t) => formatter('dayShort', { month: 'short', day: 'numeric' }).format(new Date(t));
const fmtDayLong = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  .format(new Date(`${iso}T12:00:00Z`));
const fmtHour = (t) => formatter('hour', { hour: 'numeric' }).format(new Date(t)).replace(' ', ' ');
// Time of day, with the date when it is not the selected day.
const fmtWhen = (t) => (isoDateOf(t) === state.data.day.date ? fmtClock(t) : `${fmtDayShort(t)}, ${fmtClock(t)}`);

function fmtDuration(msDur) {
  const mins = Math.round(msDur / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const firstName = (name) => (/^event:/i.test(name) ? name.replace(/^event:\s*/i, 'Event: ') : name.split(' ')[0]);

const MATCH = {
  unreserved: { label: 'No reservation', icon: '✕', cls: 'icon-bad' },
  partial: { label: 'Outside reservation', icon: '!', cls: 'icon-partial' },
  reserved: { label: 'Within reservation', icon: '✓', cls: 'icon-ok' },
  unknown: { label: 'Not compared', icon: '?', cls: 'icon-info' },
};
const BAMBU_STATUS = { finished: 'Finished', failed: 'Failed or cancelled', running: 'Printing', unknown: 'Unknown' };

function statusChip(match) {
  const m = MATCH[match] || MATCH.unknown;
  return el('span', { className: 'status' }, el('span', { className: `icon ${m.cls}`, 'aria-hidden': 'true', text: m.icon }), m.label);
}

function bambuStatusText(p) {
  if (p.finishUnknown) return 'Finish not recorded (was printing when last checked)';
  if (p.status === 'running') {
    const when = fmtWhen(ms(p.end));
    return p.overdue ? `Printing (was due ${when})` : `Printing, due ${when}`;
  }
  const label = BAMBU_STATUS[p.status] || 'Unknown';
  return p.status === 'unknown' && p.rawStatus !== null ? `${label} (status ${p.rawStatus})` : label;
}

function outsideText(p) {
  if (p.match === 'unreserved') return `Entire print (${fmtDuration(p.uncoveredMinutes * 60000)})`;
  if (p.match === 'partial') return `${fmtDuration(p.uncoveredMinutes * 60000)} outside`;
  return '';
}

// ---------------------------------------------------------------- theme

const THEMES = ['auto', 'light', 'dark'];
function storedTheme() {
  try { return THEMES.includes(localStorage.getItem('pb-theme')) ? localStorage.getItem('pb-theme') : 'auto'; } catch { return 'auto'; }
}
function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $('#theme-btn').textContent = `Theme: ${theme}`;
  try { localStorage.setItem('pb-theme', theme); } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- tooltip

const tooltip = $('#tooltip');
function showTooltip(build, anchor, evt) {
  tooltip.replaceChildren(...build().filter(Boolean));
  tooltip.hidden = false;
  moveTooltip(anchor, evt);
}
function moveTooltip(anchor, evt) {
  if (tooltip.hidden) return;
  const r = anchor.getBoundingClientRect();
  const x0 = evt && 'clientX' in evt ? evt.clientX : r.left + Math.min(r.width, 40);
  const y0 = evt && 'clientY' in evt ? evt.clientY : r.bottom;
  const w = tooltip.offsetWidth;
  const h = tooltip.offsetHeight;
  let x = x0 + 14;
  let y = y0 + 14;
  if (x + w > window.innerWidth - 8) x = Math.max(8, x0 - w - 14);
  if (y + h > window.innerHeight - 8) y = Math.max(8, y0 - h - 14);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}
function hideTooltip() { tooltip.hidden = true; }
function attachTooltip(node, build) {
  node.addEventListener('pointerenter', (e) => showTooltip(build, node, e));
  node.addEventListener('pointermove', (e) => moveTooltip(node, e));
  node.addEventListener('pointerleave', hideTooltip);
  node.addEventListener('focus', () => showTooltip(build, node));
  node.addEventListener('blur', hideTooltip);
}

const ttRow = (label, value) => el('div', { className: 'tt-row' }, `${label}: `, el('strong', { text: value }));

function printTooltip(p, row) {
  return () => [
    el('div', { className: 'tt-title', text: p.title + (p.plate ? ` · ${p.plate}` : '') }),
    statusChip(p.match),
    p.uncoveredMinutes && p.match !== 'unknown' ? ttRow('Unreserved time', fmtDuration(p.uncoveredMinutes * 60000)) : null,
    ttRow('Printer', `${p.deviceName}${row.unmapped ? ' (not matched to a Design Hub model)' : ''}`),
    ttRow('Time', `${fmtWhen(ms(p.start))} → ${fmtWhen(ms(p.end))}${p.estimated ? ' (est.)' : ''}`),
    ttRow('Duration', fmtDuration(ms(p.end) - ms(p.start))),
    ttRow('Bambu status', bambuStatusText(p)),
    p.matchedReservations.length
      ? ttRow('Reservation', p.matchedReservations.map((r) => `${r.name} (${fmtClock(ms(r.start))}–${fmtClock(ms(r.end))})`).join(', '))
      : null,
  ];
}

function reservationTooltip(r) {
  return () => [
    el('div', { className: 'tt-title', text: r.name }),
    ttRow('Time', `${fmtWhen(ms(r.start))} → ${fmtWhen(ms(r.end))}`),
    ttRow('Duration', fmtDuration(ms(r.end) - ms(r.start))),
    ttRow('Tool', `${r.tool} · ${r.model}`),
    r.noPrint ? el('div', { className: 'status' }, el('span', { className: 'icon icon-info', 'aria-hidden': 'true', text: 'i' }), 'No Bambu print recorded') : null,
    r.expiredMember ? el('div', { className: 'tt-row', text: 'Flagged on the agenda: membership expired' }) : null,
  ];
}

// ---------------------------------------------------------------- chart

function assignLanes(items) {
  const ends = [];
  const lanes = new Map();
  for (const it of [...items].sort((a, b) => a.s - b.s)) {
    let lane = ends.findIndex((end) => end <= it.s);
    if (lane === -1) { lane = ends.length; ends.push(0); }
    ends[lane] = it.e;
    lanes.set(it.id, lane);
  }
  return { lanes, count: ends.length };
}

let measureCtx;
function textWidth(text) {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = `11px ${getComputedStyle(document.body).fontFamily}`;
  }
  return measureCtx.measureText(text).width;
}

function visibleRows(data) {
  const onlyBambu = $('#only-bambu').checked;
  const showIdle = $('#show-idle').checked;
  const rows = data.rows.filter((r) => !onlyBambu || r.isBambu);
  return { active: rows.filter((r) => r.active), idle: showIdle ? rows.filter((r) => !r.active) : [] };
}

function renderChart() {
  const data = state.data;
  const chart = $('#chart');
  hideTooltip();
  // Emptying the chart collapses its width, which resets horizontal scroll.
  const scroller = $('#chart-scroll');
  const keepScroll = scroller.scrollLeft;
  chart.replaceChildren();

  const dayStart = ms(data.day.start);
  const dayEnd = ms(data.day.end);
  const span = dayEnd - dayStart;
  const clamp = (t) => Math.min(dayEnd, Math.max(dayStart, t));
  const pct = (t) => ((clamp(t) - dayStart) / span) * 100;
  const now = ms(data.now);
  const nowVisible = now >= dayStart && now <= dayEnd;

  const labelW = parseFloat(getComputedStyle(chart).getPropertyValue('--label-w')) || 168;
  const trackW = Math.max(chart.clientWidth - labelW, 1);
  const pxPerMs = trackW / span;
  const stepHours = trackW >= 1000 ? 2 : 3;

  // Hour ticks, walked in real time so DST days get 23 or 25 hours.
  const ticks = [];
  for (let t = dayStart; t <= dayEnd; t += 3600000) {
    const hour = Number(formatter('h23', { hour: 'numeric', hourCycle: 'h23' }).format(new Date(t)));
    if (hour % stepHours === 0) ticks.push(t);
  }

  const axis = el('div', { className: 'axis', 'aria-hidden': 'true' });
  for (const t of ticks) {
    // Leave room for the "Now" tag.
    if (nowVisible && Math.abs(t - now) * pxPerMs < 34) continue;
    const cls = t === dayStart ? ' is-edge-start' : t >= dayEnd ? ' is-edge-end' : '';
    axis.append(el('div', { className: `tick${cls}`, style: { left: `${pct(t)}%` }, text: fmtHour(t) }));
  }
  if (nowVisible) axis.append(el('div', { className: 'now-tag', style: { left: `${pct(now)}%` }, text: 'Now' }));
  chart.append(axis);

  const { active, idle } = visibleRows(data);
  const reservationsByRow = groupBy(data.reservations, 'rowKey');
  const printsByRow = groupBy(data.prints, 'rowKey');

  const addRow = (row, isIdle) => {
    const res = (reservationsByRow.get(row.key) || []).map((r) => ({ ...r, s: ms(r.start), e: ms(r.end) }));
    const prints = (printsByRow.get(row.key) || []).map((p) => ({ ...p, s: ms(p.start), e: ms(p.end) }));
    // Lanes only separate overlapping marks of the same source, so a print
    // and the reservation it falls in share a lane and overlap visually.
    const resLanes = assignLanes(res.map((r) => ({ id: r.id, s: Math.max(r.s, dayStart), e: Math.min(r.e, dayEnd) })));
    const printLanes = assignLanes(prints.map((p) => ({ id: p.id, s: Math.max(p.s, dayStart), e: Math.min(p.e, dayEnd) })));
    const lanes = Math.max(1, resLanes.count, printLanes.count);

    const track = el('div', { className: 'track', style: { height: `${lanes * LANE_H}px` } });
    for (const t of ticks) track.append(el('div', { className: 'gridline', style: { left: `${pct(t)}%` } }));
    if (nowVisible) track.append(el('div', { className: 'now-line', style: { left: `${pct(now)}%` } }));

    for (const r of res) {
      const left = pct(r.s);
      const width = Math.max(pct(r.e) - left, 0.2);
      const lane = resLanes.lanes.get(r.id);
      const room = (width / 100) * trackW - 14;
      const label = [firstName(r.name), r.isEvent && 'Event'].find((l) => l && textWidth(l) <= room);
      const fits = Boolean(label);
      const node = el('div', {
        className: ['res', r.noPrint && 'is-empty', r.s < dayStart && 'clip-start', r.e > dayEnd && 'clip-end'].filter(Boolean).join(' '),
        style: { left: `${left}%`, width: `${width}%`, top: `${lane * LANE_H + RES_TOP}px`, height: `${RES_H}px` },
        tabindex: '0',
        role: 'img',
        'aria-label': `Reservation: ${r.name}, ${r.model}, ${fmtWhen(r.s)} to ${fmtWhen(r.e)}${r.noPrint ? ', no Bambu print recorded' : ''}`,
      }, fits ? el('span', { className: 'res-label', text: label }) : null);
      attachTooltip(node, reservationTooltip(r));
      track.append(node);
    }

    for (const p of prints) {
      const s = Math.max(p.s, dayStart);
      const e = Math.min(p.e, dayEnd);
      const left = pct(s);
      const width = Math.max(pct(e) - left, 0.15);
      const lane = printLanes.lanes.get(p.id);
      const widthMs = Math.max(e - s, 1);
      const node = el('div', {
        className: ['print', `is-${p.match}`, p.s < dayStart && 'clip-start', p.e > dayEnd && 'clip-end'].filter(Boolean).join(' '),
        style: { left: `${left}%`, width: `${width}%`, top: `${lane * LANE_H + PRINT_TOP}px` },
        tabindex: '0',
        role: 'img',
        'aria-label': `Print: ${p.title} on ${p.deviceName}, ${fmtWhen(p.s)} to ${fmtWhen(p.e)}. ${MATCH[p.match].label}.`,
      });
      // Highlight exactly the part of a partial print that ran unreserved.
      if (p.match === 'partial') {
        for (const g of p.uncovered) {
          const gs = Math.max(ms(g.start), s);
          const ge = Math.min(ms(g.end), e);
          if (ge <= gs) continue;
          node.append(el('div', { className: 'print-seg', style: { left: `${((gs - s) / widthMs) * 100}%`, width: `${((ge - gs) / widthMs) * 100}%` } }));
        }
      }
      if (p.estimated && now < e) {
        const from = Math.max(now, s);
        node.append(el('div', { className: 'print-est', style: { left: `${((from - s) / widthMs) * 100}%`, right: '0' } }));
      }
      if (p.match === 'unreserved' || p.match === 'partial') {
        const firstGap = p.match === 'partial' && p.uncovered.length ? Math.max(ms(p.uncovered[0].start), s) : s;
        const offsetPx = (firstGap - s) * pxPerMs;
        const m = MATCH[p.match];
        node.append(el('span', { className: `icon ${m.cls} print-badge`, 'aria-hidden': 'true', style: { left: `${offsetPx - 2}px` }, text: m.icon }));
      }
      attachTooltip(node, printTooltip(p, row));
      track.append(node);
    }

    const unreserved = prints.filter((p) => p.match === 'unreserved').length;
    const partial = prints.filter((p) => p.match === 'partial').length;
    let sub;
    let subWarn = false;
    if (row.unmapped) {
      sub = 'No Design Hub match';
      subWarn = true;
    } else if (row.isBambu) {
      sub = `Bambu ${[...new Set(row.devices.map((d) => d.product).filter(Boolean))].join(', ')}`.trim();
    } else {
      sub = row.tools.join(', ') || 'Design Hub only';
    }
    const label = el('div', { className: 'row-label' },
      el('div', { className: 'row-name' },
        el('span', { text: row.label, title: row.label }),
        unreserved ? el('span', { className: 'flag-count', title: `${unreserved} print(s) with no reservation`, text: `✕ ${unreserved}` }) : null,
        partial ? el('span', { className: 'flag-count is-partial', title: `${partial} print(s) outside a reservation`, text: `! ${partial}` }) : null),
      el('div', { className: `row-sub${subWarn ? ' is-warn' : ''}`, text: sub, title: sub }));

    chart.append(el('div', { className: `row${isIdle ? ' is-idle' : ''}`, style: { minHeight: `${lanes * LANE_H}px` } }, label, track));
  };

  if (!active.length && !idle.length) {
    chart.append(el('p', { className: 'empty', text: 'No reservations or prints on this day.' }));
  }
  active.forEach((row) => addRow(row, false));
  if (idle.length) {
    chart.append(el('div', { className: 'section-label', text: 'No activity this day' }));
    idle.forEach((row) => addRow(row, true));
  }

  if (state.scrollToActivity) {
    state.scrollToActivity = false;
    scrollToActivity(data, pct, trackW);
  } else {
    scroller.scrollLeft = keepScroll;
  }

  const s = data.summary;
  $('#chart-sub').textContent = `${fmtDayLong(data.day.date)} · ${s.reservations} reservations, ${s.prints} prints · times in ${state.config.timezone}`;
}

// When the day does not fit on screen, start at the first activity of the day.
function scrollToActivity(data, pct, trackW) {
  const scroller = $('#chart-scroll');
  if (scroller.scrollWidth <= scroller.clientWidth) return;
  // Prefer activity that starts this day over jobs carried over from last night.
  const dayStart = ms(data.day.start);
  const starts = [...data.reservations, ...data.prints].map((x) => ms(x.start));
  const today = starts.filter((t) => t >= dayStart);
  const first = today.length ? Math.min(...today) : starts.length ? Math.min(...starts) : ms(data.now);
  const x = (pct(first) / 100) * trackW - 40;
  scroller.scrollLeft = Math.max(0, x);
}

function groupBy(list, key) {
  const map = new Map();
  for (const item of list) {
    if (!map.has(item[key])) map.set(item[key], []);
    map.get(item[key]).push(item);
  }
  return map;
}

// ---------------------------------------------------------------- tiles, banners, tables

function renderTiles() {
  const { summary: s, sources, graceMinutes, printsAvailable } = state.data;
  const both = sources.designhub.ok && printsAvailable;
  const val = (v, ok) => (ok ? String(v) : '—');
  const tile = (iconCls, icon, label, value, note, alert) => el('div', { className: `tile${alert ? ' is-alert' : ''}` },
    el('div', { className: 'tile-label' }, el('span', { className: `icon ${iconCls}`, 'aria-hidden': 'true', text: icon }), label),
    el('div', { className: 'tile-value', text: value }),
    el('div', { className: 'tile-note', text: note }));
  $('#tiles').replaceChildren(
    tile('icon-bad', '✕', 'Prints with no reservation', val(s.unreserved, both), 'Bambu jobs on a printer nobody had reserved', both && s.unreserved > 0),
    tile('icon-partial', '!', 'Prints outside their reservation', val(s.partial, both), `Started early or ran late by more than ${graceMinutes} min`),
    tile('icon-ok', '✓', 'Prints within a reservation', val(s.reserved, both), `of ${val(s.prints, printsAvailable)} Bambu prints this day`),
    tile('icon-info', 'i', 'Reservations', val(s.reservations, sources.designhub.ok),
      printsAvailable ? `${s.reservationsWithoutPrint} on Bambu printers with no print recorded` : 'Design Hub agenda'),
  );
}

function banner(iconCls, icon, title, message, ...extra) {
  return el('div', { className: 'banner', role: iconCls === 'icon-bad' ? 'alert' : null },
    el('span', { className: `icon ${iconCls}`, 'aria-hidden': 'true', text: icon }),
    el('div', { className: 'banner-body' }, el('strong', { text: title }), message ? el('p', { text: message }) : null, ...extra));
}

function bambuCodeForm(kind, message) {
  const input = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]*', 'aria-label': 'Verification code', required: true });
  const submit = el('button', { className: 'btn btn-primary', type: 'submit', text: 'Verify' });
  const restart = el('button', { className: 'btn', type: 'button', text: kind === 'tfa' ? 'Start over' : 'Send a new code' });
  const error = el('p', { className: 'muted', role: 'status' });
  const post = async (url, body) => {
    submit.disabled = true;
    restart.disabled = true;
    error.textContent = '';
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
      return true;
    } catch (err) {
      error.textContent = err.message;
      return false;
    } finally {
      submit.disabled = false;
      restart.disabled = false;
    }
  };
  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (await post('/api/bambu/code', { code: input.value })) load({ force: true });
    },
  }, input, submit, restart);
  restart.addEventListener('click', async () => {
    if (await post('/api/bambu/restart')) {
      error.textContent = kind === 'tfa' ? 'Started over. Enter the current code from your authenticator app.' : 'A new code is on its way.';
    }
  });
  return banner('icon-info', 'i', kind === 'tfa' ? 'Bambu two-factor code needed' : 'Bambu verification code needed', message, form, error);
}

function renderBanners() {
  const { sources, demo, rows, printsAvailable, printGaps } = state.data;
  const list = [];
  if (demo) {
    list.push(banner('icon-info', 'i', 'Showing demo data',
      'These reservations and prints are generated samples. Add the Design Hub and Bambu logins to .env and restart to compare live data.'));
  }
  const names = { designhub: 'Design Hub', bambu: 'Bambu Cloud' };
  for (const key of ['designhub', 'bambu']) {
    const src = sources[key];
    if (src.ok) continue;
    const code = src.error.code;
    if (code === 'bambu_code_required' || code === 'bambu_tfa_required') {
      list.push(bambuCodeForm(code === 'bambu_tfa_required' ? 'tfa' : 'verifyCode', src.error.message));
      continue;
    }
    list.push(banner('icon-bad', '✕', `${names[key]} data unavailable`,
      [src.error.message, src.error.hint, key === 'bambu' && printsAvailable && 'Showing prints saved in the print log.']
        .filter(Boolean).join(' ')));
  }
  if (!demo && printGaps.length) list.push(gapBanner(printGaps, sources.bambu.log, printsAvailable));
  if (sources.bambu.log?.writeError) {
    list.push(banner('icon-bad', '✕', 'Could not save the print log', `${sources.bambu.log.writeError}. New prints are kept in memory and saved once this is fixed, but are lost if PrintBuster restarts first. Check that the data folder (or Docker volume) is writable.`));
  }
  if (sources.bambu.ok && !sources.bambu.complete) {
    list.push(banner('icon-partial', '!', 'Bambu print history may be incomplete',
      'The task list ran out of pages before reaching this day. Increase BAMBU_MAX_TASK_PAGES in .env.'));
  }
  if (sources.designhub.ok && sources.designhub.skippedRows?.length) {
    const rowsText = sources.designhub.skippedRows.map((r) => `${r.name || 'unnamed'} (${r.time || 'no time'})`).join('; ');
    list.push(banner('icon-partial', '!', `${sources.designhub.skippedRows.length} agenda row(s) could not be read`, rowsText));
  }
  const unmapped = rows.filter((r) => r.unmapped && r.printCount > 0);
  if (unmapped.length) {
    list.push(banner('icon-partial', '!', 'Bambu printers not matched to a Design Hub model',
      `${unmapped.map((r) => r.label).join(', ')}: their prints count as unreserved. If they are on the agenda under another name, add them to PRINTER_MAP in .env (e.g. PRINTER_MAP=${unmapped[0].label}=Ada).`));
  }
  $('#banners').replaceChildren(...list);
}

// Bambu keeps about a day of history; explain spans nobody observed.
function gapBanner(gaps, log, printsAvailable) {
  const fmtGap = (g) => `${fmtWhen(ms(g.start))} – ${fmtWhen(ms(g.end))}`;
  const since = log?.since ? `PrintBuster's print log starts ${fmtDayShort(ms(log.since))}, ${fmtClock(ms(log.since))}.` : 'Nothing has been saved to the print log yet.';
  const intro = `Bambu only keeps about a day of print history, so PrintBuster saves every print it sees. ${since}`;
  if (!printsAvailable) {
    return banner('icon-partial', '!', 'No Bambu print data for this day',
      `${intro} Nothing was observed on this day, so its prints can't be checked.`);
  }
  return banner('icon-partial', '!', 'Part of this day has no Bambu print data',
    `${intro} Not observed: ${gaps.map(fmtGap).join('; ')}. Prints from that time can't be checked, and reservations in it aren't marked "no print recorded".`);
}

function table(headers, rows, emptyNode) {
  if (!rows.length) return emptyNode;
  return el('table', {},
    el('thead', {}, el('tr', {}, headers.map(([h, cls]) => el('th', { className: cls, scope: 'col', text: h })))),
    el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((c, i) => el('td', { className: headers[i][1] }, c))))));
}

function renderTables() {
  const { prints, reservations, rows, sources } = state.data;
  const rowLabel = new Map(rows.map((r) => [r.key, r.label]));
  const flagged = prints.filter((p) => p.match === 'unreserved' || p.match === 'partial');

  let empty;
  if (!sources.designhub.ok) {
    empty = el('p', { className: 'empty', text: 'The Design Hub agenda is needed to compare. See the messages above.' });
  } else if (!state.data.printsAvailable) {
    empty = el('p', { className: 'empty', text: 'There is no Bambu print data for this day to compare. See the message above.' });
  } else {
    empty = el('p', { className: 'empty' }, el('span', { className: 'icon icon-ok', 'aria-hidden': 'true', text: '✓' }),
      `Every Bambu print on ${fmtDayLong(state.data.day.date)} lines up with a Design Hub reservation.`);
  }
  $('#flagged').replaceChildren(table(
    [['Status'], ['Printer'], ['Print'], ['Start', 'time'], ['End', 'time'], ['Unreserved time'], ['Bambu status'], ['Overlapping reservation']],
    flagged.map((p) => [
      statusChip(p.match),
      p.deviceName + (p.unmappedPrinter ? ' (unmatched)' : ''),
      p.title,
      fmtWhen(ms(p.start)),
      fmtWhen(ms(p.end)) + (p.estimated ? ' (est.)' : ''),
      outsideText(p),
      bambuStatusText(p),
      p.matchedReservations.map((r) => `${r.name}, ${fmtClock(ms(r.start))}–${fmtClock(ms(r.end))}`).join('; ') || '—',
    ]),
    empty,
  ));

  $('#all-prints').replaceChildren(table(
    [['Match'], ['Printer'], ['Print'], ['Start', 'time'], ['End', 'time'], ['Duration', 'num'], ['Bambu status']],
    prints.map((p) => [
      statusChip(p.match),
      rowLabel.get(p.rowKey) === p.deviceName ? p.deviceName : `${p.deviceName} (${rowLabel.get(p.rowKey)})`,
      p.title,
      fmtWhen(ms(p.start)),
      fmtWhen(ms(p.end)) + (p.estimated ? ' (est.)' : ''),
      fmtDuration(ms(p.end) - ms(p.start)),
      bambuStatusText(p),
    ]),
    el('p', { className: 'empty', text: state.data.printsAvailable ? 'No Bambu prints on this day.' : 'No Bambu print data for this day.' }),
  ));

  $('#all-reservations').replaceChildren(table(
    [['Printer'], ['Tool'], ['Name'], ['Start', 'time'], ['End', 'time'], ['Duration', 'num'], ['Notes']],
    reservations.map((r) => [
      r.model,
      r.tool,
      r.name,
      fmtWhen(ms(r.start)),
      fmtWhen(ms(r.end)),
      fmtDuration(ms(r.end) - ms(r.start)),
      [r.noPrint && 'No Bambu print recorded', r.expiredMember && 'Membership expired', r.isEvent && 'Event'].filter(Boolean).join('; '),
    ]),
    el('p', { className: 'empty', text: sources.designhub.ok ? 'No reservations on this day.' : 'Design Hub data unavailable.' }),
  ));
}

function render() {
  if (!state.data) return;
  $('#demo-badge').hidden = !state.data.demo;
  renderBanners();
  renderTiles();
  renderChart();
  renderTables();
  $('#updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

// ---------------------------------------------------------------- data

let loadSeq = 0;
async function load({ force = false } = {}) {
  const seq = ++loadSeq;
  state.loading = true;
  $('#chart-scroll').classList.add('is-loading');
  $('#refresh').disabled = true;
  try {
    const res = await fetch(`/api/compare?date=${encodeURIComponent(state.date)}${force ? '&refresh=1' : ''}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    if (seq !== loadSeq) return;
    state.scrollToActivity = !state.data || state.data.day.date !== json.day.date;
    state.data = json;
    render();
  } catch (err) {
    if (seq !== loadSeq) return;
    $('#banners').replaceChildren(banner('icon-bad', '✕', 'Could not load the comparison', err.message));
  } finally {
    if (seq === loadSeq) {
      state.loading = false;
      $('#chart-scroll').classList.remove('is-loading');
      $('#refresh').disabled = false;
    }
  }
}

function setDate(iso, { push = true } = {}) {
  state.date = iso;
  $('#date').value = iso;
  if (push) {
    const url = new URL(window.location.href);
    if (iso === state.config.today) url.searchParams.delete('date');
    else url.searchParams.set('date', iso);
    history.replaceState(null, '', url);
  }
  load();
}

function shift(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Refresh, following "today" past midnight if that is what is on screen.
async function autoRefresh() {
  if (document.visibilityState !== 'visible' || state.loading) return;
  const wasToday = state.date === state.config.today;
  try {
    const res = await fetch('/api/config');
    if (res.ok) state.config.today = (await res.json()).today;
  } catch { /* keep the old value */ }
  if (wasToday && state.date !== state.config.today) setDate(state.config.today);
  else load();
}

function scheduleAutoRefresh() {
  clearInterval(state.timer);
  if (!$('#auto-refresh').checked) return;
  state.timer = setInterval(autoRefresh, AUTO_REFRESH_MS);
}

async function init() {
  applyTheme(storedTheme());
  $('#theme-btn').addEventListener('click', () => {
    applyTheme(THEMES[(THEMES.indexOf(storedTheme()) + 1) % THEMES.length]);
  });

  const res = await fetch('/api/config');
  state.config = await res.json();
  fmtCache = {};

  const fromUrl = new URL(window.location.href).searchParams.get('date');
  const start = /^\d{4}-\d{2}-\d{2}$/.test(fromUrl || '') ? fromUrl : state.config.today;

  $('#controls').addEventListener('submit', (e) => e.preventDefault());
  $('#date').addEventListener('change', (e) => { if (e.target.value) setDate(e.target.value); });
  $('#prev-day').addEventListener('click', () => setDate(shift(state.date, -1)));
  $('#next-day').addEventListener('click', () => setDate(shift(state.date, 1)));
  $('#today').addEventListener('click', () => setDate(state.config.today));
  $('#refresh').addEventListener('click', () => load({ force: true }));
  $('#only-bambu').addEventListener('change', renderChart);
  $('#show-idle').addEventListener('change', renderChart);
  $('#auto-refresh').addEventListener('change', scheduleAutoRefresh);
  document.addEventListener('visibilitychange', () => {
    if ($('#auto-refresh').checked) autoRefresh();
  });
  window.addEventListener('scroll', hideTooltip, { passive: true });

  // Label fit and tick spacing depend on width only.
  let resizeTimer;
  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width === lastWidth) return;
    lastWidth = width;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.data && renderChart(), 120);
  }).observe($('#chart-scroll'));

  scheduleAutoRefresh();
  setDate(start, { push: false });
}

init().catch((err) => {
  $('#banners').replaceChildren(banner('icon-bad', '✕', 'PrintBuster failed to start', err.message));
});
