// The Railway app: shows the tracker website (behind a password) and runs the check on schedule.
// Start with:  npm start
//
// Railway variables: SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SPAPI_REFRESH_TOKEN, SITE_PASSWORD.
// Schedule settings (checkEveryDays, checkAtHour, timeZone) live in products.json.

import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTracker, readJson, writeJson, DATA, PRODUCTS_FILE } from './tracker.js';
import { siteData, renderSite } from './build-site.js';

const TICK_MS = 10 * 60 * 1000;
let running = false;

// Date and hour "right now" in the chosen time zone, e.g. { day: '2026-10-15', hour: 9 }.
function localNow(timeZone, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function isDue(settings, status, now = new Date()) {
  if (!status.lastRunAt) return true;
  const tz = settings.timeZone || 'America/New_York';
  const today = localNow(tz, now);
  if (localNow(tz, new Date(status.lastRunAt)).day === today.day) return false;
  if (today.hour < (Number(settings.checkAtHour) || 9)) return false;
  const everyDays = Number(settings.checkEveryDays) || 1;
  const sinceSuccess = status.lastSuccessAt ? (now - Date.parse(status.lastSuccessAt)) / 86400000 : Infinity;
  return sinceSuccess >= everyDays - 0.5;
}

export async function startRun(reason) {
  if (running) return false;
  running = true;
  console.log(`[${new Date().toISOString()}] Starting check (${reason})`);
  try {
    await runTracker({ force: true });
  } catch (err) {
    console.error('Tracker failed: ' + err.message);
    const status = readJson(path.join(DATA, 'status.json'), {});
    writeJson(path.join(DATA, 'status.json'), { ...status, lastRunAt: new Date().toISOString(), errors: [`The check failed: ${err.message}`] });
  } finally {
    running = false;
  }
  return true;
}

function tick() {
  const config = readJson(PRODUCTS_FILE, {});
  const status = readJson(path.join(DATA, 'status.json'), {});
  if (isDue(config.settings || {}, status)) startRun('scheduled');
}

function passwordOk(req) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return true;
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const given = Buffer.from(Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':'));
  const wanted = Buffer.from(password);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (!passwordOk(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Competitor Watch"', 'Content-Type': 'text/plain' });
      return res.end('Password required');
    }
    if (url.pathname === '/run' && req.method === 'POST') {
      const started = !running;
      startRun('manual');
      res.writeHead(started ? 202 : 409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ started }));
    }
    if (url.pathname === '/changes.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(readJson(path.join(DATA, 'changes.json'), [])));
    }
    if (url.pathname !== '/') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const data = { ...siteData(DATA, readJson(PRODUCTS_FILE, {})), canRun: true, running };
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    res.end(renderSite(data));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  createServer().listen(port, () => console.log(`Competitor Watch running on port ${port}. Data folder: ${DATA}`));
  if (!process.env.SITE_PASSWORD) console.warn('WARNING: SITE_PASSWORD is not set, so anyone with the address can open the site.');
  if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.TRACKER_DATA_DIR) {
    console.warn('WARNING: No Railway volume attached. Tracking history will be lost on every redeploy. See README, step 4.');
  }
  setTimeout(tick, 5000);
  setInterval(tick, TICK_MS);
}
