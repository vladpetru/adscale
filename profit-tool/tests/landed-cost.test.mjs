// Landed cost tests (spec 5.1, acceptance test 2).
// Every expected number below is worked out by hand in the comments.

import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, computeLandedCosts } from '../functions/_lib/landed-cost.js';

test('acceptance 2: two box types, ocean freight by volume, duties by value', () => {
  // Line A: 100 boxes x 0.10 CBM = 10 CBM, factory value $4,000
  // Line B: 200 boxes x 0.15 CBM = 30 CBM, factory value $8,000
  // Ocean freight $6,000 by volume (10 : 30)   -> A $1,500   B $4,500
  // Duties        $1,200 by value  (4000 : 8000) -> A $400     B $800
  // A: (4,000 + 1,500 + 400) / 100 = $59.00 per box
  // B: (8,000 + 4,500 + 800) / 200 = $66.50 per box
  const [a, b] = computeLandedCosts({
    lines: [
      { id: 1, box_type_id: 'A', qty: 100, declared_value_cents: 400000, cbm: 0.1 },
      { id: 2, box_type_id: 'B', qty: 200, declared_value_cents: 800000, cbm: 0.15 },
    ],
    costs: [
      { kind: 'ocean_freight', amount_cents: 600000, allocation: 'by_volume' },
      { kind: 'duties', amount_cents: 120000, allocation: 'by_value' },
    ],
  });

  assert.equal(a.unit_cost_cents, 5900);
  assert.equal(b.unit_cost_cents, 6650);
  assert.deepEqual(a.breakdown_total_cents, {
    factory: 400000, ocean_freight: 150000, duties: 40000, inland_freight: 0, other: 0,
  });
  assert.deepEqual(b.breakdown_total_cents, {
    factory: 800000, ocean_freight: 450000, duties: 80000, inland_freight: 0, other: 0,
  });
  assert.deepEqual(a.breakdown_unit_cents, {
    factory: 4000, ocean_freight: 1500, duties: 400, inland_freight: 0, other: 0,
  });
  assert.equal(a.total_cents + b.total_cents, 400000 + 800000 + 600000 + 120000);
  assert.equal(a.rounding_cents, 0);
  assert.equal(b.rounding_cents, 0);
});

test('default allocation: freight by volume, duties by value, other by units', () => {
  // Same receipt, no allocation given, plus inland $800 (by volume: 200 / 600)
  // and other $300 (by units 100 : 200 -> 100 / 200).
  const [a, b] = computeLandedCosts({
    lines: [
      { box_type_id: 'A', qty: 100, declared_value_cents: 400000, cbm: 0.1 },
      { box_type_id: 'B', qty: 200, declared_value_cents: 800000, cbm: 0.15 },
    ],
    costs: [
      { kind: 'ocean_freight', amount_cents: 600000 },
      { kind: 'duties', amount_cents: 120000 },
      { kind: 'inland_freight', amount_cents: 80000 },
      { kind: 'other', amount_cents: 30000 },
    ],
  });
  assert.equal(a.breakdown_total_cents.inland_freight, 20000);
  assert.equal(b.breakdown_total_cents.inland_freight, 60000);
  assert.equal(a.breakdown_total_cents.other, 10000);
  assert.equal(b.breakdown_total_cents.other, 20000);
  // A: (400000 + 150000 + 40000 + 20000 + 10000) / 100 = 6200
  // B: (800000 + 450000 + 80000 + 60000 + 20000) / 200 = 7050
  assert.equal(a.unit_cost_cents, 6200);
  assert.equal(b.unit_cost_cents, 7050);
});

test('direct cost goes only to the named box type', () => {
  const [a, b] = computeLandedCosts({
    lines: [
      { box_type_id: 'A', qty: 10, declared_value_cents: 10000, cbm: 0.1 },
      { box_type_id: 'B', qty: 10, declared_value_cents: 10000, cbm: 0.1 },
    ],
    costs: [{ kind: 'other', amount_cents: 5000, allocation: 'direct', box_type_id: 'B' }],
  });
  assert.equal(a.unit_cost_cents, 1000);
  assert.equal(b.unit_cost_cents, 1500);
});

test('cbm_override replaces the box type volume', () => {
  // A normally 0.1 CBM but this shipment 0.3: volumes 30 : 10.
  const [a, b] = computeLandedCosts({
    lines: [
      { box_type_id: 'A', qty: 100, declared_value_cents: 0, cbm: 0.1, cbm_override: 0.3 },
      { box_type_id: 'B', qty: 100, declared_value_cents: 0, cbm: 0.1 },
    ],
    costs: [{ kind: 'ocean_freight', amount_cents: 40000 }],
  });
  assert.equal(a.breakdown_total_cents.ocean_freight, 30000);
  assert.equal(b.breakdown_total_cents.ocean_freight, 10000);
});

test('shares always add up to the cost element, to the cent', () => {
  // $100.00 over three equal lines: 3334 + 3333 + 3333.
  assert.deepEqual(allocate(10000, [1, 1, 1]), [3334, 3333, 3333]);
  assert.deepEqual(allocate(-10000, [1, 1, 1]), [-3334, -3333, -3333]);
  assert.deepEqual(allocate(1, [1, 3]), [0, 1]);

  const results = computeLandedCosts({
    lines: [
      { box_type_id: 'A', qty: 7, declared_value_cents: 12345, cbm: 0.137 },
      { box_type_id: 'B', qty: 13, declared_value_cents: 54321, cbm: 0.291 },
      { box_type_id: 'C', qty: 29, declared_value_cents: 99999, cbm: 0.049 },
    ],
    costs: [
      { kind: 'ocean_freight', amount_cents: 777777 },
      { kind: 'duties', amount_cents: 33333 },
      { kind: 'other', amount_cents: 101 },
    ],
  });
  const sum = (kind) => results.reduce((s, r) => s + r.breakdown_total_cents[kind], 0);
  assert.equal(sum('ocean_freight'), 777777);
  assert.equal(sum('duties'), 33333);
  assert.equal(sum('other'), 101);
  assert.equal(sum('factory'), 12345 + 54321 + 99999);
});

test('unit cost rounds to cents and reports the rounding', () => {
  // $100.00 / 3 boxes = $33.3333 -> 3333 cents, 3 x 3333 = 9999, rounding -1.
  const [a] = computeLandedCosts({
    lines: [{ box_type_id: 'A', qty: 3, declared_value_cents: 10000, cbm: 0.1 }],
  });
  assert.equal(a.unit_cost_cents, 3333);
  assert.equal(a.rounding_cents, -1);
});

test('per-unit override wins over the computed cost', () => {
  const [a] = computeLandedCosts({
    lines: [{ box_type_id: 'A', qty: 10, declared_value_cents: 10000, cbm: 0.1, unit_cost_override_cents: 1234 }],
  });
  assert.equal(a.unit_cost_cents, 1234);
  assert.equal(a.overridden, true);
  assert.equal(a.total_cents, 10000);
});

test('refuses loudly instead of guessing', () => {
  const line = { box_type_id: 'A', qty: 10, declared_value_cents: 10000 };
  assert.throws(
    () => computeLandedCosts({ lines: [line], costs: [{ kind: 'ocean_freight', amount_cents: 100 }] }),
    /no volume/,
  );
  assert.throws(
    () => computeLandedCosts({
      lines: [{ box_type_id: 'A', qty: 10, declared_value_cents: 0, cbm: 0.1 }],
      costs: [{ kind: 'duties', amount_cents: 100 }],
    }),
    /declared value/,
  );
  assert.throws(
    () => computeLandedCosts({
      lines: [{ ...line, cbm: 0.1 }],
      costs: [{ kind: 'other', amount_cents: 100, allocation: 'direct', box_type_id: 'Z' }],
    }),
    /not on this receipt/,
  );
  assert.throws(() => computeLandedCosts({ lines: [{ ...line, qty: 0 }] }), /quantity/);
  assert.throws(() => computeLandedCosts({ lines: [] }), /at least one line/);
});
