'use strict';

const $ = (sel) => document.querySelector(sel);
// `status` is the import's; `admin` is the collection, Bambu and usage.
const state = { config: null, status: null, admin: null, timer: null };
// How often the page checks on an import while one is running.
const POLL_MS = 1000;

// ---------------------------------------------------------------- helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const fmtDay = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
  .format(new Date(`${iso}T12:00:00Z`));
const fmtDateTime = (iso) => new Intl.DateTimeFormat('en-US', {
  timeZone: state.config.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(iso));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function shift(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const daysIn = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000) + 1;

const icon = (cls, text) => el('span', { className: `icon ${cls}`, 'aria-hidden': 'true', text });

function banner(iconCls, glyph, title, message) {
  return el('div', { className: 'banner', role: iconCls === 'icon-bad' ? 'alert' : null },
    icon(iconCls, glyph),
    el('div', { className: 'banner-body' }, el('strong', { text: title }), message ? el('p', { text: message }) : null));
}

const errorText = (e) => [e?.message, e?.hint].filter(Boolean).join(' ');

async function api(path, body) {
  const res = body === undefined
    ? await fetch(path)
    : await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(errorText(json.error) || `HTTP ${res.status}`);
  return json;
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

// ---------------------------------------------------------------- render

function renderRangeNote() {
  const from = $('#from').value;
  const to = $('#to').value;
  if (!from || !to) { $('#range-note').textContent = ''; return; }
  if (from > to) { $('#range-note').textContent = 'The start date is after the end date.'; return; }
  const n = daysIn(from, to);
  const max = state.status?.maxDays ?? 366;
  $('#range-note').textContent = n > max
    ? `${plural(n, 'day')}: pick at most ${max}.`
    : `${plural(n, 'day')}, up to ${plural(n, 'agenda request')}.`;
}

function renderSaved() {
  const a = state.status.reservationArchive;
  $('#saved').textContent = !a || !a.days
    ? 'No reservations are saved yet.'
    : `${plural(a.days, 'day')} saved, from ${fmtDay(a.since)} to ${fmtDay(a.until)}${state.config.demo ? ' (demo mode keeps them in memory only)' : ''}.`;
  $('#banners').replaceChildren(...[
    state.config.demo ? banner('icon-info', 'i', 'Showing demo data',
      'Imports read the generated demo agenda and are kept in memory only.') : null,
    a?.writeError ? banner('icon-partial', '!', 'Reservations could not be saved', `${a.writeError}.`) : null,
  ].filter(Boolean));
}

function jobSummary(job) {
  const done = job.read + job.failed.length;
  const read = job.state === 'running' ? `read ${done} of ${plural(job.toRead, 'day')}` : `read ${plural(job.read, 'day')}`;
  return [
    `${fmtDay(job.from)} – ${fmtDay(job.to)}: ${read}, ${plural(job.reservations, 'reservation')}`,
    job.skipped ? `${job.skipped} already final, skipped` : null,
    job.failed.length ? `${job.failed.length} failed` : null,
  ].filter(Boolean).join(' · ');
}

function renderJob() {
  const job = state.status.job;
  const running = job?.state === 'running';
  $('#start').disabled = running;
  $('#stop').hidden = !running;
  $('#stop').disabled = Boolean(job?.stopReason);
  $('#progress').hidden = !job;
  if (!job) return;

  const done = job.read + job.failed.length;
  const share = job.toRead ? done / job.toRead : 1;
  const bar = $('.progress-bar');
  bar.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  bar.firstElementChild.style.width = `${share * 100}%`;

  let status;
  if (running) status = job.stopReason ? 'Stopping after the days being read…' : `Importing… started ${fmtDateTime(job.startedAt)}`;
  else if (job.stopReason === 'failing') status = 'Stopped: Design Hub failed several days in a row.';
  else if (job.stopReason === 'stopped') status = `Stopped ${fmtDateTime(job.finishedAt)}.`;
  else status = `Finished ${fmtDateTime(job.finishedAt)}.`;
  const recalc = job.totalRecalculation;
  $('#progress-text').replaceChildren(...[
    el('strong', { text: status }), ' ', jobSummary(job), '.',
    recalc ? el('br') : null,
    recalc?.ok ? `All-time usage recalculated: ${plural(recalc.prints, 'print')} saved.` : null,
    recalc && !recalc.ok ? `All-time usage could not be recalculated: ${errorText(recalc.error)}` : null,
  ].filter((c) => c !== null));

  $('#failed').replaceChildren(job.failed.length
    ? el('table', {},
      el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Day not read' }), el('th', { scope: 'col', text: 'Why' }))),
      el('tbody', {}, job.failed.map((f) => el('tr', {},
        el('td', { className: 'time', text: fmtDay(f.date) }),
        el('td', { text: errorText(f.error) })))))
    : '');
}

function render() {
  renderSaved();
  renderJob();
  renderRangeNote();
}

// ---------------------------------------------------------------- collection, Bambu and usage

const fmtClock = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: state.config.timezone, hour: 'numeric', minute: '2-digit' })
  .format(new Date(iso));

function sourceItem(name, found) {
  if (!found) return el('li', {}, icon('icon-info', 'i'), `${name}: not checked yet`);
  return found.ok
    ? el('li', {}, icon('icon-ok', '✓'), `${name}: read`)
    : el('li', {}, icon('icon-bad', '✕'), `${name}: ${errorText(found.error)}`);
}

function renderAdmin() {
  const a = state.admin;
  const c = a.collected;
  $('#schedule').textContent = scheduleText(a.collector);
  $('#collect-status').replaceChildren(
    el('li', {}, c ? `Last collected ${fmtDateTime(c.at)}` : 'Not collected yet',
      a.collector.running ? ' · collecting now…' : '',
      a.collector.nextRunAt ? ` · next ${fmtClock(a.collector.nextRunAt)}` : ''),
    sourceItem('Design Hub', c?.designhub),
    sourceItem('Bambu', c?.bambu),
  );

  const b = a.bambu;
  const pending = !a.demo && b.pending;
  $('#bambu-form').hidden = !pending;
  $('#bambu-restart').textContent = b.pending === 'tfa' ? 'Start over' : 'Send a new code';
  $('#bambu-status').textContent = a.demo ? 'Demo mode doesn\u2019t sign in to Bambu.'
    : !b.configured ? 'Bambu sign-in isn\u2019t configured. Set BAMBU_EMAIL and BAMBU_PASSWORD, or BAMBU_ACCESS_TOKEN, in .env.'
      : b.pending === 'tfa' ? 'Bambu needs the code from your two-factor authenticator app.'
        : b.pending ? `Bambu emailed a verification code${b.email ? ` to ${b.email}` : ''}. Enter it to finish signing in.`
          : b.authenticated ? `Signed in${b.email ? ` as ${b.email}` : ''}.`
            : 'Not signed in yet. PrintBuster signs in at the next collection.';

  const u = a.usageLog;
  const last = u?.lastTotalRecalculation;
  $('#usage-status').textContent = !u ? ''
    : [`${plural(u.prints, 'print')} with saved usage`,
      last ? `total last recalculated ${fmtDateTime(last.at)}` : 'total not recalculated yet'].join(' · ');
}

async function loadAdmin() {
  try {
    state.admin = await api('/api/admin/status');
    renderAdmin();
  } catch (err) {
    $('#collect-msg').textContent = `Could not load the status: ${err.message}`;
  }
}

// Runs `fn` with `button` disabled, showing its outcome in `msg`.
async function action(button, msg, busyText, fn) {
  button.disabled = true;
  msg.textContent = busyText;
  try {
    msg.textContent = (await fn()) || '';
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

const collectNow = () => action($('#collect-now'), $('#collect-msg'), 'Collecting…', async () => {
  state.admin = await api('/api/admin/collect', {});
  renderAdmin();
  return `Collected ${fmtClock(state.admin.collected.at)}.`;
});

const recalculateTotal = () => action($('#recalc-total'), $('#usage-msg'), 'Recalculating…', async () => {
  const { usageLog } = await api('/api/usage/recalculate-total', {});
  state.admin.usageLog = usageLog;
  renderAdmin();
  return `Recalculated ${plural(usageLog.lastTotalRecalculation.prints, 'print')}.`;
});

async function bambuCode(e) {
  e.preventDefault();
  await action($('#bambu-verify'), $('#bambu-msg'), 'Checking the code…', async () => {
    await api('/api/bambu/code', { code: $('#bambu-code').value });
    $('#bambu-code').value = '';
    return 'Signed in.';
  });
  await loadAdmin();
}

async function bambuRestart() {
  const tfa = state.admin.bambu.pending === 'tfa';
  await action($('#bambu-restart'), $('#bambu-msg'), '', async () => {
    await api('/api/bambu/restart', {});
    return tfa ? 'Started over. Enter the current code from your authenticator app.' : 'A new code is on its way.';
  });
  await loadAdmin();
}

// ---------------------------------------------------------------- data

// Checks on the import every second while it runs.
function schedule() {
  clearTimeout(state.timer);
  if (state.status?.job?.state === 'running') state.timer = setTimeout(poll, POLL_MS);
}

async function poll() {
  try {
    state.status = await api('/api/admin/import');
    render();
  } catch (err) {
    $('#banners').replaceChildren(banner('icon-bad', '✕', 'Could not check the import', err.message));
  }
  schedule();
}

async function startImport(e) {
  e.preventDefault();
  const from = $('#from').value;
  const to = $('#to').value;
  $('#start').disabled = true;
  try {
    state.status = await api('/api/admin/import', {
      from, to, skipFinal: $('#skip-final').checked, recalculateTotal: $('#after-recalc').checked,
    });
    render();
  } catch (err) {
    $('#start').disabled = false;
    $('#banners').replaceChildren(banner('icon-bad', '✕', 'Could not start the import', err.message));
  }
  schedule();
}

async function stopImport() {
  $('#stop').disabled = true;
  try {
    state.status = await api('/api/admin/import/stop', {});
    render();
  } catch (err) {
    $('#banners').replaceChildren(banner('icon-bad', '✕', 'Could not stop the import', err.message));
  }
}

async function init() {
  applyTheme(storedTheme());
  $('#theme-btn').addEventListener('click', () => applyTheme(THEMES[(THEMES.indexOf(storedTheme()) + 1) % THEMES.length]));
  state.config = await (await fetch('/api/config')).json();
  $('#demo-badge').hidden = !state.config.demo;

  // Defaults to the 30 finished days before today.
  const yesterday = shift(state.config.today, -1);
  $('#to').value = yesterday;
  $('#from').value = shift(yesterday, -29);
  for (const btn of document.querySelectorAll('.presets [data-days]')) {
    btn.addEventListener('click', () => {
      const to = $('#to').value || yesterday;
      $('#to').value = to;
      $('#from').value = shift(to, -(Number(btn.dataset.days) - 1));
      renderRangeNote();
    });
  }
  $('#from').addEventListener('input', renderRangeNote);
  $('#to').addEventListener('input', renderRangeNote);
  $('#import-form').addEventListener('submit', startImport);
  $('#stop').addEventListener('click', stopImport);
  $('#collect-now').addEventListener('click', collectNow);
  $('#recalc-total').addEventListener('click', recalculateTotal);
  $('#bambu-form').addEventListener('submit', bambuCode);
  $('#bambu-restart').addEventListener('click', bambuRestart);
  // Shows each collection's result as the server finishes it.
  liveUpdates(loadAdmin);
  await Promise.all([loadAdmin(), poll()]);
}

init().catch((err) => {
  $('#banners').replaceChildren(banner('icon-bad', '✕', 'Could not load the admin page', err.message));
});
