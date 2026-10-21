// Competitor Watch: tracks Amazon competitors' prices, listings, images and A+ content.
// This file plugs the tool into OUTTANS HQ: its tab, its "Check now" button, and its daily schedule.
// Schedule settings (checkEveryDays, checkAtHour, timeZone) live in products.json.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from '../../platform/storage.js';
import { runTracker } from './tracker.js';
import { pageData } from './data.js';
import { renderTrackerPage } from './page.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TICK_MS = 10 * 60 * 1000;

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

export default {
  id: 'competitor-tracker',
  name: 'Competitor Watch',

  setup({ router, dataDir, basePath, render, log }) {
    const productsFile = process.env.TRACKER_PRODUCTS_FILE || path.join(HERE, 'products.json');
    const statusFile = path.join(dataDir, 'status.json');
    let running = false;

    async function startRun(reason) {
      if (running) return;
      running = true;
      log.log(`[Competitor Watch] Starting check (${reason})`);
      try {
        await runTracker({ dataDir, productsFile, force: true });
      } catch (err) {
        log.error('[Competitor Watch] Check failed: ' + err.message);
        writeJson(statusFile, { ...readJson(statusFile, {}), lastRunAt: new Date().toISOString(), errors: [`The check failed: ${err.message}`] });
      } finally {
        running = false;
      }
    }

    router.get('/', (req, res) => {
      const data = { ...pageData(dataDir, readJson(productsFile, {})), base: basePath, canRun: true, running };
      res.set('Cache-Control', 'no-store').send(render(req, { title: 'Competitor Watch', ...renderTrackerPage(data) }));
    });

    router.post('/run', (req, res) => {
      if (running) return res.status(409).json({ started: false });
      startRun(`started by ${req.user.name}`);
      res.status(202).json({ started: true });
    });

    router.get('/changes.json', (req, res) => res.json(readJson(path.join(dataDir, 'changes.json'), [])));

    return {
      start() {
        const tick = () => {
          const config = readJson(productsFile, {});
          const hasProducts = (config.products || []).some((p) => /^[A-Z0-9]{10}$/i.test(p.asin) && p.asin !== 'B000000000');
          if (hasProducts && isDue(config.settings || {}, readJson(statusFile, {}))) startRun('scheduled');
        };
        setTimeout(tick, 5000);
        setInterval(tick, TICK_MS);
      },
    };
  },
};
