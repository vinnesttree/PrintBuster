import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { SourceError } from './errors.js';
import { JsonFileStore } from './files.js';

// PrintBuster's own logins: accounts (data/accounts.json) and signed-in
// sessions (data/sessions.json). Both files are readable only by their
// owner. Passwords are kept only as salted scrypt hashes, and sessions only
// as SHA-256 hashes of their tokens, so neither file holds anything that can
// be used to sign in. Nothing here is ever sent to a browser except a
// session token in its own HttpOnly cookie.

const scrypt = promisify(crypto.scrypt);

export const ROLES = ['admin', 'staff'];
export const MIN_PASSWORD_LENGTH = 10;
// Long enough for any passphrase, short enough to bound the hashing work.
export const MAX_PASSWORD_LENGTH = 256;
const USERNAME = /^[a-z0-9][a-z0-9._@-]{0,63}$/;

// scrypt with N = 2^15, r = 8, p = 3: one of OWASP's recommended settings
// (32 MiB of memory per hash). Kept with each hash so it can change later.
export const SCRYPT = { N: 2 ** 15, r: 8, p: 3, keylen: 64 };

const scryptOptions = ({ N, r, p }) => ({ N, r, p, maxmem: 256 * N * r + 1024 * 1024 });

// NFKC, so the same password typed on another keyboard or system matches.
const normalizePassword = (password) => String(password).normalize('NFKC');

export async function hashPassword(password, params = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(normalizePassword(password), salt, params.keylen, scryptOptions(params));
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every((n) => Number.isSafeInteger(n) && n > 0)) return false;
  const expected = Buffer.from(hash, 'base64url');
  let key;
  try {
    key = await scrypt(normalizePassword(password), Buffer.from(salt, 'base64url'), expected.length, scryptOptions(params));
  } catch {
    return false;
  }
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

export const normalizeUsername = (name) => String(name ?? '').trim().toLowerCase();

export function checkUsername(name) {
  const clean = normalizeUsername(name);
  if (!USERNAME.test(clean)) {
    throw new SourceError('Usernames are 1 to 64 letters, digits, dots, dashes, underscores or @, starting with a letter or digit.', { code: 'bad_username' });
  }
  return clean;
}

export function checkPassword(password, username) {
  if (typeof password !== 'string') throw new SourceError('The password must be text.', { code: 'bad_password' });
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) {
    throw new SourceError(`Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`, { code: 'bad_password' });
  }
  if (length > MAX_PASSWORD_LENGTH) {
    throw new SourceError(`Passwords can be at most ${MAX_PASSWORD_LENGTH} characters.`, { code: 'bad_password' });
  }
  if (username && normalizeUsername(password) === normalizeUsername(username)) {
    throw new SourceError('The password can’t be the username.', { code: 'bad_password' });
  }
}

function checkRole(role) {
  if (!ROLES.includes(role)) throw new SourceError(`The role must be one of: ${ROLES.join(', ')}.`, { code: 'bad_role' });
  return role;
}

// What may be shown about an account: never its password hash.
export const publicAccount = (a) => ({
  username: a.username, role: a.role, createdAt: a.createdAt, passwordChangedAt: a.passwordChangedAt, lastLoginAt: a.lastLoginAt || null,
});

export class AccountStore extends JsonFileStore {
  constructor(file, { now = () => Date.now(), scryptParams = SCRYPT } = {}) {
    super(file, 'accounts');
    this.now = now;
    this.scryptParams = scryptParams;
    this.accounts = new Map();
    // Checked against when the username doesn't exist, so a wrong username
    // takes as long as a wrong password and doesn't reveal which accounts exist.
    this.dummyHash = null;
  }

  async load() {
    const saved = await this.readJson();
    for (const a of saved?.accounts || []) {
      if (USERNAME.test(a?.username || '') && ROLES.includes(a.role) && typeof a.passwordHash === 'string') {
        this.accounts.set(a.username, a);
      }
    }
  }

  save() {
    return this.persist(() => ({
      accounts: [...this.accounts.values()].sort((a, b) => a.username.localeCompare(b.username)),
    }));
  }

  get count() {
    return this.accounts.size;
  }

  get adminCount() {
    return [...this.accounts.values()].filter((a) => a.role === 'admin').length;
  }

  get(username) {
    return this.accounts.get(normalizeUsername(username)) || null;
  }

  list() {
    return [...this.accounts.values()].map(publicAccount).sort((a, b) => a.username.localeCompare(b.username));
  }

  // The account when the username and password match, else null.
  async verify(username, password) {
    const account = typeof username === 'string' ? this.get(username) : null;
    if (!account) {
      this.dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'), this.scryptParams);
      await verifyPassword(String(password), await this.dummyHash);
      return null;
    }
    return (await verifyPassword(String(password), account.passwordHash)) ? account : null;
  }

  async create({ username, password, role }) {
    const name = checkUsername(username);
    checkRole(role);
    checkPassword(password, name);
    if (this.accounts.has(name)) throw new SourceError(`There is already an account called ${name}.`, { code: 'account_exists' });
    const passwordHash = await hashPassword(password, this.scryptParams);
    // Checked again: another request may have created it while hashing.
    if (this.accounts.has(name)) throw new SourceError(`There is already an account called ${name}.`, { code: 'account_exists' });
    const at = new Date(this.now()).toISOString();
    const account = { username: name, role, passwordHash, createdAt: at, passwordChangedAt: at, lastLoginAt: null };
    this.accounts.set(name, account);
    await this.save();
    return account;
  }

  require(username) {
    const account = this.get(username);
    if (!account) throw new SourceError('There is no such account.', { code: 'no_account' });
    return account;
  }

  async setPassword(username, password) {
    const account = this.require(username);
    checkPassword(password, account.username);
    const passwordHash = await hashPassword(password, this.scryptParams);
    // The account may have been deleted while hashing.
    if (this.accounts.get(account.username) !== account) throw new SourceError('There is no such account.', { code: 'no_account' });
    account.passwordHash = passwordHash;
    account.passwordChangedAt = new Date(this.now()).toISOString();
    await this.save();
    return account;
  }

  async setRole(username, role) {
    const account = this.require(username);
    checkRole(role);
    if (account.role === 'admin' && role !== 'admin' && this.adminCount === 1) {
      throw new SourceError('This is the only admin account. Make another account an admin first.', { code: 'last_admin' });
    }
    account.role = role;
    await this.save();
    return account;
  }

  async remove(username) {
    const account = this.require(username);
    if (account.role === 'admin' && this.adminCount === 1) {
      throw new SourceError('This is the only admin account, so it can’t be deleted.', { code: 'last_admin' });
    }
    this.accounts.delete(account.username);
    await this.save();
  }

  noteLogin(account) {
    account.lastLoginAt = new Date(this.now()).toISOString();
    return this.save();
  }

  stats() {
    return { accounts: this.accounts.size, admins: this.adminCount, writeError: this.writeError };
  }
}

const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const HOUR_MS = 3600 * 1000;

// Signed-in sessions. The browser holds a random 256-bit token; only its
// hash is kept here. A session ends `idleMs` after it was last used, and
// `maxMs` after sign-in at the latest.
export class SessionStore extends JsonFileStore {
  constructor(file, { now = () => Date.now(), idleMs = 7 * 24 * HOUR_MS, maxMs = 30 * 24 * HOUR_MS } = {}) {
    super(file, 'sessions');
    this.now = now;
    this.idleMs = idleMs;
    this.maxMs = maxMs;
    this.sessions = new Map();
  }

  async load() {
    const saved = await this.readJson();
    for (const [hash, s] of Object.entries(saved?.sessions || {})) {
      if (/^[0-9a-f]{64}$/.test(hash) && typeof s?.username === 'string') this.sessions.set(hash, s);
    }
    if (this.prune()) await this.save();
  }

  save() {
    return this.persist(() => ({ sessions: Object.fromEntries(this.sessions) }));
  }

  expiresAt(s) {
    return Math.min(s.lastSeenAt + this.idleMs, s.createdAt + this.maxMs);
  }

  // Drops ended sessions; true when there were any.
  prune() {
    const now = this.now();
    let dropped = false;
    for (const [hash, s] of this.sessions) {
      if (this.expiresAt(s) <= now) {
        this.sessions.delete(hash);
        dropped = true;
      }
    }
    return dropped;
  }

  async create(username) {
    this.prune();
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    this.sessions.set(tokenHash(token), { username, createdAt: now, lastSeenAt: now });
    await this.save();
    return token;
  }

  // The live session for `token` (with its hash as `id`), or null. Use
  // keeps it alive; that is saved at most hourly.
  lookup(token) {
    if (typeof token !== 'string' || !token || token.length > 100) return null;
    const id = tokenHash(token);
    const s = this.sessions.get(id);
    if (!s) return null;
    const now = this.now();
    if (this.expiresAt(s) <= now) {
      this.sessions.delete(id);
      this.save();
      return null;
    }
    let renewed = false;
    if (now - s.lastSeenAt > HOUR_MS) {
      s.lastSeenAt = now;
      renewed = true;
      this.save();
    }
    return { id, ...s, expiresAt: this.expiresAt(s), renewed };
  }

  revoke(token) {
    if (typeof token !== 'string' || !this.sessions.delete(tokenHash(token))) return this.queue;
    return this.save();
  }

  // Ends every session of `username`, except the one with id `exceptId`.
  revokeUser(username, { exceptId = null } = {}) {
    let changed = false;
    for (const [id, s] of this.sessions) {
      if (s.username === username && id !== exceptId) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    return changed ? this.save() : this.queue;
  }

  stats() {
    return { sessions: this.sessions.size, writeError: this.writeError };
  }
}

// Failed sign-ins per username and per address, in a sliding window.
// Over the limit, sign-in is refused (even with the right password) until
// the window has passed.
export class LoginLimiter {
  constructor({ now = () => Date.now(), windowMs = 15 * 60 * 1000, perUser = 5, perAddress = 20 } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.limits = { user: perUser, address: perAddress };
    this.failures = new Map();
  }

  recent(key) {
    const since = this.now() - this.windowMs;
    const list = (this.failures.get(key) || []).filter((t) => t > since);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  // Seconds until a sign-in may be tried again, or 0 when it may now.
  retryAfter({ user, address }) {
    let wait = 0;
    for (const [kind, key] of [['user', `u:${user}`], ['address', `a:${address}`]]) {
      const list = this.recent(key);
      if (list.length >= this.limits[kind]) {
        wait = Math.max(wait, list[list.length - this.limits[kind]] + this.windowMs - this.now());
      }
    }
    return Math.ceil(wait / 1000);
  }

  fail({ user, address }) {
    for (const key of [`u:${user}`, `a:${address}`]) this.failures.set(key, [...this.recent(key), this.now()]);
    // Keeps the map from growing without bound under a spray of usernames.
    if (this.failures.size > 10000) for (const key of this.failures.keys()) this.recent(key);
  }

  succeed({ user }) {
    this.failures.delete(`u:${user}`);
  }
}
