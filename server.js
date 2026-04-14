'use strict';

// ================================================================
// AdScale — Amazon PPC Management Backend
// Data source: MarketplaceAdPros MCP (MAP)
// Architecture: MAP → PostgreSQL cache → Dashboard
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
const MAP_ACCOUNT  = {
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
  await db.query(`INSERT INTO cache (key, value, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)]);
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
// MAP MCP caller
// ----------------------------------------------------------------
async function mapCall(toolName, args = {}) {
  if (!MAP_TOKEN) throw new Error('MAP_BEARER_TOKEN not configured.');
  const response = await axios.post(MAP_ENDPOINT, {
    jsonrpc: '2.0', id: mcpCallId++,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  }, {
    headers: {
      'Authorization': `Bearer ${MAP_TOKEN}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json, text/event-stream',
    },
    timeout: 30000,
  });

  const result = response.data?.result;
  if (!result) throw new Error(`MAP returned no result for: ${toolName}`);
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text' && block.text) {
        try { return JSON.parse(block.text); } catch { return block.text; }
      }
    }
  }
  return result;
}

async function mapListTools() {
  const response = await axios.post(MAP_ENDPOINT, {
    jsonrpc: '2.0', id: mcpCallId++, method: 'tools/list', params: {},
  }, {
    headers: {
      'Authorization': `Bearer ${MAP_TOKEN}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json, text/event-stream',
    },
    timeout: 15000,
  });
  return response.data?.result?.tools || [];
}

// ----------------------------------------------------------------
// Sync function — fetches all data from MAP into PostgreSQL cache
// ----------------------------------------------------------------
async function syncFromMAP() {
  if (!MAP_TOKEN) throw new Error('MAP_BEARER_TOKEN not set.');
  const errors = [];
  let synced = 0;

  async function safeSync(cacheKey, toolName, args = {}) {
    try {
      const data = await mapCall(toolName, args);
      await cacheSet(cacheKey, data);
      synced++;
      console.log(`  Synced: ${cacheKey}`);
    } catch (err) {
      console.error(`  Failed: ${cacheKey} — ${err.message}`);
      errors.push({ key: cacheKey, error: err.message });
    }
  }

  console.log('Starting MAP sync...');

  // First discover available tools
  let tools = [];
  try {
    tools = await mapListTools();
    await cacheSet('map_tools', tools);
    console.log(`  Found ${tools.length} MAP tools`);
  } catch (err) {
    console.warn('  Could not list tools, using defaults:', err.message);
  }

  const toolNames = tools.map(t => t.name);
  const findTool = (...keywords) => {
    for (const kw of keywords) {
      const found = toolNames.find(n => n.toLowerCase().includes(kw.toLowerCase()));
      if (found) return found;
    }
    return keywords[keywords.length - 1]; // fallback to last keyword as default name
  };

  const acctArgs = { account_id: MAP_ACCOUNT.accountId, integration_id: MAP_ACCOUNT.integrationId, brand_id: MAP_ACCOUNT.brandId };

  await safeSync('campaigns',    findTool('list_campaigns', 'campaigns'), acctArgs);
  await safeSync('portfolios',   findTool('list_portfolios', 'portfolios'), acctArgs);
  await safeSync('keywords',     findTool('list_keywords', 'keywords'), acctArgs);
  await safeSync('ad_groups',    findTool('list_ad_groups', 'ad_groups'), acctArgs);
  await safeSync('product_ads',  findTool('list_product_ads', 'product_ads'), acctArgs);
  await safeSync('search_terms', findTool('search_term_report', 'search_terms'), acctArgs);
  await safeSync('performance',  findTool('performance_report', 'get_report'), acctArgs);

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
// ROUTES
// ================================================================

// Auth
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

// Sync — Refresh button
app.post('/api/sync', requireAuth, apiLimiter, async (req, res) => {
  try {
    const result = await syncFromMAP();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Data reads — all from cache
async function sendCached(res, key) {
  const cached = await cacheGet(key);
  if (!cached) return res.json({ data: [], cached: false, message: 'No data yet. Click Refresh to sync.' });
  return res.json({ data: cached.data, cached: true, updatedAt: cached.updatedAt });
}

app.get('/api/campaigns',    requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'campaigns');   } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/keywords',     requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'keywords');    } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/portfolios',   requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'portfolios');  } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/ad-groups',    requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'ad_groups');   } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/product-ads',  requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'product_ads'); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/search-terms', requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'search_terms');} catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/performance',  requireAuth, apiLimiter, async (req, res) => { try { await sendCached(res, 'performance'); } catch(e) { res.status(500).json({ error: e.message }); } });

// Write actions
app.put('/api/campaigns/:id', requireAuth, async (req, res) => {
  try {
    const tools = (await cacheGet('map_tools'))?.data || [];
    const tool = tools.find(t => t.name?.includes('update') && t.name?.includes('campaign'))?.name || 'update_campaign';
    const result = await mapCall(tool, { account_id: MAP_ACCOUNT.accountId, campaign_id: req.params.id, ...req.body });
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/keywords/:id', requireAuth, async (req, res) => {
  try {
    const tools = (await cacheGet('map_tools'))?.data || [];
    const tool = tools.find(t => t.name?.includes('update') && t.name?.includes('keyword'))?.name || 'update_keyword';
    const result = await mapCall(tool, { account_id: MAP_ACCOUNT.accountId, keyword_id: req.params.id, ...req.body });
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/campaigns', requireAuth, async (req, res) => {
  try {
    const tools = (await cacheGet('map_tools'))?.data || [];
    const tool = tools.find(t => t.name?.includes('create') && t.name?.includes('campaign'))?.name || 'create_campaign';
    const result = await mapCall(tool, { account_id: MAP_ACCOUNT.accountId, ...req.body });
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/keywords/negative', requireAuth, async (req, res) => {
  try {
    const tools = (await cacheGet('map_tools'))?.data || [];
    const tool = tools.find(t => t.name?.includes('negative'))?.name || 'add_negative_keyword';
    const result = await mapCall(tool, { account_id: MAP_ACCOUNT.accountId, ...req.body });
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Algorithm settings (PostgreSQL only)
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
    await db.query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`, [key, JSON.stringify(value)]);
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
    await db.query(`INSERT INTO algorithm_configs (algorithm_id, enabled, config, updated_at) VALUES ($1, $2, $3, NOW())
      ON CONFLICT (algorithm_id) DO UPDATE SET enabled = $2, config = $3, updated_at = NOW()`,
      [req.params.id, enabled, JSON.stringify(config || {})]);
    res.json({ success: true, persisted: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Health + debug
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mapConfigured: !!MAP_TOKEN, dbConnected: !!db, timestamp: new Date().toISOString() });
});

app.get('/api/debug/tools', requireAuth, async (req, res) => {
  try {
    const tools = await mapListTools();
    res.json({ count: tools.length, tools: tools.map(t => ({ name: t.name, description: t.description })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/debug/call', requireAuth, async (req, res) => {
  const { tool, args } = req.body;
  if (!tool) return res.status(400).json({ error: 'tool name required.' });
  try {
    const result = await mapCall(tool, args || {});
    res.json({ tool, result });
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
    console.log('  Debug: /api/debug/tools');
    console.log('');
  });
});
