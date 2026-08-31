import { Router } from "express";

import {
  Agent,
  Bundle,
  Store,
  Order,
  Customer,
  Transaction,
  Withdrawal,
  AgentPrice,
  Report,
  FeatureRequest,
  Log,
} from "./models/index.js";
import { requireAdmin, hashPassword } from "./lib/auth.js";
import { invalidateMaintenanceModeCache } from "./middleware/maintenanceMode.js";
import { recordLog } from "./lib/audit.js";
import { getSettings } from "./lib/settings.js";
import { syncPendingOrders, reverseOrder } from "./lib/fulfilment.js";
import { requestPaystackRefundForOrder } from "./lib/paystackRefund.js";
import {
  netpluseCatalog,
  netpluseCheckers,
  netpluseConfigured,
  netpluseLive,
  netpluseMode,
  netpluseWalletBalance,
} from "./lib/netpluseApi.js";

const router = Router();

// Everything under /api/admin needs a signed-in superadmin.
router.use(requireAdmin);

const money = (n) => Math.round(n * 100) / 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Public-safe agent row for the /admin/agents responses (adds stores count). */
const agentRow = (a, stores = 0) => ({
  _id: a._id,
  name: a.name,
  email: a.email,
  phone: a.phone,
  wallet: a.wallet,
  revenue: a.revenue,
  tier: a.tier,
  status: a.status,
  role: a.role || "agent",
  stores,
  createdAt: a.createdAt,
});

/* ------------------------- Withdrawal queue ------------------------- */

/** GET /api/admin/withdrawals — every agent's payout requests, newest first. */
router.get("/withdrawals", async (req, res, next) => {
  try {
    const docs = await Withdrawal.find().sort({ createdAt: -1 }).limit(200).lean();
    res.json({ data: docs });
  } catch (err) {
    next(err);
  }
});

/** Load a still-pending withdrawal or respond with the right error. */
async function loadPending(req, res) {
  const w = await Withdrawal.findById(req.params.id);
  if (!w) {
    res.status(404).json({ error: "Withdrawal not found" });
    return null;
  }
  if (w.status !== "pending") {
    res.status(409).json({ error: `Already ${w.status}.` });
    return null;
  }
  return w;
}

/**
 * POST /api/admin/withdrawals/:id/approve — pay it out. The funds were held
 * at request time, so this just finalizes: mark approved + log the payout on
 * the agent's ledger.
 */
router.post("/withdrawals/:id/approve", async (req, res, next) => {
  try {
    const w = await loadPending(req, res);
    if (!w) return;

    w.status = "approved";
    w.decidedAt = new Date();
    await w.save();

    await Transaction.create({
      agentId: w.agent,
      agent: w.agentName,
      type: "payout",
      description: `Withdrawal · ${w.method}${w.destination ? ` · ${w.destination}` : ""}`,
      amount: -w.amount,
    });

    recordLog("info", `Withdrawal approved · ${w.agentName} · ₵${w.amount}`, "admin/withdrawals");
    res.json({ data: w });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/withdrawals/:id/reject — decline and refund the held amount. */
router.post("/withdrawals/:id/reject", async (req, res, next) => {
  try {
    const w = await loadPending(req, res);
    if (!w) return;

    const agent = await Agent.findById(w.agent);
    if (agent) {
      agent.wallet = money(agent.wallet + w.amount);
      await agent.save();
    }

    w.status = "rejected";
    w.decidedAt = new Date();
    await w.save();

    recordLog("info", `Withdrawal rejected · ${w.agentName} · ₵${w.amount} refunded`, "admin/withdrawals");
    res.json({ data: w });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- Platform data -------------------------- */

/**
 * POST /api/admin/agents — create a new account (agent or admin) straight from
 * the console. Mirrors /api/auth/register's validation, but a superadmin may
 * set the role and no session is issued (the new user signs in themselves).
 */
router.post("/agents", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const phone = String(req.body.phone || "").trim();
    const password = String(req.body.password || "");
    const role = req.body.role === "superadmin" ? "superadmin" : "agent";

    if (name.length < 2) return res.status(400).json({ error: "Please enter a name." });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    const existing = await Agent.findOne({ email });
    if (existing) return res.status(409).json({ error: "An account with that email already exists." });

    const passwordHash = await hashPassword(password);
    const agent = await Agent.create({ name, email, phone, passwordHash, role });

    recordLog("info", `User created · ${agent.name} (${role})`, "admin/users", { email });
    res.status(201).json({ data: agentRow(agent) });
  } catch (err) {
    // Duplicate key from the unique email index (race between check and create).
    if (err?.code === 11000) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    next(err);
  }
});

/** GET /api/admin/agents — every agent with their store count. */
router.get("/agents", async (req, res, next) => {
  try {
    const [agents, storeCounts] = await Promise.all([
      Agent.find().sort({ createdAt: -1 }).lean(),
      Store.aggregate([{ $group: { _id: "$agent", count: { $sum: 1 } } }]),
    ]);
    const counts = new Map(storeCounts.map((s) => [String(s._id), s.count]));
    const data = agents.map((a) => ({
      _id: a._id,
      name: a.name,
      email: a.email,
      phone: a.phone,
      wallet: a.wallet,
      revenue: a.revenue,
      tier: a.tier,
      status: a.status,
      role: a.role || "agent",
      stores: counts.get(String(a._id)) || 0,
      createdAt: a.createdAt,
    }));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/agents/:id — change an agent's status (active/suspended). */
router.patch("/agents/:id", async (req, res, next) => {
  try {
    const status = String(req.body.status || "");
    if (!["active", "suspended"].includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    if (String(req.agent._id) === req.params.id) {
      return res.status(400).json({ error: "You can't change your own account's status." });
    }
    const agent = await Agent.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    ).lean();
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    recordLog("info", `Agent ${status} · ${agent.name}`, "admin/agents");
    res.json({ data: agent });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/agents/:id/role — grant or revoke admin (superadmin) access.
 * Guards: valid role, you can't change your own role (no self-lockout), and an
 * account needs an email + password before it can be promoted — admin sign-in
 * (`/api/auth/admin/login`) is by email/password, so an account missing either
 * could never actually reach the console.
 */
router.patch("/agents/:id/role", async (req, res, next) => {
  try {
    const role = String(req.body.role || "");
    if (!["agent", "superadmin"].includes(role)) {
      return res.status(400).json({ error: "Invalid role." });
    }
    if (String(req.agent._id) === req.params.id) {
      return res.status(400).json({ error: "You can't change your own role." });
    }

    // Need passwordHash (select:false) to confirm a promotable account can sign in.
    const agent = await Agent.findById(req.params.id).select("+passwordHash");
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    if (role === "superadmin") {
      if (!agent.email) {
        return res.status(400).json({ error: "This account has no email, so it can't sign in to the admin console." });
      }
      if (!agent.passwordHash) {
        return res.status(400).json({ error: "This account has no password set, so it can't sign in to the admin console." });
      }
    }

    agent.role = role;
    await agent.save();

    recordLog(
      "info",
      `${role === "superadmin" ? "Admin access granted" : "Admin access revoked"} · ${agent.name}`,
      "admin/users"
    );
    res.json({ data: { _id: agent._id, name: agent.name, email: agent.email, role: agent.role } });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/agents/:id — permanently remove an account and everything it
 * owns (stores, orders, customers, ledger entries, prices, withdrawals). You
 * can't delete your own account. Irreversible.
 */
router.delete("/agents/:id", async (req, res, next) => {
  try {
    if (String(req.agent._id) === req.params.id) {
      return res.status(400).json({ error: "You can't delete your own account." });
    }
    const agent = await Agent.findById(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const id = agent._id;
    const [stores, orders] = await Promise.all([
      Store.deleteMany({ agent: id }),
      Order.deleteMany({ agent: id }),
      Customer.deleteMany({ agent: id }),
      Transaction.deleteMany({ agentId: id }),
      AgentPrice.deleteMany({ agent: id }),
      Withdrawal.deleteMany({ agent: id }),
    ]);
    await agent.deleteOne();

    recordLog(
      "warning",
      `User deleted · ${agent.name} (${agent.email || agent.phone || "no contact"}) · ${stores.deletedCount} store(s), ${orders.deletedCount} order(s)`,
      "admin/users"
    );
    res.json({ data: { _id: String(id), deleted: true } });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/stores — every storefront with its owner's name. */
router.get("/stores", async (req, res, next) => {
  try {
    const stores = await Store.find().sort({ createdAt: -1 }).populate("agent", "name").lean();
    const data = stores.map((s) => ({
      ...s,
      agent: s.agent ? String(s.agent._id) : null,
      agentName: s.agent?.name || "—",
    }));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/stores/:id — pause / restore a storefront. */
router.patch("/stores/:id", async (req, res, next) => {
  try {
    const status = String(req.body.status || "");
    if (!["active", "paused"].includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    const store = await Store.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    ).lean();
    if (!store) return res.status(404).json({ error: "Store not found" });
    recordLog("info", `Store ${status} · ${store.name}`, "admin/stores");
    res.json({ data: store });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/customers — every customer across all stores. */
router.get("/customers", async (req, res, next) => {
  try {
    const docs = await Customer.find().sort({ updatedAt: -1 }).limit(500).lean();
    res.json({ data: docs });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/transactions — the master ledger, newest first. */
router.get("/transactions", async (req, res, next) => {
  try {
    const docs = await Transaction.find().sort({ createdAt: -1 }).limit(300).lean();
    res.json({ data: docs });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/overview — dashboard/analytics aggregates in one call:
 * platform totals, 7-day volume, sales by carrier, top agents, recent ledger.
 */
router.get("/overview", async (req, res, next) => {
  try {
    const dayMs = 24 * 60 * 60 * 1000;
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const weekStart = new Date(startToday.getTime() - 6 * dayMs);
    const prevWeekStart = new Date(weekStart.getTime() - 7 * dayMs);
    const countedOrderMatch = { status: { $nin: ["failed", "refunded", "cancelled"] } };

    const [
      agentsTotal,
      agentsActive,
      storesTotal,
      customersTotal,
      walletAgg,
      orderAgg,
      dayAgg,
      prevWeekAgg,
      carrierAgg,
      topAgentAgg,
      pendingWithdrawals,
      recent,
    ] = await Promise.all([
      Agent.countDocuments(),
      Agent.countDocuments({ status: "active" }),
      Store.countDocuments(),
      Customer.countDocuments(),
      Agent.aggregate([
        { $match: { role: { $ne: "superadmin" } } }, // agent float only, not app-owner earnings
        { $group: { _id: null, wallet: { $sum: "$wallet" } } },
      ]),
      Order.aggregate([
        { $match: countedOrderMatch },
        {
          $group: {
            _id: null,
            volume: { $sum: "$amount" },
            agentEarnings: { $sum: { $ifNull: ["$earning", 0] } },
            platformRevenue: { $sum: { $subtract: ["$amount", { $ifNull: ["$earning", 0] }] } },
            platformMargin: { $sum: { $ifNull: ["$platformEarning", 0] } },
            agentPortalMargin: {
              $sum: {
                $cond: [
                  { $eq: [{ $ifNull: ["$store", ""] }, ""] },
                  { $ifNull: ["$platformEarning", 0] },
                  0,
                ],
              },
            },
            storefrontMargin: {
              $sum: {
                $cond: [
                  { $ne: [{ $ifNull: ["$store", ""] }, ""] },
                  { $ifNull: ["$platformEarning", 0] },
                  0,
                ],
              },
            },
            orders: { $sum: 1 },
            payingAgents: { $addToSet: "$agent" },
          },
        },
      ]),
      Order.aggregate([
        { $match: { ...countedOrderMatch, createdAt: { $gte: weekStart } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            value: { $sum: "$amount" },
          },
        },
      ]),
      Order.aggregate([
        { $match: { ...countedOrderMatch, createdAt: { $gte: prevWeekStart, $lt: weekStart } } },
        { $group: { _id: null, value: { $sum: "$amount" } } },
      ]),
      Order.aggregate([
        { $match: countedOrderMatch },
        { $group: { _id: "$carrier", value: { $sum: "$amount" } } },
      ]),
      Order.aggregate([
        { $match: countedOrderMatch },
        { $group: { _id: "$agent", volume: { $sum: "$amount" }, orders: { $sum: 1 } } },
        { $sort: { volume: -1 } },
        { $limit: 5 },
      ]),
      Withdrawal.countDocuments({ status: "pending" }),
      Transaction.find().sort({ createdAt: -1 }).limit(8).lean(),
    ]);

    // 7 day buckets, oldest → today, labeled Mon/Tue/…
    const byDay = new Map(dayAgg.map((d) => [d._id, d.value]));
    const weeklyVolume = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(startToday.getTime() - i * dayMs);
      const key = d.toISOString().slice(0, 10);
      weeklyVolume.push({
        day: d.toLocaleDateString("en-US", { weekday: "short" }),
        value: money(byDay.get(key) || 0),
      });
    }

    // Resolve top-agent names/tiers in one query.
    const topIds = topAgentAgg.map((t) => t._id).filter(Boolean);
    const topDocs = await Agent.find({ _id: { $in: topIds } }, "name tier").lean();
    const nameOf = new Map(topDocs.map((a) => [String(a._id), a]));
    const topAgents = topAgentAgg.map((t) => ({
      id: String(t._id),
      name: nameOf.get(String(t._id))?.name || "Unknown",
      tier: nameOf.get(String(t._id))?.tier || "Bronze",
      volume: money(t.volume),
      orders: t.orders,
    }));

    const totals = orderAgg[0] || {
      volume: 0,
      agentEarnings: 0,
      platformRevenue: 0,
      platformMargin: 0,
      agentPortalMargin: 0,
      storefrontMargin: 0,
      orders: 0,
      payingAgents: [],
    };
    res.json({
      data: {
        totals: {
          agents: agentsTotal,
          activeAgents: agentsActive,
          stores: storesTotal,
          customers: customersTotal,
          walletsHeld: money(walletAgg[0]?.wallet || 0),
          volume: money(totals.volume),
          agentEarnings: money(totals.agentEarnings),
          platformRevenue: money(totals.platformRevenue),
          platformMargin: money(totals.platformMargin),
          platformEarnings: {
            total: money(totals.platformMargin),
            agentPortal: money(totals.agentPortalMargin),
            storefront: money(totals.storefrontMargin),
          },
          orders: totals.orders,
          payingAgents: totals.payingAgents.length,
          pendingWithdrawals,
        },
        weeklyVolume,
        prevWeekVolume: money(prevWeekAgg[0]?.value || 0),
        carrierSales: carrierAgg.map((c) => ({ carrier: c._id, value: money(c.value) })),
        topAgents,
        recent,
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------- Support tickets -------------------------- */

/** GET /api/admin/reports — support tickets, newest first. */
router.get("/reports", async (req, res, next) => {
  try {
    const docs = await Report.find().sort({ createdAt: -1 }).limit(300).lean();
    res.json({ data: docs });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/reports/:id — move a ticket through Open → Pending → Resolved. */
router.patch("/reports/:id", async (req, res, next) => {
  try {
    const status = String(req.body.status || "");
    if (!["Open", "Pending", "Resolved"].includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    const report = await Report.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    ).lean();
    if (!report) return res.status(404).json({ error: "Ticket not found" });
    if (status === "Resolved") {
      recordLog("info", `Ticket resolved · ${report.reference}`, "support");
    }
    res.json({ data: report });
  } catch (err) {
    next(err);
  }
});

/* ------------------------- Feature requests ------------------------- */

/** GET /api/admin/feature-requests — most-voted first. */
router.get("/feature-requests", async (req, res, next) => {
  try {
    const docs = await FeatureRequest.find().sort({ votes: -1, createdAt: -1 }).limit(300).lean();
    res.json({ data: docs });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/feature-requests/:id — set roadmap status (Open/Planned/Shipped). */
router.patch("/feature-requests/:id", async (req, res, next) => {
  try {
    const status = String(req.body.status || "");
    if (!["Open", "Planned", "Shipped"].includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    const doc = await FeatureRequest.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    ).lean();
    if (!doc) return res.status(404).json({ error: "Feature request not found" });
    recordLog("info", `Feature "${doc.title}" marked ${status}`, "admin/roadmap");
    res.json({ data: doc });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- Audit logs ----------------------------- */

/** GET /api/admin/logs — platform event stream, newest first. Optional ?level= filter. */
router.get("/logs", async (req, res, next) => {
  try {
    const level = String(req.query.level || "");
    const filter = ["error", "warning", "info"].includes(level) ? { level } : {};
    const docs = await Log.find(filter).sort({ createdAt: -1 }).limit(300).lean();
    res.json({ data: docs });
  } catch (err) {
    next(err);
  }
});

/* ------------------------- Platform settings ------------------------ */

/** GET /api/admin/settings — the full settings document. */
router.get("/settings", async (req, res, next) => {
  try {
    const s = await getSettings();
    res.json({ data: s });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/admin/settings — update platform settings (brand, contact, toggles, fees). */
router.put("/settings", async (req, res, next) => {
  try {
    const b = req.body || {};
    const s = await getSettings();

    const str = (v, cur) => (typeof v === "string" ? v.trim() : cur);
    const bool = (v, cur) => (typeof v === "boolean" ? v : cur);
    const num = (v, cur) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : cur;
    };

    s.appName = str(b.appName, s.appName) || "BuyDataNow";
    s.tagline = str(b.tagline, s.tagline);
    s.contactPhone = str(b.contactPhone, s.contactPhone);
    s.whatsapp = str(b.whatsapp, s.whatsapp);
    s.supportEmail = str(b.supportEmail, s.supportEmail).toLowerCase();
    s.address = str(b.address, s.address);
    s.maintenanceMode = bool(b.maintenanceMode, s.maintenanceMode);
    s.allowSignups = bool(b.allowSignups, s.allowSignups);
    s.autoApproveSmallFunds = bool(b.autoApproveSmallFunds, s.autoApproveSmallFunds);
    s.transactionFeePct = num(b.transactionFeePct, s.transactionFeePct);
    s.withdrawalFee = num(b.withdrawalFee, s.withdrawalFee);
    s.whatsappAlerts = bool(b.whatsappAlerts, s.whatsappAlerts);
    s.smsAlerts = bool(b.smsAlerts, s.smsAlerts);
    await s.save();
    invalidateMaintenanceModeCache();

    recordLog("info", `Platform settings updated · ${s.appName}`, "admin/settings");
    res.json({ data: s });
  } catch (err) {
    next(err);
  }
});

/* ---------------------- Platform bundle pricing --------------------- */
/*
 * The bundle catalog (and the price agents pay) is superadmin-owned.
 * Reads stay public on /api/bundles; writes live here.
 */
/** Find the authoritative Netpluse package for a local bundle identity. */
async function providerPackage(carrier, gb, { force = false } = {}) {
  if (!netpluseConfigured()) return null;
  const rows = await netpluseCatalog({ force, allowStale: !force });
  return rows.find((row) => row.carrier === carrier && row.gb === Number(gb)) || null;
}

/** POST /api/admin/bundles — create with a server-fetched Netpluse base cost. */
router.post("/bundles", async (req, res, next) => {
  try {
    const carrier = String(req.body?.carrier || "");
    const gb = Number(req.body?.gb);
    const upstream = await providerPackage(carrier, gb, { force: true });
    if (!upstream) {
      return res.status(400).json({
        error: `Netpluse does not currently list a ${carrier || "selected network"} ${gb || "?"}GB bundle.`,
      });
    }

    const price = money(Number(req.body?.price));
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: "Enter a valid agent price." });
    }
    if (price < money(upstream.cost)) {
      return res.status(400).json({
        error: `Agent price cannot be below the Netpluse base cost of GHS ${money(upstream.cost).toFixed(2)}.`,
      });
    }

    const doc = await Bundle.create({
      carrier: upstream.carrier,
      gb: upstream.gb,
      size: `${upstream.gb} GB`,
      cost: money(upstream.cost),
      price,
      active: req.body?.active !== false,
    });
    recordLog(
      "info",
      `Bundle added · ${upstream.carrier} ${upstream.capacity} · Netpluse cost GHS ${money(upstream.cost).toFixed(2)}`,
      "admin/bundles"
    );
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/bundles/:id — base cost stays provider-owned. */
router.patch("/bundles/:id", async (req, res, next) => {
  try {
    const doc = await Bundle.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });

    if (Object.hasOwn(req.body || {}, "price")) {
      const upstream = await providerPackage(doc.carrier, doc.gb, { force: true });
      if (!upstream) {
        return res.status(409).json({
          error: `Netpluse does not currently list ${doc.carrier} ${doc.gb}GB, so its margin cannot be changed.`,
        });
      }
      const price = money(Number(req.body.price));
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: "Enter a valid agent price." });
      }
      if (price < money(upstream.cost)) {
        return res.status(400).json({
          error: `Agent price cannot be below the Netpluse base cost of GHS ${money(upstream.cost).toFixed(2)}.`,
        });
      }
      doc.cost = money(upstream.cost);
      doc.price = price;
    }
    if (typeof req.body?.active === "boolean") doc.active = req.body.active;

    await doc.save();
    res.json({ data: doc });
  } catch (err) {
    next(err);
  }
});

router.delete("/bundles/:id", async (req, res, next) => {
  try {
    const doc = await Bundle.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json({ data: { id: req.params.id, deleted: true } });
  } catch (err) {
    next(err);
  }
});

/* -------------------- Fulfilment provider (Netpluse) ---------------------- */
/*
 * Every order the platform sells is delivered by Netpluse out of one shared
 * float. These endpoints are how the app owner watches that float, keeps our
 * base costs in step with theirs, and chases orders still in flight.
 */

/** GET /api/admin/provider — connection state and the upstream wallet balance. */
router.get("/provider", async (req, res, next) => {
  try {
    const [balance, catalog] = await Promise.all([
      netpluseConfigured() ? netpluseWalletBalance() : Promise.resolve({ ok: false }),
      netpluseConfigured() ? netpluseCatalog() : Promise.resolve([]),
    ]);
    const inFlight = await Order.countDocuments({ status: "processing" });

    res.json({
      data: {
        name: "Netpluse",
        configured: netpluseConfigured(),
        mode: netpluseMode(),
        // false = orders settle locally without being sent (development).
        fulfilling: netpluseLive(),
        balance: balance.ok ? balance.balance : null,
        currency: balance.ok ? balance.currency : "GHS",
        lastTransactionAt: balance.ok ? balance.lastTransactionAt : null,
        error: balance.ok ? null : balance.message || null,
        bundles: catalog.length,
        ordersInFlight: inFlight,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/provider/catalog — a live, non-cached Netpluse cost catalog. */
router.get("/provider/catalog", async (req, res, next) => {
  try {
    if (!netpluseConfigured()) {
      return res.status(409).json({ error: "Netpluse isn't configured." });
    }
    const rows = await netpluseCatalog({ force: true, allowStale: false });
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/provider/wholesale-bundles — live Netpluse costs for admin purchases. */
router.get("/provider/wholesale-bundles", async (_req, res, next) => {
  try {
    if (!netpluseConfigured()) {
      return res.status(409).json({ error: "Netpluse isn't configured." });
    }
    const rows = await netpluseCatalog({ force: true, allowStale: false });
    res.json({
      data: rows.map((row) => ({
        id: `${row.carrier}-${row.capacity}`,
        carrier: row.carrier,
        gb: row.gb,
        size: `${row.gb} GB`,
        cost: money(row.cost),
        price: money(row.cost),
        active: true,
      })),
    });
  } catch (err) {
    next(err);
  }
});

async function waecCheckerPricing() {
  if (!netpluseConfigured()) {
    const error = new Error("Netpluse isn't configured.");
    error.status = 409;
    throw error;
  }
  const [checkers, settings] = await Promise.all([netpluseCheckers(), getSettings()]);
  const checker = checkers.find((item) => item.id === "waec");
  if (!checker) {
    const error = new Error("Netpluse does not currently list the WAEC Result Checker.");
    error.status = 502;
    throw error;
  }
  const margin = money(Number(settings.waecCheckerMargin) || 0);
  return {
    ...checker,
    baseCost: money(checker.price),
    margin,
    sellingPrice: money(checker.price + margin),
  };
}

/** GET /api/admin/provider/checkers/waec — live cost plus the platform margin. */
router.get("/provider/checkers/waec", async (_req, res, next) => {
  try {
    res.json({ data: await waecCheckerPricing() });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/admin/provider/checkers/waec/margin — set the WAEC selling margin. */
router.put("/provider/checkers/waec/margin", async (req, res, next) => {
  try {
    const margin = Number(req.body?.margin);
    if (!Number.isFinite(margin) || margin < 0 || margin > 1000) {
      return res.status(400).json({ error: "Enter a margin between GHS 0.00 and GHS 1,000.00." });
    }

    const settings = await getSettings();
    settings.waecCheckerMargin = money(margin);
    await settings.save();
    const pricing = await waecCheckerPricing();
    recordLog(
      "info",
      `WAEC checker margin updated · GHS ${pricing.margin.toFixed(2)} · selling price GHS ${pricing.sellingPrice.toFixed(2)}`,
      "admin/provider/checkers/waec"
    );
    res.json({ data: pricing });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/provider/sync-costs — pull Netpluse prices into `Bundle.cost`
 * so the platform margin shown on the dashboard reflects what we actually pay.
 * Selling prices are never touched. `?dryRun=1` reports without writing.
 */
router.post("/provider/sync-costs", async (req, res, next) => {
  try {
    if (!netpluseConfigured()) {
      return res.status(409).json({ error: "Netpluse isn't configured." });
    }
    const rows = await netpluseCatalog({ force: true, allowStale: false });
    if (!rows.length) {
      return res.status(502).json({ error: "Could not read the Netpluse catalog." });
    }

    const dryRun = req.body?.dryRun === true || req.query.dryRun === "1";
    const costOf = new Map(rows.map((r) => [`${r.carrier}-${r.gb}`, r.cost]));
    const bundles = await Bundle.find().lean();

    const changed = [];
    const unmatched = [];
    for (const b of bundles) {
      const cost = costOf.get(`${b.carrier}-${b.gb}`);
      if (cost === undefined) {
        unmatched.push({ carrier: b.carrier, gb: b.gb });
        continue;
      }
      if (money(cost) === money(b.cost || 0)) continue;
      changed.push({ carrier: b.carrier, gb: b.gb, from: money(b.cost || 0), to: money(cost) });
      if (!dryRun) await Bundle.updateOne({ _id: b._id }, { $set: { cost: money(cost) } });
    }

    if (!dryRun && changed.length) {
      recordLog("info", `Provider costs synced · ${changed.length} bundle(s) updated`, "admin/provider");
    }
    res.json({ data: { dryRun, updated: changed.length, changed, unmatched, catalog: rows } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/orders/:ref/reverse — put the money back on an order that was
 * booked but never delivered (e.g. one settled locally while fulfilment was
 * switched off). Credits the buyer, claws the platform margin back off the app
 * owner, and rolls the store/customer counters back.
 *
 * Refuses an order the provider actually delivered — that has to be disputed
 * upstream first, or we'd refund data the customer received. Idempotent.
 */
router.post("/orders/:ref/reverse", async (req, res, next) => {
  try {
    const order = await Order.findOne({ ref: req.params.ref });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.reversedAt) {
      return res.status(409).json({ error: `Already reversed on ${order.reversedAt.toISOString()}.` });
    }
    if (order.provider && order.provider !== "simulated" && order.status === "completed") {
      return res.status(409).json({
        error: "The provider delivered this order — raise it with them before refunding.",
      });
    }
    if (!order.reversal?.agent) {
      return res.status(409).json({ error: "This order has no reversal plan recorded." });
    }

    const { credit, platformClawback } = order.reversal;
    const agentAdjustment = Number.isFinite(order.reversal.agentWalletAdjustment)
      ? order.reversal.agentWalletAdjustment
      : credit;
    const platformAdjustment = Number.isFinite(order.reversal.platformWalletAdjustment)
      ? order.reversal.platformWalletAdjustment
      : -platformClawback;
    await reverseOrder(order);
    const settled = await Order.findById(order._id).lean();

    recordLog(
      "warning",
      `Order reversed by admin · ${order.ref} · ${order.carrier} ${order.gb}GB · ₵${credit} returned`,
      "admin/orders"
    );
    res.json({
      data: {
        ref: order.ref,
        status: settled?.status,
        reversedAt: settled?.reversedAt,
        agentWalletAdjustment: agentAdjustment,
        platformWalletAdjustment: platformAdjustment,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Retry a definitively failed Paystack refund after the cause is corrected. */
router.post("/orders/:ref/refund", async (req, res, next) => {
  try {
    const order = await Order.findOne({ ref: req.params.ref });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.paymentReference) {
      return res.status(409).json({ error: "This order was not paid through Paystack." });
    }
    if (!order.reversedAt) {
      return res.status(409).json({ error: "Reverse the undelivered order before refunding it." });
    }
    if (["requesting", "pending", "processing", "processed", "unknown"].includes(order.refund?.status)) {
      return res.status(409).json({
        error: `Refund status is ${order.refund.status}; reconcile it in Paystack before retrying.`,
      });
    }

    const result = await requestPaystackRefundForOrder(
      order,
      String(req.body?.reason || order.providerMessage || "Data order was not delivered")
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/provider/sync-orders — settle orders still in flight now. */
router.post("/provider/sync-orders", async (req, res, next) => {
  try {
    const result = await syncPendingOrders({ limit: Number(req.body?.limit) || 100 });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
