import { Router } from "express";

import {
  Store,
  Agent,
  Bundle,
  Order,
  Customer,
  Transaction,
  AgentPrice,
  Report,
  FeatureRequest,
} from "./models/index.js";
import { crud } from "./lib/crud.js";
import { crudScoped } from "./lib/crudScoped.js";
import { requireAuth } from "./lib/auth.js";
import { recordLog } from "./lib/audit.js";
import { paystack, paystackConfigured, clientOrigin } from "./lib/paystackApi.js";
import { fulfilOrder } from "./lib/fulfilment.js";
import { validPhone, normalizePhone } from "./lib/remaApi.js";
import { getSettings, publicSettings } from "./lib/settings.js";

const router = Router();

/* Public platform settings — brand & contact info shown on the site/storefront. */
router.get("/settings", async (req, res, next) => {
  try {
    const s = await getSettings();
    res.json({ data: publicSettings(s) });
  } catch (err) {
    next(err);
  }
});

const money = (n) => Math.round(n * 100) / 100;

/** Human-friendly tracking reference (no easily-confused chars). */
function makeReference() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `DP-${out}`;
}

/** Higher priority for money/delivery issues than general feedback. */
function priorityFor(category = "") {
  const c = category.toLowerCase();
  if (c.includes("payment") || c.includes("not received") || c.includes("no order")) return "High";
  if (c.includes("wallet") || c.includes("top-up")) return "Medium";
  return "Low";
}

/* =====================================================================
 * PUBLIC routes (no auth) — storefronts and the shared bundle catalog.
 * Must be registered BEFORE `requireAuth` below.
 * ===================================================================== */

/* Public storefront lookup by slug — any store, for `/store/[slug]`. */
router.get("/stores/slug/:slug", async (req, res, next) => {
  try {
    const doc = await Store.findOne({ slug: req.params.slug.toLowerCase() }).lean();
    if (!doc) return res.status(404).json({ error: "Store not found" });
    res.json({ data: doc });
  } catch (err) {
    next(err);
  }
});

/* Bundles are a shared platform catalog — public to read (Buy Data / store fronts).
 * Writes are superadmin-only and live under /api/admin/bundles. */
const bundle = crud(Bundle);
router.get("/bundles", bundle.list);
router.get("/bundles/:id", bundle.get);

/*
 * Support-center report intake (public) — a customer/agent submits an issue.
 * Persists the ticket and returns its tracking reference. The reporter isn't a
 * signed-in user, so this is intentionally unauthenticated (add rate limiting
 * in production).
 */
router.post("/reports", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const category = String(req.body.category || "").trim();
    const description = String(req.body.description || "").trim();
    if (name.length < 2) return res.status(400).json({ error: "Please enter your name." });
    if (!category) return res.status(400).json({ error: "Choose an issue type." });
    if (description.length < 10) {
      return res.status(400).json({ error: "Tell us what happened (at least 10 characters)." });
    }

    const reference = String(req.body.reference || "").trim() || makeReference();
    const report = await Report.create({
      reference,
      name,
      phone: String(req.body.phone || "").trim(),
      email: String(req.body.email || "").trim(),
      orderRef: String(req.body.orderRef || "").trim(),
      category,
      description,
      priority: priorityFor(category),
    });

    recordLog("info", `New support ticket · ${category} · ${reference}`, "support");
    res.status(201).json({ data: { reference: report.reference } });
  } catch (err) {
    next(err);
  }
});

/* Feature-request intake (public) — an agent submits an idea from the portal. */
router.post("/feature-requests", async (req, res, next) => {
  try {
    const title = String(req.body.title || "").trim();
    if (title.length < 3) return res.status(400).json({ error: "Give your idea a short title." });

    const doc = await FeatureRequest.create({
      title,
      category: String(req.body.category || "Other").trim(),
      description: String(req.body.description || "").trim(),
      by: String(req.body.by || "Anonymous").trim() || "Anonymous",
    });
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
});

/*
 * Public storefront catalog — the platform's active bundles priced with the
 * store OWNER's selling prices (their AgentPrice rows; platform price where
 * they haven't set one). This is what customers see on `/store/[slug]`.
 */
router.get("/stores/slug/:slug/bundles", async (req, res, next) => {
  try {
    const store = await Store.findOne({ slug: req.params.slug.toLowerCase() }).lean();
    if (!store) return res.status(404).json({ error: "Store not found" });

    const [bundles, prices] = await Promise.all([
      Bundle.find({ active: true }).lean(),
      store.agent ? AgentPrice.find({ agent: store.agent }).lean() : [],
    ]);
    const own = new Map(prices.map((p) => [`${p.carrier}-${p.gb}`, p.price]));

    const data = bundles.map((b) => ({
      _id: b._id,
      carrier: b.carrier,
      gb: b.gb,
      size: b.size,
      price: own.get(`${b.carrier}-${b.gb}`) ?? b.price,
      active: true,
    }));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/*
 * Public storefront purchase — a customer buys a bundle on `/store/[slug]`.
 * The order is fulfilled from the STORE OWNER's wallet: it deducts the bundle
 * price, records an order + ledger entry for that agent, and bumps store stats.
 * Fails if the owner's wallet can't cover it (they need to Add Fund).
 *
 * NOTE: public + unauthenticated by design (the customer isn't a user). In
 * production this must sit behind the customer's own payment (they pay first,
 * then we fulfil) and/or rate limiting — otherwise it can drain a wallet.
 */
if (false) router.post("/stores/slug/:slug/buy", async (req, res, next) => {
  try {
    const store = await Store.findOne({ slug: req.params.slug.toLowerCase() });
    if (!store) return res.status(404).json({ error: "Store not found" });
    if (store.status === "paused") {
      return res.status(409).json({ error: "This store isn't accepting orders right now." });
    }

    const network = String(req.body.network || "").trim();
    const gb = Number(req.body.gb) || 0;
    const phone = normalizePhone(req.body.phone || "");
    // The recipient line is what the provider actually loads the data onto, so
    // it's required here rather than optional.
    if (!validPhone(phone)) {
      return res.status(400).json({ error: "Enter the phone number that should receive the data." });
    }

    const bundleDoc = await Bundle.findOne({ carrier: network, gb });
    if (!bundleDoc) return res.status(400).json({ error: "That bundle isn't available." });

    const agent = store.agent ? await Agent.findById(store.agent) : null;
    if (!agent) return res.status(409).json({ error: "This store isn't ready to take orders yet." });

    // Platform price = what the owner pays the platform to fulfil; base cost =
    // the platform's own cost; their AgentPrice = what the customer pays them.
    const platformPrice = money(bundleDoc.price);
    const cost = money(bundleDoc.cost ?? 0);
    const ownPrice = await AgentPrice.findOne({ agent: agent._id, carrier: network, gb }).lean();
    const amount = money(ownPrice?.price ?? bundleDoc.price);
    const platformMargin = money(Math.max(0, platformPrice - cost));
    // The store owner's margin on the sale (their selling price − platform cost).
    const earning = money(Math.max(0, amount - platformPrice));

    if (platformPrice > agent.wallet) {
      return res.status(402).json({ error: "This store can't fulfil this order right now." });
    }

    // Charge the PLATFORM price (cost of goods) to the owner's wallet and add back
    // ONLY their margin — the full customer payment is never credited to the wallet.
    // e.g. wallet 538.90, sale 5.10, platform 4.70 → 538.90 − 4.70 + 0.40 = 534.60.
    agent.wallet = money(agent.wallet - platformPrice + earning);
    await agent.save();

    // The app owner (superadmin) earns only the platform margin.
    const superadmin = await Agent.findOne({ role: "superadmin" }).sort({ createdAt: 1 });
    if (superadmin && platformMargin > 0) {
      superadmin.wallet = money(superadmin.wallet + platformMargin);
      await superadmin.save();
    }

    // Upsert the customer (keyed by phone, scoped to the store owner) so the
    // owner's Customers list reflects who's buying.
    const existing = await Customer.findOne({ agent: agent._id, phone }).lean();
    const newCustomer = !existing;
    await Customer.updateOne(
      { agent: agent._id, phone },
      { $setOnInsert: { name: phone }, $set: { store: store.name }, $inc: { orders: 1, spent: amount } },
      { upsert: true }
    );

    // Record the sale on the store at the customer-facing price. (Money lives on
    // the agent's wallet — see above — so we don't draw down store.balance here;
    // this matches the Paystack flow and avoids a negative store balance.)
    store.orders = (store.orders || 0) + 1;
    store.revenue = money((store.revenue || 0) + amount);
    if (newCustomer) store.customers = (store.customers || 0) + 1;
    await store.save();

    // Create the order + ledger entries (scoped to the owning agent).
    const order = await Order.create({
      agent: agent._id,
      ref: `DP-${Date.now().toString().slice(-7)}`,
      store: store.name,
      customer: phone,
      phone,
      carrier: network,
      bundle: `${gb} GB`,
      gb,
      amount,
      earning,
      platformEarning: platformMargin,
      status: "pending",
    });
    await Transaction.create({
      agentId: agent._id,
      agent: agent.name,
      store: store.name,
      type: "purchase",
      description: `Platform cost · ${network} ${gb}GB · ${store.name}${phone ? ` · ${phone}` : ""}`,
      amount: -platformPrice, // the platform price, charged to the wallet
    });
    if (earning > 0) {
      // The margin credited back to the wallet, so the ledger reconciles with the balance.
      await Transaction.create({
        agentId: agent._id,
        agent: agent.name,
        store: store.name,
        type: "commission",
        description: `Sale margin · ${network} ${gb}GB · ${store.name}`,
        amount: earning,
      });
    }
    if (superadmin && platformMargin > 0) {
      await Transaction.create({
        agentId: superadmin._id,
        agent: superadmin.name,
        store: store.name,
        type: "commission",
        description: `Platform margin · ${store.name} · ${network} ${gb}GB`,
        amount: platformMargin,
      });
    }

    // Deliver it. A provider rejection reverses everything above (wallet, the
    // app owner's margin, store and customer counters) and marks the order
    // refunded — so report the settled status rather than assuming success.
    const fulfilment = await fulfilOrder(order, {
      agent: agent._id,
      agentName: agent.name,
      credit: money(platformPrice - earning),
      platformClawback: platformMargin,
      storeId: store._id,
    });
    if (order.status === "failed" || order.status === "refunded") {
      return res.status(502).json({
        error: "We couldn't deliver that bundle. Nothing has been charged — please try again.",
      });
    }

    res.status(201).json({
      data: { ok: true, ref: order.ref, network, gb, amount, status: fulfilment.status },
    });
  } catch (err) {
    next(err);
  }
});

/*
 * Storefront checkout via Paystack (public). The customer pays the store owner's
 * own selling price online; on success the order is fulfilled, the customer is
 * recorded, and the owner's margin is credited to their wallet. Two steps:
 *   1) /pay/init   — start the payment, redirect the customer to Paystack
 *   2) /pay/verify — on return, confirm the payment and fulfil the order
 */
if (false) router.post("/stores/slug/:slug/pay/init", async (req, res, next) => {
  try {
    if (!paystackConfigured()) {
      return res.status(500).json({ error: "Online payments aren't configured right now." });
    }
    const store = await Store.findOne({ slug: req.params.slug.toLowerCase() });
    if (!store) return res.status(404).json({ error: "Store not found" });
    if (store.status === "paused") {
      return res.status(409).json({ error: "This store isn't accepting orders right now." });
    }
    if (!store.agent) return res.status(409).json({ error: "This store isn't ready to take orders yet." });

    const network = String(req.body.network || "").trim();
    const gb = Number(req.body.gb) || 0;
    const phone = String(req.body.phone || "").trim();
    if (phone.replace(/\D/g, "").length < 9) {
      return res.status(400).json({ error: "Enter the phone number that should receive the data." });
    }

    const bundleDoc = await Bundle.findOne({ carrier: network, gb });
    if (!bundleDoc) return res.status(400).json({ error: "That bundle isn't available." });

    // The customer pays the store owner's own selling price.
    const ownPrice = await AgentPrice.findOne({ agent: store.agent, carrier: network, gb }).lean();
    const amount = money(ownPrice?.price ?? bundleDoc.price);

    const reference = `DP-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    // Paystack requires a valid email for the receipt: the customer's if given,
    // otherwise the store owner's (they're the merchant).
    const owner = await Agent.findById(store.agent).lean();
    const email = String(req.body.email || "").trim() || owner?.email || "orders@buydatanow.store";

    const { ok, json } = await paystack("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email,
        amount: Math.round(amount * 100), // subunit (pesewas)
        reference,
        callback_url: `${clientOrigin()}/store/${store.slug}`,
        metadata: { purpose: "storefront_order", storeSlug: store.slug, agentId: String(store.agent), network, gb, phone },
      }),
    });
    if (!ok || !json?.status) {
      return res.status(502).json({ error: json?.message || "Could not start the payment." });
    }
    res.json({ data: { authorization_url: json.data.authorization_url, reference: json.data.reference, amount } });
  } catch (err) {
    next(err);
  }
});

if (false) router.post("/stores/slug/:slug/pay/verify", async (req, res, next) => {
  try {
    if (!paystackConfigured()) {
      return res.status(500).json({ error: "Online payments aren't configured right now." });
    }
    const reference = String(req.body.reference || "").trim();
    if (!reference) return res.status(400).json({ error: "Missing payment reference." });

    // Idempotency: the unique Transaction.reference means a payment is only ever
    // fulfilled once, even if the customer refreshes the return page.
    const already = await Transaction.findOne({ reference }).lean();
    if (already) {
      const order = await Order.findOne({ ref: reference }).lean();
      return res.json({ data: { status: "success", order, alreadyFulfilled: true } });
    }

    const { ok, json } = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (!ok || !json?.status) {
      return res.status(502).json({ error: json?.message || "Could not verify the payment." });
    }
    const data = json.data;
    if (data.status !== "success") {
      return res.json({ data: { status: data.status } }); // abandoned / failed — nothing to fulfil
    }

    const meta = data.metadata || {};
    if (meta.purpose !== "storefront_order" || meta.storeSlug !== req.params.slug.toLowerCase()) {
      return res.status(400).json({ error: "This payment isn't for this store." });
    }

    const store = await Store.findOne({ slug: meta.storeSlug });
    const agent = store?.agent ? await Agent.findById(store.agent) : null;
    if (!store || !agent) return res.status(409).json({ error: "This store is no longer available." });

    const network = String(meta.network || "");
    const gb = Number(meta.gb) || 0;
    const phone = String(meta.phone || "");
    const bundleDoc = await Bundle.findOne({ carrier: network, gb });
    const price = money(bundleDoc?.price ?? 0); // platform price (store owner's cost of goods)
    const cost = money(bundleDoc?.cost ?? 0); // platform's base cost
    const amount = money((data.amount || 0) / 100); // what Paystack confirmed (store owner's price)
    const agentMargin = money(Math.max(0, amount - price)); // the store owner earns this
    const platformMargin = money(Math.max(0, price - cost)); // the app owner earns this

    const order = await Order.create({
      agent: agent._id,
      ref: reference,
      store: store.name,
      customer: phone,
      phone,
      carrier: network,
      bundle: `${gb} GB`,
      gb,
      amount,
      earning: agentMargin,
      platformEarning: platformMargin,
      status: "pending",
    });

    let newCustomer = false;
    if (phone) {
      const existingCust = await Customer.findOne({ agent: agent._id, phone }).lean();
      newCustomer = !existingCust;
      await Customer.updateOne(
        { agent: agent._id, phone },
        { $setOnInsert: { name: phone }, $set: { store: store.name }, $inc: { orders: 1, spent: amount } },
        { upsert: true }
      );
    }

    // Store owner's wallet: deduct the platform price (their cost of goods) and
    // add ONLY their margin — the full customer payment is not credited.
    agent.wallet = money(agent.wallet - price + agentMargin);
    await agent.save();

    const superadmin = await Agent.findOne({ role: "superadmin" }).sort({ createdAt: 1 });
    if (superadmin && platformMargin > 0) {
      superadmin.wallet = money(superadmin.wallet + platformMargin);
      await superadmin.save();
    }

    store.orders = (store.orders || 0) + 1;
    store.revenue = money((store.revenue || 0) + amount);
    if (newCustomer) store.customers = (store.customers || 0) + 1;
    await store.save();

    // Ledger: the owner's platform cost (−price, carries the Paystack reference
    // for idempotency), their sale margin (+margin), and the app owner's margin.
    await Transaction.create({
      agentId: agent._id,
      agent: agent.name,
      store: store.name,
      type: "fee",
      description: `Platform cost · ${network} ${gb}GB · ${phone}`,
      amount: -price,
      reference,
    });
    if (agentMargin > 0) {
      await Transaction.create({
        agentId: agent._id,
        agent: agent.name,
        store: store.name,
        type: "commission",
        description: `Sale margin · ${network} ${gb}GB`,
        amount: agentMargin,
        reference: `${reference}-margin`,
      });
    }
    if (superadmin && platformMargin > 0) {
      await Transaction.create({
        agentId: superadmin._id,
        agent: superadmin.name,
        store: store.name,
        type: "commission",
        description: `Platform margin · ${store.name} · ${network} ${gb}GB`,
        amount: platformMargin,
        reference: `${reference}-platform`,
      });
    }

    recordLog("info", `Store sale · ${store.name} · ${network} ${gb}GB · ₵${amount} (platform +₵${platformMargin})`, "storefront");

    // Deliver it. The customer has already paid Paystack, so a provider failure
    // reverses the wallet/margin movements above and leaves the order refunded
    // for support to settle with the customer — it never silently reads as sold.
    await fulfilOrder(order, {
      agent: agent._id,
      agentName: agent.name,
      credit: money(price - agentMargin),
      platformClawback: platformMargin,
      storeId: store._id,
    });

    res.status(201).json({ data: { status: "success", order } });
  } catch (err) {
    next(err);
  }
});

/* =====================================================================
 * AUTH-SCOPED routes — everything below belongs to the signed-in agent.
 * ===================================================================== */
router.use(requireAuth);

/* Stores — each agent sees and manages only their own. */
const store = crudScoped(Store);
router.get("/stores", store.list);
router.post("/stores", store.create);
router.get("/stores/:id", store.get);
router.patch("/stores/:id", store.update);
router.delete("/stores/:id", store.remove);

/*
 * Agent selling prices — the agent's own price per platform bundle, shown on
 * their storefront. Must be at least the platform price (no selling at a loss).
 */
router.get("/my-prices", async (req, res, next) => {
  try {
    const docs = await AgentPrice.find({ agent: req.agent._id }).lean();
    res.json({ data: docs });
  } catch (err) {
    next(err);
  }
});

router.put("/my-prices", async (req, res, next) => {
  try {
    const carrier = String(req.body.carrier || "").trim();
    const gb = Number(req.body.gb);
    const price = Math.round(Number(req.body.price) * 100) / 100;
    if (!carrier || !gb || gb <= 0) return res.status(400).json({ error: "Invalid bundle." });
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: "Enter a valid price." });
    }

    const bundleDoc = await Bundle.findOne({ carrier, gb });
    if (!bundleDoc) return res.status(404).json({ error: "That bundle doesn't exist." });
    if (price < bundleDoc.price) {
      return res.status(400).json({
        error: `Your price can't be below the platform price (${bundleDoc.price.toFixed(2)}).`,
      });
    }

    const doc = await AgentPrice.findOneAndUpdate(
      { agent: req.agent._id, carrier, gb },
      { $set: { price } },
      { new: true, upsert: true }
    ).lean();
    res.json({ data: doc });
  } catch (err) {
    next(err);
  }
});

/*
 * The agent's own Buy Data catalog — active platform bundles priced with the
 * agent's OWN selling prices (their AgentPrice rows), falling back to the
 * platform price where they haven't set one. Same shape as /bundles so
 * BundlesProvider can consume it directly.
 */
router.get("/my-bundles", async (req, res, next) => {
  try {
    const [bundles, prices] = await Promise.all([
      Bundle.find({ active: true }).lean(),
      AgentPrice.find({ agent: req.agent._id }).lean(),
    ]);
    const own = new Map(prices.map((p) => [`${p.carrier}-${p.gb}`, p.price]));
    const data = bundles.map((b) => ({
      _id: b._id,
      carrier: b.carrier,
      gb: b.gb,
      size: b.size,
      price: own.get(`${b.carrier}-${b.gb}`) ?? b.price,
      active: true,
    }));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/* Reset one bundle back to the platform price. */
router.delete("/my-prices/:carrier/:gb", async (req, res, next) => {
  try {
    await AgentPrice.deleteOne({
      agent: req.agent._id,
      carrier: req.params.carrier,
      gb: Number(req.params.gb),
    });
    res.json({ data: { ok: true } });
  } catch (err) {
    next(err);
  }
});

/*
 * Weekly leaderboard — every agent ranked by this calendar week's sales (the
 * week resets Monday 00:00). Cross-tenant by design: it's a competitive board,
 * so it exposes only aggregate name/sales/orders/stores. The caller's own row is
 * flagged `isYou`. Superadmin accounts are excluded.
 */
router.get("/leaderboard", async (req, res, next) => {
  try {
    const weekStart = new Date();
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // back to Monday

    const [salesAgg, storeAgg, agents] = await Promise.all([
      Order.aggregate([
        { $match: { createdAt: { $gte: weekStart } } },
        { $group: { _id: "$agent", sales: { $sum: "$amount" }, orders: { $sum: 1 } } },
      ]),
      Store.aggregate([{ $group: { _id: "$agent", count: { $sum: 1 } } }]),
      Agent.find({ role: { $ne: "superadmin" } }, "name").lean(),
    ]);

    const salesBy = new Map(salesAgg.map((s) => [String(s._id), s]));
    const storesBy = new Map(storeAgg.map((s) => [String(s._id), s.count]));
    const me = String(req.agent._id);

    const rows = agents
      .map((a) => {
        const s = salesBy.get(String(a._id));
        return {
          name: a.name,
          sales: money(s?.sales || 0),
          orders: s?.orders || 0,
          stores: storesBy.get(String(a._id)) || 0,
          isYou: String(a._id) === me,
        };
      })
      .sort((a, b) => b.sales - a.sales || b.orders - a.orders || a.name.localeCompare(b.name))
      .map((r, i) => ({ rank: i + 1, ...r }));

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

/*
 * Order earnings — the signed-in agent's margin (Order.earning) on delivered
 * orders, aggregated for the Earnings page and the Withdraw "earnings" card.
 */
router.get("/earnings", async (req, res, next) => {
  try {
    const agentId = req.agent._id;
    const dayMs = 24 * 60 * 60 * 1000;
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const weekStart = new Date(startToday.getTime() - 6 * dayMs);
    const prevWeekStart = new Date(weekStart.getTime() - 7 * dayMs);
    const done = { agent: agentId, status: "completed" };

    const [totalsAgg, weekAgg, prevWeekAgg, dayAgg, storeAgg, recent] = await Promise.all([
      Order.aggregate([
        { $match: done },
        { $group: { _id: null, earnings: { $sum: "$earning" }, orders: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { ...done, createdAt: { $gte: weekStart } } },
        { $group: { _id: null, earnings: { $sum: "$earning" } } },
      ]),
      Order.aggregate([
        { $match: { ...done, createdAt: { $gte: prevWeekStart, $lt: weekStart } } },
        { $group: { _id: null, earnings: { $sum: "$earning" } } },
      ]),
      Order.aggregate([
        { $match: { ...done, createdAt: { $gte: weekStart } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            value: { $sum: "$earning" },
          },
        },
      ]),
      Order.aggregate([
        { $match: done },
        { $group: { _id: "$store", value: { $sum: "$earning" } } },
        { $sort: { value: -1 } },
      ]),
      Order.find(done).sort({ createdAt: -1 }).limit(6).lean(),
    ]);

    const byDay = new Map(dayAgg.map((d) => [d._id, d.value]));
    const weekly = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(startToday.getTime() - i * dayMs);
      weekly.push({
        day: d.toLocaleDateString("en-US", { weekday: "short" }),
        value: money(byDay.get(d.toISOString().slice(0, 10)) || 0),
      });
    }

    const totals = totalsAgg[0] || { earnings: 0, orders: 0 };
    res.json({
      data: {
        totalEarnings: money(totals.earnings),
        completedOrders: totals.orders,
        avgEarning: totals.orders > 0 ? money(totals.earnings / totals.orders) : 0,
        weekEarnings: money(weekAgg[0]?.earnings || 0),
        prevWeekEarnings: money(prevWeekAgg[0]?.earnings || 0),
        weekly,
        byStore: storeAgg.map((s) => ({ name: s._id || "—", value: money(s.value) })),
        recent: recent.map((o) => ({
          ref: o.ref,
          store: o.store,
          bundle: o.bundle,
          amount: money(o.amount || 0),
          earning: money(o.earning || 0),
          createdAt: o.createdAt,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

/* Per-tenant operational data (read-only lists for now). */
router.get("/orders", crudScoped(Order).list);
router.get("/customers", crudScoped(Customer).list);
router.get("/transactions", crudScoped(Transaction, "agentId").list);

export default router;
