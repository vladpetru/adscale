// Compares yesterday's snapshot of a product family with today's and lists every change.

const MAX_TEXT = 400;

const money = (v) => (v === null || v === undefined ? 'none' : `$${v.toFixed(2)}`);
const pct = (a, b) => (a ? Math.round(((b - a) / a) * 1000) / 10 : 0);
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const short = (s) => (s && s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s);

// Shows only the part of a long text that actually changed, with a little context around it.
export function changedPart(before = '', after = '', context = 60) {
  before = before || '';
  after = after || '';
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length, endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) { endB--; endA--; }
  const from = Math.max(0, start - context);
  const cut = (s, end) => (from > 0 ? '…' : '') + short(s.slice(from, Math.min(s.length, end + context))) + (end + context < s.length ? '…' : '');
  return { before: cut(before, endB), after: cut(after, endA) };
}

function diffText(asin, type, label, a, b) {
  if ((a || '') === (b || '')) return [];
  if (!a) return [{ asin, type, field: label, summary: `${label} added`, before: null, after: short(b) }];
  if (!b) return [{ asin, type, field: label, summary: `${label} removed`, before: short(a), after: null }];
  const part = a.length > 120 || b.length > 120 ? changedPart(a, b) : { before: a, after: b };
  return [{ asin, type, field: label, summary: `${label} changed`, ...part }];
}

function diffBullets(asin, a = [], b = []) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if ((a[i] || '') === (b[i] || '')) continue;
    const label = `Bullet ${i + 1}`;
    if (!a[i]) out.push({ asin, type: 'bullets', field: label, summary: `${label} added`, before: null, after: short(b[i]) });
    else if (!b[i]) out.push({ asin, type: 'bullets', field: label, summary: `${label} removed`, before: short(a[i]), after: null });
    else out.push({ asin, type: 'bullets', field: label, summary: `${label} changed`, ...changedPart(a[i], b[i]) });
  }
  return out;
}

function diffImages(asin, a = [], b = []) {
  const ids = (list) => list.map((i) => i.id);
  if (ids(a).join() === ids(b).join()) return [];
  const before = new Set(ids(a)), after = new Set(ids(b));
  const added = ids(b).filter((id) => !before.has(id));
  const removed = ids(a).filter((id) => !after.has(id));
  const parts = [];
  if (a[0]?.id !== b[0]?.id) parts.push('main image replaced');
  const extraAdded = added.filter((id) => id !== b[0]?.id).length;
  const extraRemoved = removed.filter((id) => id !== a[0]?.id).length;
  if (extraAdded) parts.push(`${extraAdded} image${extraAdded > 1 ? 's' : ''} added`);
  if (extraRemoved) parts.push(`${extraRemoved} image${extraRemoved > 1 ? 's' : ''} removed`);
  if (!parts.length) parts.push('image order changed');
  const summary = parts.join(', ');
  return [{ asin, type: 'images', field: 'Images', summary: summary[0].toUpperCase() + summary.slice(1), before: ids(a), after: ids(b) }];
}

function diffPrice(asin, a, b) {
  if (!a?.available || !b?.available) return [];
  const out = [];
  if (a.buyBox !== b.buyBox) {
    let summary;
    if (a.buyBox === null) summary = `Buy Box back at ${money(b.buyBox)}`;
    else if (b.buyBox === null) summary = `No Buy Box (was ${money(a.buyBox)}), possibly out of stock`;
    else summary = `Price ${money(a.buyBox)} → ${money(b.buyBox)} (${signed(pct(a.buyBox, b.buyBox))}%)`;
    out.push({ asin, type: 'price', field: 'Buy Box price', summary, before: a.buyBox, after: b.buyBox });
  }
  if (a.listPrice !== b.listPrice) {
    out.push({ asin, type: 'price', field: 'List price', summary: `List (strikethrough) price ${money(a.listPrice)} → ${money(b.listPrice)}`, before: a.listPrice, after: b.listPrice });
  }
  if (a.sellers !== b.sellers) {
    out.push({ asin, type: 'sellers', field: 'Sellers', summary: `Sellers ${a.sellers} → ${b.sellers}`, before: a.sellers, after: b.sellers });
  }
  return out;
}

function diffRank(asin, a, b, thresholdPercent) {
  const ra = a?.main?.rank, rb = b?.main?.rank;
  if (!ra || !rb || ra === rb) return [];
  const change = pct(ra, rb);
  if (Math.abs(change) < thresholdPercent) return [];
  const dir = rb < ra ? 'improved' : 'dropped';
  return [{ asin, type: 'rank', field: 'Best Sellers Rank', summary: `Rank ${dir}: #${ra.toLocaleString('en-US')} → #${rb.toLocaleString('en-US')} in ${b.main.category}`, before: ra, after: rb }];
}

function diffOther(asin, a = {}, b = {}) {
  const out = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[key] === b[key]) continue;
    const name = key.replace(/_/g, ' ');
    const summary = a[key] === undefined ? `"${name}" added` : b[key] === undefined ? `"${name}" removed` : `"${name}" changed`;
    out.push({ asin, type: 'other', field: key, summary, before: short(a[key] ?? null), after: short(b[key] ?? null) });
  }
  return out;
}

export function diffAplus(a, b) {
  const comparable = (x) => x && (x.status === 'ok' || x.status === 'none');
  if (!comparable(a) || !comparable(b) || a.asin !== b.asin) return [];
  const asin = b.asin;
  if (a.status === 'none' && b.status === 'none') return [];
  if (a.status === 'none') return [{ asin, type: 'aplus', field: 'A+ content', summary: 'A+ content added', before: null, after: { text: short(b.text), images: b.images } }];
  if (b.status === 'none') return [{ asin, type: 'aplus', field: 'A+ content', summary: 'A+ content removed', before: { text: short(a.text), images: a.images }, after: null }];
  if (a.hash === b.hash) return [];

  const before = new Set(a.images), after = new Set(b.images);
  const added = b.images.filter((i) => !before.has(i)).length;
  const removed = a.images.filter((i) => !after.has(i)).length;
  const parts = [];
  if (a.text !== b.text) parts.push('text changed');
  if (added) parts.push(`${added} image${added > 1 ? 's' : ''} added`);
  if (removed) parts.push(`${removed} image${removed > 1 ? 's' : ''} removed`);
  if (!parts.length) parts.push('layout changed');
  const text = a.text !== b.text ? changedPart(a.text, b.text) : { before: null, after: null };
  return [{
    asin, type: 'aplus', field: 'A+ content', summary: `A+ content: ${parts.join(', ')}`,
    before: { text: text.before, images: a.images }, after: { text: text.after, images: b.images },
  }];
}

export function diffFamily(prev, next, settings = {}) {
  if (!prev) return [];
  const out = [];
  const pa = prev.variations?.childAsins || [], pb = next.variations?.childAsins || [];
  const added = pb.filter((x) => !pa.includes(x)), removed = pa.filter((x) => !pb.includes(x));
  if (added.length) out.push({ asin: next.parentAsin, type: 'variations', field: 'Variations', summary: `${added.length} variation${added.length > 1 ? 's' : ''} added`, before: null, after: added });
  if (removed.length) out.push({ asin: next.parentAsin, type: 'variations', field: 'Variations', summary: `${removed.length} variation${removed.length > 1 ? 's' : ''} removed`, before: removed, after: null });
  if ((prev.variations?.theme || null) !== (next.variations?.theme || null)) {
    out.push({ asin: next.parentAsin, type: 'variations', field: 'Variation theme', summary: 'Variation theme changed', before: prev.variations?.theme, after: next.variations?.theme });
  }

  for (const asin of Object.keys(next.items)) {
    const a = prev.items?.[asin], b = next.items[asin];
    if (!a) continue;
    out.push(
      ...diffText(asin, 'title', 'Title', a.title, b.title),
      ...diffText(asin, 'other', 'Brand', a.brand, b.brand),
      ...diffBullets(asin, a.bullets, b.bullets),
      ...diffText(asin, 'description', 'Description', a.description, b.description),
      ...diffImages(asin, a.images, b.images),
      ...diffPrice(asin, a.price, b.price),
      ...diffRank(asin, a.rank, b.rank, settings.rankChangeAlertPercent ?? 25),
      ...diffOther(asin, a.other, b.other),
    );
  }
  out.push(...diffAplus(prev.aplus, next.aplus));
  return out;
}
