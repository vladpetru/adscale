// One Competitor Watch check: fetch every tracked product, compare with the last snapshot, log changes.
// index.js calls runTracker() on a schedule and when someone clicks "Check now".

import path from 'node:path';
import { readJson, writeJson } from '../../platform/storage.js';
import { SpApi } from './spapi.js';
import { normalizeItem, variationInfo } from './normalize.js';
import { fetchAplus } from './aplus.js';
import { diffFamily } from './diff.js';

const MAX_CHANGES_KEPT = 20000;
const MAX_HISTORY_DAYS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAsin = (s) => /^[A-Z0-9]{10}$/.test(s) && s !== 'B000000000';

export async function runTracker({ dataDir, productsFile, force = false }) {
  const DATA = dataDir;
  const config = readJson(productsFile, null);
  if (!config) throw new Error('products.json is missing or is not valid JSON (check for a missing comma or quote).');
  const settings = config.settings || {};
  const watch = (config.products || [])
    .map((p) => ({ ...p, asin: String(p.asin || '').trim().toUpperCase() }))
    .filter((p) => isAsin(p.asin));
  const status = readJson(path.join(DATA, 'status.json'), {});

  const everyDays = Number(settings.checkEveryDays) || 1;
  const sinceLast = status.lastSuccessAt ? (Date.now() - Date.parse(status.lastSuccessAt)) / 86400000 : Infinity;
  if (!force && sinceLast < everyDays - 0.1) {
    console.log(`Last check was ${sinceLast.toFixed(1)} days ago; checkEveryDays is ${everyDays}. Skipping this run.`);
    return;
  }
  if (!watch.length) {
    console.log('No products to track yet. Add competitor ASINs to products.json.');
    return;
  }

  const marketplace = settings.marketplace || 'US';
  const api = new SpApi({
    clientId: process.env.SPAPI_CLIENT_ID,
    clientSecret: process.env.SPAPI_CLIENT_SECRET,
    refreshToken: process.env.SPAPI_REFRESH_TOKEN,
    marketplace,
  });
  const mp = api.marketplaceId;
  const now = new Date().toISOString();
  const errors = [];

  // 1. Look up each listed ASIN and find its parent (you can list a parent or any one of its children).
  console.log(`Looking up ${watch.length} product(s)...`);
  const catalog = await api.getCatalogItems(watch.map((w) => w.asin));
  const families = new Map();
  for (const w of watch) {
    const item = catalog[w.asin];
    if (!item) { errors.push(`${w.asin}: not found on Amazon ${marketplace}`); continue; }
    const parent = variationInfo(item, mp).parentAsins[0] || w.asin;
    if (!families.has(parent)) families.set(parent, { parentAsin: parent, nickname: w.nickname || parent, listedAsin: w.asin });
  }
  const missingParents = [...families.keys()].filter((p) => !catalog[p]);
  Object.assign(catalog, await api.getCatalogItems(missingParents));

  // 2. Work out which child ASINs (variations) to follow for each family.
  for (const fam of families.values()) {
    const v = variationInfo(catalog[fam.parentAsin], mp);
    fam.variations = { theme: v.theme, childAsins: v.childAsins };
    let kids = v.childAsins;
    if (settings.trackVariations === false) kids = kids.includes(fam.listedAsin) ? [fam.listedAsin] : kids.slice(0, 1);
    const max = Number(settings.maxChildrenPerParent) || 40;
    if (kids.length > max) errors.push(`${fam.parentAsin}: has ${kids.length} variations, only the first ${max} are tracked (raise maxChildrenPerParent to track more)`);
    fam.children = kids.slice(0, max);
    fam.priced = fam.children.length ? fam.children : [fam.parentAsin];
  }

  // 3. Download listing details and prices for every child in as few requests as possible.
  const allChildren = [...new Set([...families.values()].flatMap((f) => f.children))].filter((a) => !catalog[a]);
  console.log(`Fetching details for ${allChildren.length} variation(s)...`);
  Object.assign(catalog, await api.getCatalogItems(allChildren));
  const allPriced = [...new Set([...families.values()].flatMap((f) => f.priced))];
  console.log(`Fetching prices for ${allPriced.length} ASIN(s) (Amazon allows about 20 every 10 seconds)...`);
  let offers = {};
  try { offers = await api.getOffers(allPriced); } catch (err) { errors.push(`Prices: ${err.message}`); }

  // 4. Build today's snapshot of each family, compare with the last one, and save.
  const changes = readJson(path.join(DATA, 'changes.json'), []);
  let newChanges = 0;
  for (const fam of families.values()) {
    const snapFile = path.join(DATA, 'snapshots', `${fam.parentAsin}.json`);
    const prev = readJson(snapFile, null);
    try {
      const items = {};
      for (const asin of [fam.parentAsin, ...fam.children]) {
        if (!catalog[asin]) continue;
        const priceData = fam.priced.includes(asin) ? offers[asin] ?? { error: 'price not returned' } : undefined;
        items[asin] = normalizeItem(catalog[asin], priceData, mp);
        // Keep the last good price when Amazon's price lookup failed, so it is not seen as a change tomorrow.
        if (items[asin].price && !items[asin].price.available && prev?.items?.[asin]?.price?.available) {
          items[asin].price = prev.items[asin].price;
        }
      }

      let aplus = prev?.aplus || null;
      if (settings.checkAplusContent !== false) {
        const pageAsin = fam.children.includes(prev?.aplus?.asin) ? prev.aplus.asin
          : fam.children.includes(fam.listedAsin) ? fam.listedAsin
          : fam.children[0] || fam.parentAsin;
        await sleep(process.env.TRACKER_FAST ? 0 : 3000 + Math.random() * 4000); // be polite to Amazon's website
        const result = await fetchAplus(pageAsin, marketplace);
        console.log(`  A+ check ${pageAsin}: ${result.status}`);
        if (result.status === 'ok' || result.status === 'none') aplus = { asin: pageAsin, ...result, checkedAt: now };
        else aplus = prev?.aplus ? { ...prev.aplus, lastBlockedAt: now } : { asin: pageAsin, status: result.status, note: result.note, checkedAt: now };
      }

      const next = { parentAsin: fam.parentAsin, nickname: fam.nickname, checkedAt: now, variations: fam.variations, items, aplus };
      const found = prev ? diffFamily(prev, next, settings) : [];
      const tracked = fam.children.length || 1;
      if (!prev) found.push({ asin: fam.parentAsin, type: 'baseline', field: 'Tracking', summary: `Started tracking (${tracked} ASIN${tracked === 1 ? '' : 's'})`, before: null, after: null });
      found.forEach((c, i) => changes.push({ id: `${now}-${fam.parentAsin}-${i}`, detectedAt: now, parentAsin: fam.parentAsin, nickname: fam.nickname, ...c }));
      newChanges += found.length;
      console.log(`${fam.nickname} (${fam.parentAsin}): ${prev ? `${found.length} change(s)` : 'baseline saved'}`);

      writeJson(snapFile, next);
      appendHistory(DATA, fam.parentAsin, now, items);
    } catch (err) {
      errors.push(`${fam.parentAsin}: ${err.message}`);
    }
  }

  writeJson(path.join(DATA, 'changes.json'), changes.slice(-MAX_CHANGES_KEPT));
  writeJson(path.join(DATA, 'status.json'), {
    lastRunAt: now,
    lastSuccessAt: families.size ? now : status.lastSuccessAt,
    productsTracked: families.size,
    newChanges,
    errors,
  });
  console.log(`Done. ${newChanges} new change(s). ${errors.length} warning(s).`);
  errors.forEach((e) => console.log('  ! ' + e));
}

function appendHistory(DATA, parentAsin, now, items) {
  const file = path.join(DATA, 'history', `${parentAsin}.json`);
  const history = readJson(file, []);
  const row = { date: now.slice(0, 10), price: {}, rank: {} };
  for (const [asin, it] of Object.entries(items)) {
    if (it.price?.available) row.price[asin] = it.price.buyBox;
    if (it.rank?.main?.rank) row.rank[asin] = it.rank.main.rank;
  }
  const kept = history.filter((h) => h.date !== row.date);
  kept.push(row);
  writeJson(file, kept.slice(-MAX_HISTORY_DAYS));
}
