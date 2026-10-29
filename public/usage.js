'use strict';

const $ = (sel) => document.querySelector(sel);
const state = { config: null, data: null, sort: { key: 'grams', dir: 'desc' }, expanded: new Set(), loading: false };

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
const fmtDay = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
  .format(new Date(`${iso}T12:00:00Z`));
const pct = (f) => `${Math.round(f * 100)}%`;

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
    list.push(banner('icon-bad', '✕', 'Usage cannot be attributed without the Design Hub agenda',
      [e.message, e.hint].filter(Boolean).join(' ')));
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
  $('#tiles').replaceChildren(
    tile('icon-ok', '✓', 'Filament counted', v(fmtGrams(t?.countedGrams)), t ? `${t.countedPrints} prints inside reservations` : 'Needs the Design Hub agenda'),
    tile('icon-info', 'i', 'Members', v(String(t?.users)), t ? `${printing} printed something` : ''),
    tile('icon-partial', '!', 'Not counted', v(fmtGrams(t?.excludedGrams)), t ? `${t.excludedPrints} prints more than half outside a reservation` : ''),
    tile('icon-bad', '✕', 'No reservation', v(fmtGrams(t?.unattributedGrams)), t ? `${t.unattributedPrints} prints not charged to anyone` : ''),
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

function visibleUsers() {
  const q = $('#search').value.trim().toLowerCase();
  const showEvents = $('#show-events').checked;
  const { key, dir } = state.sort;
  const sign = dir === 'asc' ? 1 : -1;
  return state.data.users
    .filter((u) => (showEvents || !u.isEvent) && (!q || u.name.toLowerCase().includes(q)))
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      if (key === 'name') return sign * byName;
      return sign * (a[key] - b[key]) || byName;
    });
}

function sortHeader(label, key, cls) {
  const active = state.sort.key === key;
  const ariaSort = active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const arrow = active ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return el('th', { scope: 'col', className: cls, 'aria-sort': ariaSort },
    el('button', {
      className: 'sort-btn', type: 'button',
      onclick: () => {
        state.sort = active
          ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: key === 'name' ? 'asc' : 'desc' };
        saveUrl();
        renderUsers();
      },
    }, label, el('span', { className: 'sort-arrow', 'aria-hidden': 'true', text: arrow })));
}

function materialsText(materials) {
  const entries = Object.entries(materials).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([type, g]) => `${type} ${fmtGrams(g)}`).join(' · ') : '—';
}

function printRows(u) {
  return el('table', { className: 'detail-table' },
    el('thead', {}, el('tr', {},
      ['Started', 'Printer', 'Print', 'Status', 'Filament', 'Outside reservation', ''].map((h, i) => el('th', { scope: 'col', className: i === 4 || i === 5 ? 'num' : null, text: h })))),
    el('tbody', {}, u.list.map((p) => el('tr', { className: p.excluded ? 'is-excluded' : null },
      el('td', { className: 'time', text: fmtDateTime(p.start) }),
      el('td', { text: p.printer }),
      el('td', { text: p.title }),
      el('td', { text: (METHOD[p.method] || (() => p.status))(p) }),
      el('td', { className: 'num' },
        p.usedGrams == null ? '—' : fmtGrams(p.usedGrams),
        p.estimateGrams != null && p.usedGrams !== p.estimateGrams ? el('span', { className: 'muted', text: ` of ${fmtGrams(p.estimateGrams)}` }) : null),
      el('td', { className: 'num', text: p.outsideShare ? pct(p.outsideShare) : '—' }),
      el('td', {}, p.excluded
        ? el('span', { className: 'status' }, icon('icon-partial', '!'), 'Not counted')
        : el('span', { className: 'status' }, icon('icon-ok', '✓'), 'Counted'))))));
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
          disabled: !u.list.length,
          onclick: () => { if (open) state.expanded.delete(u.name); else state.expanded.add(u.name); renderUsers(); },
        }, el('span', { className: 'chev', 'aria-hidden': 'true', text: u.list.length ? (open ? '▾' : '▸') : '' }), u.name),
        u.isEvent ? el('span', { className: 'tag', text: 'Event' }) : null),
      el('td', { className: 'num col-res', text: String(u.reservations) }),
      el('td', { className: 'num', text: String(u.prints) }),
      el('td', { className: 'num usage-cell' },
        el('span', { className: 'usage-bar', 'aria-hidden': 'true' }, el('span', { style: { width: `${(u.grams / maxGrams) * 100}%` } })),
        el('span', { className: 'usage-val', text: fmtGrams(u.grams) })),
      el('td', { className: 'materials', text: materialsText(u.materials) }),
      el('td', { className: 'num' }, u.excludedPrints
        ? el('span', { className: 'status' }, icon('icon-partial', '!'), `${u.excludedPrints} · ${fmtGrams(u.excludedGrams)}`)
        : el('span', { className: 'muted', text: '—' }))));
    if (open) {
      rows.push(el('tr', { className: 'detail-row', id: detailId }, el('td', { colspan: '6' }, printRows(u))));
    }
  }

  $('#users').replaceChildren(el('table', { className: 'usage-table' },
    el('thead', {}, el('tr', {},
      sortHeader('Name', 'name'),
      el('th', { scope: 'col', className: 'num col-res', text: 'Reservations' }),
      sortHeader('Prints', 'prints', 'num'),
      sortHeader('Filament used', 'grams', 'num'),
      el('th', { scope: 'col', text: 'Materials' }),
      el('th', { scope: 'col', className: 'num', text: 'Not counted' }))),
    el('tbody', {}, rows)));
}

function renderUnattributed() {
  const u = state.data.unattributed;
  $('#unattributed-sum').textContent = state.data.available ? `${u.prints} prints · ${fmtGrams(u.grams)}` : '';
  $('#unattributed').replaceChildren(u.list.length
    ? el('table', {},
      el('thead', {}, el('tr', {}, ['Started', 'Printer', 'Print', 'Status', 'Filament'].map((h, i) => el('th', { scope: 'col', className: i === 4 ? 'num' : null, text: h })))),
      el('tbody', {}, u.list.map((p) => el('tr', {},
        el('td', { className: 'time', text: fmtDateTime(p.start) }),
        el('td', { text: p.printer }),
        el('td', { text: p.title }),
        el('td', { text: (METHOD[p.method] || (() => p.status))(p) }),
        el('td', { className: 'num', text: fmtGrams(p.usedGrams) })))))
    : el('p', { className: 'empty', text: 'Every print in this range overlapped a reservation.' }));
}

function render() {
  $('#demo-badge').hidden = !state.data.demo;
  renderBanners();
  renderTiles();
  renderUsers();
  renderUnattributed();
  $('#updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

// ---------------------------------------------------------------- data

function saveUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('from', $('#from').value);
  url.searchParams.set('to', $('#to').value);
  const q = $('#search').value.trim();
  if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
  url.searchParams.set('sort', `${state.sort.key}-${state.sort.dir}`);
  history.replaceState(null, '', url);
}

let loadSeq = 0;
async function load({ force = false } = {}) {
  const from = $('#from').value;
  const to = $('#to').value;
  if (!from || !to) return;
  saveUrl();
  const seq = ++loadSeq;
  state.loading = true;
  $('#users').classList.add('is-loading');
  $('#refresh').disabled = true;
  $('#updated').textContent = 'Loading…';
  try {
    const res = await fetch(`/api/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${force ? '&refresh=1' : ''}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    if (seq !== loadSeq) return;
    state.data = json;
    render();
  } catch (err) {
    if (seq !== loadSeq) return;
    $('#banners').replaceChildren(banner('icon-bad', '✕', 'Could not load filament usage', err.message));
    $('#updated').textContent = '';
  } finally {
    if (seq === loadSeq) {
      state.loading = false;
      $('#users').classList.remove('is-loading');
      $('#refresh').disabled = false;
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
  if (['name', 'prints', 'grams'].includes(key) && ['asc', 'desc'].includes(dir)) state.sort = { key, dir };

  $('#controls').addEventListener('submit', (e) => e.preventDefault());
  $('#from').addEventListener('change', () => load());
  $('#to').addEventListener('change', () => load());
  $('#refresh').addEventListener('click', () => load({ force: true }));
  for (const btn of document.querySelectorAll('.presets [data-days]')) {
    btn.addEventListener('click', () => {
      $('#to').value = isoToday();
      $('#from').value = shift(isoToday(), -(Number(btn.dataset.days) - 1));
      load();
    });
  }
  $('#search').addEventListener('input', () => { saveUrl(); if (state.data) renderUsers(); });
  $('#show-events').addEventListener('change', () => { if (state.data) renderUsers(); });

  load();
}

init().catch((err) => {
  $('#banners').replaceChildren(banner('icon-bad', '✕', 'PrintBuster failed to start', err.message));
});
