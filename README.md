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
| GET/POST | `/api/stores` | List / create stores; MoMo creation provisions a Paystack subaccount |
| GET | `/api/stores/slug/:slug` | Public storefront lookup |
| POST | `/api/stores/slug/:slug/pay/init` | Provider preflight + hosted Paystack MoMo checkout or manual bank-payment request |
| POST | `/api/stores/slug/:slug/pay/submit` | Customer submits a manual bank transaction ID |
| GET | `/api/stores/slug/:slug/pay/status/:reference` | Customer-safe payment/order status |
| POST | `/api/payments/:reference/confirm` | Store owner confirms receipt, debits wallet, fulfils order |
| POST | `/api/payments/:reference/reject` | Store owner rejects an unmatched payment claim |
| POST | `/api/wallet/paystack/init` and `/verify` | Verified agent wallet top-up |
| POST | `/api/paystack/webhook` | Signed Paystack event receiver |
| GET/PATCH/DELETE | `/api/stores/:id` | Read / update / delete a store |
| GET/POST/PATCH/DELETE | `/api/bundles` | Data bundles (Pricing / Buy Data) |
| GET/POST/PATCH/DELETE | `/api/agents` | Agents |
| GET | `/api/orders` · `/api/customers` · `/api/transactions` | Tenant-scoped lists |
| POST | `/api/orders/:ref/cancel` | Cancel an owned pending order before provider dispatch |
| GET | `/api/admin/provider` | Fulfilment provider state + upstream wallet balance |
| GET | `/api/admin/provider/catalog` | What Netpluse sells us, at our cost price |
| POST | `/api/admin/provider/sync-costs` | Pull Netpluse prices into `Bundle.cost` (`{"dryRun":true}` to preview) |
| POST | `/api/admin/provider/sync-orders` | Settle orders still awaiting delivery |

All responses are `{ "data": ... }`. Errors are `{ "error": "..." }`.

## Storefront payment model

Paystack is used for agent wallet top-ups and hosted storefront Mobile Money
checkout. When an agent configures a MoMo store, they provide the provider,
registered name, and number. The backend fetches Paystack's current Ghana MoMo
settlement institutions and creates (or later updates) a zero-platform-share
Paystack subaccount. The `ACCT_...` code and Paystack-resolved settlement state
are stored privately; agents never enter a subaccount code themselves.

1. A customer selects a bundle and enters only the phone number that should
   receive the data. A receipt email is optional.
2. The customer is redirected to Paystack's hosted checkout, where Paystack
   collects their Mobile Money provider and payment number. Paystack routes the
   collection to the store's subaccount and sends the trusted phone prompt. The
   storefront never asks for or stores the customer's MoMo PIN.
3. A signed `charge.success` webhook (with status polling as fallback) verifies
   the payment.
4. Verification atomically debits the platform/wholesale price from the agent's
   prepaid wallet, records the sale, and dispatches the bundle to Netpluse.
5. If delivery fails, the exact wallet debit and platform commission are reversed
   and the Paystack refund workflow is started.

Bank-transfer stores retain the manual fallback: the customer receives the bank
instructions, submits the provider transaction ID, and the authenticated store
owner confirms receipt before the same wallet-debit and fulfilment transaction.

The agent's selling-price margin is **not** credited to the platform wallet;
the agent already received it as part of the customer's direct payment. Payment
records retain `verificationMode` and `settlementModel`, keeping gateway-verified
MoMo and agent-confirmed bank transfers on the same accounting model.

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

Also configure Paystack's webhook URL as
`https://YOUR-API-HOST/api/paystack/webhook`; successful payments are then
settled even when the customer's browser never returns from checkout. Financial
writes use MongoDB transactions: Atlas supports them, while a local MongoDB must
run as a replica set.

Deploy this service **before** the frontend: `NEXT_PUBLIC_API_URL` is inlined
into the Next.js bundle at build time, so that build needs this URL to exist.

## Fulfilment (Netpluse)

Bundles are delivered by **Netpluse** (<https://netpluse.shop/api/v1>). Every paid
order — agent Buy Data or a confirmed direct storefront payment —
goes through `lib/fulfilment.js`, which POSTs it to the provider, records the
provider reference on the order, and **reverses the money** (wallet, platform
margin, store and customer counters) if delivery fails. Orders come back as
`processing` and are settled by a background poller, so an order is only
`completed` once the data has actually gone out.

Three things worth knowing:

- **The configured key is live.** `NETPLUSE_FULFILMENT=auto` sends upstream only
  in production-like environments. Use `off` while testing and switch to `on`
  only when real delivery and provider-wallet spending are intended.
- **With fulfilment off, purchases are refused, not faked.** Marking an unsent
  order "delivered" still debits the buyer's wallet and books store revenue, so
  a local session pointed at the production `MONGODB_URI` quietly charges real
  agents for data nobody received. Orders are therefore failed and refunded
  instead. `NETPLUSE_ALLOW_SIMULATED_SALES=true` restores the old behaviour for a
  disposable database only.
- **Package capacity is exact.** Purchases send the exact `capacity` string
  returned by `/packages`, and the app's order reference is Netpluse's
  idempotency key so safe retries cannot create a duplicate order.

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
├── lib/netpluseApi.js Netpluse client (catalog, purchase, status, balance)
├── lib/fulfilment.js  Delivery, refunds on failure, status poller
├── middleware/error.js 404 + error handler
├── models/            Mongoose schemas
└── seed.js            Sample-data seeder
```
