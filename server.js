'use strict';

// ================================================================
// AdScale — Amazon PPC Management Backend
// ================================================================
// Security features:
//   - Password login with session management
//   - Rate limiting on login (blocks brute force)
//   - IP allowlist (optional)
//   - Helmet (sets secure HTTP headers)
//   - Sessions expire after 24 hours
//   - All secrets in environment variables
//   - HTTPS enforced on Railway automatically
// Persistence:
//   - PostgreSQL (Railway) stores all algorithm settings
//   - Settings survive server restarts and are shared across devices
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
  console.error('Copy .env.example to .env and fill in your values.');
  process.exit(1);
}

// ----------------------------------------------------------------
// PostgreSQL database setup
// ----------------------------------------------------------------
let db = null;

async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('WARNING: DATABASE_URL not set. Settings will not persist across restarts.');
    console.warn('Add a PostgreSQL database on Railway to enable persistent settings.');
    return;
  }

  try {
    db = new Pool({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
    });

    // Create settings table if it doesn't exist
    await db.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Create algorithm_configs table
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
// Amazon Ads API config
// ----------------------------------------------------------------
const AMAZON = {
  clientId:     process.env.AMAZON_CLIENT_ID     || '',
  clientSecret: process.env.AMAZON_CLIENT_SECRET || '',
  region:       process.env.AMAZON_REGION        || 'NA',
  redirectUri:  process.env.AMAZON_REDIRECT_URI  || `http://localhost:${PORT}/auth/callback`,
};

const REGION_ENDPOINTS = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
};
const AMAZON_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const AMAZON_AUTH_URL  = 'https://www.amazon.com/ap/oa';
const API_BASE         = REGION_ENDPOINTS[AMAZON.region] || REGION_ENDPOINTS.NA;

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

function requireAmazon(req, res, next) {
  if (req.session && req.session.amazonTokens) return next();
  return res.status(401).json({ error: 'Amazon account not connected.' });
}

// ----------------------------------------------------------------
// Helper: Refresh Amazon access token if expired
// ----------------------------------------------------------------
async function getValidToken(session) {
  const tokens = session.amazonTokens;
  if (!tokens) throw new Error('No Amazon tokens found.');

  const now = Date.now();
  if (tokens.expiresAt && now < tokens.expiresAt - 5 * 60 * 1000) {
    return tokens.accessToken;
  }

  const response = await axios.post(AMAZON_TOKEN_URL, new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id:     AMAZON.clientId,
    client_secret: AMAZON.clientSecret,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  session.amazonTokens = {
    accessToken:  response.data.access_token,
    refreshToken: tokens.refreshToken,
    expiresAt:    Date.now() + (response.data.expires_in * 1000),
  };
  return session.amazonTokens.accessToken;
}

// ----------------------------------------------------------------
// Helper: Amazon API request
// ----------------------------------------------------------------
async function amazonRequest(session, method, endpoint, data = null, params = null) {
  const token     = await getValidToken(session);
  const profileId = session.amazonProfileId;

  const config = {
    method,
    url: `${API_BASE}${endpoint}`,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': AMAZON.clientId,
      'Content-Type': 'application/json',
      ...(profileId ? { 'Amazon-Advertising-API-Scope': profileId } : {}),
    },
    ...(params ? { params } : {}),
    ...(data   ? { data }   : {}),
  };

  const response = await axios(config);
  return response.data;
}

// ================================================================
// ROUTES — Auth
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
    amazonConnected: !!req.session.amazonTokens,
    profileId:       req.session.amazonProfileId   || null,
    profileName:     req.session.amazonProfileName || null,
    dbConnected:     !!db,
  });
});

app.get('/auth/amazon', requireAuth, (req, res) => {
  if (!AMAZON.clientId) {
    return res.status(400).json({ error: 'Amazon credentials not configured.' });
  }
  const state = Math.random().toString(36).substring(2, 15);
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id:     AMAZON.clientId,
    scope:         'advertising::campaign_management',
    response_type: 'code',
    redirect_uri:  AMAZON.redirectUri,
    state,
  });
  res.redirect(`${AMAZON_AUTH_URL}?${params.toString()}`);
});

app.get('/auth/callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?error=amazon_denied');
  if (!state || state !== req.session.oauthState) return res.redirect('/?error=invalid_state');

  try {
    const tokenResponse = await axios.post(AMAZON_TOKEN_URL, new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  AMAZON.redirectUri,
      client_id:     AMAZON.clientId,
      client_secret: AMAZON.clientSecret,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    req.session.amazonTokens = {
      accessToken:  tokenResponse.data.access_token,
      refreshToken: tokenResponse.data.refresh_token,
      expiresAt:    Date.now() + (tokenResponse.data.expires_in * 1000),
    };
    req.session.oauthState = null;
    res.redirect('/?amazon=connected');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ================================================================
// ROUTES — Settings (persistent, stored in PostgreSQL)
// ================================================================

// GET /api/settings — load all saved settings
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

// POST /api/settings — save a setting by key
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

// GET /api/algorithms — load all algorithm configs
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

// POST /api/algorithms/:id — save one algorithm config
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
// ROUTES — Amazon Ads API
// ================================================================

app.get('/api/profiles', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    res.json(await amazonRequest(req.session, 'GET', '/v2/profiles'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/profiles/select', requireAuth, requireAmazon, async (req, res) => {
  const { profileId, profileName } = req.body;
  if (!profileId) return res.status(400).json({ error: 'profileId required.' });
  req.session.amazonProfileId   = profileId;
  req.session.amazonProfileName = profileName || '';
  res.json({ success: true, profileId, profileName });
});

app.get('/api/portfolios', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    res.json(await amazonRequest(req.session, 'GET', '/v2/portfolios'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    const params = {};
    if (req.query.portfolioId)  params.portfolioId  = req.query.portfolioId;
    if (req.query.state)        params.state        = req.query.state;
    if (req.query.campaignType) params.campaignType = req.query.campaignType;
    res.json(await amazonRequest(req.session, 'GET', '/v2/campaigns', null, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns', requireAuth, requireAmazon, async (req, res) => {
  try {
    res.json(await amazonRequest(req.session, 'POST', '/v2/campaigns', [req.body]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/campaigns/:id', requireAuth, requireAmazon, async (req, res) => {
  try {
    res.json(await amazonRequest(req.session, 'PUT', '/v2/campaigns', [{ campaignId: req.params.id, ...req.body }]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/keywords', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    const params = {};
    if (req.query.campaignId) params.campaignId = req.query.campaignId;
    if (req.query.adGroupId)  params.adGroupId  = req.query.adGroupId;
    if (req.query.state)      params.state      = req.query.state;
    if (req.query.matchType)  params.matchType  = req.query.matchType;
    res.json(await amazonRequest(req.session, 'GET', '/v2/keywords', null, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/keywords/:id', requireAuth, requireAmazon, async (req, res) => {
  try {
    res.json(await amazonRequest(req.session, 'PUT', '/v2/keywords', [{ keywordId: req.params.id, ...req.body }]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/keywords/negative', requireAuth, requireAmazon, async (req, res) => {
  try {
    res.json(await amazonRequest(req.session, 'POST', '/v2/negativeKeywords', req.body));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ad-groups', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    const params = {};
    if (req.query.campaignId) params.campaignId = req.query.campaignId;
    if (req.query.state)      params.state      = req.query.state;
    res.json(await amazonRequest(req.session, 'GET', '/v2/adGroups', null, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/product-ads', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    const params = {};
    if (req.query.campaignId) params.campaignId = req.query.campaignId;
    if (req.query.adGroupId)  params.adGroupId  = req.query.adGroupId;
    if (req.query.state)      params.state      = req.query.state;
    res.json(await amazonRequest(req.session, 'GET', '/v2/productAds', null, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search-terms', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    const reportRequest = await amazonRequest(req.session, 'POST', '/v2/reports', {
      reportDate:  req.query.date || new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      metrics:     'impressions,clicks,cost,attributedSales30d,attributedConversions30d',
      segment:     'query',
      recordType:  'keywords',
    });
    res.json({ reportId: reportRequest.reportId, status: reportRequest.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/:reportId', requireAuth, requireAmazon, async (req, res) => {
  try {
    res.json(await amazonRequest(req.session, 'GET', `/v2/reports/${req.params.reportId}`));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaign-stats', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    const reportRequest = await amazonRequest(req.session, 'POST', '/v2/reports', {
      reportDate:  req.query.date || new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      metrics:     'impressions,clicks,cost,attributedSales30d,attributedConversions30d,attributedUnitsOrdered30d',
      recordType:  'campaigns',
    });
    res.json({ reportId: reportRequest.reportId, status: reportRequest.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status:           'ok',
    amazonConfigured: !!(AMAZON.clientId && AMAZON.clientSecret),
    dbConnected:      !!db,
    region:           AMAZON.region,
    timestamp:        new Date().toISOString(),
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----------------------------------------------------------------
// Start server
// ----------------------------------------------------------------
initDatabase().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║        AdScale Server Running        ║');
    console.log(`  ║   http://0.0.0.0:${PORT}               ║`);
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
    console.log(`  Amazon API configured: ${!!(AMAZON.clientId && AMAZON.clientSecret)}`);
    console.log(`  Database connected:    ${!!db}`);
    console.log(`  Region: ${AMAZON.region}`);
    console.log(`  IP allowlist: ${process.env.ALLOWED_IPS ? 'enabled' : 'disabled'}`);
    console.log('');
  });
});

app.use(helmet({
  contentSecurityPolicy: false, // Disabled so our HTML app loads correctly
}));

app.use(cors({
  origin: true,
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session setup — stored in SQLite so sessions survive server restarts
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: '.' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    httpOnly: true,   // Not accessible from JavaScript
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',
  },
  name: 'adscale.sid',
}));

// Apply IP allowlist to everything
app.use(ipAllowlist);

// Serve static files (your index.html dashboard)
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------
// Auth middleware — protects all /api routes
// ----------------------------------------------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ error: 'Not authenticated. Please log in.' });
}

function requireAmazon(req, res, next) {
  if (req.session && req.session.amazonTokens) return next();
  return res.status(401).json({ error: 'Amazon account not connected. Please authorize.' });
}

// ----------------------------------------------------------------
// Helper: Refresh Amazon access token if expired
// ----------------------------------------------------------------
async function getValidToken(session) {
  const tokens = session.amazonTokens;
  if (!tokens) throw new Error('No Amazon tokens found.');

  const now = Date.now();
  // Refresh if token expires within 5 minutes
  if (tokens.expiresAt && now < tokens.expiresAt - 5 * 60 * 1000) {
    return tokens.accessToken;
  }

  try {
    const response = await axios.post(AMAZON_TOKEN_URL, new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id:     AMAZON.clientId,
      client_secret: AMAZON.clientSecret,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    session.amazonTokens = {
      accessToken:  response.data.access_token,
      refreshToken: tokens.refreshToken,
      expiresAt:    Date.now() + (response.data.expires_in * 1000),
    };
    return session.amazonTokens.accessToken;
  } catch (err) {
    throw new Error('Failed to refresh Amazon token: ' + err.message);
  }
}

// ----------------------------------------------------------------
// Helper: Make authenticated Amazon Ads API request
// ----------------------------------------------------------------
async function amazonRequest(session, method, path, data = null, params = null) {
  const token = await getValidToken(session);
  const profileId = session.amazonProfileId;

  const config = {
    method,
    url: `${API_BASE}${path}`,
    headers: {
      'Authorization':          `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': AMAZON.clientId,
      'Content-Type':           'application/json',
      ...(profileId ? { 'Amazon-Advertising-API-Scope': profileId } : {}),
    },
    ...(params ? { params } : {}),
    ...(data   ? { data }   : {}),
  };

  const response = await axios(config);
  return response.data;
}

// ================================================================
// ROUTES
// ================================================================

// ----------------------------------------------------------------
// POST /auth/login — App password login
// ----------------------------------------------------------------
app.post('/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password is required.' });
  }
  if (password !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  req.session.loggedIn = true;
  req.session.loginAt  = Date.now();
  console.log(`Login successful from ${req.ip}`);
  return res.json({ success: true });
});

// ----------------------------------------------------------------
// POST /auth/logout
// ----------------------------------------------------------------
app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// ----------------------------------------------------------------
// GET /auth/status — check if logged in + Amazon connected
// ----------------------------------------------------------------
app.get('/auth/status', requireAuth, (req, res) => {
  res.json({
    loggedIn:         true,
    amazonConnected:  !!req.session.amazonTokens,
    profileId:        req.session.amazonProfileId || null,
    profileName:      req.session.amazonProfileName || null,
  });
});

// ----------------------------------------------------------------
// GET /auth/amazon — start Amazon OAuth flow
// ----------------------------------------------------------------
app.get('/auth/amazon', requireAuth, (req, res) => {
  if (!AMAZON.clientId) {
    return res.status(400).json({
      error: 'Amazon API credentials not configured. Add AMAZON_CLIENT_ID and AMAZON_CLIENT_SECRET to your environment variables.'
    });
  }

  const state = Math.random().toString(36).substring(2, 15);
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id:     AMAZON.clientId,
    scope:         'advertising::campaign_management',
    response_type: 'code',
    redirect_uri:  AMAZON.redirectUri,
    state,
  });

  res.redirect(`${AMAZON_AUTH_URL}?${params.toString()}`);
});

// ----------------------------------------------------------------
// GET /auth/callback — Amazon OAuth callback
// ----------------------------------------------------------------
app.get('/auth/callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect('/?error=amazon_denied');
  }

  if (!state || state !== req.session.oauthState) {
    return res.redirect('/?error=invalid_state');
  }

  try {
    const tokenResponse = await axios.post(AMAZON_TOKEN_URL, new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  AMAZON.redirectUri,
      client_id:     AMAZON.clientId,
      client_secret: AMAZON.clientSecret,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    req.session.amazonTokens = {
      accessToken:  tokenResponse.data.access_token,
      refreshToken: tokenResponse.data.refresh_token,
      expiresAt:    Date.now() + (tokenResponse.data.expires_in * 1000),
    };
    req.session.oauthState = null;

    console.log('Amazon OAuth successful');
    res.redirect('/?amazon=connected');
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ----------------------------------------------------------------
// GET /api/profiles — list all ad accounts/profiles
// ----------------------------------------------------------------
app.get('/api/profiles', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    const profiles = await amazonRequest(req.session, 'GET', '/v2/profiles');
    res.json(profiles);
  } catch (err) {
    console.error('Profiles error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// POST /api/profiles/select — set active profile
// ----------------------------------------------------------------
app.post('/api/profiles/select', requireAuth, requireAmazon, async (req, res) => {
  const { profileId, profileName } = req.body;
  if (!profileId) return res.status(400).json({ error: 'profileId required.' });
  req.session.amazonProfileId   = profileId;
  req.session.amazonProfileName = profileName || '';
  res.json({ success: true, profileId, profileName });
});

// ----------------------------------------------------------------
// GET /api/portfolios — list all portfolios
// ----------------------------------------------------------------
app.get('/api/portfolios', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    const data = await amazonRequest(req.session, 'GET', '/v2/portfolios');
    res.json(data);
  } catch (err) {
    console.error('Portfolios error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// GET /api/campaigns — list campaigns
// ----------------------------------------------------------------
app.get('/api/campaigns', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    const params = {};
    if (req.query.portfolioId) params.portfolioId = req.query.portfolioId;
    if (req.query.state)       params.state       = req.query.state;
    if (req.query.campaignType) params.campaignType = req.query.campaignType;

    const data = await amazonRequest(req.session, 'GET', '/v2/campaigns', null, params);
    res.json(data);
  } catch (err) {
    console.error('Campaigns error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// POST /api/campaigns — create a new campaign
// ----------------------------------------------------------------
app.post('/api/campaigns', requireAuth, requireAmazon, async (req, res) => {
  try {
    const data = await amazonRequest(req.session, 'POST', '/v2/campaigns', [req.body]);
    res.json(data);
  } catch (err) {
    console.error('Create campaign error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// PUT /api/campaigns/:id — update a campaign (pause, budget, etc.)
// ----------------------------------------------------------------
app.put('/api/campaigns/:id', requireAuth, requireAmazon, async (req, res) => {
  try {
    const payload = { campaignId: req.params.id, ...req.body };
    const data = await amazonRequest(req.session, 'PUT', '/v2/campaigns', [payload]);
    res.json(data);
  } catch (err) {
    console.error('Update campaign error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// GET /api/keywords — list keywords
// ----------------------------------------------------------------
app.get('/api/keywords', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    const params = {};
    if (req.query.campaignId)  params.campaignId  = req.query.campaignId;
    if (req.query.adGroupId)   params.adGroupId   = req.query.adGroupId;
    if (req.query.state)       params.state       = req.query.state;
    if (req.query.matchType)   params.matchType   = req.query.matchType;

    const data = await amazonRequest(req.session, 'GET', '/v2/keywords', null, params);
    res.json(data);
  } catch (err) {
    console.error('Keywords error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// PUT /api/keywords/:id — update keyword (bid, state)
// ----------------------------------------------------------------
app.put('/api/keywords/:id', requireAuth, requireAmazon, async (req, res) => {
  try {
    const payload = { keywordId: req.params.id, ...req.body };
    const data = await amazonRequest(req.session, 'PUT', '/v2/keywords', [payload]);
    res.json(data);
  } catch (err) {
    console.error('Update keyword error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// POST /api/keywords/negative — add negative keywords
// ----------------------------------------------------------------
app.post('/api/keywords/negative', requireAuth, requireAmazon, async (req, res) => {
  try {
    const data = await amazonRequest(req.session, 'POST', '/v2/negativeKeywords', req.body);
    res.json(data);
  } catch (err) {
    console.error('Negative keywords error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// GET /api/search-terms — get search term report
// ----------------------------------------------------------------
app.get('/api/search-terms', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    // Request search term report
    const reportRequest = await amazonRequest(req.session, 'POST', '/v2/reports', {
      reportDate:  req.query.date || new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      metrics:     'impressions,clicks,cost,attributedSales30d,attributedConversions30d',
      segment:     'query',
      recordType:  'keywords',
    });

    res.json({ reportId: reportRequest.reportId, status: reportRequest.status });
  } catch (err) {
    console.error('Search terms error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// GET /api/reports/:reportId — poll report status / download
// ----------------------------------------------------------------
app.get('/api/reports/:reportId', requireAuth, requireAmazon, async (req, res) => {
  try {
    const data = await amazonRequest(req.session, 'GET', `/v2/reports/${req.params.reportId}`);
    res.json(data);
  } catch (err) {
    console.error('Report status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// GET /api/ad-groups — list ad groups
// ----------------------------------------------------------------
app.get('/api/ad-groups', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    const params = {};
    if (req.query.campaignId) params.campaignId = req.query.campaignId;
    if (req.query.state)      params.state      = req.query.state;

    const data = await amazonRequest(req.session, 'GET', '/v2/adGroups', null, params);
    res.json(data);
  } catch (err) {
    console.error('Ad groups error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// GET /api/product-ads — list product ads (ASINs in campaigns)
// ----------------------------------------------------------------
app.get('/api/product-ads', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    const params = {};
    if (req.query.campaignId) params.campaignId = req.query.campaignId;
    if (req.query.adGroupId)  params.adGroupId  = req.query.adGroupId;
    if (req.query.state)      params.state      = req.query.state;

    const data = await amazonRequest(req.session, 'GET', '/v2/productAds', null, params);
    res.json(data);
  } catch (err) {
    console.error('Product ads error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// GET /api/campaign-stats — campaign performance metrics
// ----------------------------------------------------------------
app.get('/api/campaign-stats', requireAuth, requireAmazon, apiLimiter, async (req, res) => {
  try {
    const reportRequest = await amazonRequest(req.session, 'POST', '/v2/reports', {
      reportDate:  req.query.date || new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      metrics:     'impressions,clicks,cost,attributedSales30d,attributedConversions30d,attributedUnitsOrdered30d',
      recordType:  'campaigns',
    });
    res.json({ reportId: reportRequest.reportId, status: reportRequest.status });
  } catch (err) {
    console.error('Campaign stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// GET /api/health — server health check (no auth needed)
// ----------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status:           'ok',
    amazonConfigured: !!(AMAZON.clientId && AMAZON.clientSecret),
    region:           AMAZON.region,
    timestamp:        new Date().toISOString(),
  });
});

// ----------------------------------------------------------------
// Catch-all — serve index.html for all non-API routes
// ----------------------------------------------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----------------------------------------------------------------
// Start server — bind to 0.0.0.0 so Railway can reach it
// ----------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║        AdScale Server Running        ║');
  console.log(`  ║   http://0.0.0.0:${PORT}               ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  Amazon API configured: ${!!(AMAZON.clientId && AMAZON.clientSecret)}`);
  console.log(`  Region: ${AMAZON.region}`);
  console.log(`  IP allowlist: ${process.env.ALLOWED_IPS ? 'enabled' : 'disabled'}`);
  console.log('');
  });
});

