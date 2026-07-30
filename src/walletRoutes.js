import { Router } from "express";

import { Agent, AgentPrice, Bundle, Order, Transaction, Withdrawal } from "./models/index.js";
import { requireAuth, publicAgent } from "./lib/auth.js";
import { fulfilOrder } from "./lib/fulfilment.js";
import { normalizePhone, validPhone } from "./lib/remaApi.js";

const router = Router();

// Every wallet route needs a signed-in agent.
router.use(requireAuth);

/** Round to 2dp to avoid floating-point drift on the balance. */
const money = (n) => Math.round(n * 100) / 100;

/** Parse & validate a positive amount from the body. */
function readAmount(body) {
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return money(amount);
}

/** Log a ledger entry for the agent (shows on Transactions / Payment History). */
function logTxn(agent, { type, description, amount }) {
  return Transaction.create({
    agentId: agent._id,
    agent: agent.name,
    type,
    description,
    amount,
  });
}

/** POST /api/wallet/fund — top up the agent's wallet. */
router.post("/fund", async (req, res, next) => {
  try {
    const amount = readAmount(req.body);
    if (amount === null) return res.status(400).json({ error: "Enter a valid amount." });
    const method = String(req.body.method || "MoMo").trim();

    req.agent.wallet = money(req.agent.wallet + amount);
    await req.agent.save();
    const transaction = await logTxn(req.agent, {
      type: "topup",
      description: `Wallet top-up · ${method}`,
      amount,
    });

    res.status(201).json({ data: { agent: publicAgent(req.agent), transaction } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/wallet/withdraw — request a payout. The amount is HELD (deducted
 * from the wallet immediately so it can't be double-spent) and the request
 * goes to the superadmin's queue; approval logs the payout transaction,
 * rejection refunds the wallet.
 */
router.post("/withdraw", async (req, res, next) => {
  try {
    const amount = readAmount(req.body);
    if (amount === null) return res.status(400).json({ error: "Enter a valid amount." });
    if (amount > req.agent.wallet) {
      return res.status(400).json({ error: "Amount exceeds your wallet balance." });
    }
    const method = String(req.body.method || "MoMo").trim();
    const destination = String(req.body.destination || "").trim();

    req.agent.wallet = money(req.agent.wallet - amount);
    await req.agent.save();
    const withdrawal = await Withdrawal.create({
      agent: req.agent._id,
      agentName: req.agent.name,
      amount,
      method,
      destination,
    });

    res.status(201).json({ data: { agent: publicAgent(req.agent), withdrawal } });
  } catch (err) {
    next(err);
  }
});

/** GET /api/wallet/withdrawals — the agent's own payout requests, newest first. */
router.get("/withdrawals", async (req, res, next) => {
  try {
    const docs = await Withdrawal.find({ agent: req.agent._id })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ data: docs });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/wallet/spend — buy a data bundle from the agent's own wallet.
 *
 * The price is resolved server-side from the catalog (the agent's own price for
 * the bundle, or the platform price where they haven't set one); the amount in
 * the request body is ignored, because this now spends the platform's provider
 * float and a forged price would spend real money.
 *
 * The purchase is recorded as an Order and handed to the fulfilment provider.
 * If it can't be delivered the wallet is credited straight back.
 */
router.post("/spend", async (req, res, next) => {
  try {
    const network = String(req.body.network || "").trim();
    const gb = Number(req.body.gb) || 0;
    const phone = normalizePhone(req.body.phone || "");
    if (!validPhone(phone)) {
      return res.status(400).json({ error: "Enter the phone number that should receive the data." });
    }

    const bundleDoc = await Bundle.findOne({ carrier: network, gb, active: true }).lean();
    if (!bundleDoc) return res.status(400).json({ error: "That bundle isn't available." });

    // Same price the Buy Data screen shows (see GET /api/my-bundles).
    const own = await AgentPrice.findOne({ agent: req.agent._id, carrier: network, gb }).lean();
    const amount = money(own?.price ?? bundleDoc.price);
    if (amount > req.agent.wallet) {
      return res.status(400).json({ error: "Insufficient wallet balance. Add funds to continue." });
    }

    req.agent.wallet = money(req.agent.wallet - amount);
    await req.agent.save();
    const transaction = await logTxn(req.agent, {
      type: "purchase",
      description: `${network} ${gb}GB · data purchase · ${phone}`,
      amount: -amount,
    });

    const order = await Order.create({
      agent: req.agent._id,
      ref: `DP-${Date.now().toString().slice(-7)}`,
      customer: phone,
      phone,
      carrier: network,
      bundle: `${gb} GB`,
      gb,
      amount,
      status: "pending",
    });

    const fulfilment = await fulfilOrder(order, {
      agent: req.agent._id,
      agentName: req.agent.name,
      credit: amount,
    });
    if (order.status === "failed" || order.status === "refunded") {
      // The provider's message usually carries its own refund sentence; ours is
      // the authoritative one, so strip theirs instead of stacking the two.
      const reason =
        String(fulfilment.message || "")
          .replace(/\s*your wallet has been refunded\.?\s*$/i, "")
          .replace(/[.\s]+$/, "")
          .trim() || "the provider rejected it";
      // reverseOrder already put the money back — hand the caller a fresh agent.
      const refreshed = await Agent.findById(req.agent._id);
      return res.status(502).json({
        error: `We couldn't deliver that bundle: ${reason}. Your wallet has been refunded.`,
        data: { agent: publicAgent(refreshed || req.agent) },
      });
    }

    res.status(201).json({
      data: {
        agent: publicAgent(req.agent),
        transaction,
        order: { ref: order.ref, status: order.status, phone, network, gb, amount },
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
