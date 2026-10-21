import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeAmazon } from './helpers/fake-amazon.js';
import { diffFamily, changedPart } from '../tools/competitor-tracker/diff.js';
import { parseAplus } from '../tools/competitor-tracker/aplus.js';
import { imageId, normalizePrice } from '../tools/competitor-tracker/normalize.js';
import { runTracker } from '../tools/competitor-tracker/tracker.js';
import { pageData } from '../tools/competitor-tracker/data.js';
import { renderTrackerPage } from '../tools/competitor-tracker/page.js';
import { isDue } from '../tools/competitor-tracker/index.js';

test('imageId ignores size suffixes', () => {
  assert.equal(imageId('https://m.media-amazon.com/images/I/71abc+XYZ._AC_SL1500_.jpg'), '71abc+XYZ');
  assert.equal(imageId('https://m.media-amazon.com/images/I/71abc+XYZ.jpg'), '71abc+XYZ');
});

test('changedPart shows only the edited region of long text', () => {
  const a = 'x'.repeat(200) + ' old words ' + 'y'.repeat(200);
  const b = 'x'.repeat(200) + ' new words ' + 'y'.repeat(200);
  const part = changedPart(a, b);
  assert.match(part.before, /old words/);
  assert.match(part.after, /new words/);
  assert.ok(part.before.length < 160);
});

test('price lookup errors are not treated as price changes', () => {
  const item = (price) => ({ title: 't', bullets: [], images: [], other: {}, rank: {}, price });
  const prev = { items: { A: item({ available: true, buyBox: 10, listPrice: null, sellers: 1 }) }, variations: { childAsins: [] } };
  const next = { items: { A: item(normalizePrice({ error: 'boom' })) }, variations: { childAsins: [] } };
  assert.deepEqual(diffFamily(prev, next), []);
});

test('A+ parser detects robot checks and missing A+', () => {
  assert.equal(parseAplus('<form action="/errors/validateCaptcha"></form>').status, 'blocked');
  assert.equal(parseAplus('<div id="dp"><span id="productTitle">x</span></div>').status, 'none');
});

test('full run: baseline, then detects every kind of change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-'));
  const state = {
    throttleOnce: true,
    products: {
      PARENT0001: { title: 'Acme Picnic Table', bullets: [], description: '', images: ['parentimg'], children: ['CHILD00001', 'CHILD00002'] },
      CHILD00001: { title: 'Acme Picnic Table, Black', bullets: ['Strong steel', 'Seats 8'], description: 'A sturdy table.', images: ['main1', 'side1', 'side2'], parent: 'PARENT0001', color: 'Black', rank: 1000 },
      CHILD00002: { title: 'Acme Picnic Table, Green', bullets: ['Strong steel'], description: 'A sturdy table.', images: ['main2'], parent: 'PARENT0001', color: 'Green', rank: 1200 },
    },
    prices: { CHILD00001: 199.99, CHILD00002: 209.99 },
    aplus: { text: 'Built for parks and schools.', images: ['ap1', 'ap2'] },
  };
  const server = await startFakeAmazon(state);
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify({
    settings: { checkEveryDays: 1, rankChangeAlertPercent: 25 }, // trackVariations left out on purpose: it defaults to on
    products: [{ asin: 'CHILD00001', nickname: 'Acme tables' }],
  }));
  Object.assign(process.env, {
    TRACKER_FAST: '1', SPAPI_ENDPOINT: base, SPAPI_TOKEN_URL: base + '/auth', AMAZON_PAGE_BASE: base,
    SPAPI_CLIENT_ID: 'id', SPAPI_CLIENT_SECRET: 'secret', SPAPI_REFRESH_TOKEN: 'refresh',
  });
  const dataDir = path.join(dir, 'data');
  const productsFile = path.join(dir, 'products.json');
  const track = () => runTracker({ dataDir, productsFile, force: true });
  const changes = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'changes.json'), 'utf8'));

  try {
    // Day 1: a child ASIN was listed; the tracker should find the parent and save a baseline.
    await track();
    assert.deepEqual(changes().map((c) => c.type), ['baseline']);
    const snap = JSON.parse(fs.readFileSync(path.join(dataDir, 'snapshots/PARENT0001.json'), 'utf8'));
    assert.deepEqual(Object.keys(snap.items).sort(), ['CHILD00001', 'CHILD00002', 'PARENT0001']);
    assert.equal(snap.aplus.status, 'ok');
    assert.deepEqual(snap.aplus.images, ['ap1', 'ap2'].map((id) => `https://m.media-amazon.com/images/S/aplus-media/${id}.jpg`));

    // Day 2: the competitor changes a lot of things.
    state.prices.CHILD00001 = 179.99;
    state.products.CHILD00002.title = 'Acme Heavy Duty Picnic Table, Green';
    state.products.CHILD00001.images = ['main1b', 'side1', 'side2', 'side3'];
    state.products.CHILD00001.bullets = ['Strong steel', 'Seats 10', 'Free shipping'];
    state.products.CHILD00001.material = 'Aluminum';
    state.products.CHILD00001.rank = 2500;
    state.products.PARENT0001.children = ['CHILD00001', 'CHILD00002', 'CHILD00003'];
    state.products.CHILD00003 = { title: 'Acme Picnic Table, Red', bullets: [], description: '', images: ['main3'], parent: 'PARENT0001', color: 'Red' };
    state.prices.CHILD00003 = 219.99;
    state.aplus = { text: 'Built for parks, schools and campsites.', images: ['ap1', 'ap3'] };
    await track();

    const day2 = changes().filter((c) => c.type !== 'baseline');
    const byType = (t) => day2.filter((c) => c.type === t);
    assert.equal(byType('price')[0].summary, 'Price $199.99 → $179.99 (-10%)');
    assert.equal(byType('title')[0].asin, 'CHILD00002');
    assert.equal(byType('images')[0].summary, 'Main image replaced, 1 image added');
    assert.deepEqual(byType('bullets').map((c) => c.summary), ['Bullet 2 changed', 'Bullet 3 added']);
    assert.equal(byType('other')[0].field, 'material');
    assert.match(byType('rank')[0].summary, /Rank dropped: #1,000 → #2,500/);
    assert.deepEqual(byType('variations')[0].after, ['CHILD00003']);
    assert.equal(byType('aplus')[0].summary, 'A+ content: text changed, 1 image added, 1 image removed');

    // Day 3: Amazon shows a robot check and nothing else changes, so no A+ change is reported.
    state.aplus = 'captcha';
    const before = changes().length;
    await track();
    assert.equal(changes().length, before);

    const data = pageData(dataDir, JSON.parse(fs.readFileSync(productsFile, 'utf8')));
    assert.equal(data.products[0].nickname, 'Acme tables');
    assert.equal(data.products[0].childCount, 3);
    assert.equal(data.changes[0].detectedAt >= data.changes.at(-1).detectedAt, true, 'newest first');
    assert.match(renderTrackerPage(data).body, /Acme tables/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

test('page data with a "</script>" inside A+ text cannot break the page', () => {
  const { body } = renderTrackerPage({ base: '/x', products: [], labels: {}, status: {}, checkEveryDays: 1,
    changes: [{ id: '1', detectedAt: '2026-10-01T00:00:00Z', type: 'aplus', summary: 'x', before: '</script><b>', after: null }] });
  assert.equal(body.match(/<\/script>/g).length, 1);
});
