// FIFO consumption through the bill of materials (spec section 5.2).
//
// Stock is held as batches of boxes (one batch per receipt line). A sale of a
// product uses up the boxes in its bill of materials, always from the oldest
// batch that had already arrived when the order was placed. The cost of the
// sale is the cost of the boxes it used.
//
// This file is pure: no database, no network. It takes everything that
// happened (batches, orders, refunds, adjustments) and replays it from the
// start in date order. Same input, same output, every time. That is what
// makes a back-dated receipt or a corrected order safe: change the input and
// replay.
//
// Rules
//   Sale          Take from FIFO batches of the right pool ('fba' for FBA
//                 orders, 'warehouse' for everything else), oldest first,
//                 only batches received on or before the order date.
//   No stock      If no FIFO batch covers the sale, cost it from the latest
//                 "by period" cost on or before the order date and flag it:
//                   by_period          no FIFO batch had arrived yet (history)
//                   fallback_oversold  FIFO batches exist but ran out
//                   missing            no cost is known at all (cost 0, listed
//                                      in issues so it is never silent)
//   Refund        Only when marked sellable AND restocked: the boxes go back
//                 to the batches they came from, at the same cost.
//   Adjustment    Negative: uses FIFO like a sale. Positive: adds a new batch
//                 at the cost of the batch currently in use.
//   FBA transfer  Moves boxes from the oldest warehouse batches into mirror
//                 batches in the 'fba' pool, same cost and receipt date.
//
// Ledger rule that always holds for every FIFO batch:
//   qty_remaining = qty_in - sum(qty of its consumptions)

const RANK = { transfer: 0, adjustment: 1, sale: 2, restock: 3 };
const SOURCE_SEVERITY = { fifo: 0, by_period: 1, fallback_oversold: 2, missing: 3 };

function toMs(value, what) {
  if (value == null) throw new Error(`${what}: date is missing`);
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${what}: "${value}" is not a valid date`);
  return ms;
}

function compareIds(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

function worse(a, b) {
  return SOURCE_SEVERITY[a] >= SOURCE_SEVERITY[b] ? a : b;
}

/**
 * Replay everything and return the FIFO ledger.
 *
 * batches:     [{ id, box_type_id, method: 'fifo' | 'by_period', pool?, received_at, qty_in, unit_cost_cents }]
 *              by_period batches have no quantity; received_at null means "since forever".
 * bom:         [{ product_id, box_type_id, qty }]
 * orderItems:  [{ id, order_id, ordered_at, product_id, qty, fulfillment?, canceled? }]
 * refunds:     [{ id, order_item_id, qty, sellable, restocked_at }]
 * adjustments: [{ id, date, box_type_id, qty, reason, pool? }]
 *              reason 'fba_transfer': qty boxes move from warehouse to FBA.
 *
 * Returns { consumptions, batches, items, issues }.
 */
export function replayFifo({ batches = [], bom = [], orderItems = [], refunds = [], adjustments = [] }) {
  const consumptions = [];
  const issues = [];

  // --- Batches -------------------------------------------------------------
  const fifo = []; // working copies of FIFO batches, including derived ones
  const byPeriod = new Map(); // box_type_id -> by_period batches, oldest first
  const fifoById = new Map();
  let seq = 0;

  function addFifoBatch(b) {
    const batch = { ...b, seq: seq++ };
    fifo.push(batch);
    fifoById.set(batch.id, batch);
    return batch;
  }

  for (const b of batches) {
    if (b.method === 'by_period') {
      const entry = {
        id: b.id,
        box_type_id: b.box_type_id,
        method: 'by_period',
        ms: b.received_at == null ? -Infinity : toMs(b.received_at, `Batch ${b.id}`),
        received_at: b.received_at ?? null,
        unit_cost_cents: b.unit_cost_cents,
      };
      if (!byPeriod.has(b.box_type_id)) byPeriod.set(b.box_type_id, []);
      byPeriod.get(b.box_type_id).push(entry);
    } else {
      if (!Number.isInteger(b.qty_in) || b.qty_in < 0) {
        throw new Error(`Batch ${b.id}: quantity must be a whole number, zero or more`);
      }
      addFifoBatch({
        id: b.id,
        box_type_id: b.box_type_id,
        method: 'fifo',
        pool: b.pool ?? 'warehouse',
        origin: b.origin ?? 'receipt',
        parent_batch_id: b.parent_batch_id ?? null,
        received_at: b.received_at,
        ms: toMs(b.received_at, `Batch ${b.id}`),
        qty_in: b.qty_in,
        qty_remaining: b.qty_in,
        unit_cost_cents: b.unit_cost_cents,
      });
    }
  }
  for (const list of byPeriod.values()) list.sort((a, b) => a.ms - b.ms || compareIds(a.id, b.id));

  // FIFO batches of a box type and pool that have arrived by time ms, oldest first.
  function queue(boxTypeId, pool, ms) {
    return fifo
      .filter((b) => b.box_type_id === boxTypeId && b.pool === pool && b.ms <= ms)
      .sort((a, b) => a.ms - b.ms || a.seq - b.seq);
  }

  function byPeriodAt(boxTypeId, ms) {
    const list = byPeriod.get(boxTypeId) ?? [];
    let found = null;
    for (const b of list) if (b.ms <= ms) found = b;
    return found;
  }

  function anyFifoArrived(boxTypeId, ms) {
    return fifo.some((b) => b.box_type_id === boxTypeId && b.ms <= ms);
  }

  // Take boxes oldest first. Returns what was taken and how many are still missing.
  function take(boxTypeId, pool, qty, ms) {
    const taken = [];
    let left = qty;
    for (const batch of queue(boxTypeId, pool, ms)) {
      if (left === 0) break;
      if (batch.qty_remaining <= 0) continue;
      const q = Math.min(left, batch.qty_remaining);
      batch.qty_remaining -= q;
      left -= q;
      taken.push({ batch, qty: q });
    }
    return { taken, short: left };
  }

  // Cost a quantity that no FIFO batch could cover.
  function fallback(boxTypeId, ms) {
    const bp = byPeriodAt(boxTypeId, ms);
    if (!bp) return { batch_id: null, unit_cost_cents: 0, cost_source: 'missing' };
    return {
      batch_id: bp.id,
      unit_cost_cents: bp.unit_cost_cents,
      cost_source: anyFifoArrived(boxTypeId, ms) ? 'fallback_oversold' : 'by_period',
    };
  }

  // Use up boxes for a sale or a negative adjustment. Returns the rows written.
  function consume({ sourceType, sourceId, reason, boxTypeId, pool, qty, ms, at }) {
    const rows = [];
    const { taken, short } = take(boxTypeId, pool, qty, ms);
    for (const t of taken) {
      rows.push({
        source_type: sourceType,
        source_id: sourceId,
        reason,
        box_type_id: boxTypeId,
        batch_id: t.batch.id,
        qty: t.qty,
        unit_cost_cents: t.batch.unit_cost_cents,
        cost_source: 'fifo',
        consumed_at: at,
      });
    }
    if (short > 0) {
      const fb = fallback(boxTypeId, ms);
      rows.push({
        source_type: sourceType,
        source_id: sourceId,
        reason,
        box_type_id: boxTypeId,
        batch_id: fb.batch_id,
        qty: short,
        unit_cost_cents: fb.unit_cost_cents,
        cost_source: fb.cost_source,
        consumed_at: at,
      });
      if (fb.cost_source !== 'by_period') {
        issues.push({
          type: fb.cost_source === 'missing' ? 'missing_cost' : 'oversold',
          source_type: sourceType,
          source_id: sourceId,
          box_type_id: boxTypeId,
          pool,
          qty: short,
          at,
        });
      }
    }
    consumptions.push(...rows);
    return rows;
  }

  // --- Bill of materials ----------------------------------------------------
  const bomByProduct = new Map();
  for (const line of bom) {
    if (!bomByProduct.has(line.product_id)) bomByProduct.set(line.product_id, []);
    bomByProduct.get(line.product_id).push(line);
  }
  for (const list of bomByProduct.values()) list.sort((a, b) => compareIds(a.box_type_id, b.box_type_id));

  // --- Timeline -------------------------------------------------------------
  const events = [];
  const itemById = new Map();
  for (const item of orderItems) {
    itemById.set(item.id, item);
    if (item.canceled) continue;
    events.push({
      kind: 'sale',
      ms: toMs(item.ordered_at, `Order item ${item.id}`),
      at: item.ordered_at,
      k1: item.order_id ?? item.id,
      k2: item.id,
      item,
    });
  }
  for (const refund of refunds) {
    if (refund.sellable !== true && refund.sellable !== 1) continue;
    if (refund.restocked_at == null) continue;
    events.push({
      kind: 'restock',
      ms: toMs(refund.restocked_at, `Refund ${refund.id}`),
      at: refund.restocked_at,
      k1: refund.id,
      k2: refund.id,
      refund,
    });
  }
  for (const adj of adjustments) {
    if (!Number.isInteger(adj.qty)) throw new Error(`Adjustment ${adj.id}: quantity must be a whole number`);
    if (adj.qty === 0) continue;
    events.push({
      kind: adj.reason === 'fba_transfer' ? 'transfer' : 'adjustment',
      ms: toMs(adj.date, `Adjustment ${adj.id}`),
      at: adj.date,
      k1: adj.id,
      k2: adj.id,
      adj,
    });
  }
  events.sort(
    (a, b) => a.ms - b.ms || RANK[a.kind] - RANK[b.kind] || compareIds(a.k1, b.k1) || compareIds(a.k2, b.k2),
  );

  // --- Replay ---------------------------------------------------------------
  const items = new Map(); // order_item_id -> result
  const itemLedger = new Map(); // order_item_id -> sale rows with what is still out

  for (const ev of events) {
    if (ev.kind === 'sale') {
      const { item } = ev;
      const result = { order_item_id: item.id, cogs_cents: 0, restocked_cents: 0, cost_source: null };
      items.set(item.id, result);
      if (item.product_id == null) {
        issues.push({ type: 'unmapped', source_type: 'order_item', source_id: item.id, at: ev.at });
        continue;
      }
      const lines = bomByProduct.get(item.product_id);
      if (!lines || lines.length === 0) {
        issues.push({
          type: 'no_bom',
          source_type: 'order_item',
          source_id: item.id,
          product_id: item.product_id,
          at: ev.at,
        });
        continue;
      }
      const pool = item.fulfillment === 'FBA' ? 'fba' : 'warehouse';
      const ledger = [];
      let source = 'fifo';
      for (const line of lines) {
        const rows = consume({
          sourceType: 'order_item',
          sourceId: item.id,
          reason: 'sale',
          boxTypeId: line.box_type_id,
          pool,
          qty: item.qty * line.qty,
          ms: ev.ms,
          at: ev.at,
        });
        for (const row of rows) {
          result.cogs_cents += row.qty * row.unit_cost_cents;
          source = worse(source, row.cost_source);
          ledger.push({ row, out: row.qty });
        }
      }
      result.cost_source = source;
      itemLedger.set(item.id, ledger);
    } else if (ev.kind === 'restock') {
      const { refund } = ev;
      const item = itemById.get(refund.order_item_id);
      const ledger = itemLedger.get(refund.order_item_id);
      const lines = item ? bomByProduct.get(item.product_id) : null;
      if (!item || !ledger || !lines) {
        issues.push({ type: 'restock_without_sale', source_type: 'refund', source_id: refund.id, at: ev.at });
        continue;
      }
      const result = items.get(item.id);
      for (const line of lines) {
        let left = refund.qty * line.qty;
        // Give back to the batches most recently taken from first.
        for (let i = ledger.length - 1; i >= 0 && left > 0; i--) {
          const entry = ledger[i];
          if (entry.row.box_type_id !== line.box_type_id || entry.out === 0) continue;
          const q = Math.min(left, entry.out);
          entry.out -= q;
          left -= q;
          const batch = entry.row.cost_source === 'fifo' ? fifoById.get(entry.row.batch_id) : null;
          if (batch) batch.qty_remaining += q;
          consumptions.push({
            source_type: 'refund',
            source_id: refund.id,
            reason: 'restock',
            box_type_id: line.box_type_id,
            batch_id: entry.row.batch_id,
            qty: -q,
            unit_cost_cents: entry.row.unit_cost_cents,
            cost_source: entry.row.cost_source,
            consumed_at: ev.at,
          });
          result.restocked_cents += q * entry.row.unit_cost_cents;
        }
        if (left > 0) {
          issues.push({
            type: 'restock_exceeds_sale',
            source_type: 'refund',
            source_id: refund.id,
            box_type_id: line.box_type_id,
            qty: left,
            at: ev.at,
          });
        }
      }
    } else if (ev.kind === 'transfer') {
      const { adj } = ev;
      if (adj.qty < 0) throw new Error(`Adjustment ${adj.id}: an FBA transfer quantity must be positive`);
      const { taken, short } = take(adj.box_type_id, 'warehouse', adj.qty, ev.ms);
      for (const t of taken) {
        const mirrorId = `${t.batch.id}:fba`;
        let mirror = fifoById.get(mirrorId);
        if (!mirror) {
          mirror = addFifoBatch({
            id: mirrorId,
            box_type_id: t.batch.box_type_id,
            method: 'fifo',
            pool: 'fba',
            origin: 'fba_transfer',
            parent_batch_id: t.batch.id,
            received_at: t.batch.received_at,
            ms: t.batch.ms,
            qty_in: 0,
            qty_remaining: 0,
            unit_cost_cents: t.batch.unit_cost_cents,
          });
        }
        mirror.qty_in += t.qty;
        mirror.qty_remaining += t.qty;
        consumptions.push({
          source_type: 'adjustment',
          source_id: adj.id,
          reason: 'transfer',
          box_type_id: adj.box_type_id,
          batch_id: t.batch.id,
          to_batch_id: mirrorId,
          qty: t.qty,
          unit_cost_cents: t.batch.unit_cost_cents,
          cost_source: 'fifo',
          consumed_at: ev.at,
        });
      }
      if (short > 0) {
        issues.push({
          type: 'transfer_short',
          source_type: 'adjustment',
          source_id: adj.id,
          box_type_id: adj.box_type_id,
          qty: short,
          at: ev.at,
        });
      }
    } else {
      const { adj } = ev;
      const pool = adj.pool ?? 'warehouse';
      if (adj.qty < 0) {
        consume({
          sourceType: 'adjustment',
          sourceId: adj.id,
          reason: 'adjustment',
          boxTypeId: adj.box_type_id,
          pool,
          qty: -adj.qty,
          ms: ev.ms,
          at: ev.at,
        });
      } else {
        // Found extra boxes: add them at the cost of the batch now in use.
        const q = queue(adj.box_type_id, pool, ev.ms);
        const active = q.find((b) => b.qty_remaining > 0) ?? q[q.length - 1];
        const reference = active ?? byPeriodAt(adj.box_type_id, ev.ms);
        if (!reference) {
          issues.push({
            type: 'missing_cost',
            source_type: 'adjustment',
            source_id: adj.id,
            box_type_id: adj.box_type_id,
            pool,
            qty: adj.qty,
            at: ev.at,
          });
        }
        addFifoBatch({
          id: `adj:${adj.id}`,
          box_type_id: adj.box_type_id,
          method: 'fifo',
          pool,
          origin: 'count_correction',
          parent_batch_id: null,
          adjustment_id: adj.id,
          received_at: adj.date,
          ms: ev.ms,
          qty_in: adj.qty,
          qty_remaining: adj.qty,
          unit_cost_cents: reference ? reference.unit_cost_cents : 0,
        });
      }
    }
  }

  // --- Batch status: depleted at zero, active = oldest with stock, else queued
  const activeSeen = new Set();
  const outBatches = [];
  for (const b of [...fifo].sort((a, b2) => a.ms - b2.ms || a.seq - b2.seq)) {
    let status;
    if (b.qty_remaining <= 0) status = 'depleted';
    else {
      const key = `${b.box_type_id}|${b.pool}`;
      status = activeSeen.has(key) ? 'queued' : 'active';
      activeSeen.add(key);
    }
    const { ms, seq: _seq, ...rest } = b;
    outBatches.push({ ...rest, status });
  }
  for (const list of byPeriod.values()) {
    for (const b of list) {
      const { ms, ...rest } = b;
      outBatches.push({ ...rest, pool: null, qty_in: null, qty_remaining: null, status: null });
    }
  }

  return { consumptions, batches: outBatches, items: [...items.values()], issues };
}
