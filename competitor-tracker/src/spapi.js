// Talks to Amazon's Selling Partner API (SP-API).
// Docs: https://developer-docs.amazon.com/sp-api/
//
// Needs three secrets (see README): SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SPAPI_REFRESH_TOKEN.

const MARKETPLACES = {
  US: { id: 'ATVPDKIKX0DER', endpoint: 'https://sellingpartnerapi-na.amazon.com' },
  CA: { id: 'A2EUQ1WTGCTBG2', endpoint: 'https://sellingpartnerapi-na.amazon.com' },
  MX: { id: 'A1AM78C64UM0Y8', endpoint: 'https://sellingpartnerapi-na.amazon.com' },
  UK: { id: 'A1F83G8C2ARO7P', endpoint: 'https://sellingpartnerapi-eu.amazon.com' },
  DE: { id: 'A1PA6795UKMFR9', endpoint: 'https://sellingpartnerapi-eu.amazon.com' },
};

const CATALOG_DATA = 'attributes,images,relationships,salesRanks,summaries';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SpApi {
  constructor({ clientId, clientSecret, refreshToken, marketplace = 'US' }) {
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Missing SP-API secrets. Set SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET and SPAPI_REFRESH_TOKEN.');
    }
    const mp = MARKETPLACES[marketplace];
    if (!mp) throw new Error(`Unknown marketplace "${marketplace}". Use one of: ${Object.keys(MARKETPLACES).join(', ')}`);
    this.creds = { clientId, clientSecret, refreshToken };
    this.marketplaceId = mp.id;
    this.endpoint = process.env.SPAPI_ENDPOINT || mp.endpoint;
    this.token = null;
    this.tokenExpires = 0;
    this.lastCall = {};
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpires) return this.token;
    const res = await fetch(process.env.SPAPI_TOKEN_URL || 'https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.creds.refreshToken,
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Amazon login failed (${res.status}): ${body.error_description || body.error || 'unknown error'}`);
    this.token = body.access_token;
    this.tokenExpires = Date.now() + (body.expires_in - 120) * 1000;
    return this.token;
  }

  // Waits so each operation stays under Amazon's rate limit, and retries when throttled.
  async call(operation, minGapMs, method, path, { query, body } = {}) {
    const url = new URL(this.endpoint + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

    for (let attempt = 0; attempt < 6; attempt++) {
      const wait = (this.lastCall[operation] || 0) + minGapMs - Date.now();
      if (wait > 0 && !process.env.TRACKER_FAST) await sleep(wait);
      this.lastCall[operation] = Date.now();

      const res = await fetch(url, {
        method,
        headers: {
          'x-amz-access-token': await this.accessToken(),
          'Content-Type': 'application/json',
          'User-Agent': 'competitor-tracker/1.0 (Language=JavaScript)',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(process.env.TRACKER_FAST ? 10 : Math.min(60000, 2000 * 2 ** attempt));
        continue;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json.errors?.map((e) => e.message).join('; ') || res.statusText;
        throw new Error(`${operation} failed (${res.status}): ${msg}`);
      }
      return json;
    }
    throw new Error(`${operation} kept getting throttled by Amazon, gave up after 6 tries`);
  }

  // Catalog data for up to 20 ASINs per request (title, bullets, images, variations, rank...).
  async getCatalogItems(asins) {
    const out = {};
    for (let i = 0; i < asins.length; i += 20) {
      const batch = asins.slice(i, i + 20);
      const json = await this.call('searchCatalogItems', 600, 'GET', '/catalog/2022-04-01/items', {
        query: {
          identifiers: batch.join(','),
          identifiersType: 'ASIN',
          marketplaceIds: this.marketplaceId,
          includedData: CATALOG_DATA,
          pageSize: '20',
        },
      });
      for (const item of json.items || []) out[item.asin] = item;
    }
    return out;
  }

  // Buy Box price, lowest price and seller count for up to 20 ASINs per request.
  async getOffers(asins) {
    const out = {};
    for (let i = 0; i < asins.length; i += 20) {
      const batch = asins.slice(i, i + 20);
      const json = await this.call('getItemOffersBatch', 10500, 'POST', '/batches/products/pricing/v0/itemOffers', {
        body: {
          requests: batch.map((asin) => ({
            uri: `/products/pricing/v0/items/${asin}/offers`,
            method: 'GET',
            MarketplaceId: this.marketplaceId,
            ItemCondition: 'New',
            CustomerType: 'Consumer',
          })),
        },
      });
      for (const r of json.responses || []) {
        const asin = r.body?.payload?.ASIN || r.request?.Asin || r.request?.uri?.split('/')[5];
        if (!asin) continue;
        out[asin] = r.status?.statusCode === 200 ? r.body.payload : { error: r.body?.errors?.[0]?.message || 'no offer data' };
      }
    }
    return out;
  }
}
