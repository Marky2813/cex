# CEX - Centralized Exchange Backend

A backend for a centralized crypto exchange, built from scratch. Supports limit and market orders, a real-time matching engine, order book depth, and fill tracking.

Built with Bun, Express, TypeScript, Prisma, and PostgreSQL.

---

## What it does

Users can sign up, deposit funds, and place buy/sell orders on financial instruments like SOL or BTC. When a buy and sell order match on price, the engine fills them automatically, moves balances, and records the trade.

The order book lives in memory for fast matching. The database is the source of truth for everything else.

---

## How the matching engine works

When a limit buy order comes in at price X:
- The engine checks the sell side of the order book for asks at price ≤ X
- It matches against the cheapest available seller first (min-heap by price)
- At each price level, orders are matched FIFO - whoever listed first gets matched first
- If the buy order isn't fully filled, it rests in the buy side of the order book waiting for a future seller
- Every match creates a fill record and updates balances atomically in a single DB transaction

Market orders skip the price check entirely - they match against whatever is available and cancel the remainder if the book runs dry.

---

## Why in-memory order book?

Matching needs to be fast - potentially thousands of orders per second. Running SQL queries for every match isn't viable. The in-memory order book is a pair of heaps (min for asks, max for bids) with a Map for O(1) price level lookup. The DB is only written to after matching is done, in a single atomic transaction.

On server restart, the order book is rebuilt from all pending/partial limit orders in the DB.

---

## Schema

- **User** - credentials + USD balance (total, locked)
- **Instrument** - tradeable asset with a symbol (SOL, BTC etc.)
- **Order** - every order ever placed, with status (Pending, Partial, Completed, Cancelled)
- **Fill** - every matched trade, linking a buy order and sell order with qty and price
- **UserBalance** - per-user instrument holdings (total, locked)

---

## API

```
POST /signup
POST /login
POST /deposit           - add USD or instrument balance
POST /order             - place a limit or market order
GET  /orderbook/:symbol - aggregated depth (price levels + total qty)
```

---

## Stack

- **Runtime** - Bun
- **Framework** - Express
- **Language** - TypeScript
- **ORM** - Prisma with PostgreSQL
- **In-memory** - custom heap-based order book using `heap-js`
- **Auth** - JWT

---

## Running locally

```bash
bun install
bunx prisma migrate dev
bunx prisma generate
bun run index.ts
```

Set `DATABASE_URL` and `JWT_SECRET` in a `.env` file before running.

---

## What's next

- WebSocket for real-time order book updates
- Sell side market orders
- Refactor matching logic into a shared `matchOrder` function
- Rate limiting on order placement
