import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { BambuClient } from './bambu.js';
import { loadConfig, loadEnvFile, ROOT_DIR } from './config.js';
import { DemoBambu, DemoDesignHub } from './demo.js';
import { DesignHubClient } from './designhub.js';
import { AccountStore, LoginLimiter, publicAccount, SessionStore } from './accounts.js';
import { AssignmentLog } from './assignments.js';
import {
  clearedCookie, readCookie, redactSecrets, safeNext, SESSION_COOKIE, sessionCookie, sessionUser,
} from './auth.js';
import { Collector } from './collector.js';
import { ReservationImport } from './importer.js';
import { BambuHistoryImport } from './bambuhistory.js';
import { describeError, SourceError } from './errors.js';
import { guestComparison, guestConfig } from './guest.js';
import { PrintLog } from './printlog.js';
import { ReservationArchive } from './reservations.js';
import { UsageLog } from './usagelog.js';
import { CompareService } from './service.js';
import { sourceHealth, SOURCES, staleAfterMs, UptimeKumaPusher } from './uptime.js';
import { isIsoDate, shiftDate, todayIn } from './time.js';

function notConfigured(code, message, hint) {
  const fail = () => Promise.reject(new SourceError(message, { code, hint }));
  return { getAgenda: fail, getReservations: fail, getDay: fail, getDevices: fail, getTasks: fail };
}

// Pages that need a sign-in; anyone without one is sent to the sign-in page.
const SIGNED_IN_PAGES = new Set(['/', '/index.html', '/usage.html', '/admin.html', '/account.html']);

// `scryptParams` is for tests only, which use cheaper password hashing.
export async function createApp(config, { fetch = globalThis.fetch, now = () => Date.now(), scryptParams } = {}) {
  let designhub;
  let bambu;
  let printLog = null;
  let reservationArchive = null;
  let usageLog = null;
  let assignments = null;
  let accounts;
  let sessions;
  const sessionOptions = { now, idleMs: config.sessionDays * 86400000, maxMs: Math.max(30, config.sessionDays) * 86400000 };
  if (config.demo) {
    designhub = new DemoDesignHub({ zone: config.timezone, now });
    bambu = new DemoBambu({ zone: config.timezone, now });
    // Demo mode keeps its saved reservations and usage in memory only.
    reservationArchive = new ReservationArchive(null);
    usageLog = new UsageLog(null);
    assignments = new AssignmentLog(null);
    accounts = new AccountStore(null, { now, scryptParams });
    sessions = new SessionStore(null, sessionOptions);
  } else {
    designhub = config.designhub.configured
      ? new DesignHubClient(config.designhub, { zone: config.timezone, fetch })
      : notConfigured('designhub_not_configured', 'Design Hub credentials are not configured.',
        'Set DESIGNHUB_USERNAME and DESIGNHUB_PASSWORD (or DESIGNHUB_COOKIE) in .env.');
    bambu = new BambuClient(config.bambu, { fetch, now });
    await bambu.init();
    printLog = new PrintLog(config.printLogPath);
    await printLog.load();
    reservationArchive = new ReservationArchive(config.reservationLogPath);
    await reservationArchive.load();
    usageLog = new UsageLog(config.usageLogPath);
    await usageLog.load();
    assignments = new AssignmentLog(config.assignmentLogPath);
    await assignments.load();
    accounts = new AccountStore(config.accountsPath, { now, scryptParams });
    await accounts.load();
    sessions = new SessionStore(config.sessionsPath, sessionOptions);
    await sessions.load();
  }
  await createFirstAdmin(config, accounts, sessions);
  const limiter = new LoginLimiter({ now });
  const service = new CompareService(config, {
    designhub, bambu, printLog, reservationArchive, usageLog, assignments, now,
  });
  const bambuStatus = () => (bambu.status ? bambu.status() : { configured: false });
  // Every credential the server holds is for collecting data only. None is
  // ever sent to a browser: every JSON response and event is checked for them.
  const secrets = () => [
    ...(designhub.secrets?.() || []), ...(bambu.secrets?.() || []), config.appPassword,
  ];

  // Open pages hold an event stream while visible. That is how the server
  // knows someone is watching, and how it tells them new data is in.
  const streams = new Set();
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${redactSecrets(JSON.stringify(data), secrets())}\n\n`);
  const kuma = new UptimeKumaPusher(config.uptimeKumaPush, { fetch, demo: config.demo });
  const collector = new Collector({
    run: () => service.collect(),
    activeMs: config.pollActiveMinutes * 60000,
    idleMs: config.pollIdleMinutes * 60000,
    now,
    onRun: () => {
      const status = collector.status();
      for (const res of streams) send(res, 'update', status);
      // Not awaited: a slow monitor must not hold up the next collection.
      if (kuma.configured) kuma.push(service.collected);
    },
  });
  service.attachCollector(collector);
  const importer = new ReservationImport(service, { now });
  const bambuHistory = new BambuHistoryImport(service, { now });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.locals.service = service;
  app.locals.collector = collector;
  app.locals.kuma = kuma;
  app.locals.importer = importer;
  app.locals.bambuHistory = bambuHistory;
  app.locals.accounts = accounts;
  app.locals.sessions = sessions;
  // Ends every open event stream, so the server can close.
  app.locals.closeStreams = () => {
    for (const res of streams) res.end();
    streams.clear();
  };

  app.use((req, res, next) => {
    res.json = (body) => {
      if (!res.get('Content-Type')) res.type('application/json');
      return res.send(redactSecrets(JSON.stringify(body), secrets()));
    };
    next();
  });

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  // Liveness probe for container healthchecks; needs no sign-in.
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Whether the last collection could read each upstream source, for uptime
  // monitors such as Uptime Kuma: 200 when up, 503 when down, not yet
  // checked, or no longer being checked. Like /healthz they need no login,
  // so they say only up or down and an error code, never names or messages.
  const staleMs = staleAfterMs({ activeMs: config.pollActiveMinutes * 60000, idleMs: config.pollIdleMinutes * 60000 });
  const health = (source) => sourceHealth(service.collected, source, { now: now(), staleMs });
  app.get('/healthz/sources', (req, res) => {
    const sources = Object.keys(SOURCES).map(health);
    const ok = sources.every((s) => s.ok);
    res.status(ok ? 200 : 503).json({ ok, sources });
  });
  for (const source of Object.keys(SOURCES)) {
    app.get(`/healthz/${source}`, (req, res) => {
      const result = health(source);
      res.status(result.ok ? 200 : 503).json(result);
    });
  }

  // API answers are per user and never cached. Requests that change
  // something must be JSON from this site: another site can't send JSON
  // without the browser asking first, and SameSite=Strict keeps the session
  // cookie off its requests anyway.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: { message: 'Requests from other sites are not allowed.', code: 'cross_site' } });
    }
    if (!req.is('application/json')) {
      return res.status(415).json({ error: { message: 'Send the request as JSON.', code: 'bad_type' } });
    }
    next();
  });

  app.use(express.json({ limit: '10kb' }));

  // Who the request is from. With no accounts at all, demo mode is open to
  // anyone (its data is generated); live mode needs an account.
  const isOpen = () => config.demo && accounts.count === 0;
  app.use((req, res, next) => {
    req.user = null;
    req.session = null;
    if (isOpen()) {
      req.user = { username: null, role: 'admin', open: true };
      return next();
    }
    const token = readCookie(req, SESSION_COOKIE);
    const session = sessions.lookup(token);
    const account = session && accounts.get(session.username);
    if (account) {
      req.session = session;
      req.user = { username: account.username, role: account.role, open: false };
      // Use keeps the sign-in alive on the server; the cookie follows.
      if (session.renewed) res.set('Set-Cookie', sessionCookie(req, config.cookieSecure, token, session.expiresAt - now()));
    }
    next();
  });

  app.use((req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && SIGNED_IN_PAGES.has(req.path) && !req.user) {
      const target = safeNext(req.originalUrl);
      return res.redirect(302, `/login.html${target === '/' ? '' : `?next=${encodeURIComponent(target)}`}`);
    }
    next();
  });

  app.use(express.static(path.join(ROOT_DIR, 'public')));

  // ------------------------------------------------ open to anyone

  app.get('/api/session', (req, res) => {
    res.json({
      user: req.user?.open ? null : sessionUser(req.user),
      open: isOpen(),
      // Live mode with no accounts yet: nobody can sign in until one exists.
      setupNeeded: !isOpen() && accounts.count === 0,
      guestView: config.guestView,
      demo: config.demo,
    });
  });

  app.post('/api/login', async (req, res) => {
    const { username, password, next } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password
      || username.length > 200 || password.length > 1024) {
      return res.status(400).json({ error: { message: 'Enter a username and password.', code: 'bad_login' } });
    }
    const who = { user: username.trim().toLowerCase(), address: req.ip };
    const wait = limiter.retryAfter(who);
    if (wait) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({
        error: { message: `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} min.`, code: 'login_limited' },
      });
    }
    const account = await accounts.verify(username, password);
    if (!account) {
      limiter.fail(who);
      console.warn(`Sign-in failed for ${JSON.stringify(who.user.slice(0, 64))} from ${req.ip}.`);
      return res.status(401).json({ error: { message: 'Wrong username or password.', code: 'bad_login' } });
    }
    limiter.succeed(who);
    // A fresh session every time, so a token set before sign-in is never reused.
    await sessions.revoke(readCookie(req, SESSION_COOKIE));
    const token = await sessions.create(account.username);
    await accounts.noteLogin(account);
    res.set('Set-Cookie', sessionCookie(req, config.cookieSecure, token, sessions.idleMs));
    res.json({ user: sessionUser(account), next: safeNext(next) });
  });

  app.post('/api/logout', async (req, res) => {
    await sessions.revoke(readCookie(req, SESSION_COOKIE));
    res.set('Set-Cookie', clearedCookie(req, config.cookieSecure));
    res.json({ ok: true });
  });

  // The guest view: the waterfall without names or print titles, with no
  // sign-in. GUEST_VIEW=false turns it off.
  const guestOnly = (req, res, next) => (config.guestView
    ? next()
    : res.status(404).json({ error: { message: 'The guest view is turned off.', code: 'guest_off' } }));

  app.get('/api/guest/config', guestOnly, (req, res) => {
    res.json(guestConfig(config, todayIn(config.timezone, new Date(now()))));
  });

  app.get('/api/guest/compare', guestOnly, async (req, res) => {
    const date = req.query.date || todayIn(config.timezone, new Date(now()));
    if (!isIsoDate(date)) {
      return res.status(400).json({ error: { message: 'date must look like YYYY-MM-DD', code: 'bad_date' } });
    }
    // Saved data only: a guest never makes the server ask Design Hub.
    res.json(guestComparison(await service.compare(date, { fillMissing: false })));
  });

  // An open page's event stream: counts as a viewer while it is connected,
  // gets "hello" now and "update" after every collection. It carries only
  // the collection schedule, so the guest view may use it too.
  app.get('/api/events', (req, res) => {
    if (!req.user && !config.guestView) {
      return res.status(401).json({ error: { message: 'Sign in to continue.', code: 'login_required' } });
    }
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      // Stops a reverse proxy such as nginx from holding events back.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const viewer = Symbol('viewer');
    streams.add(res);
    collector.addViewer(viewer);
    send(res, 'hello', collector.status());
    // Keeps idle connections from being dropped by proxies.
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    ping.unref();
    req.on('close', () => {
      clearInterval(ping);
      streams.delete(res);
      collector.removeViewer(viewer);
    });
  });

  // ------------------------------------------------ signed in only

  app.use('/api', (req, res, next) => {
    if (req.user) return next();
    const setup = accounts.count === 0;
    res.status(401).json({
      error: setup
        ? { message: 'No accounts have been set up yet.', code: 'no_accounts', hint: 'Set APP_USERNAME and APP_PASSWORD in .env and restart.' }
        : { message: 'Sign in to continue.', code: 'login_required' },
    });
  });

  const adminOnly = (req, res, next) => (req.user.role === 'admin'
    ? next()
    : res.status(403).json({ error: { message: 'Only admins can do this.', code: 'admin_only' } }));

  app.get('/api/config', (req, res) => {
    res.json({
      demo: config.demo,
      timezone: config.timezone,
      today: todayIn(config.timezone, new Date(now())),
      graceMinutes: config.graceMinutes,
      flagWeightGrams: config.flagWeightGrams,
      flagDurationHours: config.flagDurationHours,
      designhub: { configured: config.demo || config.designhub.configured, baseUrl: config.designhub.baseUrl },
      bambu: bambuStatus(),
      collector: collector.status(),
    });
  });

  app.get('/api/compare', async (req, res) => {
    const date = req.query.date || todayIn(config.timezone, new Date(now()));
    if (!isIsoDate(date)) {
      return res.status(400).json({ error: { message: 'date must look like YYYY-MM-DD', code: 'bad_date' } });
    }
    res.json(await service.compare(date, { force: req.query.refresh === '1' }));
  });

  app.get('/api/usage', async (req, res) => {
    const today = todayIn(config.timezone, new Date(now()));
    const to = req.query.to || today;
    const from = req.query.from || (isIsoDate(to) ? shiftDate(to, -29) : to);
    res.json(await service.usage(from, to, { force: req.query.refresh === '1' }));
  });

  // Re-reads the range's reservations from Design Hub (saved past days too),
  // recalculates usage and saves both.
  app.post('/api/usage/recalculate', adminOnly, async (req, res) => {
    res.json(await service.usage(req.body?.from, req.body?.to, { force: true, recalculate: true }));
  });

  // Recalculates every saved print's usage from saved data only.
  app.post('/api/usage/recalculate-total', adminOnly, async (req, res) => {
    res.json(await service.recalculateTotal());
  });

  // Charges a print with no reservation to a member ({ printId, name }), or
  // removes that with an empty name.
  app.post('/api/usage/assign', async (req, res) => {
    res.json(await service.assign(req.body?.printId, req.body?.name));
  });

  // Admin tasks. The status of the server's collection and of the Bambu
  // sign-in, and "Collect now".
  const adminStatus = () => {
    const found = service.collected;
    const source = (s) => (s ? { ok: s.ok, ...(s.ok ? {} : { error: describeError(s.error) }) } : null);
    return {
      demo: config.demo,
      collector: collector.status(),
      collected: found ? { at: new Date(found.at).toISOString(), designhub: source(found.designhub), bambu: source(found.bambu) } : null,
      bambu: bambuStatus(),
      usageLog: service.usageLog ? service.usageLog.stats() : null,
      accounts: accounts.stats(),
    };
  };
  app.use('/api/admin', adminOnly);
  app.use('/api/bambu', adminOnly);
  app.use('/api/accounts', adminOnly);
  app.get('/api/admin/status', (req, res) => res.json(adminStatus()));

  app.post('/api/admin/collect', async (req, res) => {
    await service.refreshNow();
    res.json(adminStatus());
  });

  // The bulk import reads a date range's reservations from
  // Design Hub in the background; the admin page polls its progress.
  app.get('/api/admin/import', (req, res) => res.json(importer.status()));

  app.post('/api/admin/import', (req, res) => {
    if (importer.busy) {
      return res.status(409).json({ error: { message: 'An import is already running.', code: 'import_running', hint: 'Wait for it to finish, or stop it.' } });
    }
    const { from, to, skipFinal = true, recalculateTotal = false } = req.body || {};
    res.status(202).json(importer.start({ from, to, skipFinal: skipFinal !== false, recalculateTotal: recalculateTotal === true }));
  });

  app.post('/api/admin/import/stop', (req, res) => res.json(importer.stop()));

  // Reads Bambu's whole print history into the print log, in the
  // background; the admin page polls its progress.
  app.get('/api/admin/bambu-history', (req, res) => res.json(bambuHistory.status()));

  app.post('/api/admin/bambu-history', (req, res) => {
    if (bambuHistory.busy) {
      return res.status(409).json({ error: { message: 'A Bambu history import is already running.', code: 'import_running', hint: 'Wait for it to finish, or stop it.' } });
    }
    res.status(202).json(bambuHistory.start({ recalculateTotal: req.body?.recalculateTotal === true }));
  });

  app.post('/api/admin/bambu-history/stop', (req, res) => res.json(bambuHistory.stop()));

  app.post('/api/bambu/code', async (req, res) => {
    if (!bambu.submitCode) return res.status(400).json({ error: { message: 'Not available in demo mode.' } });
    await bambu.submitCode(req.body?.code);
    service.clearCache('bambu:');
    // Signed in: collect now rather than at the next scheduled run.
    await collector.runNow();
    res.json({ bambu: bambuStatus() });
  });

  app.post('/api/bambu/restart', async (req, res) => {
    if (!bambu.restartSignIn) return res.status(400).json({ error: { message: 'Not available in demo mode.' } });
    await bambu.restartSignIn();
    service.clearCache('bambu:');
    res.json({ bambu: bambuStatus() });
  });

  // ------------------------------------------------ accounts

  // Changes your own password; your other sign-ins end.
  app.post('/api/account/password', async (req, res) => {
    if (req.user.open) throw new SourceError('No one is signed in.', { code: 'not_signed_in' });
    const { currentPassword, newPassword } = req.body || {};
    const who = { user: req.user.username, address: req.ip };
    const wait = limiter.retryAfter(who);
    if (wait) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: { message: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} min.`, code: 'login_limited' } });
    }
    if (typeof currentPassword !== 'string' || currentPassword.length > 1024 || !await accounts.verify(req.user.username, currentPassword)) {
      limiter.fail(who);
      return res.status(400).json({ error: { message: 'Your current password is wrong.', code: 'bad_password' } });
    }
    await accounts.setPassword(req.user.username, newPassword);
    await sessions.revokeUser(req.user.username, { exceptId: req.session.id });
    res.json({ ok: true });
  });

  app.get('/api/accounts', (req, res) => {
    res.json({ accounts: accounts.list(), me: req.user.username });
  });

  app.post('/api/accounts', async (req, res) => {
    const { username, password, role = 'staff' } = req.body || {};
    const account = await accounts.create({ username, password, role });
    console.log(`Account ${account.username} (${account.role}) created by ${req.user.username || 'the open demo'}.`);
    res.status(201).json({ account: publicAccount(account), accounts: accounts.list() });
  });

  // Sets someone's password (an admin resetting it); their sign-ins end,
  // except this one when it is your own.
  app.post('/api/accounts/password', async (req, res) => {
    const account = await accounts.setPassword(req.body?.username, req.body?.password);
    await sessions.revokeUser(account.username, { exceptId: req.session?.id });
    res.json({ account: publicAccount(account), accounts: accounts.list() });
  });

  app.post('/api/accounts/role', async (req, res) => {
    const account = await accounts.setRole(req.body?.username, req.body?.role);
    res.json({ account: publicAccount(account), accounts: accounts.list() });
  });

  app.post('/api/accounts/delete', async (req, res) => {
    const account = accounts.require(req.body?.username);
    await accounts.remove(account.username);
    await sessions.revokeUser(account.username);
    console.log(`Account ${account.username} deleted by ${req.user.username || 'the open demo'}.`);
    res.json({ accounts: accounts.list() });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: { message: 'Not found' } }));

  // Express 5 forwards rejected promises from async handlers here.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    // Express's own 4xx errors, such as a body that isn't valid JSON.
    const clientError = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500;
    if (!(err instanceof SourceError) && !clientError) console.error(err);
    res.status(err instanceof SourceError ? 400 : clientError ? err.status : 500).json({ error: describeError(err) });
  });

  return app;
}

// While there is no admin account, APP_USERNAME and APP_PASSWORD create
// one (or make that existing account an admin with that password). That is
// how the first account is made, and how to get back in if no admin is left.
async function createFirstAdmin(config, accounts, sessions) {
  if (accounts.adminCount > 0 || !config.appPassword) return;
  try {
    const existing = accounts.get(config.appUsername);
    if (existing) {
      await accounts.setPassword(existing.username, config.appPassword);
      await accounts.setRole(existing.username, 'admin');
      await sessions.revokeUser(existing.username);
    } else {
      await accounts.create({ username: config.appUsername, password: config.appPassword, role: 'admin' });
    }
  } catch (err) {
    throw new Error(`Could not create the admin account from APP_USERNAME and APP_PASSWORD: ${err.message}`);
  }
  if (!config.demo) {
    console.log(`Created the admin account ${accounts.get(config.appUsername).username} from APP_USERNAME and APP_PASSWORD. `
      + 'Sign in with it, then remove APP_PASSWORD from .env.');
  }
}

async function main() {
  loadEnvFile();
  const config = loadConfig();
  const app = await createApp(config);
  const server = app.listen(config.port, config.host, () => {
    const { port } = server.address();
    // On 0.0.0.0 (as in Docker) the reachable address depends on port publishing.
    console.log(config.host === '0.0.0.0'
      ? `PrintBuster listening on all interfaces, port ${port}`
      : `PrintBuster running at http://${config.host}:${port}/`);
    if (config.demo) console.log('Demo mode: showing generated sample data, not live data.');
    else {
      if (!config.designhub.configured) console.warn('Design Hub credentials are missing; that source will show an error.');
      if (!config.bambu.configured) console.warn('Bambu credentials are missing; that source will show an error.');
    }
    if (!app.locals.accounts.count) {
      console.warn(config.demo
        ? 'No accounts: demo mode is open to anyone who can reach it. Set APP_USERNAME and APP_PASSWORD to require a sign-in.'
        : 'No accounts yet, so nobody can sign in. Set APP_USERNAME and APP_PASSWORD in .env and restart to create the admin account.');
    }
    const pushes = Object.entries(config.uptimeKumaPush).filter(([, u]) => u).map(([s]) => s);
    if (pushes.length) console.log(`Reporting to Uptime Kuma after each collection: ${pushes.join(', ')}.`);
  });
  app.locals.collector.start();

  // As PID 1 in a container, Node gets no default SIGTERM handling, so
  // `docker stop` would otherwise wait out its timeout and kill the process.
  const shutdown = () => {
    app.locals.collector.stop();
    app.locals.importer.stop();
    app.locals.bambuHistory.stop();
    app.locals.closeStreams();
    // Let any print log or reservation write in flight finish before exiting.
    server.close(async () => {
      await app.locals.service.printLog?.queue;
      await app.locals.importer.running;
      await app.locals.bambuHistory.running;
      await app.locals.service.reservationArchive?.queue;
      await app.locals.service.usageLog?.queue;
      await app.locals.service.assignments?.queue;
      await app.locals.accounts.queue;
      await app.locals.sessions.queue;
      await app.locals.kuma.pending;
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
