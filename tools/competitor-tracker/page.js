// The Competitor Watch tab: competitor cards on top, then a filterable feed of every change.
// The page draws itself in the browser from the data passed in by index.js.

const STYLES = `
.cw {
  --t-price: #0f5d8c; --t-images: #7a3fa0; --t-aplus: #b0472b; --t-title: #2f6b2f;
  --t-bullets: #3d6b6b; --t-description: #5b5f1f; --t-variations: #8a4b00; --t-rank: #4b5aa8;
  --t-sellers: #6b5b45; --t-other: #5a6876; --t-baseline: #8792a0;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cw {
    --t-price: #6cb4e4; --t-images: #c49ae0; --t-aplus: #f0937a; --t-title: #8fd18f; --t-bullets: #7cc4c4;
    --t-description: #cfd27a; --t-variations: #f0ac5a; --t-rank: #9aa8f0; --t-sellers: #c9b79a; --t-other: #93a1af; --t-baseline: #6b7886;
  }
}
:root[data-theme="dark"] .cw {
  --t-price: #6cb4e4; --t-images: #c49ae0; --t-aplus: #f0937a; --t-title: #8fd18f; --t-bullets: #7cc4c4;
  --t-description: #cfd27a; --t-variations: #f0ac5a; --t-rank: #9aa8f0; --t-sellers: #c9b79a; --t-other: #93a1af; --t-baseline: #6b7886;
}
.cw { display: grid; gap: 24px; min-width: 0; }
.cw-head { display: flex; flex-wrap: wrap; gap: 16px 32px; align-items: end; justify-content: space-between; }
.cw-head h1 { margin-bottom: 6px; }
.status { display: flex; flex-wrap: wrap; gap: 8px 20px; color: var(--muted); font-size: 0.85rem; align-items: center; }
.status b { color: var(--ink); font-weight: 600; }
.actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.run-note { color: var(--muted); font-size: 0.85rem; max-width: 34ch; }
.products { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.product { display: grid; grid-template-columns: 64px 1fr; gap: 12px; align-items: start; text-align: left; font: inherit; color: inherit;
  background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px; cursor: pointer; }
.product:hover { border-color: var(--accent); }
.product[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.thumb { width: 64px; height: 64px; border-radius: 6px; background: var(--sunken); object-fit: contain; display: block; }
.product .name { font-weight: 600; line-height: 1.25; }
.product .meta { color: var(--muted); font-size: 0.8rem; display: grid; gap: 2px; margin-top: 4px; min-width: 0; }
.product .price { font-family: var(--mono); font-size: 0.95rem; color: var(--ink); }

.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font: inherit; font-size: 0.82rem; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
.chip[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.chip .n { color: inherit; opacity: 0.6; margin-left: 4px; font-family: var(--mono); font-size: 0.75rem; }
select, input[type="search"] { font: inherit; font-size: 0.88rem; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
input[type="search"] { flex: 1 1 180px; min-width: 0; }

.day { display: grid; gap: 8px; }
.day h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-family: var(--body); font-weight: 600; padding-top: 8px; }
.change { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
.change summary { list-style: none; cursor: pointer; display: grid; grid-template-columns: 110px 1fr auto; gap: 12px; align-items: baseline; padding: 12px 14px; }
.change summary::-webkit-details-marker { display: none; }
.change[open] summary { border-bottom: 1px solid var(--line); }
.type { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; color: var(--tc); display: flex; align-items: center; gap: 6px; }
.type::before { content: ""; width: 8px; height: 8px; border-radius: 2px; background: var(--tc); flex: none; }
.what { min-width: 0; }
.what .sum { font-weight: 500; }
.what .who { color: var(--muted); font-size: 0.82rem; overflow-wrap: anywhere; }
.delta { font-family: var(--mono); font-size: 0.82rem; padding: 1px 8px; border-radius: 6px; white-space: nowrap; }
.delta.up { background: var(--up-soft); color: var(--up); }
.delta.down { background: var(--down-soft); color: var(--down); }
.detail { padding: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.side { min-width: 0; border-radius: 8px; padding: 10px 12px; font-size: 0.88rem; overflow-wrap: anywhere; }
.side.before { background: var(--sunken); }
.side.after { background: var(--accent-soft); }
.side .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 600; margin-bottom: 4px; }
.side .empty { color: var(--muted); font-style: italic; }
.imgs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.imgs a { display: block; }
.imgs img, .imgs .missing { width: 72px; height: 72px; object-fit: contain; border-radius: 6px; background: var(--surface); border: 1px solid var(--line); }
.imgs .missing { display: grid; place-items: center; font-family: var(--mono); font-size: 0.6rem; color: var(--muted); padding: 4px; overflow: hidden; text-align: center; }
.imgs .new { outline: 2px solid var(--down); outline-offset: 1px; }
.imgs .gone { outline: 2px solid var(--up); outline-offset: 1px; }
.empty-state { background: var(--surface); border: 1px dashed var(--line); border-radius: 10px; padding: 28px; text-align: center; color: var(--muted); }
.more { justify-self: center; }

.feed { display: grid; gap: 18px; }
.more { justify-self: center; }
@media (max-width: 640px) {
  .change summary { grid-template-columns: 1fr auto; }
  .change summary .type { grid-column: 1 / -1; }
  .detail { grid-template-columns: 1fr; }
}
`;

const MARKUP = `
<div class="cw">
  <div class="cw-head">
    <div>
      <h1>Competitor Watch</h1>
      <div class="status" id="status"></div>
    </div>
    <div class="actions" id="actions" hidden>
      <button class="btn primary" id="run" type="button">Check now</button>
      <span class="run-note" id="runNote"></span>
    </div>
  </div>
  <div id="notice" hidden></div>
  <section class="products" id="products" aria-label="Tracked competitors"></section>
  <section class="filters" aria-label="Filters">
    <div class="chips" id="types"></div>
    <select id="range" aria-label="Time range">
      <option value="7">Last 7 days</option>
      <option value="30" selected>Last 30 days</option>
      <option value="90">Last 90 days</option>
      <option value="0">All time</option>
    </select>
    <input type="search" id="q" placeholder="Search changes" aria-label="Search changes">
  </section>
  <section id="feed" class="feed"></section>
</div>`;

const SCRIPT = `
const DATA = __DATA__;
const TYPES = { price: 'Price', images: 'Images', aplus: 'A+ content', title: 'Title', bullets: 'Bullets', description: 'Description',
  variations: 'Variations', rank: 'Rank', sellers: 'Sellers', other: 'Other', baseline: 'Started' };
const state = { type: 'all', product: null, range: 30, q: '', limit: 150 };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const img = (id, size) => (/^https?:/.test(id) ? id : \`https://m.media-amazon.com/images/I/\${id}._AC_SL\${size}_.jpg\`);
const site = DATA.amazonSite || 'www.amazon.com';
const money = (v) => (v == null ? 'none' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const ago = (iso) => { const d = Math.round((Date.now() - Date.parse(iso)) / 86400000); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago'; };

function thumb(id, size, cls = '') {
  return \`<a href="\${img(id, 1000)}" target="_blank" rel="noopener"><img class="\${cls}" src="\${img(id, size)}" alt="Product image \${esc(id)}" loading="lazy"
    onerror="this.outerHTML='<span class=&quot;missing \${cls}&quot;>\${esc(id.split('/').pop())}</span>'"></a>\`;
}

function renderStatus() {
  const s = DATA.status || {};
  const errs = s.errors || [];
  $('status').innerHTML = [
    s.lastRunAt ? \`<span>Last check <b>\${esc(fmtTime(s.lastRunAt))}</b></span>\` : '<span>Not run yet</span>',
    \`<span><b>\${DATA.products.length}</b> competitor\${DATA.products.length === 1 ? '' : 's'}</span>\`,
    \`<span>Checks every <b>\${DATA.checkEveryDays}</b> day\${DATA.checkEveryDays == 1 ? '' : 's'}</span>\`,
    errs.length ? \`<span class="pill warn">\${errs.length} warning\${errs.length > 1 ? 's' : ''}</span>\` : (s.lastRunAt ? '<span class="pill ok">All checks ran</span>' : ''),
  ].filter(Boolean).join('');
  if (DATA.sample) {
    $('notice').hidden = false;
    $('notice').className = 'notice warn';
    $('notice').innerHTML = '<b>Preview with made-up sample data.</b> Your real competitors appear here after the tracker runs. Product photos load on the real site.';
    return;
  }
  if (errs.length) {
    $('notice').hidden = false;
    $('notice').className = 'notice warn';
    $('notice').innerHTML = \`<b>Last check warnings</b><ul>\${errs.map((e) => \`<li>\${esc(e)}</li>\`).join('')}</ul>\`;
  }
}

function renderProducts() {
  $('products').innerHTML = DATA.products.map((p) => {
    const price = p.priceMin == null ? 'No price' : p.priceMin === p.priceMax ? money(p.priceMin) : \`\${money(p.priceMin)} to \${money(p.priceMax)}\`;
    return \`<button class="product" data-asin="\${esc(p.parentAsin)}" aria-pressed="\${state.product === p.parentAsin}">
      \${p.image ? \`<img class="thumb" src="\${img(p.image, 160)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb'}))">\` : '<div class="thumb"></div>'}
      <div style="min-width:0">
        <div class="name">\${esc(p.nickname)}</div>
        <div class="meta">
          <span class="price">\${price}</span>
          <span>\${p.childCount ? p.childCount + ' variation' + (p.childCount === 1 ? '' : 's') : 'No variations'} · <span class="mono">\${esc(p.parentAsin)}</span></span>
          <span>\${p.changes30} change\${p.changes30 === 1 ? '' : 's'} in 30 days\${p.lastChange ? ', latest ' + ago(p.lastChange) : ''}</span>
        </div>
      </div>
    </button>\`;
  }).join('') || '<div class="empty-state">No competitors yet. Add ASINs to <span class="mono">products.json</span> and the next run will start tracking them.</div>';
  document.querySelectorAll('.product').forEach((b) => b.addEventListener('click', () => {
    state.product = state.product === b.dataset.asin ? null : b.dataset.asin;
    state.limit = 150;
    render();
  }));
}

function filtered(ignoreType) {
  const cutoff = state.range ? Date.now() - state.range * 86400000 : 0;
  const q = state.q.toLowerCase();
  return DATA.changes.filter((c) =>
    (ignoreType || state.type === 'all' || c.type === state.type) &&
    (!state.product || c.parentAsin === state.product) &&
    Date.parse(c.detectedAt) >= cutoff &&
    (!q || JSON.stringify([c.summary, c.nickname, c.asin, c.field, c.before, c.after, DATA.labels[c.asin]]).toLowerCase().includes(q)));
}

function renderTypes() {
  const counts = {};
  for (const c of filtered(true)) counts[c.type] = (counts[c.type] || 0) + 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chips = [['all', 'All', total], ...Object.keys(TYPES).filter((t) => counts[t]).map((t) => [t, TYPES[t], counts[t]])];
  $('types').innerHTML = chips.map(([t, label, n]) =>
    \`<button class="chip" data-type="\${t}" aria-pressed="\${state.type === t}">\${label}<span class="n">\${n}</span></button>\`).join('');
  document.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { state.type = b.dataset.type; state.limit = 150; render(); }));
}

function sideHtml(c, which) {
  const v = c[which];
  const other = c[which === 'before' ? 'after' : 'before'];
  if (v == null) return '<span class="empty">Nothing</span>';
  if (c.type === 'images' || (c.type === 'variations' && Array.isArray(v))) {
    if (c.type === 'variations') return v.map((a) => \`<a class="mono" href="https://\${site}/dp/\${a}" target="_blank" rel="noopener">\${a}</a>\`).join(', ');
    const otherSet = new Set(other || []);
    return \`<div class="imgs">\${v.map((id) => thumb(id, 160, otherSet.has(id) ? '' : which === 'after' ? 'new' : 'gone')).join('')}</div>\`;
  }
  if (c.type === 'aplus') {
    const otherImgs = new Set(other?.images || []);
    return \`\${v.text ? \`<div>\${esc(v.text)}</div>\` : '<div class="empty">Text unchanged</div>'}
      <div class="imgs">\${(v.images || []).map((id) => thumb(id, 160, otherImgs.has(id) ? '' : which === 'after' ? 'new' : 'gone')).join('')}</div>\`;
  }
  if (c.type === 'price' || c.field === 'List price') return \`<span class="mono">\${money(v)}</span>\`;
  if (c.type === 'rank') return \`<span class="mono">#\${Number(v).toLocaleString('en-US')}</span>\`;
  return esc(v);
}

function deltaHtml(c) {
  if (c.type !== 'price' || c.before == null || c.after == null) return '';
  const pct = ((c.after - c.before) / c.before) * 100;
  return \`<span class="delta \${pct > 0 ? 'up' : 'down'}">\${pct > 0 ? '+' : ''}\${pct.toFixed(1)}%</span>\`;
}

function renderFeed() {
  const list = filtered(false);
  if (!list.length) {
    $('feed').innerHTML = \`<div class="empty-state">\${DATA.changes.length ? 'No changes match these filters.' : 'No changes yet. The first run saves a starting point, and changes appear from the second run on.'}</div>\`;
    return;
  }
  const shown = list.slice(0, state.limit);
  const days = new Map();
  for (const c of shown) {
    const key = c.detectedAt.slice(0, 10);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(c);
  }
  $('feed').innerHTML = [...days.entries()].map(([, items]) => \`<div class="day"><h2>\${fmtDate(items[0].detectedAt)}</h2>\${items.map((c) => {
    const label = DATA.labels[c.asin];
    const hasDetail = c.type !== 'baseline';
    return \`<details class="change" style="--tc: var(--t-\${esc(c.type)}, var(--t-other))">
      <summary>
        <span class="type">\${TYPES[c.type] || esc(c.type)}</span>
        <span class="what"><div class="sum">\${esc(c.summary)}</div>
          <div class="who">\${esc(c.nickname)} · <a class="mono" href="https://\${site}/dp/\${esc(c.asin)}" target="_blank" rel="noopener">\${esc(c.asin)}</a>\${label ? ' · ' + esc(label) : ''}</div></span>
        \${deltaHtml(c)}
      </summary>
      \${hasDetail ? \`<div class="detail">
        <div class="side before"><div class="label">Before</div>\${sideHtml(c, 'before')}</div>
        <div class="side after"><div class="label">After</div>\${sideHtml(c, 'after')}</div>
      </div>\` : ''}
    </details>\`;
  }).join('')}</div>\`).join('') + (list.length > shown.length ? \`<div class="more"><button class="btn" id="more">Show more (\${list.length - shown.length} left)</button></div>\` : '');
  $('more')?.addEventListener('click', () => { state.limit += 150; renderFeed(); });
}

function render() { renderProducts(); renderTypes(); renderFeed(); }

$('range').addEventListener('change', (e) => { state.range = Number(e.target.value); state.limit = 150; render(); });
$('q').addEventListener('input', (e) => { state.q = e.target.value; state.limit = 150; renderTypes(); renderFeed(); });
function setupRun() {
  if (!DATA.canRun) return;
  $('actions').hidden = false;
  const busy = () => { $('run').disabled = true; $('runNote').textContent = 'Checking now. This takes a few minutes; refresh the page to see results.'; };
  if (DATA.running) busy();
  $('run').addEventListener('click', async () => {
    busy();
    try {
      const res = await fetch(DATA.base + '/run', { method: 'POST' });
      if (res.status === 409) $('runNote').textContent = 'A check is already running. Refresh in a few minutes.';
      else if (!res.ok) throw new Error();
    } catch {
      $('run').disabled = false;
      $('runNote').textContent = 'Could not start the check. Try again in a moment.';
    }
  });
}

renderStatus();
setupRun();
render();`;

// Makes the data safe to place inside a <script> tag.
const embed = (data) => JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function renderTrackerPage(data) {
  return {
    head: `<style>${STYLES}</style>`,
    body: `${MARKUP}\n<script>\n${SCRIPT.replace('__DATA__', () => embed(data))}\n</script>`,
  };
}
