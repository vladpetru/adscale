'use strict';

// ================================================================
// AdScale — Amazon PPC Management Backend
// ================================================================
// Now connects via MarketplaceAdPros MCP API instead of direct Amazon API.
// All campaign data flows through MAP using your Bearer token.
// ================================================================

require('dotenv').config();
const express      = require('express');
const session      = require('express-session');
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');
const cors         = require('cors');
const axios        = require('axios');
const path         = require('path');
const { Pool }     = require('pg');
const SQLiteStore  = require('connect-sqlite3')(session);

const app  = express();
const PORT = process.env.PORT || 8080;

// ----------------------------------------------------------------
// Environment variable validation
// ----------------------------------------------------------------
const REQUIRED_VARS = ['APP_PASSWORD', 'SESSION_SECRET'];
const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error('ERROR: Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

// ----------------------------------------------------------------
// MarketplaceAdPros config
// ----------------------------------------------------------------
const MAP_TOKEN          = process.env.MAP_BEARER_TOKEN || '';
const MAP_MCP_URL        = 'https://app.marketplaceadpros.com/mcp';
const MAP_INTEGRATION_ID = '512ee096-b7f1-4515-896d-d165d526caa2';
const MAP_ACCOUNT_ID     = '47e6da51-bf41-42ae-9da2-edbfbc38f771';  // UNIEVO US
const MAP_BRAND_ID       = '4a6fa058-4ca9-438b-9a04-edad5aec8a87';

// ----------------------------------------------------------------
// PostgreSQL database setup
// ----------------------------------------------------------------
let db = null;

async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('WARNING: DATABASE_URL not set. Settings will not persist.');
    return;
  }

  try {
    db = new Pool({
      connectionString: dbUrl,
      ssl: dbUrl.includes('railway.internal') ? false : { rejectUnauthorized: false },
    });

    await db.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS algorithm_configs (
        algorithm_id  TEXT PRIMARY KEY,
        enabled       BOOLEAN DEFAULT false,
        config        JSONB NOT NULL DEFAULT '{}',
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log('  Database connected and tables ready.');
  } catch (err) {
    console.error('Database init error:', err.message);
    db = null;
  }
}

// ----------------------------------------------------------------
// Security: IP allowlist middleware (optional)
// ----------------------------------------------------------------
function ipAllowlist(req, res, next) {
  const allowed = process.env.ALLOWED_IPS;
  if (!allowed || allowed.trim() === '') return next();

  const allowedList = allowed.split(',').map(ip => ip.trim());
  const clientIp = (
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    ''
  ).split(',')[0].trim();

  if (allowedList.includes(clientIp)) return next();

  console.warn(`Blocked IP: ${clientIp}`);
  return res.status(403).json({ error: 'Access denied.' });
}

// ----------------------------------------------------------------
// Rate limiters
// ----------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Slow down.' },
});

// ----------------------------------------------------------------
// Middleware
// ----------------------------------------------------------------
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: '.' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  },
  name: 'adscale.sid',
}));

app.use(ipAllowlist);
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------
// Auth middleware
// ----------------------------------------------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ error: 'Not authenticated. Please log in.' });
}

// ----------------------------------------------------------------
// MAP MCP Helper: call a tool on the MAP MCP server
// ----------------------------------------------------------------
let mcpSessionId = null;

async function mapCallTool(toolName, args = {}) {
  if (!MAP_TOKEN) throw new Error('MAP_BEARER_TOKEN not configured.');

  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${MAP_TOKEN}`,
    'Accept': 'application/json, text/event-stream',
  };

  if (mcpSessionId) {
    headers['Mcp-Session-Id'] = mcpSessionId;
  }

  try {
    const response = await axios.post(MAP_MCP_URL, body, { headers, timeout: 30000 });

    // Capture session ID from response headers
    const sid = response.headers['mcp-session-id'];
    if (sid) mcpSessionId = sid;

    // Handle MCP response format
    const data = response.data;

    // If it's a standard JSON-RPC response
    if (data && data.result) {
      // MCP tools/call returns { content: [...] }
      const content = data.result.content || [];
      const textParts = content
        .filter(c => c.type === 'text')
        .map(c => c.text);
      const combined = textParts.join('\n');

      // Try to parse as JSON
      try {
        return JSON.parse(combined);
      } catch {
        return combined;
      }
    }

    if (data && data.error) {
      throw new Error(data.error.message || 'MCP error');
    }

    return data;
  } catch (err) {
    // If session expired, reset and retry once
    if (err.response && err.response.status === 404 && mcpSessionId) {
      mcpSessionId = null;
      return mapCallTool(toolName, args);
    }
    throw new Error(`MAP API error: ${err.message}`);
  }
}

// Initialize MCP session on startup
async function initMcpSession() {
  if (!MAP_TOKEN) {
    console.warn('  MAP_BEARER_TOKEN not set. Dashboard will show sample data.');
    return;
  }

  try {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'AdScale', version: '1.0.0' },
      },
    };

    const response = await axios.post(MAP_MCP_URL, body, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MAP_TOKEN}`,
        'Accept': 'application/json, text/event-stream',
      },
      timeout: 15000,
    });

    const sid = response.headers['mcp-session-id'];
    if (sid) mcpSessionId = sid;

    console.log('  MAP MCP session initialized.');
  } catch (err) {
    console.warn('  MAP MCP init failed:', err.message);
    console.warn('  Dashboard will fall back to sample data.');
  }
}

// ----------------------------------------------------------------
// Helper: default MAP args (always UNIEVO US)
// ----------------------------------------------------------------
function mapDefaults() {
  return {
    integration_id: MAP_INTEGRATION_ID,
    account_id:     MAP_ACCOUNT_ID,
    brand_id:       MAP_BRAND_ID,
  };
}

// ================================================================
// ROUTES - Auth
// ================================================================

app.post('/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required.' });
  if (password !== process.env.APP_PASSWORD) return res.status(401).json({ error: 'Incorrect password.' });

  req.session.loggedIn = true;
  req.session.loginAt  = Date.now();
  console.log(`Login from ${req.ip}`);
  return res.json({ success: true });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/auth/status', requireAuth, (req, res) => {
  res.json({
    loggedIn:        true,
    amazonConnected: !!MAP_TOKEN,
    profileId:       MAP_ACCOUNT_ID,
    profileName:     'UNIEVO US',
    dbConnected:     !!db,
    mapConnected:    !!MAP_TOKEN,
  });
});

// ================================================================
// ROUTES - Settings (persistent, stored in PostgreSQL)
// ================================================================

app.get('/api/settings', requireAuth, async (req, res) => {
  if (!db) return res.json({ algorithms: {}, general: {} });

  try {
    const result = await db.query('SELECT key, value FROM settings');
    const out = {};
    result.rows.forEach(row => { out[row.key] = row.value; });
    res.json(out);
  } catch (err) {
    console.error('Settings load error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', requireAuth, async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required.' });

  if (!db) return res.json({ success: true, persisted: false });

  try {
    await db.query(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = $2, updated_at = NOW()
    `, [key, JSON.stringify(value)]);
    res.json({ success: true, persisted: true });
  } catch (err) {
    console.error('Settings save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// ROUTES - Algorithm configs
// ================================================================

app.get('/api/algorithms', requireAuth, async (req, res) => {
  if (!db) return res.json([]);

  try {
    const result = await db.query(
      'SELECT algorithm_id, enabled, config, updated_at FROM algorithm_configs ORDER BY algorithm_id'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Algorithm load error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/algorithms/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { enabled, config } = req.body;

  if (!db) return res.json({ success: true, persisted: false });

  try {
    await db.query(`
      INSERT INTO algorithm_configs (algorithm_id, enabled, config, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (algorithm_id) DO UPDATE
        SET enabled = $2, config = $3, updated_at = NOW()
    `, [id, enabled, JSON.stringify(config || {})]);
    res.json({ success: true, persisted: true });
  } catch (err) {
    console.error('Algorithm save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// ROUTES - Amazon Ads via MAP MCP
// ================================================================

// GET /api/portfolios
app.get('/api/portfolios', requireAuth, apiLimiter, async (req, res) => {
  try {
    const data = await mapCallTool('list_resources', {
      ...mapDefaults(),
      resource_type: 'sp_portfolios',
    });
    const items = data.items || data || [];
    res.json(Array.isArray(items) ? items : []);
  } catch (err) {
    console.error('Portfolios error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns
app.get('/api/campaigns', requireAuth, apiLimiter, async (req, res) => {
  try {
    const filters = {};
    if (req.query.state) filters.state_filter = req.query.state.toUpperCase();

    // Get SP campaigns
    const spData = await mapCallTool('list_resources', {
      ...mapDefaults(),
      resource_type: 'sp_campaigns',
      filters,
    });
    let campaigns = spData.items || spData || [];

    // Also get SB campaigns
    try {
      const sbData = await mapCallTool('list_resources', {
        ...mapDefaults(),
        resource_type: 'sb_campaigns',
        filters,
      });
      const sbCampaigns = (sbData.items || sbData || []).map(c => ({
        ...c,
        campaignType: 'SB',
      }));
      campaigns = [...campaigns.map(c => ({ ...c, campaignType: c.campaignType || 'SP' })), ...sbCampaigns];
    } catch (e) {
      console.warn('SB campaigns fetch failed:', e.message);
    }

    // Filter by portfolio if requested
    if (req.query.portfolioId) {
      const pid = req.query.portfolioId;
      if (pid === 'none') {
        campaigns = campaigns.filter(c => !c.portfolioId);
      } else {
        campaigns = campaigns.filter(c => String(c.portfolioId) === String(pid));
      }
    }

    res.json(campaigns);
  } catch (err) {
    console.error('Campaigns error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/campaigns/:id - update a campaign
app.put('/api/campaigns/:id', requireAuth, async (req, res) => {
  try {
    const updateData = { campaignId: req.params.id, ...req.body };
    const resourceType = req.body._type === 'SB' ? 'sb_campaigns' : 'sp_campaigns';
    delete updateData._type;

    const result = await mapCallTool('update_resources', {
      ...mapDefaults(),
      resources: [{ type: resourceType, ...updateData }],
      note: 'Updated from AdScale dashboard',
    });
    res.json(result);
  } catch (err) {
    console.error('Campaign update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ad-groups
app.get('/api/ad-groups', requireAuth, apiLimiter, async (req, res) => {
  try {
    if (!req.query.campaignId) {
      return res.status(400).json({ error: 'campaignId required.' });
    }
    const data = await mapCallTool('list_resources', {
      ...mapDefaults(),
      resource_type: 'sp_ad_groups',
      filters: { campaign_id: req.query.campaignId },
    });
    res.json(data.items || data || []);
  } catch (err) {
    console.error('Ad groups error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/keywords
app.get('/api/keywords', requireAuth, apiLimiter, async (req, res) => {
  try {
    if (!req.query.campaignId) {
      return res.status(400).json({ error: 'campaignId required.' });
    }
    const filters = { campaign_id: req.query.campaignId };
    if (req.query.adGroupId) filters.ad_group_id = req.query.adGroupId;

    const data = await mapCallTool('list_resources', {
      ...mapDefaults(),
      resource_type: 'sp_keywords',
      filters,
    });
    res.json(data.items || data || []);
  } catch (err) {
    console.error('Keywords error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/keywords/:id - update a keyword (bid, state)
app.put('/api/keywords/:id', requireAuth, async (req, res) => {
  try {
    const result = await mapCallTool('update_resources', {
      ...mapDefaults(),
      resources: [{
        type: 'sp_keywords',
        keywordId: req.params.id,
        ...req.body,
      }],
      note: 'Updated from AdScale dashboard',
    });
    res.json(result);
  } catch (err) {
    console.error('Keyword update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/keywords/negative - add negative keywords
app.post('/api/keywords/negative', requireAuth, async (req, res) => {
  try {
    const keywords = Array.isArray(req.body) ? req.body : [req.body];
    const resources = keywords.map(kw => ({
      type: 'sp_negative_keywords',
      campaignId: kw.campaignId,
      adGroupId: kw.adGroupId,
      keywordText: kw.keywordText,
      matchType: kw.matchType || 'EXACT',
      state: 'ENABLED',
    }));

    const result = await mapCallTool('create_resources', {
      ...mapDefaults(),
      resources,
      note: 'Negative keyword added from AdScale dashboard',
    });
    res.json(result);
  } catch (err) {
    console.error('Negative keyword error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/product-ads
app.get('/api/product-ads', requireAuth, apiLimiter, async (req, res) => {
  try {
    if (!req.query.campaignId) {
      return res.status(400).json({ error: 'campaignId required.' });
    }
    const filters = { campaign_id: req.query.campaignId };
    if (req.query.adGroupId) filters.ad_group_id = req.query.adGroupId;

    const data = await mapCallTool('list_resources', {
      ...mapDefaults(),
      resource_type: 'sp_product_ads',
      filters,
    });
    res.json(data.items || data || []);
  } catch (err) {
    console.error('Product ads error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/targets
app.get('/api/targets', requireAuth, apiLimiter, async (req, res) => {
  try {
    if (!req.query.campaignId) {
      return res.status(400).json({ error: 'campaignId required.' });
    }
    const filters = { campaign_id: req.query.campaignId };
    if (req.query.adGroupId) filters.ad_group_id = req.query.adGroupId;

    const data = await mapCallTool('list_resources', {
      ...mapDefaults(),
      resource_type: 'sp_targets',
      filters,
    });
    res.json(data.items || data || []);
  } catch (err) {
    console.error('Targets error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/negative-keywords
app.get('/api/negative-keywords', requireAuth, apiLimiter, async (req, res) => {
  try {
    if (!req.query.campaignId) {
      return res.status(400).json({ error: 'campaignId required.' });
    }
    const filters = { campaign_id: req.query.campaignId };
    if (req.query.adGroupId) filters.ad_group_id = req.query.adGroupId;

    const data = await mapCallTool('list_resources', {
      ...mapDefaults(),
      resource_type: 'sp_negative_keywords',
      filters,
    });
    res.json(data.items || data || []);
  } catch (err) {
    console.error('Negative keywords error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/budget-rules
app.get('/api/budget-rules', requireAuth, apiLimiter, async (req, res) => {
  try {
    const filters = {};
    if (req.query.campaignId) filters.campaign_id = req.query.campaignId;

    const data = await mapCallTool('list_resources', {
      ...mapDefaults(),
      resource_type: 'sp_budget_rules',
      filters,
    });
    res.json(data.items || data || []);
  } catch (err) {
    console.error('Budget rules error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/product-metadata
app.get('/api/product-metadata', requireAuth, apiLimiter, async (req, res) => {
  try {
    const asins = req.query.asins ? req.query.asins.split(',') : [];
    if (asins.length === 0) return res.status(400).json({ error: 'asins required.' });

    const data = await mapCallTool('get_amazon_ads_product_metadata', {
      ...mapDefaults(),
      asins,
    });
    res.json(data);
  } catch (err) {
    console.error('Product metadata error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status:        'ok',
    mapConfigured: !!MAP_TOKEN,
    dbConnected:   !!db,
    mcpSession:    !!mcpSessionId,
    timestamp:     new Date().toISOString(),
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----------------------------------------------------------------
// Start server
// ----------------------------------------------------------------
initDatabase().then(() => {
  initMcpSession().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log('');
      console.log('  ======================================');
      console.log('  |        AdScale Server Running        |');
      console.log(`  |   http://0.0.0.0:${PORT}               |`);
      console.log('  ======================================');
      console.log('');
      console.log(`  MAP configured:     ${!!MAP_TOKEN}`);
      console.log(`  MCP session:        ${!!mcpSessionId}`);
      console.log(`  Database connected: ${!!db}`);
      console.log(`  IP allowlist:       ${process.env.ALLOWED_IPS ? 'enabled' : 'disabled'}`);
      console.log('');
    });
  });
});
