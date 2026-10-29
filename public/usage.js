'use strict';

const $ = (sel) => document.querySelector(sel);
const state = {
  config: null, data: null, allTime: new Map(), expanded: new Set(), loading: false,
  // Sort of the members in the selected range, and of the all-time table.
  sort: { key: 'grams', dir: 'desc' },
  allSort: { key: 'grams', dir: 'desc' },
};

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
const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: state.config.timezone, ...opts });
const fmtDateTime = (iso) => fmt({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const fmtTime = (iso) => fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const localDay = (iso) => fmt({ year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(iso));
const fmtSpan = (start, end) => `${fmtDateTime(start)} – ${localDay(start) === localDay(end) ? fmtTime(end) : fmtDateTime(end)}`;
const fmtDay = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
  .format(new Date(`${iso}T12:00:00Z`));
const pct = (f) => `${Math.round(f * 100)}%`;
const fmtDate = (iso) => fmt({ month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));

function fmtGrams(g) {
  if (g == null) return '—';
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  return `${g < 10 ? g.toFixed(1) : Math.round(g)} g`;
}

function isoToday() {
  return state.config.today;
}
function shift(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const icon = (cls, text) => el('span', { className: `icon ${cls}`, 'aria-hidden': 'true', text });

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

// ---------------------------------------------------------------- banners and tiles

function banner(iconCls, glyph, title, message) {
  return el('div', { className: 'banner', role: iconCls === 'icon-bad' ? 'alert' : null },
    icon(iconCls, glyph),
    el('div', { className: 'banner-body' }, el('strong', { text: title }), message ? el('p', { text: message }) : null));
}

function renderBanners() {
  const d = state.data;
  const list = [];
  if (d.demo) {
    list.push(banner('icon-info', 'i', 'Showing demo data',
      'These members, reservations and prints are generated samples. Add the Design Hub and Bambu logins to .env and restart to see live usage.'));
  }
  if (!d.sources.designhub.ok) {
    const e = d.sources.designhub.error;
    list.push(e.code === 'not_saved'
      ? banner('icon-info', 'i', 'Reservations for this range aren\u2019t saved yet',
        'The server saves each day as it collects. Press Refresh to read these days from Design Hub now.')
      : banner('icon-bad', '✕', 'Usage cannot be attributed without the Design Hub agenda',
        [e.message, e.hint].filter(Boolean).join(' ')));
  }
  const missing = d.sources.designhub.missingDays || [];
  if (d.sources.designhub.ok && missing.length) {
    const shown = missing.slice(0, 5).map(fmtDay).join(', ') + (missing.length > 5 ? ` and ${missing.length - 5} more` : '');
    list.push(banner('icon-partial', '!', `Reservations for ${missing.length} day${missing.length === 1 ? '' : 's'} in this range aren\u2019t saved yet`,
      `Prints on ${shown} aren't counted for anyone. Press Refresh to read those days from Design Hub.`));
  }
  if (d.sources.designhub.ok && d.sources.designhub.staleDays) {
    const n = d.sources.designhub.staleDays;
    list.push(banner('icon-partial', '!', 'Design Hub could not be reached',
      `${n} day${n === 1 ? '' : 's'} in this range use${n === 1 ? 's' : ''} reservations saved earlier, which may have changed since.`));
  }
  if (d.sources.reservationArchive?.writeError) {
    list.push(banner('icon-partial', '!', 'Reservations could not be saved',
      `${d.sources.reservationArchive.writeError}. Usage still shows, but past reservations depend on Design Hub until saving works.`));
  }
  if (d.sources.usageLog?.writeError) {
    list.push(banner('icon-partial', '!', 'Usage could not be saved',
      `${d.sources.usageLog.writeError}. The figures below are correct but were not written to the data folder.`));
  }
  if (!d.sources.bambu.ok) {
    const e = d.sources.bambu.error;
    list.push(banner('icon-partial', '!', 'Bambu Cloud data unavailable',
      [e.message, e.hint, d.sources.bambu.log ? 'Usage below comes from prints saved in the print log.' : null].filter(Boolean).join(' ')));
  }
  if (!d.demo && d.printGaps.length) {
    const since = d.sources.bambu.log?.since;
    const shown = d.printGaps.slice(0, 3).map((g) => `${fmtDateTime(g.start)} – ${fmtDateTime(g.end)}`);
    const more = d.printGaps.length > 3 ? ` and ${d.printGaps.length - 3} more` : '';
    list.push(banner('icon-partial', '!', 'Part of this range has no Bambu print data',
      `Bambu only keeps about a day of history, so usage relies on PrintBuster's print log${since ? `, which starts ${fmtDateTime(since)}` : ''}. `
      + `Prints in these times are missing: ${shown.join('; ')}${more}.`));
  }
  if (d.totals?.printsWithoutWeight) {
    list.push(banner('icon-info', 'i', `${d.totals.printsWithoutWeight} print(s) had no filament weight`,
      'Bambu did not report a weight for them, so they count as 0 g.'));
  }
  $('#banners').replaceChildren(...list);
}

function renderTiles() {
  const t = state.data.totals;
  const v = (x) => (t ? x : '—');
  const tile = (iconCls, glyph, label, value, note) => el('div', { className: 'tile' },
    el('div', { className: 'tile-label' }, icon(iconCls, glyph), label),
    el('div', { className: 'tile-value', text: value }),
    el('div', { className: 'tile-note', text: note }));
  const printing = state.data.users.filter((u) => !u.isEvent && u.prints > 0).length;
  const all = state.data.allTime;
  const totalNote = !all ? 'Not saved in this mode'
    : !all.since ? 'Nothing saved yet'
      : [`${all.countedPrints} prints since ${fmtDate(all.since)}`,
        all.lastTotalRecalculation ? `recalculated ${fmtDateTime(all.lastTotalRecalculation.at)}` : null].filter(Boolean).join(' · ');
  $('#tiles').replaceChildren(
    tile('icon-ok', '✓', 'Filament counted', v(fmtGrams(t?.countedGrams)), t ? `${t.countedPrints} prints inside reservations` : 'Needs the Design Hub agenda'),
    tile('icon-info', 'i', 'Members', v(String(t?.users)), t ? `${printing} printed something` : ''),
    tile('icon-partial', '!', 'Not counted', v(fmtGrams(t?.excludedGrams)), t ? `${t.excludedPrints} prints more than half outside their reservation` : ''),
    tile('icon-bad', '✕', 'No reservation', v(fmtGrams(t?.unattributedGrams)), t ? `${t.unattributedPrints} prints not charged to anyone` : ''),
    tile('icon-info', 'Σ', 'All-time total', all?.since ? fmtGrams(all.countedGrams) : '—', totalNote),
  );
}

// ---------------------------------------------------------------- table

const METHOD = {
  finished: () => 'Finished',
  cancelled: (p) => `Cancelled or failed · ran ${pct(p.fraction)} of its estimated time`,
  'cancelled-no-estimate': () => 'Cancelled or failed · no time estimate, full amount',
  running: (p) => `Printing · ${pct(p.fraction)} so far`,
  'running-no-estimate': () => 'Printing',
  'finish-unknown': () => 'Finish not recorded · full amount',
};

const totalFor = (u) => state.allTime.get(u.name);
const sortValue = (u, key) => (key === 'total' ? totalFor(u)?.grams ?? 0 : u[key]);

// The name search and the event checkbox apply to both tables.
function matchesFilters(member) {
  const q = $('#search').value.trim().toLowerCase();
  return ($('#show-events').checked || !member.isEvent) && (!q || member.name.toLowerCase().includes(q));
}

function sortMembers(list, { key, dir }, valueOf) {
  const sign = dir === 'asc' ? 1 : -1;
  return list.sort((a, b) => {
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (key === 'name') return sign * byName;
    return sign * (valueOf(a, key) - valueOf(b, key)) || byName;
  });
}

function visibleUsers() {
  return sortMembers(state.data.users.filter(matchesFilters), state.sort, sortValue);
}

// `table` is 'range' (members in the selected dates) or 'all' (all-time).
function sortHeader(label, key, cls, table = 'range') {
  const current = table === 'all' ? state.allSort : state.sort;
  const active = current.key === key;
  const ariaSort = active ? (current.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const arrow = active ? (current.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return el('th', { scope: 'col', className: cls, 'aria-sort': ariaSort },
    el('button', {
      className: 'sort-btn', type: 'button',
      onclick: () => {
        const next = active
          ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: key === 'name' ? 'asc' : 'desc' };
        if (table === 'all') state.allSort = next;
        else state.sort = next;
        saveUrl();
        if (table === 'all') renderAllTime();
        else renderUsers();
      },
    }, label, el('span', { className: 'sort-arrow', 'aria-hidden': 'true', text: arrow })));
}

function materialsText(materials) {
  const entries = Object.entries(materials).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([type, g]) => `${type} ${fmtGrams(g)}`).join(' · ') : '—';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function bookingSummary(b) {
  if (!b.prints && !b.excludedPrints) return 'no prints';
  const parts = [];
  if (b.prints) parts.push(`${plural(b.prints, 'print')} · ${fmtGrams(b.grams)}`);
  if (b.excludedPrints) parts.push(`${b.excludedPrints} not counted · ${fmtGrams(b.excludedGrams)}`);
  return parts.join(' · ');
}

// The member's reservations in time order, each followed by the prints
// charged to it.
function printRows(u) {
  const cols = ['Started', 'Print', 'Status', 'Filament', 'Outside their reservation', ''];
  const rows = [];
  for (const b of u.bookings) {
    rows.push(el('tr', { className: 'booking-row' },
      el('th', { scope: 'rowgroup', colspan: String(cols.length) },
        el('span', { text: `${fmtSpan(b.start, b.end)} · ${b.printer}` }),
        el('span', { className: 'muted', text: ` · ${bookingSummary(b)}` }))));
    for (const p of u.list.filter((x) => x.reservation?.id === b.id)) {
      rows.push(el('tr', { className: p.excluded ? 'is-excluded' : null },
        el('td', { className: 'time', text: fmtDateTime(p.start) }),
        el('td', { text: p.title }),
        el('td', { text: (METHOD[p.method] || (() => p.status))(p) }),
        el('td', { className: 'num' },
          p.usedGrams == null ? '—' : fmtGrams(p.usedGrams),
          p.estimateGrams != null && p.usedGrams !== p.estimateGrams ? el('span', { className: 'muted', text: ` of ${fmtGrams(p.estimateGrams)}` }) : null),
        el('td', { className: 'num', text: p.outsideShare ? pct(p.outsideShare) : '—' }),
        el('td', {}, p.excluded
          ? el('span', { className: 'status' }, icon('icon-partial', '!'), 'Not counted')
          : el('span', { className: 'status' }, icon('icon-ok', '✓'), 'Counted'))));
    }
  }
  return el('table', { className: 'detail-table' },
    el('thead', {}, el('tr', {}, cols.map((h, i) => el('th', { scope: 'col', className: i === 3 || i === 4 ? 'num' : null, text: h })))),
    el('tbody', {}, rows));
}

function renderUsers() {
  const d = state.data;
  if (!d.available) {
    $('#users').replaceChildren(el('p', { className: 'empty', text: 'Usage can only be attributed once the Design Hub agenda loads. See the message above.' }));
    $('#users-sub').textContent = '';
    return;
  }
  const users = visibleUsers();
  const maxGrams = Math.max(1, ...users.map((u) => u.grams));
  $('#users-sub').textContent = `${fmtDay(d.from)} – ${fmtDay(d.to)} · ${users.length} of ${d.users.length} shown · times in ${d.timezone}`;

  if (!users.length) {
    $('#users').replaceChildren(el('p', { className: 'empty', text: d.users.length ? 'No names match your search.' : 'No reservations on Bambu printers in this range.' }));
    return;
  }

  const rows = [];
  for (const u of users) {
    const open = state.expanded.has(u.name);
    const detailId = `detail-${rows.length}`;
    rows.push(el('tr', { className: open ? 'is-open' : null },
      el('td', {},
        el('button', {
          className: 'expand-btn', type: 'button', 'aria-expanded': String(open), 'aria-controls': detailId,
          disabled: !u.bookings.length,
          onclick: () => { if (open) state.expanded.delete(u.name); else state.expanded.add(u.name); renderUsers(); },
        }, el('span', { className: 'chev', 'aria-hidden': 'true', text: u.bookings.length ? (open ? '▾' : '▸') : '' }), u.name),
        u.isEvent ? el('span', { className: 'tag', text: 'Event' }) : null),
      el('td', { className: 'num col-res', text: String(u.reservations) }),
      el('td', { className: 'num', text: String(u.prints) }),
      el('td', { className: 'num usage-cell' },
        el('span', { className: 'usage-bar', 'aria-hidden': 'true' }, el('span', { style: { width: `${(u.grams / maxGrams) * 100}%` } })),
        el('span', { className: 'usage-val', text: fmtGrams(u.grams) })),
      el('td', { className: 'num all-time', title: totalFor(u) ? `${plural(totalFor(u).prints, 'print')} counted in all saved data` : null, text: fmtGrams(totalFor(u)?.grams ?? 0) }),
      el('td', { className: 'materials', text: materialsText(u.materials) }),
      el('td', { className: 'num' }, u.excludedPrints
        ? el('span', { className: 'status' }, icon('icon-partial', '!'), `${u.excludedPrints} · ${fmtGrams(u.excludedGrams)}`)
        : el('span', { className: 'muted', text: '—' }))));
    if (open) {
      rows.push(el('tr', { className: 'detail-row', id: detailId }, el('td', { colspan: '7' }, printRows(u))));
    }
  }

  $('#users').replaceChildren(el('table', { className: 'usage-table' },
    el('thead', {}, el('tr', {},
      sortHeader('Name', 'name'),
      el('th', { scope: 'col', className: 'num col-res', text: 'Reservations' }),
      sortHeader('Prints', 'prints', 'num'),
      sortHeader('Filament used', 'grams', 'num'),
      sortHeader('All time', 'total', 'num'),
      el('th', { scope: 'col', text: 'Materials' }),
      el('th', { scope: 'col', className: 'num', text: 'Not counted' }))),
    el('tbody', {}, rows)));
}

function renderAllTime() {
  const all = state.data.allTime;
  if (!all) {
    $('#alltime-sub').textContent = '';
    $('#alltime').replaceChildren(el('p', { className: 'empty', text: 'All-time totals are not saved in this mode.' }));
    return;
  }
  const members = sortMembers(all.members.filter(matchesFilters), state.allSort,
    (m, key) => (key === 'last' ? (m.lastPrint ? ms(m.lastPrint) : 0) : m[key]));
  $('#alltime-sub').textContent = [
    all.since ? `Since ${fmtDate(all.since)}` : null,
    `${members.length} of ${all.members.length} shown`,
    all.lastTotalRecalculation ? `total recalculated ${fmtDateTime(all.lastTotalRecalculation.at)}` : null,
  ].filter(Boolean).join(' · ');
  if (!members.length) {
    $('#alltime').replaceChildren(el('p', { className: 'empty', text: all.members.length ? 'No names match your search.' : 'No usage is saved yet.' }));
    return;
  }
  const maxGrams = Math.max(1, ...members.map((m) => m.grams));
  $('#alltime').replaceChildren(el('table', { className: 'usage-table' },
    el('thead', {}, el('tr', {},
      sortHeader('Name', 'name', null, 'all'),
      sortHeader('Prints', 'prints', 'num', 'all'),
      sortHeader('Filament used', 'grams', 'num', 'all'),
      el('th', { scope: 'col', text: 'Materials' }),
      el('th', { scope: 'col', className: 'num', text: 'Not counted' }),
      sortHeader('Last print', 'last', 'num col-res', 'all'))),
    el('tbody', {}, members.map((m) => el('tr', {},
      el('td', { className: 'member-name' }, m.name, m.isEvent ? el('span', { className: 'tag', text: 'Event' }) : null),
      el('td', { className: 'num', text: String(m.prints) }),
      el('td', { className: 'num usage-cell' },
        el('span', { className: 'usage-bar', 'aria-hidden': 'true' }, el('span', { style: { width: `${(m.grams / maxGrams) * 100}%` } })),
        el('span', { className: 'usage-val', text: fmtGrams(m.grams) })),
      el('td', { className: 'materials', text: materialsText(m.materials) }),
      el('td', { className: 'num' }, m.excludedPrints
        ? el('span', { className: 'status' }, icon('icon-partial', '!'), `${m.excludedPrints} · ${fmtGrams(m.excludedGrams)}`)
        : el('span', { className: 'muted', text: '—' })),
      el('td', { className: 'num col-res time', text: m.lastPrint ? fmtDate(m.lastPrint) : '—' }))))));
}

const NO_RESERVATION = {
  none: 'Overlapped no reservation',
  'started-outside': 'Started outside a reservation, then ran into one',
  'mostly-outside': 'Under 10% inside a reservation',
};

function renderUnattributed() {
  const u = state.data.unattributed;
  $('#unattributed-sum').textContent = state.data.available ? `${u.prints} prints · ${fmtGrams(u.grams)}` : '';
  $('#unattributed').replaceChildren(u.list.length
    ? el('table', {},
      el('thead', {}, el('tr', {}, ['Started', 'Printer', 'Print', 'Status', 'Filament', 'Why'].map((h, i) => el('th', { scope: 'col', className: i === 4 ? 'num' : null, text: h })))),
      el('tbody', {}, u.list.map((p) => el('tr', {},
        el('td', { className: 'time', text: fmtDateTime(p.start) }),
        el('td', { text: p.printer }),
        el('td', { text: p.title }),
        el('td', { text: (METHOD[p.method] || (() => p.status))(p) }),
        el('td', { className: 'num', text: fmtGrams(p.usedGrams) }),
        el('td', { className: 'muted', text: NO_RESERVATION[p.noReservationReason] || NO_RESERVATION.none })))))
    : el('p', { className: 'empty', text: 'Every print in this range overlapped a reservation.' }));
}

function render() {
  state.allTime = new Map((state.data.allTime?.members || []).map((m) => [m.name, m]));
  $('#demo-badge').hidden = !state.data.demo;
  $('#grace-min').textContent = String(state.data.graceMinutes);
  renderBanners();
  renderTiles();
  renderUsers();
  renderAllTime();
  renderUnattributed();
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('#updated').textContent = state.data.recalculated
    ? `Recalculated${state.data.demo ? '' : ' and saved'} ${time}`
    : collectedText(state.data.collector) || `Updated ${time}`;
  $('#updated').title = scheduleText(state.data.collector);
}

// ---------------------------------------------------------------- data

function saveUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('from', $('#from').value);
  url.searchParams.set('to', $('#to').value);
  const q = $('#search').value.trim();
  if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
  url.searchParams.set('sort', `${state.sort.key}-${state.sort.dir}`);
  url.searchParams.set('allsort', `${state.allSort.key}-${state.allSort.dir}`);
  history.replaceState(null, '', url);
}

let loadSeq = 0;
async function load({ force = false, recalculate = false } = {}) {
  const from = $('#from').value;
  const to = $('#to').value;
  if (!from || !to) return;
  saveUrl();
  const seq = ++loadSeq;
  state.loading = true;
  $('#users').classList.add('is-loading');
  setBusy(true);
  $('#updated').textContent = recalculate ? 'Recalculating… re-reading every day from Design Hub' : 'Loading…';
  try {
    const res = recalculate
      ? await fetch('/api/usage/recalculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }) })
      : await fetch(`/api/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${force ? '&refresh=1' : ''}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    if (seq !== loadSeq) return;
    state.data = json;
    render();
  } catch (err) {
    if (seq !== loadSeq) return;
    $('#banners').replaceChildren(banner('icon-bad', '✕', recalculate ? 'Could not recalculate filament usage' : 'Could not load filament usage', err.message));
    $('#updated').textContent = '';
  } finally {
    if (seq === loadSeq) {
      state.loading = false;
      $('#users').classList.remove('is-loading');
      setBusy(false);
    }
  }
}

function setBusy(busy) {
  for (const id of ['#refresh', '#recalc', '#recalc-total']) $(id).disabled = busy;
}

// Recalculates all-time usage from saved data only; the range shown is
// unchanged.
async function recalculateTotal() {
  if (!state.data) return;
  const seq = ++loadSeq;
  state.loading = true;
  setBusy(true);
  $('#updated').textContent = 'Recalculating the all-time total from saved data…';
  try {
    const res = await fetch('/api/usage/recalculate-total', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const json = await res.json();
    if (!res.ok) throw new Error([json.error?.message, json.error?.hint].filter(Boolean).join(' ') || `HTTP ${res.status}`);
    if (seq !== loadSeq) return;
    state.data.allTime = json.allTime;
    render();
    const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('#updated').textContent = `Total recalculated from saved data ${time}`;
  } catch (err) {
    if (seq !== loadSeq) return;
    $('#banners').replaceChildren(banner('icon-bad', '✕', 'Could not recalculate the all-time total', err.message));
    $('#updated').textContent = '';
  } finally {
    if (seq === loadSeq) {
      state.loading = false;
      setBusy(false);
    }
  }
}

async function init() {
  applyTheme(storedTheme());
  $('#theme-btn').addEventListener('click', () => applyTheme(THEMES[(THEMES.indexOf(storedTheme()) + 1) % THEMES.length]));

  state.config = await (await fetch('/api/config')).json();
  const params = new URL(window.location.href).searchParams;
  const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  $('#to').value = valid(params.get('to')) ? params.get('to') : isoToday();
  $('#from').value = valid(params.get('from')) ? params.get('from') : shift($('#to').value, -29);
  $('#search').value = params.get('q') || '';
  const [key, dir] = (params.get('sort') || '').split('-');
  if (['name', 'prints', 'grams', 'total'].includes(key) && ['asc', 'desc'].includes(dir)) state.sort = { key, dir };
  const [allKey, allDir] = (params.get('allsort') || '').split('-');
  if (['name', 'prints', 'grams', 'last'].includes(allKey) && ['asc', 'desc'].includes(allDir)) state.allSort = { key: allKey, dir: allDir };

  $('#controls').addEventListener('submit', (e) => e.preventDefault());
  $('#from').addEventListener('change', () => load());
  $('#to').addEventListener('change', () => load());
  $('#refresh').addEventListener('click', () => load({ force: true }));
  $('#recalc').addEventListener('click', () => load({ recalculate: true }));
  $('#recalc-total').addEventListener('click', recalculateTotal);
  // The server collects the data; reload the view when it says there is
  // something new, unless a load or recalculation is under way.
  liveUpdates(() => { if (state.data && !state.loading) load(); });
  for (const btn of document.querySelectorAll('.presets [data-days]')) {
    btn.addEventListener('click', () => {
      $('#to').value = isoToday();
      $('#from').value = shift(isoToday(), -(Number(btn.dataset.days) - 1));
      load();
    });
  }
  const refilter = () => {
    if (!state.data) return;
    renderUsers();
    renderAllTime();
  };
  $('#search').addEventListener('input', () => { saveUrl(); refilter(); });
  $('#show-events').addEventListener('change', refilter);

  load();
}

init().catch((err) => {
  $('#banners').replaceChildren(banner('icon-bad', '✕', 'PrintBuster failed to start', err.message));
});
