-- OUTTANS profit tool: initial schema (spec section 3).
--
-- Conventions
--   Money:      integer cents, USD. Costs are negative where the spec says so.
--   Quantities: integers (boxes, units).
--   Dates:      ISO 8601 UTC text. "date" columns hold a business day
--               (YYYY-MM-DD in the display time zone, America/New_York by default).
--   Every table has id, created_at, updated_at.
--
-- Applied with: wrangler d1 migrations apply outtans-profit

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 3.1 Catalog
-- ---------------------------------------------------------------------------

CREATE TABLE families (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Sellable items.
CREATE TABLE products (
  id               INTEGER PRIMARY KEY,
  family_id        INTEGER REFERENCES families(id),
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  color            TEXT,
  size             TEXT,
  metal            TEXT CHECK (metal IN ('EXP', 'PUN', 'WOOD', 'none')),
  backrest         INTEGER NOT NULL DEFAULT 0 CHECK (backrest IN (0, 1)),
  ada              INTEGER NOT NULL DEFAULT 0 CHECK (ada IN (0, 1)),
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  tags             TEXT NOT NULL DEFAULT '[]',
  list_price_cents INTEGER,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_products_family ON products(family_id);

-- Components: one per Scanship SKU (a physical box).
CREATE TABLE box_types (
  id           INTEGER PRIMARY KEY,
  scanship_sku TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  cbm          REAL,
  weight_kg    REAL,
  family_id    INTEGER REFERENCES families(id),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Bill of materials: which boxes, and how many, make one sellable product.
CREATE TABLE bom (
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  box_type_id INTEGER NOT NULL REFERENCES box_types(id),
  qty         INTEGER NOT NULL CHECK (qty > 0),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (product_id, box_type_id)
);

-- Channel mapping. product_id is null until the listing is mapped
-- (unmapped listings show on the "Unmapped" screen).
CREATE TABLE listings (
  id                 INTEGER PRIMARY KEY,
  product_id         INTEGER REFERENCES products(id),
  channel            TEXT NOT NULL,
  marketplace        TEXT NOT NULL,
  external_id        TEXT NOT NULL DEFAULT '',
  seller_sku         TEXT NOT NULL DEFAULT '',
  parent_external_id TEXT,
  title              TEXT,
  fulfillment        TEXT NOT NULL DEFAULT 'n/a' CHECK (fulfillment IN ('FBM', 'FBA', 'n/a')),
  last_fba_fee_cents INTEGER,
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (channel, marketplace, external_id, seller_sku)
);
CREATE INDEX idx_listings_product ON listings(product_id);
CREATE INDEX idx_listings_sku ON listings(channel, seller_sku);

-- ---------------------------------------------------------------------------
-- 3.2 Orders and money
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id                INTEGER PRIMARY KEY,
  channel           TEXT NOT NULL,
  marketplace       TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  order_number      TEXT,
  ordered_at        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                      ('pending', 'unshipped', 'shipped', 'canceled', 'refunded', 'partially_refunded')),
  fulfillment       TEXT CHECK (fulfillment IN ('FBM', 'FBA')),
  customer_type     TEXT NOT NULL DEFAULT 'b2c' CHECK (customer_type IN ('b2c', 'b2b')),
  ship_state        TEXT,
  ship_zip          TEXT,
  ship_country      TEXT,
  currency          TEXT NOT NULL DEFAULT 'USD',
  payment_gateway   TEXT,
  tracking_numbers  TEXT NOT NULL DEFAULT '[]',
  needs_refresh     INTEGER NOT NULL DEFAULT 0 CHECK (needs_refresh IN (0, 1)),
  raw_json          TEXT,
  source            TEXT NOT NULL DEFAULT 'sync' CHECK (source IN ('sync', 'ingest', 'import')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (channel, marketplace, external_order_id)
);
CREATE INDEX idx_orders_ordered_at ON orders(ordered_at);
CREATE INDEX idx_orders_number ON orders(order_number);

CREATE TABLE order_items (
  id                     INTEGER PRIMARY KEY,
  order_id               INTEGER NOT NULL REFERENCES orders(id),
  external_line_id       TEXT NOT NULL,
  listing_id             INTEGER REFERENCES listings(id),
  product_id             INTEGER REFERENCES products(id),
  seller_sku             TEXT,
  qty                    INTEGER NOT NULL,
  item_price_cents       INTEGER NOT NULL DEFAULT 0,
  discount_cents         INTEGER NOT NULL DEFAULT 0,
  shipping_charged_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents              INTEGER NOT NULL DEFAULT 0,
  tip_cents              INTEGER NOT NULL DEFAULT 0,
  -- Written by the FIFO recompute (spec 5.2).
  cogs_cents             INTEGER,
  cost_source            TEXT CHECK (cost_source IN ('fifo', 'by_period', 'fallback_oversold', 'missing')),
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (order_id, external_line_id)
);
CREATE INDEX idx_order_items_product ON order_items(product_id);
CREATE INDEX idx_order_items_listing ON order_items(listing_id);

-- One row per fee or money movement. order_id is null for channel-level
-- charges (storage fees and similar), which then need channel filled in.
CREATE TABLE order_charges (
  id            INTEGER PRIMARY KEY,
  order_id      INTEGER REFERENCES orders(id),
  order_item_id INTEGER REFERENCES order_items(id),
  channel       TEXT,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'referral_fee', 'fba_fee', 'shipping_chargeback', 'giftwrap_chargeback',
                  'promo', 'payment_fee', 'refund_amount', 'refund_commission',
                  'refund_commission_returned', 'refund_fee_returned', 'other_channel_fee',
                  'deal_fee', 'storage_fee', 'reimbursement', 'giftwrap', 'other')),
  amount_cents  INTEGER NOT NULL,
  estimated     INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1)),
  posted_at     TEXT NOT NULL,
  external_ref  TEXT,
  raw_json      TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_order_charges_order ON order_charges(order_id);
CREATE INDEX idx_order_charges_posted ON order_charges(posted_at);
CREATE UNIQUE INDEX idx_order_charges_ref ON order_charges(external_ref, kind)
  WHERE external_ref IS NOT NULL;

CREATE TABLE refunds (
  id            INTEGER PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  order_item_id INTEGER REFERENCES order_items(id),
  external_ref  TEXT,
  qty           INTEGER NOT NULL DEFAULT 0,
  refunded_at   TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  -- null = not decided yet, 1 = back on the shelf, 0 = not sellable.
  sellable      INTEGER CHECK (sellable IN (0, 1)),
  restocked_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_refunds_order ON refunds(order_id);
CREATE UNIQUE INDEX idx_refunds_ref ON refunds(external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE ad_spend (
  id                     INTEGER PRIMARY KEY,
  channel                TEXT NOT NULL CHECK (channel IN ('amazon', 'google', 'meta', 'other')),
  platform_account       TEXT NOT NULL DEFAULT '',
  date                   TEXT NOT NULL,
  campaign_type          TEXT NOT NULL DEFAULT '',
  campaign               TEXT NOT NULL DEFAULT '',
  listing_id             INTEGER REFERENCES listings(id),
  product_id             INTEGER REFERENCES products(id),
  seller_sku             TEXT NOT NULL DEFAULT '',
  spend_cents            INTEGER NOT NULL DEFAULT 0,
  attributed_sales_cents INTEGER NOT NULL DEFAULT 0,
  source                 TEXT NOT NULL CHECK (source IN ('api', 'csv', 'manual')),
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (channel, platform_account, date, campaign_type, campaign, seller_sku)
);
CREATE INDEX idx_ad_spend_date ON ad_spend(date);

-- Amazon business report by ASIN by day.
CREATE TABLE traffic (
  id            INTEGER PRIMARY KEY,
  listing_id    INTEGER REFERENCES listings(id),
  asin          TEXT NOT NULL,
  date          TEXT NOT NULL,
  sessions      INTEGER,
  page_views    INTEGER,
  units_ordered INTEGER,
  bsr           INTEGER,
  buy_box_pct   REAL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (asin, date)
);

-- ---------------------------------------------------------------------------
-- 3.3 Costs and stock
-- ---------------------------------------------------------------------------

-- A container or PO arriving at a warehouse.
CREATE TABLE receipts (
  id           INTEGER PRIMARY KEY,
  receipt_date TEXT NOT NULL,
  reference    TEXT,
  supplier     TEXT,
  warehouse    TEXT,
  status       TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_transit', 'received')),
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE receipt_lines (
  id                   INTEGER PRIMARY KEY,
  receipt_id           INTEGER NOT NULL REFERENCES receipts(id),
  box_type_id          INTEGER NOT NULL REFERENCES box_types(id),
  qty                  INTEGER NOT NULL CHECK (qty > 0),
  declared_value_cents INTEGER NOT NULL DEFAULT 0,
  cbm_override         REAL,
  unit_cost_override_cents INTEGER,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_receipt_lines_receipt ON receipt_lines(receipt_id);

-- Cost elements on a receipt, shared out over its lines (spec 5.1).
CREATE TABLE receipt_costs (
  id           INTEGER PRIMARY KEY,
  receipt_id   INTEGER NOT NULL REFERENCES receipts(id),
  kind         TEXT NOT NULL CHECK (kind IN ('factory', 'ocean_freight', 'duties', 'inland_freight', 'other')),
  amount_cents INTEGER NOT NULL,
  allocation   TEXT NOT NULL CHECK (allocation IN ('by_volume', 'by_value', 'by_units', 'direct')),
  box_type_id  INTEGER REFERENCES box_types(id),
  comment      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (allocation <> 'direct' OR box_type_id IS NOT NULL)
);
CREATE INDEX idx_receipt_costs_receipt ON receipt_costs(receipt_id);

-- The FIFO queue. One row per receipt line once the receipt is received,
-- plus rows the engine derives (FBA mirror batches, count corrections) and
-- "by_period" rows that cost history from before FIFO started.
CREATE TABLE batches (
  id                  INTEGER PRIMARY KEY,
  box_type_id         INTEGER NOT NULL REFERENCES box_types(id),
  receipt_line_id     INTEGER REFERENCES receipt_lines(id),
  parent_batch_id     INTEGER REFERENCES batches(id),
  adjustment_id       INTEGER REFERENCES stock_adjustments(id),
  origin              TEXT NOT NULL DEFAULT 'receipt' CHECK (origin IN
                        ('receipt', 'fba_transfer', 'count_correction', 'cost_history')),
  pool                TEXT NOT NULL DEFAULT 'warehouse' CHECK (pool IN ('warehouse', 'fba')),
  method              TEXT NOT NULL DEFAULT 'fifo' CHECK (method IN ('fifo', 'by_period')),
  -- null on a by_period batch means "from the beginning of time".
  received_at         TEXT,
  qty_in              INTEGER,
  qty_remaining       INTEGER,
  unit_cost_cents     INTEGER NOT NULL,
  cost_breakdown_json TEXT,
  status              TEXT CHECK (status IN ('queued', 'active', 'depleted')),
  comment             TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (method = 'by_period' OR (received_at IS NOT NULL AND qty_in IS NOT NULL))
);
CREATE INDEX idx_batches_queue ON batches(box_type_id, pool, method, received_at);

-- The FIFO ledger. Rebuilt from scratch by the recompute, never edited by hand.
-- Exactly one of order_item_id, refund_id, adjustment_id is set.
CREATE TABLE consumptions (
  id              INTEGER PRIMARY KEY,
  order_item_id   INTEGER REFERENCES order_items(id),
  refund_id       INTEGER REFERENCES refunds(id),
  adjustment_id   INTEGER REFERENCES stock_adjustments(id),
  reason          TEXT NOT NULL CHECK (reason IN ('sale', 'restock', 'adjustment', 'transfer')),
  box_type_id     INTEGER NOT NULL REFERENCES box_types(id),
  batch_id        INTEGER REFERENCES batches(id),
  -- Positive when stock leaves, negative when a sellable return comes back.
  qty             INTEGER NOT NULL,
  unit_cost_cents INTEGER NOT NULL,
  cost_source     TEXT NOT NULL CHECK (cost_source IN ('fifo', 'by_period', 'fallback_oversold', 'missing')),
  consumed_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_consumptions_item ON consumptions(order_item_id);
CREATE INDEX idx_consumptions_batch ON consumptions(batch_id);
CREATE INDEX idx_consumptions_at ON consumptions(consumed_at);

-- One row per box type per warehouse per day. FBA rows use warehouse = 'FBA'.
CREATE TABLE stock_snapshots (
  id            INTEGER PRIMARY KEY,
  date          TEXT NOT NULL,
  box_type_id   INTEGER REFERENCES box_types(id),
  listing_id    INTEGER REFERENCES listings(id),
  sku           TEXT NOT NULL,
  warehouse     TEXT NOT NULL,
  quantity      INTEGER,
  safe_quantity INTEGER,
  reserved      INTEGER,
  on_hold       INTEGER,
  available     INTEGER,
  fulfillable   INTEGER,
  inbound       INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (date, sku, warehouse)
);

CREATE TABLE stock_adjustments (
  id          INTEGER PRIMARY KEY,
  date        TEXT NOT NULL,
  box_type_id INTEGER NOT NULL REFERENCES box_types(id),
  -- For fba_transfer, qty is the number of boxes moved from warehouse to FBA.
  qty         INTEGER NOT NULL,
  pool        TEXT NOT NULL DEFAULT 'warehouse' CHECK (pool IN ('warehouse', 'fba')),
  reason      TEXT NOT NULL CHECK (reason IN ('count_correction', 'damaged', 'sample', 'fba_transfer', 'other')),
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- 3.4 Delivery cost
-- ---------------------------------------------------------------------------

CREATE TABLE delivery_profiles (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  valid_from      TEXT NOT NULL,
  valid_to        TEXT,
  scope           TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'family', 'product')),
  scope_id        INTEGER,
  channel         TEXT,
  rule            TEXT NOT NULL CHECK (rule IN
                    ('per_unit', 'per_order', 'pct_of_price', 'equals_customer_charge', 'none')),
  zone_rates_json TEXT NOT NULL DEFAULT '[]',
  currency        TEXT NOT NULL DEFAULT 'USD',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Effective cost = actual_cents when present, else estimated_cents.
CREATE TABLE order_delivery_costs (
  id              INTEGER PRIMARY KEY,
  order_id        INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  estimated_cents INTEGER,
  profile_id      INTEGER REFERENCES delivery_profiles(id),
  actual_cents    INTEGER,
  carrier         TEXT,
  tracking        TEXT,
  invoice_ref     TEXT,
  actualized_at   TEXT,
  source          TEXT CHECK (source IN ('csv', 'manual')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- 3.5 Expenses and settings
-- ---------------------------------------------------------------------------

CREATE TABLE expenses (
  id             INTEGER PRIMARY KEY,
  date           TEXT NOT NULL,
  name           TEXT NOT NULL,
  category       TEXT,
  recurrence     TEXT NOT NULL DEFAULT 'one_time' CHECK (recurrence IN
                   ('one_time', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly')),
  end_date       TEXT,
  amount_cents   INTEGER NOT NULL,
  channel        TEXT,
  assign_type    TEXT NOT NULL DEFAULT 'none' CHECK (assign_type IN ('none', 'product', 'family', 'channel')),
  assign_id      TEXT,
  is_advertising INTEGER NOT NULL DEFAULT 0 CHECK (is_advertising IN (0, 1)),
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Phase 2.
CREATE TABLE variable_expense_rules (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  basis      TEXT NOT NULL CHECK (basis IN ('pct_of_price', 'per_unit', 'per_order')),
  amount     REAL NOT NULL,
  channel    TEXT,
  scope      TEXT NOT NULL DEFAULT 'all',
  scope_id   INTEGER,
  valid_from TEXT,
  valid_to   TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE payment_gateways (
  id                      INTEGER PRIMARY KEY,
  channel                 TEXT NOT NULL,
  gateway                 TEXT NOT NULL,
  pct                     REAL NOT NULL DEFAULT 0,
  fixed_cents             INTEGER NOT NULL DEFAULT 0,
  use_actual_when_present INTEGER NOT NULL DEFAULT 1 CHECK (use_actual_when_present IN (0, 1)),
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (channel, gateway)
);

-- One global row (box_type_id null) plus optional per-box-type overrides.
CREATE TABLE velocity_settings (
  id                INTEGER PRIMARY KEY,
  box_type_id       INTEGER UNIQUE REFERENCES box_types(id),
  weight_3          REAL NOT NULL DEFAULT 0.5,
  weight_7          REAL NOT NULL DEFAULT 0.3,
  weight_30         REAL NOT NULL DEFAULT 0.2,
  weight_60         REAL NOT NULL DEFAULT 0,
  weight_180        REAL NOT NULL DEFAULT 0,
  ignore_oos_days   INTEGER NOT NULL DEFAULT 1 CHECK (ignore_oos_days IN (0, 1)),
  seasonality_json  TEXT,
  lead_time_days    INTEGER NOT NULL DEFAULT 90,
  target_cover_days INTEGER NOT NULL DEFAULT 90,
  safety_days       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE settings (
  id         INTEGER PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,
  value      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Every scheduled run writes a row here. A silent failure is not allowed.
CREATE TABLE job_runs (
  id          INTEGER PRIMARY KEY,
  job         TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  counts_json TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_job_runs_job ON job_runs(job, started_at);

CREATE TABLE ingest_log (
  id          INTEGER PRIMARY KEY,
  endpoint    TEXT NOT NULL,
  received_at TEXT NOT NULL,
  rows_in     INTEGER NOT NULL DEFAULT 0,
  rows_ok     INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT,
  cursor      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Who changed what in the UI. No foreign keys on purpose: in the CRM a
-- foreign key here made rows with history impossible to delete.
CREATE TABLE activity_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor       TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  detail_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- 3.6 Daily aggregates: every dashboard view reads from here (spec 5.5).
-- product_id 0 = not tied to a product (channel-level rows).
-- ---------------------------------------------------------------------------

CREATE TABLE daily_product_metrics (
  id                       INTEGER PRIMARY KEY,
  date                     TEXT NOT NULL,
  product_id               INTEGER NOT NULL DEFAULT 0,
  channel                  TEXT NOT NULL,
  units                    INTEGER NOT NULL DEFAULT 0,
  orders                   INTEGER NOT NULL DEFAULT 0,
  refund_units             INTEGER NOT NULL DEFAULT 0,
  sellable_return_units    INTEGER NOT NULL DEFAULT 0,
  sessions                 INTEGER NOT NULL DEFAULT 0,
  gross_sales_cents        INTEGER NOT NULL DEFAULT 0,
  promo_cents              INTEGER NOT NULL DEFAULT 0,
  sales_cents              INTEGER NOT NULL DEFAULT 0,
  refund_cost_cents        INTEGER NOT NULL DEFAULT 0,
  channel_fees_cents       INTEGER NOT NULL DEFAULT 0,
  advertising_cents        INTEGER NOT NULL DEFAULT 0,
  attributed_sales_cents   INTEGER NOT NULL DEFAULT 0,
  delivery_cents           INTEGER NOT NULL DEFAULT 0,
  delivery_estimated_cents INTEGER NOT NULL DEFAULT 0,
  cogs_cents               INTEGER NOT NULL DEFAULT 0,
  variable_cents           INTEGER NOT NULL DEFAULT 0,
  gross_profit_cents       INTEGER NOT NULL DEFAULT 0,
  indirect_cents           INTEGER NOT NULL DEFAULT 0,
  net_profit_cents         INTEGER NOT NULL DEFAULT 0,
  est_payout_cents         INTEGER NOT NULL DEFAULT 0,
  tax_cents                INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (date, product_id, channel)
);

-- ---------------------------------------------------------------------------
-- Starting values (decided in spec section 1).
-- ---------------------------------------------------------------------------

INSERT INTO settings (key, value) VALUES
  ('display_time_zone', 'America/New_York'),
  ('history_start_date', '2025-01-01'),
  ('fifo_start_date', '2026-01-01'),
  ('amazon_referral_fee_pct_default', '15'),
  ('reconciliation_threshold_boxes', '2');

INSERT INTO velocity_settings (box_type_id) VALUES (NULL);
