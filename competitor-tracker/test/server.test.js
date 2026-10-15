import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeAmazon } from './fake-amazon.js';
import { isDue } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('schedule: runs once a day after the chosen hour, honoring checkEveryDays', () => {
  const settings = { checkAtHour: 9, timeZone: 'America/New_York', checkEveryDays: 1 };
  const at = (iso) => new Date(iso);
  assert.equal(isDue(settings, {}), true, 'first ever run starts right away');
  const ran = { lastRunAt: '2026-10-14T13:20:00Z', lastSuccessAt: '2026-10-14T13:20:00Z' }; // 9:20 AM New York
  assert.equal(isDue(settings, ran, at('2026-10-14T20:00:00Z')), false, 'already ran today');
  assert.equal(isDue(settings, ran, at('2026-10-15T12:50:00Z')), false, '8:50 AM is before 9');
  assert.equal(isDue(settings, ran, at('2026-10-15T13:10:00Z')), true, '9:10 AM next day');
  assert.equal(isDue({ ...settings, checkEveryDays: 3 }, ran, at('2026-10-16T13:10:00Z')), false, 'only 2 days later');
  assert.equal(isDue({ ...settings, checkEveryDays: 3 }, ran, at('2026-10-17T13:10:00Z')), true, '3 days later');
});

test('server: password protects the site and "Check now" runs a check', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-srv-'));
  const state = {
    products: {
      SOLO000001: { title: 'Acme Bench', bullets: ['Steel'], description: 'A bench.', images: ['bench1'], parent: undefined, children: undefined },
    },
    prices: { SOLO000001: 129.5 },
    aplus: { text: 'Great bench.', images: [] },
  };
  const fake = await startFakeAmazon(state);
  const base = `http://127.0.0.1:${fake.address().port}`;
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify({
    settings: { checkAtHour: 0, timeZone: 'America/New_York' },
    products: [{ asin: 'SOLO000001', nickname: 'Acme bench' }],
  }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
    env: {
      ...process.env, PORT: String(port), SITE_PASSWORD: 's3cret', TRACKER_FAST: '1',
      TRACKER_DATA_DIR: path.join(dir, 'data'), TRACKER_PRODUCTS_FILE: path.join(dir, 'products.json'),
      SPAPI_ENDPOINT: base, SPAPI_TOKEN_URL: base + '/auth', AMAZON_PAGE_BASE: base,
      SPAPI_CLIENT_ID: 'id', SPAPI_CLIENT_SECRET: 'secret', SPAPI_REFRESH_TOKEN: 'refresh',
    },
    stdio: 'ignore',
  });
  const site = `http://127.0.0.1:${port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('me:s3cret').toString('base64') };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(site + '/health'); break; } catch { await sleep(100); } }
    assert.equal((await fetch(site + '/')).status, 401);
    assert.equal((await fetch(site + '/', { headers: { Authorization: 'Basic ' + Buffer.from('me:wrong').toString('base64') } })).status, 401);
    assert.equal((await fetch(site + '/health')).status, 200);

    assert.equal((await fetch(site + '/run', { method: 'POST', headers: auth })).status, 202);
    let changes = [];
    for (let i = 0; i < 50 && !changes.length; i++) {
      await sleep(100);
      changes = await (await fetch(site + '/changes.json', { headers: auth })).json();
    }
    assert.equal(changes[0]?.type, 'baseline');
    const html = await (await fetch(site + '/', { headers: auth })).text();
    assert.match(html, /Acme bench/);
    assert.match(html, /\$129\.5|129\.5/);
  } finally {
    child.kill();
    fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
