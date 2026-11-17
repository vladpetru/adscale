# OUTTANS Profit

One place to see profit, costs and stock for Amazon and Shopify. It replaces the two Sellerboard subscriptions.

This folder is a self-contained app. It does not share code with the rest of this repository, so it can be moved to its own repository as is.

## Status

Phase 1, first step: the data core.

| Piece | State |
|---|---|
| Database schema (29 tables) | Done, tested |
| Landed cost per box (container costs shared by volume, value or units) | Done, tested |
| FIFO cost engine (oldest stock is sold first, through the bill of materials) | Done, tested |
| Cloudflare setup, Shopify sync, Amazon ingest, screens | Not started |

## What is where

```
migrations/      the database, as numbered files applied in order
functions/_lib/  the calculations (no database or network inside them)
  landed-cost.js   what one box really cost once freight and duties are added
  fifo.js          which batch each sale used, and so what it cost
public/          the screens (placeholder for now)
tests/           checks with numbers worked out by hand
wrangler.toml    Cloudflare settings
```

## Running the tests

Needs Node 22.13 or newer. Nothing to install.

```bash
npm test
```

## How the numbers work, in plain words

**Landed cost.** A container arrives with several kinds of boxes. Each kind has a factory price. The shared bills are split between them: ocean and inland freight by how much space each kind took (cubic meters), duties by factory value, anything else by box count. Factory price plus its share, divided by the number of boxes, is what one box cost to land.

**FIFO.** Every container line becomes a batch with that cost. When a product sells, the boxes it is made of are taken from the oldest batch that had arrived by the order date. The cost of the sale is the cost of those exact boxes. Amazon and Shopify draw from the same stock. Boxes sent to FBA keep their cost and are tracked separately.

**When the records fall short.** If a sale finds no batch (more sold than was ever recorded as received), it is costed from the older "by period" cost and flagged, so it shows on the Health screen. Nothing is guessed silently.

**Refunds.** A returned item goes back into the batch it came from, at the same cost, only when it is marked sellable and restocked. Otherwise the cost stays as a loss.

Everything is replayed from the start in date order on each recompute, so entering a receipt late, or fixing an old order, gives the same result as if it had been entered on time.
