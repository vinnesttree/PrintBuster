'use strict';

const $ = (sel) => document.querySelector(sel);
// `status` is the import's; `admin` is the collection, Bambu and usage.
// `history` is the Bambu history import's.
const state = { config: null, status: null, admin: null, history: null, timer: null, historyTimer: null, accounts: { accounts: [], me: null } };
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
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const fmtDate = (iso) => new Intl.DateTimeFormat('en-US', {
  timeZone: state.config.timezone, month: 'short', day: 'numeric', year: 'numeric',
}).format(new Date(iso));

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
    ? await apiFetch(path)
    : await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  const bar = $('#progress .progress-bar');
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

// ---------------------------------------------------------------- Bambu history

const HISTORY_STOPPED = {
  stopped: 'Stopped',
  page_limit: 'Stopped at the page limit (BAMBU_HISTORY_MAX_PAGES); older prints were not read',
  incomplete: 'Stopped: Bambu sent the same page again, so older prints could not be read',
};

function renderHistory() {
  const h = state.history;
  const log = h.printLog;
  $('#history-log').textContent = state.config.demo ? 'Demo mode keeps no print log.'
    : !log || !log.prints ? 'The print log is empty.'
      : `${plural(log.prints, 'print')} in the print log${log.since ? `, observed since ${fmtDate(log.since)}` : ''}.`;
  const job = h.job;
  const running = job?.state === 'running';
  $('#history-start').disabled = running || state.config.demo;
  $('#history-stop').hidden = !running;
  $('#history-stop').disabled = Boolean(job?.stopReason);
  $('#history-progress').hidden = !job;
  if (!job) return;

  const share = job.state === 'done' ? 1 : job.total ? Math.min(1, job.prints / job.total) : 0;
  const bar = $('#history-progress .progress-bar');
  bar.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  bar.firstElementChild.style.width = `${share * 100}%`;

  let status;
  if (running) status = job.stopReason ? 'Stopping after the page being read…' : `Importing… started ${fmtDateTime(job.startedAt)}`;
  else if (job.state === 'failed') status = `Failed ${fmtDateTime(job.finishedAt)}: ${errorText(job.error)}`;
  else if (job.state === 'stopped') status = `${HISTORY_STOPPED[job.stopReason] || 'Stopped'} (${fmtDateTime(job.finishedAt)}).`;
  else status = `Finished ${fmtDateTime(job.finishedAt)}.`;
  const summary = [
    `Read ${job.total !== null && job.state !== 'done' ? `${job.prints.toLocaleString('en-US')} of ${plural(job.total, 'print')}` : plural(job.prints, 'print')}`
      + (job.oldest ? `, back to ${fmtDate(job.oldest)}` : ''),
    `${job.added.toLocaleString('en-US')} new to the print log`,
  ].join(' · ');
  const recalc = job.totalRecalculation;
  $('#history-text').replaceChildren(...[
    el('strong', { text: status }), ' ', summary, '.',
    recalc ? el('br') : null,
    recalc?.ok ? `All-time usage recalculated: ${plural(recalc.prints, 'print')} saved.` : null,
    recalc && !recalc.ok ? `All-time usage could not be recalculated: ${errorText(recalc.error)}` : null,
  ].filter((c) => c !== null));
}

// Checks on the history import every second while it runs.
function scheduleHistory() {
  clearTimeout(state.historyTimer);
  if (state.history?.job?.state === 'running') state.historyTimer = setTimeout(pollHistory, POLL_MS);
}

async function pollHistory() {
  try {
    state.history = await api('/api/admin/bambu-history');
    renderHistory();
  } catch (err) {
    $('#history-msg').textContent = `Could not check the Bambu history import: ${err.message}`;
  }
  scheduleHistory();
}

async function startHistory() {
  $('#history-start').disabled = true;
  $('#history-msg').textContent = '';
  try {
    state.history = await api('/api/admin/bambu-history', { recalculateTotal: $('#history-recalc').checked });
    renderHistory();
  } catch (err) {
    $('#history-start').disabled = false;
    $('#history-msg').textContent = err.message;
  }
  scheduleHistory();
}

async function stopHistory() {
  $('#history-stop').disabled = true;
  try {
    state.history = await api('/api/admin/bambu-history/stop', {});
    renderHistory();
  } catch (err) {
    $('#history-msg').textContent = err.message;
  }
}

// ---------------------------------------------------------------- accounts

const ROLES = { admin: 'Admin', staff: 'Staff' };

function roleSelect(a) {
  const select = el('select', { 'aria-label': `Role of ${a.username}` },
    Object.entries(ROLES).map(([value, label]) => el('option', { value, selected: value === a.role }, label)));
  select.addEventListener('change', () => accountAction(
    () => api('/api/accounts/role', { username: a.username, role: select.value }),
    `${a.username} is now ${ROLES[select.value].toLowerCase()}.`,
  ));
  return select;
}

// "Set password" opens a box for the new one in the account's row.
function passwordCell(a) {
  const cell = el('div', { className: 'assign-cell' });
  const open = () => {
    const input = el('input', {
      type: 'password', minlength: '10', maxlength: '256', autocomplete: 'new-password', placeholder: 'New password',
      'aria-label': `New password for ${a.username}`, required: true,
    });
    const form = el('form', {
      className: 'assign-form',
      onsubmit: (e) => {
        e.preventDefault();
        accountAction(() => api('/api/accounts/password', { username: a.username, password: input.value }),
          `Password set for ${a.username}${a.username === state.accounts.me ? '' : '; they were signed out everywhere'}.`);
      },
    }, input,
    el('button', { className: 'btn btn-small', type: 'submit' }, 'Save'),
    el('button', { className: 'btn btn-small', type: 'button', onclick: () => cell.replaceChildren(...buttons()) }, 'Cancel'));
    cell.replaceChildren(form);
    input.focus();
  };
  const buttons = () => [
    el('button', { className: 'btn btn-small', type: 'button', onclick: open }, 'Set password'),
    el('button', {
      className: 'btn btn-small', type: 'button',
      onclick: () => {
        const self = a.username === state.accounts.me;
        if (!window.confirm(self ? 'Delete your own account? You will be signed out.' : `Delete the account ${a.username}?`)) return;
        accountAction(() => api('/api/accounts/delete', { username: a.username }), `Deleted ${a.username}.`);
      },
    }, 'Delete'),
  ];
  cell.append(...buttons());
  return cell;
}

function renderAccounts() {
  const { accounts, me } = state.accounts;
  $('#account-list').replaceChildren(accounts.length
    ? el('table', {},
      el('thead', {}, el('tr', {}, ['Username', 'Role', 'Created', 'Last sign-in', ''].map((h) => el('th', { scope: 'col', text: h })))),
      el('tbody', {}, accounts.map((a) => el('tr', {},
        el('td', { className: 'member-name' }, a.username, a.username === me ? el('span', { className: 'tag', text: 'You' }) : null),
        el('td', {}, roleSelect(a)),
        el('td', { className: 'time', text: fmtDateTime(a.createdAt) }),
        el('td', { className: 'time', text: a.lastLoginAt ? fmtDateTime(a.lastLoginAt) : 'Never' }),
        el('td', {}, passwordCell(a))))))
    : el('p', { className: 'empty', text: 'No accounts yet. Demo mode is open to anyone until you add one.' }));
}

async function loadAccounts() {
  try {
    state.accounts = await api('/api/accounts');
    renderAccounts();
  } catch (err) {
    $('#account-msg').textContent = `Could not load the accounts: ${err.message}`;
  }
}

// Runs an account change, then shows the list as the server has it.
async function accountAction(fn, done) {
  const msg = $('#account-msg');
  msg.textContent = 'Saving…';
  try {
    const result = await fn();
    msg.textContent = done;
    if (result.accounts) state.accounts = { ...state.accounts, accounts: result.accounts };
  } catch (err) {
    msg.textContent = err.message;
  }
  // A change can end this sign-in (deleting yourself), or the open demo
  // mode (adding its first account): reloading then goes to the sign-in page.
  await loadAccounts();
}

async function addAccount(e) {
  e.preventDefault();
  const username = $('#new-username').value.trim();
  const first = !state.accounts.accounts.length;
  await accountAction(async () => {
    const result = await api('/api/accounts', { username, password: $('#new-password').value, role: $('#new-role').value });
    $('#account-form').reset();
    return result;
  }, first ? `Added ${username}. Sign-in is now required: sign in with it.` : `Added ${username}.`);
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
  state.config = await (await apiFetch('/api/config')).json();
  $('#demo-badge').hidden = !state.config.demo;
  const session = await currentSession();
  if (!session.open && session.user?.role !== 'admin') {
    for (const section of document.querySelectorAll('main > section')) section.hidden = true;
    $('#banners').replaceChildren(banner('icon-info', 'i', 'Only admins can use this page',
      'Ask an admin if you need data collected, reservations imported or an account changed.'));
    return;
  }

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
  $('#account-form').addEventListener('submit', addAccount);
  $('#history-start').addEventListener('click', startHistory);
  $('#history-stop').addEventListener('click', stopHistory);
  // Shows each collection's result as the server finishes it.
  liveUpdates(loadAdmin);
  await Promise.all([loadAdmin(), poll(), pollHistory(), loadAccounts()]);
}

init().catch((err) => {
  $('#banners').replaceChildren(banner('icon-bad', '✕', 'Could not load the admin page', err.message));
});
