'use strict';

// Live updates, shared by both pages. While the page is visible it holds an
// event stream to the server. That tells the server someone is watching, so
// it collects from Design Hub and Bambu every couple of minutes instead of
// every quarter hour. The server says when new data is in, and the page then
// reloads its view from the server. The page itself never polls.
//
// onUpdate(status) runs after each server collection, and when the page
// comes back into view (or reconnects after the server restarted), since
// updates may have been missed meanwhile. status is the server's collection
// schedule (see Collector#status).
function liveUpdates(onUpdate) {
  let source = null;
  let connections = 0;
  const open = () => {
    if (source || document.visibilityState !== 'visible') return;
    source = new EventSource('/api/events');
    source.addEventListener('hello', (e) => {
      // The first hello is the page's own initial load; later ones follow a
      // gap in which updates may have been missed.
      if (connections++ > 0) onUpdate(JSON.parse(e.data));
    });
    source.addEventListener('update', (e) => onUpdate(JSON.parse(e.data)));
  };
  const close = () => {
    source?.close();
    source = null;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') open();
    else close();
  });
  window.addEventListener('pagehide', close);
  window.addEventListener('pageshow', open);
  open();
}

// "Checked 7:58 PM", from the time of the server's last collection.
function collectedText(collector) {
  if (!collector?.lastRunAt) return '';
  return `Checked ${new Date(collector.lastRunAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

// Explains the schedule, for a tooltip.
function scheduleText(collector) {
  if (!collector) return '';
  const every = (m) => (m ? `every ${m < 1 ? `${Math.round(m * 60)} s` : `${m} min`}` : 'never');
  const watching = collector.viewers === 1 ? '1 page is open' : `${collector.viewers} pages are open`;
  return `The server checks Design Hub and Bambu ${every(collector.activeMinutes)} while a page is open `
    + `and ${every(collector.idleMinutes)} otherwise (${watching} now).`;
}

// ---------------------------------------------------------------- sign-in

const IS_GUEST_PAGE = document.body.dataset.view === 'guest';

// Fetches from the API. When the sign-in has ended (or never was), a signed-in
// page goes to the sign-in page and comes back here afterwards.
async function apiFetch(url, init) {
  const res = await fetch(url, init);
  if (res.status === 401 && !IS_GUEST_PAGE) {
    window.location.assign(`/login.html?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    // Nothing more should happen on this page.
    return new Promise(() => {});
  }
  return res;
}

// Who is signed in, from the server: { user, open, guestView, ... }.
let sessionPromise = null;
function currentSession() {
  sessionPromise ??= fetch('/api/session').then((r) => r.json());
  return sessionPromise;
}

async function signOut() {
  try {
    await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } finally {
    window.location.assign('/login.html');
  }
}

// The top bar's account menu: your name (linking to your account page) and
// Sign out. Pages admins only can use are left out of the nav for staff.
async function accountMenu() {
  const menu = document.getElementById('account-menu');
  if (!menu) return;
  let session;
  try {
    session = await currentSession();
  } catch {
    return;
  }
  const isAdmin = session.open || session.user?.role === 'admin';
  for (const a of document.querySelectorAll('.pagenav [data-admin]')) a.hidden = !isAdmin;
  for (const a of document.querySelectorAll('.pagenav [data-guest]')) a.hidden = !session.guestView;
  if (session.open) {
    menu.replaceChildren(Object.assign(document.createElement('span'), {
      className: 'muted account-name', textContent: 'No accounts: open to anyone',
      title: 'Demo mode with no accounts needs no sign-in. Create an account on the Admin page to require one.',
    }));
    return;
  }
  if (!session.user) return;
  const name = Object.assign(document.createElement('a'), {
    href: 'account.html', className: 'account-name', textContent: session.user.username,
    title: `Signed in as ${session.user.username} (${session.user.role}). Change your password here.`,
  });
  const out = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-ghost', textContent: 'Sign out' });
  out.addEventListener('click', signOut);
  menu.replaceChildren(name, out);
}

accountMenu();
