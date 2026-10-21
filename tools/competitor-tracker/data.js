// Gathers what the Competitor Watch tab shows: the tracked products and the change log.

import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../../platform/storage.js';

const SITES = { US: 'www.amazon.com', CA: 'www.amazon.ca', MX: 'www.amazon.com.mx', UK: 'www.amazon.co.uk', DE: 'www.amazon.de' };
const MAX_CHANGES_ON_PAGE = 5000;

export function pageData(dataDir, config) {
  const settings = config?.settings || {};
  const changes = readJson(path.join(dataDir, 'changes.json'), []);
  const snapDir = path.join(dataDir, 'snapshots');
  const snaps = fs.existsSync(snapDir)
    ? fs.readdirSync(snapDir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(snapDir, f), null)).filter(Boolean)
    : [];
  const order = (config?.products || []).map((p) => p.nickname);
  snaps.sort((a, b) => (order.indexOf(a.nickname) + 1 || 999) - (order.indexOf(b.nickname) + 1 || 999));

  const monthAgo = Date.now() - 30 * 86400000;
  const labels = {};
  const products = snaps.map((s) => {
    const items = Object.entries(s.items || {});
    const kids = items.filter(([asin]) => asin !== s.parentAsin);
    for (const [asin, it] of items) labels[asin] = asin === s.parentAsin && kids.length ? 'Parent' : it.variant || it.title;
    const prices = items.map(([, it]) => it.price?.buyBox).filter((v) => typeof v === 'number');
    const mine = changes.filter((c) => c.parentAsin === s.parentAsin && c.type !== 'baseline');
    const first = kids[0]?.[1] || s.items?.[s.parentAsin] || {};
    return {
      parentAsin: s.parentAsin,
      nickname: s.nickname,
      title: s.items?.[s.parentAsin]?.title || first.title,
      image: first.images?.[0]?.id || s.items?.[s.parentAsin]?.images?.[0]?.id || null,
      childCount: s.variations?.childAsins?.length || kids.length,
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
      changes30: mine.filter((c) => Date.parse(c.detectedAt) >= monthAgo).length,
      lastChange: mine.length ? mine[mine.length - 1].detectedAt : null,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    amazonSite: SITES[settings.marketplace || 'US'] || SITES.US,
    checkEveryDays: Number(settings.checkEveryDays) || 1,
    status: readJson(path.join(dataDir, 'status.json'), {}),
    products,
    labels,
    changes: changes.slice(-MAX_CHANGES_ON_PAGE).reverse(),
  };
}
