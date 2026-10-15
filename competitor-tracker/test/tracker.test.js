import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFakeAmazon } from './fake-amazon.js';
import { diffFamily, changedPart } from '../src/diff.js';
import { parseAplus } from '../src/aplus.js';
import { imageId, normalizePrice } from '../src/normalize.js';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    settings: { checkEveryDays: 1, trackVariations: true, rankChangeAlertPercent: 25 },
    products: [{ asin: 'CHILD00001', nickname: 'Acme tables' }],
  }));
  const env = {
    ...process.env, FORCE_RUN: '1', TRACKER_FAST: '1',
    TRACKER_DATA_DIR: path.join(dir, 'data'), TRACKER_PRODUCTS_FILE: path.join(dir, 'products.json'), TRACKER_SITE_DIR: path.join(dir, 'site'),
    SPAPI_ENDPOINT: base, SPAPI_TOKEN_URL: base + '/auth', AMAZON_PAGE_BASE: base,
    SPAPI_CLIENT_ID: 'id', SPAPI_CLIENT_SECRET: 'secret', SPAPI_REFRESH_TOKEN: 'refresh',
  };
  const track = () => run(process.execPath, [path.join(ROOT, 'src/index.js')], { env });
  const changes = () => JSON.parse(fs.readFileSync(path.join(dir, 'data/changes.json'), 'utf8'));

  try {
    // Day 1: a child ASIN was listed; the tracker should find the parent and save a baseline.
    await track();
    assert.deepEqual(changes().map((c) => c.type), ['baseline']);
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'data/snapshots/PARENT0001.json'), 'utf8'));
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

    const html = fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8');
    assert.match(html, /<title>Competitor Watch<\/title>/);
    assert.match(html, /Acme tables/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
