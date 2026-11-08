// Sign-in plumbing for the server: the session cookie, who a request is
// from, and keeping credentials out of every response.

export const SESSION_COOKIE = 'pb_session';

export function readCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Secure when the connection is HTTPS (behind a proxy, set TRUST_PROXY so
// Express can tell), or always or never with COOKIE_SECURE.
export const isSecure = (req, setting) => (setting === 'auto' ? req.secure : setting === true);

// HttpOnly keeps page scripts from reading the token; SameSite=Strict keeps
// other sites from sending it, so they can't act as the signed-in user.
export function sessionCookie(req, setting, token, maxAgeMs) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (isSecure(req, setting)) parts.push('Secure');
  return parts.join('; ');
}

export const clearedCookie = (req, setting) => sessionCookie(req, setting, '', 0);

// What a page may know about who is signed in.
export const sessionUser = (account) => (account ? { username: account.username, role: account.role } : null);

// Each way a credential can be written: as given, URL-encoded, and
// URL-decoded (a cookie may be configured in one form and echoed in the
// other). Values under 6 characters are skipped, since they would also
// match ordinary text.
function secretForms(secrets) {
  const forms = new Set();
  for (const secret of new Set(secrets)) {
    if (typeof secret !== 'string') continue;
    let decoded = secret;
    try {
      decoded = decodeURIComponent(secret);
    } catch {
      // Not URL-encoded.
    }
    for (const value of [secret, decoded]) {
      if (value.length < 6) continue;
      forms.add(value);
      forms.add(encodeURIComponent(value));
    }
  }
  // Longest first, so a form is never left half replaced by a shorter one.
  return [...forms].sort((a, b) => b.length - a.length);
}

const replaceAll = (text, forms) => forms.reduce((out, form) => out.split(form).join('[redacted]'), text);

// Replaces every credential the server holds with "[redacted]" in plain
// text, such as a message sent to an uptime monitor.
export function redactText(text, secrets) {
  return replaceAll(String(text), secretForms(secrets));
}

// Replaces every credential the server holds with "[redacted]" in a JSON
// text. Credentials are only for collecting data; this makes sure that one
// echoed back in an upstream error message, say, never reaches a browser.
export function redactSecrets(text, secrets) {
  // As each form appears inside a JSON string.
  const out = replaceAll(text, secretForms(secrets).map((form) => JSON.stringify(form).slice(1, -1)));
  if (out === text) return text;
  try {
    JSON.parse(out);
    return out;
  } catch {
    // Only a credential made of JSON punctuation could get here.
    return JSON.stringify({ error: { message: 'This response was withheld because it contained a credential.', code: 'redacted' } });
  }
}

// Where to go after signing in: one of PrintBuster's own pages only, so a
// crafted link can't send someone to another site.
const PAGES = new Set(['/', '/index.html', '/usage.html', '/admin.html', '/account.html']);
export function safeNext(next) {
  if (typeof next !== 'string') return '/';
  let url;
  try {
    url = new URL(next, 'http://printbuster.invalid');
  } catch {
    return '/';
  }
  if (url.origin !== 'http://printbuster.invalid' || !PAGES.has(url.pathname)) return '/';
  return url.pathname + url.search;
}
