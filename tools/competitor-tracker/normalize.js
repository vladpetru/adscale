// Turns raw SP-API responses into a small, stable "snapshot" that is easy to compare day to day.

// These attributes get their own change type, so they are left out of the "other" bucket.
const OWN_FIELDS = new Set(['item_name', 'bullet_point', 'product_description', 'brand']);

// Attributes that change on their own without the seller doing anything.
const IGNORED_ATTRIBUTES = new Set(['list_price', 'purchasable_offer', 'fulfillment_availability', 'merchant_shipping_group']);

const IMAGE_ORDER = ['MAIN', 'PT01', 'PT02', 'PT03', 'PT04', 'PT05', 'PT06', 'PT07', 'PT08', 'PT09', 'PT10', 'PT11', 'PT12', 'SWCH'];

const values = (attr) => (attr || []).map((a) => a.value).filter((v) => v !== undefined && v !== null);

// Removes marketplace/language tags so only the real content is compared, with keys in a fixed order.
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === 'marketplace_id' || key === 'language_tag') continue;
      out[key] = clean(value[key]);
    }
    return out;
  }
  return value;
}

// "https://m.media-amazon.com/images/I/71abcXYZ.jpg" -> "71abcXYZ" (the same picture at any size)
export function imageId(url) {
  const m = /\/images\/I\/([^._/]+)/.exec(url || '');
  return m ? m[1] : url;
}

export function imageUrl(id, size = 300) {
  return `https://m.media-amazon.com/images/I/${id}._AC_SL${size}_.jpg`;
}

function normalizeImages(item, marketplaceId) {
  const set = (item.images || []).find((s) => s.marketplaceId === marketplaceId) || item.images?.[0];
  const best = {};
  for (const img of set?.images || []) {
    const cur = best[img.variant];
    if (!cur || (img.height || 0) > (cur.height || 0)) best[img.variant] = img;
  }
  return Object.values(best)
    .sort((a, b) => {
      const ia = IMAGE_ORDER.indexOf(a.variant), ib = IMAGE_ORDER.indexOf(b.variant);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.variant.localeCompare(b.variant);
    })
    .map((img) => ({ slot: img.variant, id: imageId(img.link) }));
}

function normalizeRank(item, marketplaceId) {
  const set = (item.salesRanks || []).find((s) => s.marketplaceId === marketplaceId) || item.salesRanks?.[0];
  const main = set?.displayGroupRanks?.[0];
  const sub = set?.classificationRanks?.[0];
  return {
    main: main ? { rank: main.rank, category: main.title } : null,
    sub: sub ? { rank: sub.rank, category: sub.title } : null,
  };
}

export function variationInfo(item, marketplaceId) {
  const set = (item?.relationships || []).find((s) => s.marketplaceId === marketplaceId) || item?.relationships?.[0];
  const rels = (set?.relationships || []).filter((r) => r.type === 'VARIATION');
  return {
    childAsins: [...new Set(rels.flatMap((r) => r.childAsins || []))].sort(),
    parentAsins: [...new Set(rels.flatMap((r) => r.parentAsins || []))].sort(),
    theme: rels.find((r) => r.variationTheme)?.variationTheme?.theme || null,
  };
}

function money(m) {
  return m && typeof m.Amount === 'number' ? Math.round(m.Amount * 100) / 100 : null;
}

export function normalizePrice(offers) {
  if (!offers || offers.error) return { available: false, note: offers?.error || 'no data' };
  const s = offers.Summary || {};
  const buyBox = (s.BuyBoxPrices || []).find((p) => (p.condition || '').toLowerCase() === 'new') || s.BuyBoxPrices?.[0];
  const lowest = (s.LowestPrices || [])
    .filter((p) => (p.condition || '').toLowerCase() === 'new')
    .map((p) => money(p.LandedPrice))
    .filter((v) => v !== null);
  const totalSellers = (s.NumberOfOffers || [])
    .filter((o) => (o.condition || '').toLowerCase() === 'new')
    .reduce((n, o) => n + (o.OfferCount || 0), 0);
  return {
    available: true,
    buyBox: buyBox ? money(buyBox.LandedPrice) ?? money(buyBox.ListingPrice) : null,
    lowest: lowest.length ? Math.min(...lowest) : null,
    listPrice: money(s.ListPrice),
    sellers: totalSellers,
  };
}

// One ASIN (parent or child) -> snapshot record.
export function normalizeItem(item, offers, marketplaceId) {
  const attrs = item.attributes || {};
  const summary = (item.summaries || []).find((s) => s.marketplaceId === marketplaceId) || item.summaries?.[0] || {};
  const other = {};
  for (const key of Object.keys(attrs).sort()) {
    if (OWN_FIELDS.has(key) || IGNORED_ATTRIBUTES.has(key)) continue;
    other[key] = JSON.stringify(clean(attrs[key]));
  }
  return {
    title: values(attrs.item_name)[0] || summary.itemName || null,
    brand: values(attrs.brand)[0] || summary.brand || null,
    bullets: values(attrs.bullet_point),
    description: values(attrs.product_description)[0] || null,
    images: normalizeImages(item, marketplaceId),
    rank: normalizeRank(item, marketplaceId),
    variant: [summary.color, summary.size, summary.style].filter(Boolean).join(' / ') || null,
    price: offers === undefined ? null : normalizePrice(offers),
    other,
  };
}
