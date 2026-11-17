// Landed cost per box at receipt time (spec section 5.1).
//
// A receipt (one container) has lines (box type, quantity, factory value) and
// cost elements (ocean freight, duties, inland freight, other). Each cost
// element is shared out over the lines, then:
//
//   unit landed cost = (factory value of the line + its shares) / quantity
//
// All money is integer cents. Shares are split with exact integer math so the
// shares of one cost element always add up to the element, to the cent.
//
// This file is pure: no database, no network. It only computes.

export const COST_KINDS = ['factory', 'ocean_freight', 'duties', 'inland_freight', 'other'];

// How each kind is shared out when the user does not choose (spec 5.1 step 4).
export const DEFAULT_ALLOCATION = {
  factory: 'by_value',
  ocean_freight: 'by_volume',
  duties: 'by_value',
  inland_freight: 'by_volume',
  other: 'by_units',
};

const ALLOCATIONS = ['by_volume', 'by_value', 'by_units', 'direct'];

// Volume is measured in millionths of a cubic meter so it can be an integer.
const CBM_SCALE = 1_000_000;

function isInt(n) {
  return Number.isInteger(n);
}

/**
 * Split an integer amount over integer weights, exactly.
 * Each share is rounded down, then the leftover cents go one by one to the
 * lines with the largest remainders (ties: earlier line first).
 */
export function allocate(amountCents, weights) {
  if (!isInt(amountCents)) throw new Error(`Amount must be whole cents, got ${amountCents}`);
  const w = weights.map((x) => BigInt(x));
  if (w.some((x) => x < 0n)) throw new Error('Allocation weights cannot be negative');
  const total = w.reduce((a, b) => a + b, 0n);
  if (total === 0n) throw new Error('Cannot allocate: all weights are zero');

  const negative = amountCents < 0;
  const amount = BigInt(Math.abs(amountCents));
  const shares = w.map((x) => (amount * x) / total);
  const remainders = w.map((x, i) => ({ i, r: (amount * x) % total }));
  let left = amount - shares.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (let k = 0; left > 0n; k++, left--) shares[remainders[k].i] += 1n;

  return shares.map((s) => (negative ? -Number(s) : Number(s)));
}

/**
 * Compute landed costs for one receipt.
 *
 * lines: [{ id, box_type_id, qty, declared_value_cents, cbm, cbm_override?, unit_cost_override_cents? }]
 *   cbm is cubic meters per box. declared_value_cents is the factory total for the line.
 * costs: [{ kind, amount_cents, allocation?, box_type_id? }]
 *   box_type_id is only used when allocation is 'direct'.
 *
 * Returns one result per line, in the same order:
 *   { line_id, box_type_id, qty, total_cents, unit_cost_cents,
 *     breakdown_total_cents: { factory, ocean_freight, duties, inland_freight, other },
 *     breakdown_unit_cents:  { ...same keys, per box, rounded to cents },
 *     rounding_cents, overridden }
 *
 * rounding_cents = unit_cost_cents x qty - total_cents: the few cents gained
 * or lost because a unit cost has to be a whole number of cents.
 */
export function computeLandedCosts({ lines, costs = [] }) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('A receipt needs at least one line');
  }

  const prepared = lines.map((line, index) => {
    const label = `Line ${index + 1} (box type ${line.box_type_id})`;
    if (!isInt(line.qty) || line.qty <= 0) throw new Error(`${label}: quantity must be a whole number above zero`);
    const declared = line.declared_value_cents ?? 0;
    if (!isInt(declared) || declared < 0) throw new Error(`${label}: declared value must be whole cents, zero or more`);
    const cbm = line.cbm_override ?? line.cbm;
    return { line, label, declared, cbm };
  });

  const breakdowns = prepared.map((p) => ({
    factory: p.declared,
    ocean_freight: 0,
    duties: 0,
    inland_freight: 0,
    other: 0,
  }));

  costs.forEach((cost, index) => {
    const label = `Cost element ${index + 1} (${cost.kind})`;
    if (!COST_KINDS.includes(cost.kind)) throw new Error(`${label}: unknown kind`);
    if (!isInt(cost.amount_cents)) throw new Error(`${label}: amount must be whole cents`);
    const allocation = cost.allocation ?? DEFAULT_ALLOCATION[cost.kind];
    if (!ALLOCATIONS.includes(allocation)) throw new Error(`${label}: unknown allocation "${allocation}"`);

    let weights;
    if (allocation === 'by_volume') {
      weights = prepared.map((p) => {
        if (typeof p.cbm !== 'number' || !(p.cbm > 0)) {
          throw new Error(`${label}: ${p.label} has no volume (CBM), so the cost cannot be shared by volume`);
        }
        return BigInt(Math.round(p.cbm * CBM_SCALE)) * BigInt(p.line.qty);
      });
    } else if (allocation === 'by_value') {
      weights = prepared.map((p) => BigInt(p.declared));
      if (weights.every((x) => x === 0n)) {
        throw new Error(`${label}: no line has a declared value, so the cost cannot be shared by value`);
      }
    } else if (allocation === 'by_units') {
      weights = prepared.map((p) => BigInt(p.line.qty));
    } else {
      if (cost.box_type_id == null) throw new Error(`${label}: a direct cost needs a box type`);
      weights = prepared.map((p) => (p.line.box_type_id === cost.box_type_id ? BigInt(p.line.qty) : 0n));
      if (weights.every((x) => x === 0n)) {
        throw new Error(`${label}: box type ${cost.box_type_id} is not on this receipt`);
      }
    }

    const shares = allocate(cost.amount_cents, weights);
    shares.forEach((share, i) => {
      breakdowns[i][cost.kind] += share;
    });
  });

  return prepared.map((p, i) => {
    const qty = p.line.qty;
    const breakdown = breakdowns[i];
    const total = COST_KINDS.reduce((sum, kind) => sum + breakdown[kind], 0);
    const override = p.line.unit_cost_override_cents;
    const overridden = override != null;
    if (overridden && (!isInt(override) || override < 0)) {
      throw new Error(`${p.label}: unit cost override must be whole cents, zero or more`);
    }
    const unit = overridden ? override : Math.round(total / qty);
    const unitBreakdown = {};
    for (const kind of COST_KINDS) unitBreakdown[kind] = Math.round(breakdown[kind] / qty);
    return {
      line_id: p.line.id ?? null,
      box_type_id: p.line.box_type_id,
      qty,
      total_cents: total,
      unit_cost_cents: unit,
      breakdown_total_cents: breakdown,
      breakdown_unit_cents: unitBreakdown,
      rounding_cents: unit * qty - total,
      overridden,
    };
  });
}
