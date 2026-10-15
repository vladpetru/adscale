// Builds site/index.html (the tracker website) from the saved data.
// Run on its own with:  npm run build-site

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITES = { US: 'www.amazon.com', CA: 'www.amazon.ca', MX: 'www.amazon.com.mx', UK: 'www.amazon.co.uk', DE: 'www.amazon.de' };
const MAX_CHANGES_ON_SITE = 5000;

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

export function siteData(dataDir, config) {
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
    for (const [asin, it] of items) labels[asin] = asin === s.parentAsin ? 'Parent' : it.variant || it.title;
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
    changes: changes.slice(-MAX_CHANGES_ON_SITE).reverse(),
  };
}

// fragment: true gives just the page body (used for previews); otherwise a complete web page.
export function renderSite(data, { fragment = false } = {}) {
  const template = fs.readFileSync(path.join(ROOT, 'src', 'site-template.html'), 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const page = template.replace('/*__DATA__*/null', () => json);
  if (fragment) return page;
  const split = page.indexOf('<div class="wrap">');
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="robots" content="noindex, nofollow">\n${page.slice(0, split)}</head>\n<body>\n${page.slice(split)}</body>\n</html>\n`;
}

export function buildSite(dataDir = path.join(ROOT, 'data'), config = readJson(path.join(ROOT, 'products.json'), {}), outDir = path.join(ROOT, 'site')) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), renderSite(siteData(dataDir, config)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildSite();
  console.log('Built site/index.html');
}
