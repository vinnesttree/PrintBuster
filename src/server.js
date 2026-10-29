import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { BambuClient } from './bambu.js';
import { loadConfig, loadEnvFile, ROOT_DIR } from './config.js';
import { DemoBambu, DemoDesignHub } from './demo.js';
import { DesignHubClient } from './designhub.js';
import { describeError, SourceError } from './errors.js';
import { PrintLog } from './printlog.js';
import { ReservationArchive } from './reservations.js';
import { UsageLog } from './usagelog.js';
import { CompareService } from './service.js';
import { isIsoDate, shiftDate, todayIn } from './time.js';

function notConfigured(code, message, hint) {
  const fail = () => Promise.reject(new SourceError(message, { code, hint }));
  return { getReservations: fail, getDay: fail, getDevices: fail, getTasks: fail };
}

export async function createApp(config, { fetch = globalThis.fetch, now = () => Date.now() } = {}) {
  let designhub;
  let bambu;
  let printLog = null;
  let reservationArchive = null;
  let usageLog = null;
  if (config.demo) {
    designhub = new DemoDesignHub({ zone: config.timezone, now });
    bambu = new DemoBambu({ zone: config.timezone, now });
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
  }
  const service = new CompareService(config, { designhub, bambu, printLog, reservationArchive, usageLog, now });
  const bambuStatus = () => (bambu.status ? bambu.status() : { configured: false });

  const app = express();
  app.disable('x-powered-by');
  app.locals.service = service;

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  // Liveness probe for container healthchecks; stays reachable behind APP_PASSWORD.
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Optional basic auth: the page shows member names from an admin view.
  if (config.appPassword) {
    const expected = Buffer.from(`${config.appUsername}:${config.appPassword}`);
    app.use((req, res, next) => {
      const [scheme, encoded] = (req.get('authorization') || '').split(' ');
      const given = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
      res.set('WWW-Authenticate', 'Basic realm="PrintBuster", charset="UTF-8"').status(401).send('Authentication required');
    });
  }

  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(path.join(ROOT_DIR, 'public')));

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
  // recalculates usage and saves both. JSON only, so another site can't
  // trigger it with a plain form post.
  app.post('/api/usage/recalculate', async (req, res) => {
    if (!req.is('application/json')) {
      return res.status(415).json({ error: { message: 'Send JSON: {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}', code: 'bad_type' } });
    }
    res.json(await service.usage(req.body?.from, req.body?.to, { force: true, recalculate: true }));
  });

  app.post('/api/bambu/code', async (req, res) => {
    if (!bambu.submitCode) return res.status(400).json({ error: { message: 'Not available in demo mode.' } });
    await bambu.submitCode(req.body?.code);
    service.clearCache('bambu:');
    res.json({ bambu: bambuStatus() });
  });

  app.post('/api/bambu/restart', async (req, res) => {
    if (!bambu.restartSignIn) return res.status(400).json({ error: { message: 'Not available in demo mode.' } });
    await bambu.restartSignIn();
    service.clearCache('bambu:');
    res.json({ bambu: bambuStatus() });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: { message: 'Not found' } }));

  // Express 5 forwards rejected promises from async handlers here.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (!(err instanceof SourceError)) console.error(err);
    res.status(err instanceof SourceError ? 400 : 500).json({ error: describeError(err) });
  });

  return app;
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
  });
  if (!config.demo && config.bambu.configured) app.locals.service.startPolling(config.bambu.pollMinutes);

  // As PID 1 in a container, Node gets no default SIGTERM handling, so
  // `docker stop` would otherwise wait out its timeout and kill the process.
  const shutdown = () => {
    app.locals.service.stopPolling();
    // Let any print log or reservation write in flight finish before exiting.
    server.close(async () => {
      await app.locals.service.printLog?.queue;
      await app.locals.service.reservationArchive?.queue;
      await app.locals.service.usageLog?.queue;
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
