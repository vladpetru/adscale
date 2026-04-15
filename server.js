'use strict';

// ================================================================
// AdScale — Amazon PPC Management Backend
// Data source: MarketplaceAdPros (MAP)
// Architecture: MAP list_resources → PostgreSQL cache → Dashboard
// ================================================================

require('dotenv').config();
const express     = require('express');
const session     = require('express-session');
const rateLimit   = require('express-rate-limit');
const helmet      = require('helmet');
const cors        = require('cors');
const axios       = require('axios');
const path        = require('path');
const { Pool }    = require('pg');
const SQLiteStore = require('connect-sqlite3')(session);

const app  = express();
const PORT = process.env.PORT || 8080;

// ----------------------------------------------------------------
// Env validation
// ----------------------------------------------------------------
const REQUIRED_VARS = ['APP_PASSWORD', 'SESSION_SECRET'];
const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error('ERROR: Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

const MAP_TOKEN    = process.env.MAP_BEARER_TOKEN || '';
const MAP_ENDPOINT = 'https://app.marketplaceadpros.com/mcp';

// Your UNIEVO US account IDs
const MAP_ACCOUNT = {
  accountId:     process.env.MAP_ACCOUNT_ID     || '47e6da51-bf41-42ae-9da2-edbfbc38f771',
  integrationId: process.env.MAP_INTEGRATION_ID || '512ee096-b7f1-4515-896d-d165d526caa2',
  brandId:       process.env.MAP_BRAND_ID       || '4a6fa058-4ca9-438b-9a04-edad5aec8a87',
};

// ----------------------------------------------------------------
// PostgreSQL setup
// ----------------------------------------------------------------
let db = null;
let mcpCallId = 1;

async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('WARNING: DATABASE_URL not set. Data will not persist.');
    return;
  }
  try {
    db = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await db.query(`CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
    await db.query(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
    await db.query(`CREATE TABLE IF NOT EXISTS algorithm_configs (
      algorithm_id TEXT PRIMARY KEY, enabled BOOLEAN DEFAULT false,
      config JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
    console.log('  Database connected and tables ready.');
  } catch (err) {
    console.error('Database init error:', err.message);
    db = null;
  }
}

// ----------------------------------------------------------------
// Cache helpers
// ----------------------------------------------------------------
async function cacheSet(key, value) {
  if (!db) return;
  await db.query(
    `INSERT INTO cache (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

async function cacheGet(key) {
  if (!db) return null;
  const r = await db.query('SELECT value, updated_at FROM cache WHERE key = $1', [key]);
  if (!r.rows.length) return null;
  return { data: r.rows[0].value, updatedAt: r.rows[0].updated_at };
}

async function cacheLastSync() {
  if (!db) return null;
  const r = await db.query('SELECT MAX(updated_at) as last FROM cache');
  return r.rows[0]?.last || null;
}

// ----------------------------------------------------------------
// MAP MCP caller — JSON-RPC to MAP endpoint
// ----------------------------------------------------------------
async function mapCall(method, params = {}) {
  if (!MAP_TOKEN) throw new Error('MAP_BEARER_TOKEN not configured.');
  const response = await axios.post(MAP_ENDPOINT, {
    jsonrpc: '2.0',
    id: mcpCallId++,
    method,
    params,
  }, {
    headers: {
      'Authorization': `Bearer ${MAP_TOKEN}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json, text/event-stream',
    },
    timeout: 90000,
  });

  const result = response.data?.result;
  if (!result) {
    const err = response.data?.error;
    throw new Error(err?.message || `MAP returned no result for: ${method}`);
  }

  // Parse text content blocks
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text' && block.text) {
        try { return JSON.parse(block.text); } catch { return block.text; }
      }
    }
  }
  return result;
}

// ----------------------------------------------------------------
// MAP list_resources — the correct way to fetch data from MAP
// ----------------------------------------------------------------
async function mapListResources(resourceType, filters = {}) {
  return mapCall('tools/call', {
    name: 'list_resources',
    arguments: {
      account_id:     MAP_ACCOUNT.accountId,
      integration_id: MAP_ACCOUNT.integrationId,
      brand_id:       MAP_ACCOUNT.brandId,
      resource_type:  resourceType,
      filters,
    },
  });
}

// ----------------------------------------------------------------
// MAP update_resources — push changes back to Amazon via MAP
// ----------------------------------------------------------------
async function mapUpdateResources(resourceType, resources, note = '') {
  return mapCall('tools/call', {
    name: 'update_resources',
    arguments: {
      account_id:     MAP_ACCOUNT.accountId,
      integration_id: MAP_ACCOUNT.integrationId,
      brand_id:       MAP_ACCOUNT.brandId,
      note,
      resources: resources.map(r => ({ type: resourceType, ...r })),
    },
  });
}

// ----------------------------------------------------------------
// MAP create_resources
// ----------------------------------------------------------------
async function mapCreateResources(resourceType, resources, note = '') {
  return mapCall('tools/call', {
    name: 'create_resources',
    arguments: {
      account_id:     MAP_ACCOUNT.accountId,
      integration_id: MAP_ACCOUNT.integrationId,
      brand_id:       MAP_ACCOUNT.brandId,
      note,
      resources: resources.map(r => ({ type: resourceType, ...r })),
    },
  });
}

// ----------------------------------------------------------------
// Normalize MAP response into a clean array
// ----------------------------------------------------------------
function normalizeMapResult(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    // MAP often returns { items: [...] } or { campaigns: [...] } etc.
    const keys = ['items', 'campaigns', 'keywords', 'adGroups', 'ad_groups',
                  'portfolios', 'productAds', 'product_ads', 'targets', 'results', 'data'];
    for (const k of keys) {
      if (Array.isArray(result[k])) return result[k];
    }
    // Try any array-valued key
    for (const k of Object.keys(result)) {
      if (Array.isArray(result[k])) return result[k];
    }
    return [result];
  }
  return [];
}

// ----------------------------------------------------------------
// Main sync function
// ----------------------------------------------------------------
async function syncFromMAP() {
  if (!MAP_TOKEN) throw new Error('MAP_BEARER_TOKEN not set.');
  const errors = [];
  let synced = 0;

  async function safeSync(cacheKey, resourceType, filters = {}) {
    try {
      const result = await mapListResources(resourceType, filters);
      const items = normalizeMapResult(result);
      await cacheSet(cacheKey, items);
      synced++;
      console.log(`  Synced: ${cacheKey} (${items.length} items) via ${resourceType}`);
    } catch (err) {
      console.error(`  Failed: ${cacheKey} (${resourceType}) — ${err.message}`);
      errors.push({ key: cacheKey, resourceType, error: err.message });
    }
  }

  console.log('Starting MAP sync...');

  // Sponsored Products
  await safeSync('sp_campaigns',   'sp_campaigns');
  await safeSync('sp_portfolios',  'sp_portfolios');
  await safeSync('sp_keywords',    'sp_keywords');
  await safeSync('sp_ad_groups',   'sp_ad_groups');
  await safeSync('sp_product_ads', 'sp_product_ads');
  await safeSync('sp_neg_kws',     'sp_negative_keywords');
  await safeSync('sp_camp_neg_kws','sp_campaign_negative_keywords');

  // Sponsored Brands
  await safeSync('sb_campaigns',   'sb_campaigns');
  await safeSync('sb_keywords',    'sb_keywords');
  await safeSync('sb_ad_groups',   'sb_ad_groups');

  // Sponsored Display
  await safeSync('sd_campaigns',   'sd_campaigns');
  await safeSync('sd_ad_groups',   'sd_ad_groups');
  await safeSync('sd_product_ads', 'sd_product_ads');

  // Budget rules (dayparting)
  await safeSync('sp_budget_rules','sp_budget_rules');

  // Campaign performance via report analyst
  try {
    const campPerfRaw = await mapCall('tools/call', {
      name: 'ask_report_analyst',
      arguments: {
        brand_ids:       [MAP_ACCOUNT.brandId],
        integration_ids: [MAP_ACCOUNT.integrationId],
        fast: true,
        question: 'Last 30 days SP campaign performance. Return JSON array with fields: campaignId, campaignName, spend, sales14d, acos, roas, impressions, clicks, purchases14d. JSON only.',
      },
    });
    const campPerfStr = typeof campPerfRaw === 'string' ? campPerfRaw : JSON.stringify(campPerfRaw);
    let campPerfRows = [];
    const campMatch = campPerfStr.match(/\[[\s\S]*?\]/);
    if (campMatch) { try { campPerfRows = JSON.parse(campMatch[0]); } catch(e) { console.error('  Camp perf parse error:', e.message); } }
    const perfMap = {};
    campPerfRows.forEach(row => {
      if (row.campaignId) {
        perfMap[String(row.campaignId)] = {
          spend:       parseFloat(row.spend)         || 0,
          sales:       parseFloat(row.sales14d || row.sales) || 0,
          acos:        parseFloat(row.acos)           || null,
          roas:        parseFloat(row.roas)           || null,
          impressions: parseInt(row.impressions)      || 0,
          clicks:      parseInt(row.clicks)           || 0,
          orders:      parseInt(row.purchases14d || row.orders) || 0,
        };
      }
    });
    await cacheSet('performance_map', perfMap);
    synced++;
    console.log('  Synced: performance_map (' + Object.keys(perfMap).length + ' campaigns)');
  } catch (err) {
    console.error('  Failed: campaign performance — ' + err.message);
    errors.push({ key: 'performance_map', error: err.message });
  }

  // Keyword performance via report analyst
  try {
    const kwPerfRaw = await mapCall('tools/call', {
      name: 'ask_report_analyst',
      arguments: {
        brand_ids:       [MAP_ACCOUNT.brandId],
        integration_ids: [MAP_ACCOUNT.integrationId],
        fast: true,
        question: 'Last 30 days SP keyword performance. Return JSON array with fields: keywordId, keywordText, matchType, campaignId, campaignName, spend, sales14d, acos, roas, impressions, clicks, purchases14d. JSON only.',
      },
    });
    const kwPerfStr = typeof kwPerfRaw === 'string' ? kwPerfRaw : JSON.stringify(kwPerfRaw);
    let kwPerfRows = [];
    const kwMatch = kwPerfStr.match(/\[[\s\S]*?\]/);
    if (kwMatch) { try { kwPerfRows = JSON.parse(kwMatch[0]); } catch(e) { console.error('  KW perf parse error:', e.message); } }
    await cacheSet('kw_performance', kwPerfRows);
    synced++;
    console.log('  Synced: kw_performance (' + kwPerfRows.length + ' keywords)');
  } catch (err) {
    console.error('  Failed: keyword performance — ' + err.message);
    errors.push({ key: 'kw_performance', error: err.message });
  }

  // Merge all campaigns into one unified cache key for dashboard
  try {
    const sp = (await cacheGet('sp_campaigns'))?.data || [];
    const sb = (await cacheGet('sb_campaigns'))?.data || [];
    const sd = (await cacheGet('sd_campaigns'))?.data || [];
    const allCamps = [
      ...normalizeMapResult(sp).map(c => ({ ...c, _adType: 'SP' })),
      ...normalizeMapResult(sb).map(c => ({ ...c, _adType: 'SB' })),
      ...normalizeMapResult(sd).map(c => ({ ...c, _adType: 'SD' })),
    ];
    await cacheSet('campaigns', allCamps);

    // Merge all keywords
    const spKw = normalizeMapResult((await cacheGet('sp_keywords'))?.data || []);
    const sbKw = normalizeMapResult((await cacheGet('sb_keywords'))?.data || []);
    await cacheSet('keywords', [...spKw, ...sbKw]);

    // Merge all product ads
    const spAds = normalizeMapResult((await cacheGet('sp_product_ads'))?.data || []);
    const sdAds = normalizeMapResult((await cacheGet('sd_product_ads'))?.data || []);
    await cacheSet('product_ads', [...spAds, ...sdAds]);

    // Portfolios
    const ports = normalizeMapResult((await cacheGet('sp_portfolios'))?.data || []);
    await cacheSet('portfolios', ports);

    synced++;
    console.log(`  Built merged caches: campaigns(${allCamps.length}), keywords(${spKw.length+sbKw.length})`);
  } catch (err) {
    console.error('  Failed to build merged caches:', err.message);
    errors.push({ key: 'merge', error: err.message });
  }

  console.log(`Sync done. ${synced} ok, ${errors.length} failed.`);
  return { synced, errors, timestamp: new Date().toISOString() };
}

// ----------------------------------------------------------------
// Security middleware
// ----------------------------------------------------------------
function ipAllowlist(req, res, next) {
  const allowed = process.env.ALLOWED_IPS;
  if (!allowed?.trim()) return next();
  const list = allowed.split(',').map(ip => ip.trim());
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (list.includes(ip)) return next();
  return res.status(403).json({ error: 'Access denied.' });
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
});
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 200 });

// ----------------------------------------------------------------
// App setup
// ----------------------------------------------------------------
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: '.' }),
  secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true, maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax',
  },
  name: 'adscale.sid',
}));
app.use(ipAllowlist);
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session?.loggedIn) return next();
  return res.status(401).json({ error: 'Not authenticated.' });
}

// ================================================================
// ROUTES — Auth
// ================================================================

app.post('/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required.' });
  if (password !== process.env.APP_PASSWORD) return res.status(401).json({ error: 'Incorrect password.' });
  req.session.loggedIn = true;
  console.log(`Login from ${req.ip}`);
  return res.json({ success: true });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/auth/status', requireAuth, async (req, res) => {
  const lastSync = await cacheLastSync();
  res.json({ loggedIn: true, mapConfigured: !!MAP_TOKEN, dbConnected: !!db, lastSync: lastSync || null });
});

// ================================================================
// ROUTES — Sync
// ================================================================

app.post('/api/sync', requireAuth, apiLimiter, async (req, res) => {
  try {
    const result = await syncFromMAP();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Sync error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================================================================
// ROUTES — Data reads (from PostgreSQL cache)
// ================================================================

async function sendCached(res, key) {
  const cached = await cacheGet(key);
  if (!cached) {
    return res.json({ data: [], cached: false, message: 'No data yet. Click Refresh to sync.' });
  }
  const data = normalizeMapResult(cached.data);
  return res.json({ data, cached: true, updatedAt: cached.updatedAt });
}

app.get('/api/campaigns',         requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'campaigns');    } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/keywords',          requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'keywords');     } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/portfolios',        requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'portfolios');   } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/ad-groups',         requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'sp_ad_groups'); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/product-ads',       requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'product_ads');  } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/search-terms',      requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'keywords');     } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/negative-keywords', requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'sp_neg_kws');   } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/budget-rules',      requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'sp_budget_rules'); } catch(e) { res.status(500).json({ error: e.message }); } });

// SP campaigns only (for campaign filter)
app.get('/api/sp-campaigns', requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'sp_campaigns'); } catch(e) { res.status(500).json({ error: e.message }); } });

// Performance map — campaignId → metrics
app.get('/api/performance-map', requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'performance_map'); } catch(e) { res.status(500).json({ error: e.message }); } });

// Keyword performance
app.get('/api/kw-performance', requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'kw_performance'); } catch(e) { res.status(500).json({ error: e.message }); } });

// ================================================================
// ROUTES — Write actions (push to Amazon via MAP)
// ================================================================

// Update campaign (pause/enable/budget)
app.put('/api/campaigns/:id', requireAuth, async (req, res) => {
  try {
    const { _adType, ...fields } = req.body;
    const type = _adType === 'SB' ? 'sb_campaigns' : _adType === 'SD' ? 'sd_campaigns' : 'sp_campaigns';
    const result = await mapUpdateResources(type, [{ campaignId: req.params.id, ...fields }], 'AdScale dashboard update');
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update keyword (bid, state)
app.put('/api/keywords/:id', requireAuth, async (req, res) => {
  try {
    const { _adType, ...fields } = req.body;
    const type = _adType === 'SB' ? 'sb_keywords' : 'sp_keywords';
    const result = await mapUpdateResources(type, [{ keywordId: req.params.id, ...fields }], 'AdScale bid/state update');
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Add negative keyword
app.post('/api/keywords/negative', requireAuth, async (req, res) => {
  try {
    const result = await mapCreateResources('sp_negative_keywords', [req.body], 'AdScale negative keyword');
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create campaign
app.post('/api/campaigns', requireAuth, async (req, res) => {
  try {
    const { _adType, ...fields } = req.body;
    const type = _adType === 'SB' ? 'sb_campaigns' : _adType === 'SD' ? 'sd_campaigns' : 'sp_campaigns';
    const result = await mapCreateResources(type, [fields], 'AdScale new campaign');
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// ROUTES — Algorithm settings (PostgreSQL only)
// ================================================================

app.get('/api/settings', requireAuth, async (req, res) => {
  if (!db) return res.json({});
  try {
    const r = await db.query('SELECT key, value FROM settings');
    const out = {};
    r.rows.forEach(row => { out[row.key] = row.value; });
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings', requireAuth, async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required.' });
  if (!db) return res.json({ success: true, persisted: false });
  try {
    await db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
    res.json({ success: true, persisted: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/algorithms', requireAuth, async (req, res) => {
  if (!db) return res.json([]);
  try {
    const r = await db.query('SELECT algorithm_id, enabled, config, updated_at FROM algorithm_configs ORDER BY algorithm_id');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/algorithms/:id', requireAuth, async (req, res) => {
  const { enabled, config } = req.body;
  if (!db) return res.json({ success: true, persisted: false });
  try {
    await db.query(
      `INSERT INTO algorithm_configs (algorithm_id, enabled, config, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (algorithm_id) DO UPDATE SET enabled = $2, config = $3, updated_at = NOW()`,
      [req.params.id, enabled, JSON.stringify(config || {})]
    );
    res.json({ success: true, persisted: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// ROUTES — Health + debug
// ================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mapConfigured: !!MAP_TOKEN, dbConnected: !!db, timestamp: new Date().toISOString() });
});

// Debug: list available MAP resource types
app.get('/api/debug/resource-types', requireAuth, async (req, res) => {
  try {
    const result = await mapCall('tools/call', { name: 'list_resource_types', arguments: {} });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Debug: test a specific resource type list
app.get('/api/debug/list/:type', requireAuth, async (req, res) => {
  try {
    const result = await mapListResources(req.params.type);
    res.json({ type: req.params.type, count: normalizeMapResult(result).length, sample: normalizeMapResult(result).slice(0,2), raw: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================================================================
// Start
// ================================================================
initDatabase().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║        AdScale Server Running        ║');
    console.log(`  ║   http://0.0.0.0:${PORT}               ║`);
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
    console.log(`  MAP configured:     ${!!MAP_TOKEN}`);
    console.log(`  Database connected: ${!!db}`);
    console.log(`  IP allowlist:       ${process.env.ALLOWED_IPS ? 'enabled' : 'disabled'}`);
    console.log('');
    console.log('  Log in and click Refresh to sync from MAP.');
    console.log('  Debug: /api/debug/resource-types');
    console.log('');
  });
});
