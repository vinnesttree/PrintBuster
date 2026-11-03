'use strict';

const $ = (sel) => document.querySelector(sel);

// Where to go after signing in: one of PrintBuster's own pages (the server
// checks this too).
const PAGES = ['/', '/index.html', '/usage.html', '/admin.html', '/account.html'];
function nextPage() {
  const raw = new URL(window.location.href).searchParams.get('next') || '/';
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin === window.location.origin && PAGES.includes(url.pathname)) return url.pathname + url.search;
  } catch { /* not a URL */ }
  return '/';
}

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

function notice(title, text) {
  const box = document.createElement('div');
  box.className = 'banner';
  const icon = Object.assign(document.createElement('span'), { className: 'icon icon-info', textContent: 'i' });
  icon.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div');
  body.className = 'banner-body';
  body.append(Object.assign(document.createElement('strong'), { textContent: title }), Object.assign(document.createElement('p'), { textContent: text }));
  box.append(icon, body);
  return box;
}

async function signIn(e) {
  e.preventDefault();
  const button = $('#signin');
  button.disabled = true;
  $('#signin-msg').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#username').value, password: $('#password').value, next: nextPage() }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    window.location.assign(json.next || '/');
  } catch (err) {
    $('#password').value = '';
    $('#signin-msg').textContent = err.message;
    $('#password').focus();
    button.disabled = false;
  }
}

async function init() {
  applyTheme(storedTheme());
  $('#theme-btn').addEventListener('click', () => applyTheme(THEMES[(THEMES.indexOf(storedTheme()) + 1) % THEMES.length]));
  $('#signin-form').addEventListener('submit', signIn);
  const session = await (await fetch('/api/session')).json();
  // Already signed in (or nothing to sign in to): carry on.
  if (session.user || session.open) {
    window.location.replace(nextPage());
    return;
  }
  $('#guest').hidden = !session.guestView;
  if (session.setupNeeded) {
    $('#banners').replaceChildren(notice('No accounts have been set up yet',
      'An administrator needs to set APP_USERNAME and APP_PASSWORD (at least 10 characters) in .env and restart PrintBuster. That creates the first admin account.'));
  }
  $('#username').focus();
}

init().catch((err) => {
  $('#signin-msg').textContent = `Could not reach PrintBuster: ${err.message}`;
});
