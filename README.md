# BuyDataNow API — Node/Express + MongoDB

The backend for BuyDataNow. **Node.js + Express + Mongoose (MongoDB Atlas).**
The Next.js frontend lives in the parent folder and will call this API.

## 1. Get a MongoDB (Atlas)

1. Create a free account at <https://www.mongodb.com/atlas> and a free **M0** cluster.
2. **Database Access** → add a database user (username + password).
3. **Network Access** → add IP `0.0.0.0/0` (allow from anywhere) for local dev.
4. **Database → Connect → Drivers** → copy the connection string. It looks like:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
   Put your password in and add the db name `datapulse` before the `?`:
   `…mongodb.net/datapulse?retryWrites=true&w=majority`

   The database is still called `datapulse` — it predates the rename to
   BuyDataNow and holds the live agents, orders and wallet balances. The name
   is independent of the product name, so leave it alone: pointing
   `MONGODB_URI` at a `buydatanow` database gives you an empty one, not a
   renamed one. Renaming it for real means migrating the data first.

## 2. Configure & install

```bash
cd backend
cp .env.example .env        # then paste your MONGODB_URI into .env
npm install
```

## 3. Seed sample data (optional)

```bash
npm run seed
```

Loads agents, stores, bundles, customers, orders, and transactions.

## 4. Run

```bash
npm run dev     # auto-reload (nodemon)
# or
npm start
```

API runs on `http://localhost:5000`. Check `http://localhost:5000/api/health`.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | Status + DB connection state |
| GET/POST | `/api/stores` | List / create stores |
| GET | `/api/stores/slug/:slug` | Public storefront lookup |
| GET/PATCH/DELETE | `/api/stores/:id` | Read / update / delete a store |
| GET/POST/PATCH/DELETE | `/api/bundles` | Data bundles (Pricing / Buy Data) |
| GET/POST/PATCH/DELETE | `/api/agents` | Agents |
| GET | `/api/orders` · `/api/customers` · `/api/transactions` | Read-only lists |
| GET | `/api/admin/provider` | Fulfilment provider state + upstream wallet balance |
| GET | `/api/admin/provider/catalog` | What Rema sells us, at our cost price |
| POST | `/api/admin/provider/sync-costs` | Pull Rema's prices into `Bundle.cost` (`{"dryRun":true}` to preview) |
| POST | `/api/admin/provider/sync-orders` | Settle orders still awaiting delivery |

All responses are `{ "data": ... }`. Errors are `{ "error": "..." }`.

## Deploying

The API is a long-lived process — it holds a background poller that settles
orders the provider accepted as "pending". That rules out serverless hosts
(Vercel included): the process is torn down between requests, so those orders
would sit in `processing` until something else woke it. Use a normal container
or VM host.

**Render** — `render.yaml` in the repo root is a blueprint: Render → New →
Blueprint → pick the repo. It provisions the service and prompts for each
secret (they're declared `sync: false`, so no values live in the repo).

**Anywhere else** — `Dockerfile` builds a self-contained production image:

```bash
docker build -t buydatanow-api backend
docker run --rm -p 5000:5000 --env-file backend/.env buydatanow-api
```

Whichever you use, two settings decide whether it works:

- `CLIENT_URL` must be the real frontend origin. It drives CORS **and** the
  Paystack return URL, so a stale value sends paying customers to the wrong host.
- Atlas → Network Access must allow the host's outbound IPs.

Deploy this service **before** the frontend: `NEXT_PUBLIC_API_URL` is inlined
into the Next.js bundle at build time, so that build needs this URL to exist.

## Fulfilment (Rema Data)

Bundles are delivered by **Rema Data** (<https://remadata.com/api>). Every paid
order — agent Buy Data, storefront wallet sale, storefront Paystack checkout —
goes through `lib/fulfilment.js`, which POSTs it to the provider, records the
provider reference on the order, and **reverses the money** (wallet, platform
margin, store and customer counters) if delivery fails. Orders come back as
`processing` and are settled by a background poller, so an order is only
`completed` once the data has actually gone out.

Two things worth knowing:

- **There is no sandbox.** Rema issues `rd_live_` keys only, and both keys share
  one wallet. `REMA_FULFILMENT=auto` (the default) is what keeps local
  development free — it only sends orders upstream in production. See
  `.env.example`.
- **With fulfilment off, purchases are refused, not faked.** Marking an unsent
  order "delivered" still debits the buyer's wallet and books store revenue, so
  a local session pointed at the production `MONGODB_URI` quietly charges real
  agents for data nobody received. Orders are therefore failed and refunded
  instead. `REMA_ALLOW_SIMULATED_SALES=true` restores the old behaviour for a
  disposable database only.
- **`volumeInMB` is not derivable.** MTN counts in 1024s, Telecel/AirtelTigo in
  1000s, and a few Telecel rows carry GB values in that field. The client reads
  the size from the bundle *name* and always sends Rema's own `volumeInMB` back.

Keep `Bundle.cost` in step with what you're charged via
`POST /api/admin/provider/sync-costs` — the platform-margin figures on the admin
dashboard are only as accurate as that number.

## Structure

```
backend/src/
├── server.js          Express app, middleware, startup
├── routes.js          REST routes (CRUD factory)
├── config/db.js       Mongoose connection
├── lib/crud.js        Reusable CRUD handlers
├── lib/remaApi.js     Rema Data client (catalog, purchase, status, balance)
├── lib/fulfilment.js  Delivery, refunds on failure, status poller
├── middleware/error.js 404 + error handler
├── models/            Mongoose schemas
└── seed.js            Sample-data seeder
```
