// FIFO tests (spec 5.2, acceptance tests 3 and 4).
// Every expected number below is worked out by hand in the comments.

import test from 'node:test';
import assert from 'node:assert/strict';
import { replayFifo } from '../functions/_lib/fifo.js';

const TOP = 'TOP';
const LEGS = 'LEGS';

// One product (a table) made of one TOP box.
const bom = [{ product_id: 'TABLE', box_type_id: TOP, qty: 1 }];

// Three FIFO batches in 2026, plus a "by period" cost for 2025 history.
const batches = [
  { id: 'HIST', box_type_id: TOP, method: 'by_period', received_at: null, unit_cost_cents: 4500 },
  { id: 'B1', box_type_id: TOP, method: 'fifo', received_at: '2026-01-10', qty_in: 5, unit_cost_cents: 5000 },
  { id: 'B2', box_type_id: TOP, method: 'fifo', received_at: '2026-02-10', qty_in: 5, unit_cost_cents: 6000 },
  { id: 'B3', box_type_id: TOP, method: 'fifo', received_at: '2026-03-10', qty_in: 10, unit_cost_cents: 7000 },
];

// Ten orders, alternating Shopify and Amazon (FBM). Both channels share one queue.
const order = (n, date, channel, qty) => ({
  id: n, order_id: n, ordered_at: `${date}T15:00:00Z`, channel, product_id: 'TABLE', qty, fulfillment: 'FBM',
});
const orderItems = [
  order(1, '2025-12-20', 'shopify', 1),
  order(2, '2026-01-12', 'amazon', 2),
  order(3, '2026-01-20', 'shopify', 2),
  order(4, '2026-02-01', 'amazon', 2),
  order(5, '2026-02-15', 'shopify', 3),
  order(6, '2026-02-20', 'amazon', 1),
  order(7, '2026-03-01', 'shopify', 1),
  order(8, '2026-03-12', 'amazon', 4),
  order(9, '2026-03-15', 'shopify', 1),
  order(10, '2026-03-20', 'amazon', 2),
];

const rowsFor = (result, itemId) =>
  result.consumptions
    .filter((c) => c.source_type === 'order_item' && c.source_id === itemId)
    .map((c) => [c.batch_id, c.qty, c.unit_cost_cents, c.cost_source]);
const itemFor = (result, itemId) => result.items.find((i) => i.order_item_id === itemId);
const batchFor = (result, id) => result.batches.find((b) => b.id === id);

// The ledger rule: remaining = received - everything taken out.
function assertLedgerBalances(result) {
  for (const b of result.batches.filter((x) => x.method === 'fifo')) {
    const out = result.consumptions.filter((c) => c.batch_id === b.id).reduce((s, c) => s + c.qty, 0);
    assert.equal(b.qty_remaining, b.qty_in - out, `batch ${b.id} does not balance`);
    assert.ok(b.qty_remaining >= 0, `batch ${b.id} went negative`);
  }
}

test('acceptance 3a: 3 batches and 10 orders give the expected consumptions', () => {
  const r = replayFifo({ batches, bom, orderItems });

  // 1  Dec 20 2025, 1: before any FIFO batch         -> history cost 1 x 45
  // 2  Jan 12, 2:  B1 2 (B1 left 3)                  -> 100
  // 3  Jan 20, 2:  B1 2 (left 1)                     -> 100
  // 4  Feb 1,  2:  B1 1 (left 0), B2 not here yet    -> 50 + oversold 1 x 45 = 95
  // 5  Feb 15, 3:  B2 3 (left 2)                     -> 180
  // 6  Feb 20, 1:  B2 1 (left 1)                     -> 60
  // 7  Mar 1,  1:  B2 1 (left 0)                     -> 60
  // 8  Mar 12, 4:  B3 4 (left 6)                     -> 280
  // 9  Mar 15, 1:  B3 1 (left 5)                     -> 70
  // 10 Mar 20, 2:  B3 2 (left 3)                     -> 140
  assert.deepEqual(rowsFor(r, 1), [['HIST', 1, 4500, 'by_period']]);
  assert.deepEqual(rowsFor(r, 2), [['B1', 2, 5000, 'fifo']]);
  assert.deepEqual(rowsFor(r, 3), [['B1', 2, 5000, 'fifo']]);
  assert.deepEqual(rowsFor(r, 4), [['B1', 1, 5000, 'fifo'], ['HIST', 1, 4500, 'fallback_oversold']]);
  assert.deepEqual(rowsFor(r, 5), [['B2', 3, 6000, 'fifo']]);
  assert.deepEqual(rowsFor(r, 6), [['B2', 1, 6000, 'fifo']]);
  assert.deepEqual(rowsFor(r, 7), [['B2', 1, 6000, 'fifo']]);
  assert.deepEqual(rowsFor(r, 8), [['B3', 4, 7000, 'fifo']]);
  assert.deepEqual(rowsFor(r, 9), [['B3', 1, 7000, 'fifo']]);
  assert.deepEqual(rowsFor(r, 10), [['B3', 2, 7000, 'fifo']]);

  assert.deepEqual(
    r.items.map((i) => i.cogs_cents),
    [4500, 10000, 10000, 9500, 18000, 6000, 6000, 28000, 7000, 14000],
  );
  assert.equal(r.items.reduce((s, i) => s + i.cogs_cents, 0), 113000);
  assert.equal(itemFor(r, 1).cost_source, 'by_period');
  assert.equal(itemFor(r, 4).cost_source, 'fallback_oversold');
  assert.equal(itemFor(r, 5).cost_source, 'fifo');

  assert.deepEqual(
    ['B1', 'B2', 'B3'].map((id) => [batchFor(r, id).qty_remaining, batchFor(r, id).status]),
    [[0, 'depleted'], [0, 'depleted'], [3, 'active']],
  );
  // The oversold box is reported, the history-costed one is not an error.
  assert.deepEqual(r.issues.map((i) => [i.type, i.source_id, i.qty]), [['oversold', 4, 1]]);
  assertLedgerBalances(r);
});

test('acceptance 3b: running the recompute again changes nothing', () => {
  const input = { batches, bom, orderItems };
  const snapshot = structuredClone(input);
  const first = replayFifo(input);
  const second = replayFifo(input);
  assert.deepEqual(second, first);
  assert.deepEqual(input, snapshot, 'the replay must not change its input');

  // The order the rows arrive in must not matter either.
  const shuffled = replayFifo({
    batches: [...batches].reverse(),
    bom,
    orderItems: [...orderItems].reverse(),
  });
  assert.deepEqual(shuffled.consumptions, first.consumptions);
  assert.deepEqual(shuffled.items, first.items);
});

test('acceptance 3c: a back-dated receipt re-allocates everything after it', () => {
  // A receipt entered late: 2 boxes at $55 that actually arrived on Jan 25.
  const late = { id: 'B0', box_type_id: TOP, method: 'fifo', received_at: '2026-01-25', qty_in: 2, unit_cost_cents: 5500 };
  const r = replayFifo({ batches: [...batches, late], bom, orderItems });

  // 1 to 3 unchanged.
  // 4  Feb 1,  2:  B1 1, B0 1 (B0 left 1)            -> 50 + 55 = 105, no longer oversold
  // 5  Feb 15, 3:  B0 1 (left 0), B2 2 (left 3)      -> 55 + 120 = 175
  // 6  Feb 20, 1:  B2 1 (left 2)                     -> 60
  // 7  Mar 1,  1:  B2 1 (left 1)                     -> 60
  // 8  Mar 12, 4:  B2 1 (left 0), B3 3 (left 7)      -> 60 + 210 = 270
  // 9  Mar 15, 1:  B3 1 (left 6)                     -> 70
  // 10 Mar 20, 2:  B3 2 (left 4)                     -> 140
  assert.deepEqual(rowsFor(r, 3), [['B1', 2, 5000, 'fifo']]);
  assert.deepEqual(rowsFor(r, 4), [['B1', 1, 5000, 'fifo'], ['B0', 1, 5500, 'fifo']]);
  assert.deepEqual(rowsFor(r, 5), [['B0', 1, 5500, 'fifo'], ['B2', 2, 6000, 'fifo']]);
  assert.deepEqual(rowsFor(r, 8), [['B2', 1, 6000, 'fifo'], ['B3', 3, 7000, 'fifo']]);
  assert.deepEqual(
    r.items.map((i) => i.cogs_cents),
    [4500, 10000, 10000, 10500, 17500, 6000, 6000, 27000, 7000, 14000],
  );
  assert.equal(itemFor(r, 4).cost_source, 'fifo');
  assert.equal(batchFor(r, 'B3').qty_remaining, 4);
  assert.deepEqual(r.issues, []);
  assertLedgerBalances(r);
});

test('acceptance 4: a sellable refund restores the original batch, a non-sellable one does not', () => {
  const base = { batches, bom, orderItems };
  const before = replayFifo(base);
  assert.equal(batchFor(before, 'B1').qty_remaining, 0);

  // Order 3 (2 tables from B1 at $50) returns 1 table.
  const refund = { id: 'R1', order_item_id: 3, qty: 1, sellable: true, restocked_at: '2026-04-01T10:00:00Z' };

  const sellable = replayFifo({ ...base, refunds: [refund] });
  assert.equal(batchFor(sellable, 'B1').qty_remaining, 1);
  assert.equal(batchFor(sellable, 'B1').status, 'active');
  assert.equal(batchFor(sellable, 'B3').status, 'queued');
  assert.deepEqual(
    sellable.consumptions.filter((c) => c.source_type === 'refund').map((c) => [c.batch_id, c.qty, c.unit_cost_cents]),
    [['B1', -1, 5000]],
  );
  assert.equal(itemFor(sellable, 3).cogs_cents, 10000);
  assert.equal(itemFor(sellable, 3).restocked_cents, 5000);
  assertLedgerBalances(sellable);

  // Not sellable, not decided yet, or sellable but not yet back on the shelf: nothing moves.
  for (const variant of [
    { ...refund, sellable: false },
    { ...refund, sellable: null },
    { ...refund, restocked_at: null },
  ]) {
    const r = replayFifo({ ...base, refunds: [variant] });
    assert.deepEqual(r, before);
  }
});

test('a restocked box is sold again at its original cost', () => {
  // Order 2 returns a table on Jan 15 (before B1 runs out). The later orders
  // each shift by one box: order 4 on Feb 1 finds 2 boxes in B1, not 1.
  const refund = { id: 'R1', order_item_id: 2, qty: 1, sellable: true, restocked_at: '2026-01-15T10:00:00Z' };
  const r = replayFifo({ batches, bom, orderItems, refunds: [refund] });
  assert.deepEqual(rowsFor(r, 4), [['B1', 2, 5000, 'fifo']]);
  assert.equal(itemFor(r, 4).cost_source, 'fifo');
  assert.deepEqual(r.issues, []);
  assertLedgerBalances(r);
});

test('a product uses every box in its bill of materials', () => {
  // A table = 1 TOP + 2 LEGS. Selling 3 tables needs 3 TOP and 6 LEGS.
  // TOP:  3 x $50                      = $150
  // LEGS: 4 from L1 at $10, 2 from L2 at $12 = $40 + $24 = $64
  const r = replayFifo({
    bom: [
      { product_id: 'TABLE', box_type_id: TOP, qty: 1 },
      { product_id: 'TABLE', box_type_id: LEGS, qty: 2 },
    ],
    batches: [
      { id: 'T1', box_type_id: TOP, method: 'fifo', received_at: '2026-01-01', qty_in: 10, unit_cost_cents: 5000 },
      { id: 'L1', box_type_id: LEGS, method: 'fifo', received_at: '2026-01-01', qty_in: 4, unit_cost_cents: 1000 },
      { id: 'L2', box_type_id: LEGS, method: 'fifo', received_at: '2026-01-05', qty_in: 10, unit_cost_cents: 1200 },
    ],
    orderItems: [{ id: 1, order_id: 1, ordered_at: '2026-02-01T00:00:00Z', product_id: 'TABLE', qty: 3 }],
  });
  assert.equal(itemFor(r, 1).cogs_cents, 15000 + 6400);
  assert.equal(batchFor(r, 'T1').qty_remaining, 7);
  assert.equal(batchFor(r, 'L1').qty_remaining, 0);
  assert.equal(batchFor(r, 'L2').qty_remaining, 8);
  assertLedgerBalances(r);
});

test('FBA orders use the FBA pool, filled by transfers at the original cost', () => {
  const fbaBatches = [
    { id: 'B1', box_type_id: TOP, method: 'fifo', received_at: '2026-01-10', qty_in: 3, unit_cost_cents: 5000 },
    { id: 'B2', box_type_id: TOP, method: 'fifo', received_at: '2026-02-10', qty_in: 5, unit_cost_cents: 6000 },
  ];
  const r = replayFifo({
    bom,
    batches: fbaBatches,
    // Feb 12: send 4 boxes to FBA. Oldest first: 3 from B1, 1 from B2.
    adjustments: [{ id: 'A1', date: '2026-02-12T00:00:00Z', box_type_id: TOP, qty: 4, reason: 'fba_transfer' }],
    orderItems: [
      // FBA order for 4: 3 at $50 + 1 at $60 = $210.
      { id: 1, order_id: 1, ordered_at: '2026-02-20T00:00:00Z', product_id: 'TABLE', qty: 4, fulfillment: 'FBA' },
      // FBM order for 2 takes from what is left in the warehouse: B2 at $60.
      { id: 2, order_id: 2, ordered_at: '2026-02-21T00:00:00Z', product_id: 'TABLE', qty: 2, fulfillment: 'FBM' },
      // FBA order with nothing left at FBA: flagged, never taken from the warehouse.
      { id: 3, order_id: 3, ordered_at: '2026-02-22T00:00:00Z', product_id: 'TABLE', qty: 1, fulfillment: 'FBA' },
    ],
  });
  assert.deepEqual(rowsFor(r, 1), [['B1:fba', 3, 5000, 'fifo'], ['B2:fba', 1, 6000, 'fifo']]);
  assert.equal(itemFor(r, 1).cogs_cents, 21000);
  assert.deepEqual(rowsFor(r, 2), [['B2', 2, 6000, 'fifo']]);
  assert.equal(itemFor(r, 3).cost_source, 'missing');
  assert.equal(batchFor(r, 'B1').qty_remaining, 0);
  assert.equal(batchFor(r, 'B2').qty_remaining, 2);
  assert.equal(batchFor(r, 'B1:fba').pool, 'fba');
  assert.equal(batchFor(r, 'B1:fba').received_at, '2026-01-10');
  assert.equal(batchFor(r, 'B1:fba').parent_batch_id, 'B1');
  // A transfer moves stock, it is not a cost.
  assert.ok(r.consumptions.filter((c) => c.reason === 'transfer').every((c) => c.source_type === 'adjustment'));
  assert.deepEqual(r.issues.map((i) => [i.type, i.source_id]), [['missing_cost', 3]]);
  assertLedgerBalances(r);
});

test('stock adjustments: damaged boxes use FIFO, found boxes join at the active cost', () => {
  const r = replayFifo({
    bom,
    batches: [
      { id: 'B1', box_type_id: TOP, method: 'fifo', received_at: '2026-01-10', qty_in: 3, unit_cost_cents: 5000 },
      { id: 'B2', box_type_id: TOP, method: 'fifo', received_at: '2026-02-10', qty_in: 5, unit_cost_cents: 6000 },
    ],
    adjustments: [
      // 2 damaged on Jan 15: taken from B1 (left 1).
      { id: 'A1', date: '2026-01-15T00:00:00Z', box_type_id: TOP, qty: -2, reason: 'damaged' },
      // Count finds 1 extra on Feb 15: new batch at B1's cost (B1 is the batch in use).
      { id: 'A2', date: '2026-02-15T00:00:00Z', box_type_id: TOP, qty: 1, reason: 'count_correction' },
    ],
    // Mar 1, 7 tables: B1 1, B2 5, then the found box. 50 + 300 + 50 = $400.
    orderItems: [{ id: 1, order_id: 1, ordered_at: '2026-03-01T00:00:00Z', product_id: 'TABLE', qty: 7 }],
  });
  assert.deepEqual(
    r.consumptions.filter((c) => c.reason === 'adjustment').map((c) => [c.batch_id, c.qty, c.unit_cost_cents]),
    [['B1', 2, 5000]],
  );
  assert.equal(batchFor(r, 'adj:A2').unit_cost_cents, 5000);
  assert.equal(batchFor(r, 'adj:A2').origin, 'count_correction');
  assert.deepEqual(rowsFor(r, 1), [['B1', 1, 5000, 'fifo'], ['B2', 5, 6000, 'fifo'], ['adj:A2', 1, 5000, 'fifo']]);
  assert.equal(itemFor(r, 1).cogs_cents, 40000);
  assert.deepEqual(r.issues, []);
  assertLedgerBalances(r);
});

test('by-period history uses the cost in force on the order date', () => {
  const r = replayFifo({
    bom,
    batches: [
      { id: 'H1', box_type_id: TOP, method: 'by_period', received_at: null, unit_cost_cents: 4000 },
      { id: 'H2', box_type_id: TOP, method: 'by_period', received_at: '2025-07-01', unit_cost_cents: 4500 },
    ],
    orderItems: [
      { id: 1, order_id: 1, ordered_at: '2025-03-01T00:00:00Z', product_id: 'TABLE', qty: 1 },
      { id: 2, order_id: 2, ordered_at: '2025-09-01T00:00:00Z', product_id: 'TABLE', qty: 2 },
    ],
  });
  assert.deepEqual(rowsFor(r, 1), [['H1', 1, 4000, 'by_period']]);
  assert.deepEqual(rowsFor(r, 2), [['H2', 2, 4500, 'by_period']]);
  assert.deepEqual(r.issues, []);
});

test('canceled orders use nothing; unmapped items and missing BOMs are reported, not guessed', () => {
  const r = replayFifo({
    bom,
    batches,
    orderItems: [
      { id: 1, order_id: 1, ordered_at: '2026-01-12T00:00:00Z', product_id: 'TABLE', qty: 2, canceled: true },
      { id: 2, order_id: 2, ordered_at: '2026-01-13T00:00:00Z', product_id: null, qty: 1 },
      { id: 3, order_id: 3, ordered_at: '2026-01-14T00:00:00Z', product_id: 'UNKNOWN', qty: 1 },
    ],
  });
  assert.deepEqual(r.consumptions, []);
  assert.equal(batchFor(r, 'B1').qty_remaining, 5);
  assert.deepEqual(r.issues.map((i) => [i.type, i.source_id]), [['unmapped', 2], ['no_bom', 3]]);
  assert.equal(itemFor(r, 2).cost_source, null);
});
