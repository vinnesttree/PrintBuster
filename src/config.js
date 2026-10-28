import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTimezone } from './time.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Printer order used by the design-hub-waterfall userscript. Rows appear in
// this order, top to bottom; anything not listed is appended after.
export const DEFAULT_PRINTER_ORDER = [
  'Ada', 'Archimedes', 'Faraday', 'Hull', 'Pearlman', 'Bernouli', 'Clarke',
  'Euler', 'Johnson', 'Ohm', 'Emmy', 'Hedy', 'Mark', 'Ochoa', 'Kapany',
  'Maiman', 'GoldenBee', 'GorgeousSquid', 'TangibleRabbit',
];

// Load .env from the project root if present. Real environment variables win.
export function loadEnvFile(file = path.join(ROOT_DIR, '.env')) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  if (stat.isDirectory()) {
    throw new Error(`${file} is a folder, not a file. Docker creates one when it mounts a .env that does not exist yet: delete that folder, create .env from .env.example, and start again.`);
  }
  process.loadEnvFile(file);
  return true;
}

function str(env, key, fallback = '') {
  const v = env[key];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function bool(env, key) {
  const v = str(env, key).toLowerCase();
  if (v === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function int(env, key, fallback, { min = -Infinity } = {}) {
  const v = str(env, key);
  if (v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`${key} must be an integer${min > -Infinity ? ` >= ${min}` : ''} (got "${v}")`);
  }
  return n;
}

// A non-negative number (allows decimals, e.g. hours). 0 is allowed and means
// "disabled" for the threshold settings.
function num(env, key, fallback, { min = -Infinity } = {}) {
  const v = str(env, key);
  if (v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`${key} must be a number${min > -Infinity ? ` >= ${min}` : ''} (got "${v}")`);
  }
  return n;
}

function list(env, key, fallback) {
  const v = str(env, key);
  if (v === '') return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// PRINTER_MAP="Bambu device name or serial=Design Hub model, ..."
export function parsePrinterMap(value) {
  const map = new Map();
  if (!value) return map;
  for (const pair of value.split(',')) {
    if (!pair.trim()) continue;
    const idx = pair.lastIndexOf('=');
    if (idx <= 0 || idx === pair.length - 1) {
      throw new Error(`PRINTER_MAP entry "${pair.trim()}" must look like "Bambu name=Design Hub model"`);
    }
    map.set(pair.slice(0, idx).trim().toLowerCase(), pair.slice(idx + 1).trim());
  }
  return map;
}

export function loadConfig(env = process.env, argv = process.argv) {
  const designhub = {
    baseUrl: str(env, 'DESIGNHUB_BASE_URL', 'https://designhub-manager.unl.edu').replace(/\/+$/, ''),
    username: str(env, 'DESIGNHUB_USERNAME'),
    password: env.DESIGNHUB_PASSWORD ?? '',
    cookie: str(env, 'DESIGNHUB_COOKIE'),
    loginPath: str(env, 'DESIGNHUB_LOGIN_PATH', '/login/'),
    agendaPath: str(env, 'DESIGNHUB_AGENDA_PATH', '/admin/agenda/'),
    workshopCategory: str(env, 'DESIGNHUB_WORKSHOP_CATEGORY'),
  };
  designhub.configured = Boolean((designhub.username && designhub.password) || designhub.cookie);

  const region = str(env, 'BAMBU_REGION', 'global').toLowerCase();
  if (!['global', 'china'].includes(region)) {
    throw new Error(`BAMBU_REGION must be "global" or "china" (got "${region}")`);
  }
  const bambu = {
    region,
    email: str(env, 'BAMBU_EMAIL'),
    password: env.BAMBU_PASSWORD ?? '',
    accessToken: str(env, 'BAMBU_ACCESS_TOKEN'),
    tokenCachePath: path.resolve(ROOT_DIR, str(env, 'BAMBU_TOKEN_CACHE', 'data/bambu-token.json')),
    taskPageSize: int(env, 'BAMBU_TASK_PAGE_SIZE', 50, { min: 1 }),
    maxTaskPages: int(env, 'BAMBU_MAX_TASK_PAGES', 10, { min: 1 }),
    // Bambu keeps about a day of history; poll so the print log has no gaps.
    pollMinutes: int(env, 'BAMBU_POLL_MINUTES', 15, { min: 0 }),
  };
  bambu.configured = Boolean((bambu.email && bambu.password) || bambu.accessToken);

  // DEMO_MODE=true forces demo data, false forces live data. When unset, the
  // app falls back to demo data only if neither source has credentials.
  const demoFlag = argv.includes('--demo') ? true : bool(env, 'DEMO_MODE');
  const demo = demoFlag ?? !(designhub.configured || bambu.configured);

  const timezone = str(env, 'TIMEZONE', 'America/Chicago');
  assertTimezone(timezone);

  return {
    port: int(env, 'PORT', 3000, { min: 0 }),
    host: str(env, 'HOST', '127.0.0.1'),
    timezone,
    demo,
    appUsername: str(env, 'APP_USERNAME', 'admin'),
    appPassword: env.APP_PASSWORD ?? '',
    cacheSeconds: int(env, 'CACHE_SECONDS', 60, { min: 0 }),
    graceMinutes: int(env, 'MATCH_GRACE_MINUTES', 15, { min: 0 }),
    // Flag a print as large above these. 0 turns a flag off.
    flagWeightGrams: num(env, 'FLAG_WEIGHT_GRAMS', 200, { min: 0 }),
    flagDurationHours: num(env, 'FLAG_DURATION_HOURS', 12, { min: 0 }),
    printLogPath: path.resolve(ROOT_DIR, str(env, 'PRINT_LOG_PATH', 'data/print-log.jsonl')),
    printerOrder: list(env, 'PRINTER_ORDER', DEFAULT_PRINTER_ORDER),
    printerMap: parsePrinterMap(str(env, 'PRINTER_MAP')),
    designhub,
    bambu,
  };
}
