// A tiny fake of Amazon's SP-API and product pages, so the tracker can be tested without real keys.
import http from 'node:http';

const MP = 'ATVPDKIKX0DER';
const v = (value) => [{ value, marketplace_id: MP, language_tag: 'en_US' }];

export function catalogItem(asin, p) {
  return {
    asin,
    attributes: {
      item_name: v(p.title),
      brand: v('Acme'),
      bullet_point: p.bullets.map((b) => ({ value: b, marketplace_id: MP })),
      product_description: v(p.description),
      material: v(p.material || 'Steel'),
      list_price: [{ value: 99, currency: 'USD', marketplace_id: MP }],
    },
    images: [{ marketplaceId: MP, images: p.images.flatMap((id, i) => [
      { variant: i === 0 ? 'MAIN' : `PT0${i}`, link: `https://m.media-amazon.com/images/I/${id}.jpg`, height: 1500, width: 1500 },
      { variant: i === 0 ? 'MAIN' : `PT0${i}`, link: `https://m.media-amazon.com/images/I/${id}._SL75_.jpg`, height: 75, width: 75 },
    ]) }],
    relationships: [{ marketplaceId: MP, relationships: p.children
      ? [{ type: 'VARIATION', childAsins: p.children, variationTheme: { attributes: ['color'], theme: 'COLOR' } }]
      : [{ type: 'VARIATION', parentAsins: [p.parent] }] }],
    salesRanks: [{ marketplaceId: MP, displayGroupRanks: [{ title: 'Patio, Lawn & Garden', rank: p.rank || 5000 }] }],
    summaries: [{ marketplaceId: MP, itemName: p.title, color: p.color }],
  };
}

export function offers(asin, price) {
  return {
    status: { statusCode: 200 },
    body: { payload: { ASIN: asin, Summary: {
      BuyBoxPrices: price == null ? [] : [{ condition: 'New', LandedPrice: { Amount: price, CurrencyCode: 'USD' } }],
      LowestPrices: price == null ? [] : [{ condition: 'new', LandedPrice: { Amount: price } }],
      NumberOfOffers: [{ condition: 'new', OfferCount: 1 }],
    }, Offers: [] } },
    request: { uri: `/products/pricing/v0/items/${asin}/offers` },
  };
}

export function productPage(aplusText, aplusImages) {
  return `<html><head><title>Amazon.com: Table</title></head><body><div id="dp"><span id="productTitle">Table</span>
    <div id="aplus_feature_div"><div id="aplus"><h2>From the brand</h2><p>${aplusText}</p>
    ${aplusImages.map((id) => `<img data-src="https://m.media-amazon.com/images/S/aplus-media/${id}.jpg" src="https://m.media-amazon.com/images/G/01/x-locale/common/grey-pixel.gif">`).join('')}
    <script>var x = Math.random();</script></div></div></div></body></html>`;
}

// state = { products: { ASIN: {...} }, prices: { ASIN: number }, aplus: { text, images }, throttleOnce: bool }
export function startFakeAmazon(state) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    let body = '';
    for await (const chunk of req) body += chunk;

    if (url.pathname === '/auth') return send(200, { access_token: 'test-token', expires_in: 3600 });
    if (req.headers['x-amz-access-token'] !== 'test-token' && !url.pathname.startsWith('/dp/')) return send(403, { errors: [{ message: 'bad token' }] });
    if (url.pathname === '/catalog/2022-04-01/items') {
      const ids = url.searchParams.get('identifiers').split(',');
      return send(200, { items: ids.filter((a) => state.products[a]).map((a) => catalogItem(a, state.products[a])) });
    }
    if (url.pathname === '/batches/products/pricing/v0/itemOffers') {
      if (state.throttleOnce) { state.throttleOnce = false; return send(429, { errors: [{ message: 'throttled' }] }); }
      const reqs = JSON.parse(body).requests;
      return send(200, { responses: reqs.map((r) => offers(r.uri.split('/')[5], state.prices[r.uri.split('/')[5]])) });
    }
    if (url.pathname.startsWith('/dp/')) {
      if (state.aplus === 'captcha') return send(200, '<form action="/errors/validateCaptcha">Type the characters you see</form>', 'text/html');
      return send(200, productPage(state.aplus.text, state.aplus.images), 'text/html');
    }
    send(404, { errors: [{ message: 'not found' }] });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
