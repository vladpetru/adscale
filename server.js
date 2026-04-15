'use strict';

// ================================================================
// AdScale — Amazon PPC Management Backend
// Data source: MarketplaceAdPros (MAP)
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
  console.error('ERROR: Missing required env vars:', missing.join(', '));
  process.exit(1);
}

const MAP_TOKEN    = process.env.MAP_BEARER_TOKEN || '';
const MAP_ENDPOINT = 'https://app.marketplaceadpros.com/mcp';
const MAP_ACCOUNT  = {
  accountId:     process.env.MAP_ACCOUNT_ID     || '47e6da51-bf41-42ae-9da2-edbfbc38f771',
  integrationId: process.env.MAP_INTEGRATION_ID || '512ee096-b7f1-4515-896d-d165d526caa2',
  brandId:       process.env.MAP_BRAND_ID       || '4a6fa058-4ca9-438b-9a04-edad5aec8a87',
};

// ----------------------------------------------------------------
// PostgreSQL
// ----------------------------------------------------------------
let db = null;
let mcpCallId = 1;

async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.warn('WARNING: DATABASE_URL not set.'); return; }
  try {
    db = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await db.query(`CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());`);
    await db.query(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());`);
    await db.query(`CREATE TABLE IF NOT EXISTS algorithm_configs (
      algorithm_id TEXT PRIMARY KEY, enabled BOOLEAN DEFAULT false,
      config JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT NOW());`);
    console.log('  Database connected and tables ready.');
  } catch (err) { console.error('DB init error:', err.message); db = null; }
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
// MAP JSON-RPC caller
// ----------------------------------------------------------------
async function mapCall(method, params = {}) {
  if (!MAP_TOKEN) throw new Error('MAP_BEARER_TOKEN not configured.');
  const response = await axios.post(MAP_ENDPOINT, {
    jsonrpc: '2.0', id: mcpCallId++, method, params,
  }, {
    headers: {
      'Authorization': `Bearer ${MAP_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    timeout: 90000,
  });
  const result = response.data?.result;
  if (!result) {
    const err = response.data?.error;
    throw new Error(err?.message || `MAP no result for: ${method}`);
  }
  // Return the full result — callers will extract what they need
  return result;
}

// Extract text from a MAP MCP result content blocks
function extractText(result) {
  if (!result) return '';
  if (Array.isArray(result.content)) {
    return result.content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

// Extract data rows from a MAP MCP report analyst result
function extractData(result) {
  if (!result) return [];

  // Direct data field
  if (Array.isArray(result.data)) return result.data;

  // Flatten all content blocks (including nested tool_result blocks)
  const blocks = [];
  function collectBlocks(content) {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      blocks.push(block);
      if (block.content) collectBlocks(block.content);
    }
  }
  collectBlocks(result.content || []);

  for (const block of blocks) {
    if (!block.text) continue;
    // Try full JSON parse
    try {
      const parsed = JSON.parse(block.text);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      if (parsed && Array.isArray(parsed.data) && parsed.data.length > 0) return parsed.data;
      if (parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0) return parsed.rows;
      if (parsed && Array.isArray(parsed.results) && parsed.results.length > 0) return parsed.results;
    } catch {}
    // Try extracting JSON array substring
    const match = block.text.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object') return arr;
      } catch {}
    }
  }
  return [];
}

async function mapListResourcesPage(resourceType, filters = {}, nextToken = null) {
  const args = {
    account_id: MAP_ACCOUNT.accountId,
    integration_id: MAP_ACCOUNT.integrationId,
    resource_type: resourceType,
    filters,
  };
  if (nextToken) args.next_token = nextToken;
  const result = await mapCall('tools/call', { name: 'list_resources', arguments: args });
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text' && block.text) {
        try { return JSON.parse(block.text); } catch { return { items: [], next_token: null }; }
      }
    }
  }
  return { items: [], next_token: null };
}

async function mapListResources(resourceType, filters = {}) {
  // Fetch all pages — MAP returns max 100 items per page
  let allItems = [];
  let nextToken = null;
  let page = 0;
  const MAX_PAGES = 20; // safety cap at 2000 items
  do {
    const result = await mapListResourcesPage(resourceType, filters, nextToken);
    const items = result.items || result.data || [];
    allItems = allItems.concat(Array.isArray(items) ? items : []);
    nextToken = result.next_token || result.nextToken || null;
    page++;
    if (items.length === 0) break; // stop if empty page
  } while (nextToken && page < MAX_PAGES);
  return { items: allItems, total_count: allItems.length };
}

async function mapUpdateResources(resourceType, resources, note = '') {
  return mapCall('tools/call', {
    name: 'update_resources',
    arguments: {
      account_id: MAP_ACCOUNT.accountId,
      integration_id: MAP_ACCOUNT.integrationId,
      brand_id: MAP_ACCOUNT.brandId,
      note,
      resources: resources.map(r => ({ type: resourceType, ...r })),
    },
  });
}

async function mapCreateResources(resourceType, resources, note = '') {
  return mapCall('tools/call', {
    name: 'create_resources',
    arguments: {
      account_id: MAP_ACCOUNT.accountId,
      integration_id: MAP_ACCOUNT.integrationId,
      brand_id: MAP_ACCOUNT.brandId,
      note,
      resources: resources.map(r => ({ type: resourceType, ...r })),
    },
  });
}

async function askReportAnalyst(question, fast = true) {
  // Use account_id (UUID) for scoping — brand_ids may not work if brand has no report data
  return mapCall('tools/call', {
    name: 'ask_report_analyst',
    arguments: {
      account_ids: [MAP_ACCOUNT.accountId],
      integration_ids: [MAP_ACCOUNT.integrationId],
      fast,
      question,
    },
  });
}

// ----------------------------------------------------------------
// Normalize MAP responses
// ----------------------------------------------------------------
function normalizeMapResult(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    const keys = ['items','campaigns','keywords','adGroups','ad_groups',
                  'portfolios','productAds','product_ads','targets','results','data'];
    for (const k of keys) { if (Array.isArray(result[k])) return result[k]; }
    for (const k of Object.keys(result)) { if (Array.isArray(result[k])) return result[k]; }
    return [result];
  }
  return [];
}

// parseReportJson replaced by extractData()

// ----------------------------------------------------------------
// Main sync
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
      console.log(`  Synced: ${cacheKey} (${items.length} items)`);
    } catch (err) {
      console.error(`  Failed: ${cacheKey} — ${err.message}`);
      errors.push({ key: cacheKey, error: err.message });
    }
  }

  async function safeReport(cacheKey, question, fast = true) {
    try {
      const result = await askReportAnalyst(question, fast);
      // Debug: log result structure so we can see what MAP returns
      const resultKeys = result ? Object.keys(result) : [];
      const contentTypes = Array.isArray(result?.content) ? result.content.map(b => b.type).join(',') : 'none';
      console.log(`  Report ${cacheKey} result keys: [${resultKeys}] content types: [${contentTypes}]`);
      const rows = extractData(result);
      await cacheSet(cacheKey, rows);
      synced++;
      console.log(`  Synced: ${cacheKey} (${rows.length} rows) — text: ${extractText(result).slice(0,100)}`);
      return rows;
    } catch (err) {
      console.error(`  Failed report: ${cacheKey} — ${err.message}`);
      errors.push({ key: cacheKey, error: err.message });
      return [];
    }
  }

  console.log('Starting MAP sync...');

  // Structure data
  await safeSync('sp_campaigns',    'sp_campaigns');
  await safeSync('sp_portfolios',   'sp_portfolios');
  await safeSync('sp_keywords',     'sp_keywords');
  await safeSync('sp_ad_groups',    'sp_ad_groups');
  await safeSync('sp_product_ads',  'sp_product_ads');
  await safeSync('sp_neg_kws',      'sp_negative_keywords');
  await safeSync('sp_camp_neg_kws', 'sp_campaign_negative_keywords');
  await safeSync('sb_campaigns',    'sb_campaigns');
  await safeSync('sb_keywords',     'sb_keywords');
  await safeSync('sd_campaigns',    'sd_campaigns');
  await safeSync('sp_budget_rules', 'sp_budget_rules');

  // Performance reports
  const campPerf = await safeReport('perf_campaigns',
    'Last 14 days SP campaign performance. Fields: campaignId, campaignName, portfolioId, spend, sales14d, acos, roas, impressions, clicks, purchases14d, cpc. Sort by spend desc. JSON array only.');

  await safeReport('perf_keywords',
    'Last 14 days SP keyword performance. Fields: keywordId, keywordText, matchType, campaignId, campaignName, adGroupId, spend, sales14d, acos, roas, impressions, clicks, purchases14d, cpc, bid. JSON array only.');

  await safeReport('perf_search_terms',
    'Last 14 days SP search terms report. Fields: searchTerm, campaignId, campaignName, adGroupId, matchType, spend, sales14d, acos, roas, impressions, clicks, purchases14d, cpc. Sort by spend desc. Top 200. JSON array only.');

  await safeReport('perf_asins',
    'Last 14 days SP product/ASIN performance. Fields: asin, advertisedAsin, campaignId, campaignName, spend, sales14d, acos, roas, impressions, clicks, purchases14d, cpc, unitsSoldClicks14d. Sort by sales14d desc. JSON array only.');

  await safeReport('perf_analytics',
    'Last 30 days daily performance totals. Fields: date, spend, sales14d, acos, roas, impressions, clicks, purchases14d, cpc. One row per day. JSON array only.');

  // Build merged caches
  try {
    const sp   = normalizeMapResult((await cacheGet('sp_campaigns'))?.data  || []);
    const sb   = normalizeMapResult((await cacheGet('sb_campaigns'))?.data  || []);
    const sd   = normalizeMapResult((await cacheGet('sd_campaigns'))?.data  || []);
    const spKw = normalizeMapResult((await cacheGet('sp_keywords'))?.data   || []);
    const sbKw = normalizeMapResult((await cacheGet('sb_keywords'))?.data   || []);
    const spAds= normalizeMapResult((await cacheGet('sp_product_ads'))?.data || []);

    // Performance maps
    const campPerfMap = {};
    campPerf.forEach(r => {
      if (r.campaignId) campPerfMap[String(r.campaignId)] = {
        spend: parseFloat(r.spend) || 0,
        sales: parseFloat(r.sales14d || r.sales) || 0,
        acos:  parseFloat(r.acos) || null,
        roas:  parseFloat(r.roas) || null,
        impressions: parseInt(r.impressions) || 0,
        clicks: parseInt(r.clicks) || 0,
        orders: parseInt(r.purchases14d || r.orders) || 0,
        cpc:   parseFloat(r.cpc) || null,
        portfolioId: r.portfolioId || null,
      };
    });
    await cacheSet('perf_campaigns_map', campPerfMap);

    // Merge campaigns with performance
    const allCamps = [
      ...sp.map(c => {
        const perf = campPerfMap[String(c.campaignId)] || {};
        return { ...c, ...perf, _adType: 'SP' };
      }),
      ...sb.map(c => ({ ...c, _adType: 'SB' })),
      ...sd.map(c => ({ ...c, _adType: 'SD' })),
    ];
    await cacheSet('campaigns', allCamps);

    // Merge keywords
    await cacheSet('keywords', [...spKw, ...sbKw]);

    // Portfolios
    const ports = normalizeMapResult((await cacheGet('sp_portfolios'))?.data || []);
    await cacheSet('portfolios', ports);

    // Product ads
    await cacheSet('product_ads', spAds);

    synced++;
    console.log(`  Merged: ${allCamps.length} campaigns, ${spKw.length + sbKw.length} keywords`);
  } catch (err) {
    console.error('  Merge failed:', err.message);
    errors.push({ key: 'merge', error: err.message });
  }

  console.log(`Sync done. ${synced} ok, ${errors.length} failed.`);
  return { synced, errors, timestamp: new Date().toISOString() };
}

// ----------------------------------------------------------------
// Security
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
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300 });

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
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 24*60*60*1000, sameSite: 'lax' },
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
// ROUTES — Data reads
// ================================================================

async function sendCached(res, key) {
  const cached = await cacheGet(key);
  if (!cached) return res.json({ data: [], cached: false, message: 'No data. Click Refresh.' });
  const data = Array.isArray(cached.data) ? cached.data : normalizeMapResult(cached.data);
  return res.json({ data, cached: true, updatedAt: cached.updatedAt });
}

app.get('/api/campaigns',         requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'campaigns');         } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/keywords',          requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'keywords');          } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/portfolios',        requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'portfolios');        } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/ad-groups',         requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'sp_ad_groups');      } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/product-ads',       requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'product_ads');       } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/search-terms',      requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'perf_search_terms'); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/budget-rules',      requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'sp_budget_rules');   } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/perf/campaigns',    requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'perf_campaigns');    } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/perf/keywords',     requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'perf_keywords');     } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/perf/asins',        requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'perf_asins');        } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/perf/analytics',    requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'perf_analytics');    } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/perf/search-terms', requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'perf_search_terms'); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/neg-keywords',      requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'sp_neg_kws');        } catch(e) { res.status(500).json({ error: e.message }); } });

// ================================================================
// ROUTES — Write actions
// ================================================================

app.put('/api/campaigns/:id', requireAuth, async (req, res) => {
  try {
    const { _adType, ...fields } = req.body;
    const type = _adType === 'SB' ? 'sb_campaigns' : _adType === 'SD' ? 'sd_campaigns' : 'sp_campaigns';
    const result = await mapUpdateResources(type, [{ campaignId: req.params.id, ...fields }], 'AdScale update');
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/keywords/:id', requireAuth, async (req, res) => {
  try {
    const { _adType, ...fields } = req.body;
    const type = _adType === 'SB' ? 'sb_keywords' : 'sp_keywords';
    const result = await mapUpdateResources(type, [{ keywordId: req.params.id, ...fields }], 'AdScale bid/state update');
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/keywords', requireAuth, async (req, res) => {
  try {
    const result = await mapCreateResources('sp_keywords', [req.body], 'AdScale add keyword');
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/keywords/negative', requireAuth, async (req, res) => {
  try {
    const result = await mapCreateResources('sp_negative_keywords', [req.body], 'AdScale negative keyword');
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/campaigns', requireAuth, async (req, res) => {
  try {
    const { _adType, ...fields } = req.body;
    const type = _adType === 'SB' ? 'sb_campaigns' : _adType === 'SD' ? 'sd_campaigns' : 'sp_campaigns';
    const result = await mapCreateResources(type, [fields], 'AdScale new campaign');
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Portfolio update
app.put('/api/portfolios/:id', requireAuth, async (req, res) => {
  try {
    const result = await mapUpdateResources('sp_portfolios', [{ portfolioId: req.params.id, ...req.body }], 'AdScale portfolio update');
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Budget rules (dayparting)
app.post('/api/budget-rules', requireAuth, async (req, res) => {
  try {
    const result = await mapCreateResources('sp_budget_rules', [req.body], 'AdScale budget rule');
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/budget-rules/:id', requireAuth, async (req, res) => {
  try {
    const result = await mapUpdateResources('sp_budget_rules', [{ budgetRuleId: req.params.id, ...req.body }], 'AdScale budget rule update');
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// ROUTES — Settings & Algorithms (PostgreSQL, survive deploys)
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

// Bulk settings save (for theme, preferences)
app.post('/api/settings/bulk', requireAuth, async (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings object required.' });
  if (!db) return res.json({ success: true, persisted: false });
  try {
    const promises = Object.entries(settings).map(([key, value]) =>
      db.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, JSON.stringify(value)]
      )
    );
    await Promise.all(promises);
    res.json({ success: true, persisted: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/algorithms', requireAuth, async (req, res) => {
  if (!db) return res.json([]);
  try {
    const r = await db.query(
      'SELECT algorithm_id, enabled, config, updated_at FROM algorithm_configs ORDER BY algorithm_id'
    );
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

// Bulk algorithm save
app.post('/api/algorithms/bulk', requireAuth, async (req, res) => {
  const { algorithms } = req.body;
  if (!Array.isArray(algorithms)) return res.status(400).json({ error: 'algorithms array required.' });
  if (!db) return res.json({ success: true, persisted: false });
  try {
    await Promise.all(algorithms.map(a =>
      db.query(
        `INSERT INTO algorithm_configs (algorithm_id, enabled, config, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (algorithm_id) DO UPDATE SET enabled = $2, config = $3, updated_at = NOW()`,
        [a.id, a.enabled, JSON.stringify(a.config || {})]
      )
    ));
    res.json({ success: true, persisted: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// ROUTES — Health
// ================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mapConfigured: !!MAP_TOKEN, dbConnected: !!db, timestamp: new Date().toISOString() });
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
    console.log('');
  });
});
