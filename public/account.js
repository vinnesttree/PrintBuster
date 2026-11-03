'use strict';

const $ = (sel) => document.querySelector(sel);

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

const ROLE_TEXT = {
  admin: 'Admin: every page, the admin tasks and the accounts.',
  staff: 'Staff: the waterfall and filament usage, including assigning prints. The Admin page is for admins.',
};

async function changePassword(e) {
  e.preventDefault();
  const msg = $('#password-msg');
  if ($('#new').value !== $('#confirm').value) {
    msg.textContent = 'The new passwords don’t match.';
    return;
  }
  $('#save').disabled = true;
  msg.textContent = 'Saving…';
  try {
    const res = await apiFetch('/api/account/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: $('#current').value, newPassword: $('#new').value }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    msg.textContent = 'Password changed. You are still signed in here, and signed out everywhere else.';
    $('#password-form').reset();
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    $('#save').disabled = false;
  }
}

async function init() {
  applyTheme(storedTheme());
  $('#theme-btn').addEventListener('click', () => applyTheme(THEMES[(THEMES.indexOf(storedTheme()) + 1) % THEMES.length]));
  const session = await currentSession();
  if (!session.user) {
    $('#me').textContent = session.open
      ? 'Demo mode has no accounts yet, so nobody signs in. Create one on the Admin page.'
      : 'You are not signed in.';
    $('#password-form').hidden = true;
    return;
  }
  $('#me').textContent = `Signed in as ${session.user.username}. ${ROLE_TEXT[session.user.role] || ''}`;
  $('#pw-username').value = session.user.username;
  $('#password-form').addEventListener('submit', changePassword);
}

init().catch((err) => {
  $('#me').textContent = `Could not load your account: ${err.message}`;
});
