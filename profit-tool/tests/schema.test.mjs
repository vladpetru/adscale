// Checks that the migrations build a working database.
// Uses SQLite built into Node, the same engine family D1 runs on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const dir = new URL('../migrations/', import.meta.url);

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  return db;
}

const EXPECTED_TABLES = [
  'activity_log', 'ad_spend', 'batches', 'bom', 'box_types', 'consumptions',
  'daily_product_metrics', 'delivery_profiles', 'expenses', 'families', 'ingest_log',
  'job_runs', 'listings', 'order_charges', 'order_delivery_costs', 'order_items', 'orders',
  'payment_gateways', 'products', 'receipt_costs', 'receipt_lines', 'receipts', 'refunds',
  'settings', 'stock_adjustments', 'stock_snapshots', 'traffic', 'variable_expense_rules',
  'velocity_settings',
];

test('migrations are numbered in order', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  files.forEach((file, i) => {
    assert.match(file, new RegExp(`^${String(i + 1).padStart(4, '0')}_[a-z0-9_]+\\.sql$`));
  });
});

test('migrations create every table in the spec, each with id and timestamps', () => {
  const db = freshDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, EXPECTED_TABLES);
  for (const table of tables) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const col of ['id', 'created_at', 'updated_at']) {
      assert.ok(cols.includes(col), `${table} is missing ${col}`);
    }
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('decided starting values are in place', () => {
  const db = freshDb();
  const get = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key).value;
  assert.equal(get('history_start_date'), '2025-01-01');
  assert.equal(get('fifo_start_date'), '2026-01-01');
  assert.equal(get('display_time_zone'), 'America/New_York');
  const v = db.prepare('SELECT * FROM velocity_settings WHERE box_type_id IS NULL').get();
  assert.deepEqual([v.weight_3, v.weight_7, v.weight_30, v.weight_60, v.weight_180], [0.5, 0.3, 0.2, 0, 0]);
  assert.equal(v.lead_time_days, 90);
});

test('a receipt, a batch, an order and its ledger row fit together', () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO families (id, code, name) VALUES (1, 'R6-EXP', '6 ft expanded');
    INSERT INTO products (id, family_id, code, name) VALUES (1, 1, 'R6-EXP-BLACK', '6 ft table, black');
    INSERT INTO box_types (id, scanship_sku, name, cbm) VALUES (1, 'R6-EXP-BLACK-1', 'Box 1', 0.12);
    INSERT INTO bom (product_id, box_type_id, qty) VALUES (1, 1, 1);
    INSERT INTO receipts (id, receipt_date, status) VALUES (1, '2026-01-10', 'received');
    INSERT INTO receipt_lines (id, receipt_id, box_type_id, qty, declared_value_cents) VALUES (1, 1, 1, 100, 400000);
    INSERT INTO receipt_costs (receipt_id, kind, amount_cents, allocation) VALUES (1, 'ocean_freight', 150000, 'by_volume');
    INSERT INTO batches (id, box_type_id, receipt_line_id, received_at, qty_in, qty_remaining, unit_cost_cents, status)
      VALUES (1, 1, 1, '2026-01-10', 100, 99, 5500, 'active');
    INSERT INTO batches (box_type_id, origin, method, unit_cost_cents) VALUES (1, 'cost_history', 'by_period', 5000);
    INSERT INTO orders (id, channel, marketplace, external_order_id, ordered_at) VALUES (1, 'shopify', 'outtans.com', '1001', '2026-02-01T12:00:00Z');
    INSERT INTO order_items (id, order_id, external_line_id, product_id, qty, item_price_cents) VALUES (1, 1, 'L1', 1, 1, 39900);
    INSERT INTO consumptions (order_item_id, reason, box_type_id, batch_id, qty, unit_cost_cents, cost_source, consumed_at)
      VALUES (1, 'sale', 1, 1, 1, 5500, 'fifo', '2026-02-01T12:00:00Z');
  `);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM consumptions').get().n, 1);
});

test('the database refuses bad rows', () => {
  const db = freshDb();
  // The same order arriving twice must be an update, never a second row.
  db.exec("INSERT INTO orders (channel, marketplace, external_order_id, ordered_at) VALUES ('amazon', 'ATVPDKIKX0DER', '111-1', '2026-01-01T00:00:00Z')");
  assert.throws(() =>
    db.exec("INSERT INTO orders (channel, marketplace, external_order_id, ordered_at) VALUES ('amazon', 'ATVPDKIKX0DER', '111-1', '2026-01-01T00:00:00Z')"),
  );
  // A FIFO batch needs a date and a quantity.
  db.exec("INSERT INTO box_types (id, scanship_sku, name) VALUES (1, 'X', 'X')");
  assert.throws(() => db.exec("INSERT INTO batches (box_type_id, method, unit_cost_cents) VALUES (1, 'fifo', 100)"));
  // A direct cost needs a box type. Unknown values are refused.
  db.exec("INSERT INTO receipts (id, receipt_date) VALUES (1, '2026-01-01')");
  assert.throws(() => db.exec("INSERT INTO receipt_costs (receipt_id, kind, amount_cents, allocation) VALUES (1, 'other', 100, 'direct')"));
  assert.throws(() => db.exec("INSERT INTO receipt_costs (receipt_id, kind, amount_cents, allocation) VALUES (1, 'bribes', 100, 'by_units')"));
  // A row cannot point at something that does not exist.
  assert.throws(() => db.exec('INSERT INTO bom (product_id, box_type_id, qty) VALUES (999, 1, 1)'));
});
