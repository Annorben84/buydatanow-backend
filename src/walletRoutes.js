import { randomUUID } from "node:crypto";
import { Router } from "express";

import { Agent, AgentPrice, Bundle, Order, Transaction, Withdrawal } from "./models/index.js";
import { requireAuth, publicAgent } from "./lib/auth.js";
import { fulfilOrder } from "./lib/fulfilment.js";
import { withMongoTransaction } from "./lib/mongoTransaction.js";
import { netpluseCatalog, normalizePhone, validPhone } from "./lib/netpluseApi.js";
import { walletPurchasePrice } from "./lib/pricingPolicy.js";

const router = Router();
router.use(requireAuth);

const money = (n) => Math.round(Number(n) * 100) / 100;

function readAmount(body) {
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return money(amount);
}

/** Direct credits are forbidden. Top-ups must pass Paystack verification. */
router.post("/fund", (_req, res) => {
  res.status(410).json({
    error: "Direct wallet funding is disabled. Start a verified Paystack top-up instead.",
  });
});

/** Hold withdrawal funds and create the request as one atomic operation. */
router.post("/withdraw", async (req, res, next) => {
  try {
    const amount = readAmount(req.body);
    if (amount === null) return res.status(400).json({ error: "Enter a valid amount." });
    const method = String(req.body.method || "MoMo").trim();
    const destination = String(req.body.destination || "").trim();

    const result = await withMongoTransaction(async (session) => {
      const agent = await Agent.findOneAndUpdate(
        { _id: req.agent._id, wallet: { $gte: amount } },
        { $inc: { wallet: -amount } },
        { new: true, session }
      );
      if (!agent) return null;
      const [withdrawal] = await Withdrawal.create(
        [{ agent: agent._id, agentName: agent.name, amount, method, destination }],
        { session, ordered: true }
      );
      return { agent, withdrawal };
    });

    if (!result) return res.status(400).json({ error: "Amount exceeds your wallet balance." });
    res.status(201).json({
      data: { agent: publicAgent(result.agent), withdrawal: result.withdrawal },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/withdrawals", async (req, res, next) => {
  try {
    const docs = await Withdrawal.find({ agent: req.agent._id }).sort({ createdAt: -1 }).lean();
    res.json({ data: docs });
  } catch (err) {
    next(err);
  }
});

/** Book a wallet-funded data order atomically, then dispatch it to Netpluse. */
router.post("/spend", async (req, res, next) => {
  try {
    const network = String(req.body.network || "").trim();
    const gb = Number(req.body.gb) || 0;
    const phone = normalizePhone(req.body.phone || "");
    if (!validPhone(phone)) {
      return res.status(400).json({ error: "Enter the phone number that should receive the data." });
    }

    let amount;
    if (req.agent.role === "superadmin") {
      const catalog = await netpluseCatalog({ force: true, allowStale: false });
      const providerBundle = catalog.find(
        (item) => item.carrier === network && item.gb === gb
      );
      if (!providerBundle) {
        return res.status(400).json({ error: "That bundle is not listed by Netpluse." });
      }
      amount = walletPurchasePrice({
        role: req.agent.role,
        providerCost: providerBundle.cost,
      });
    } else {
      const bundle = await Bundle.findOne({ carrier: network, gb, active: true }).lean();
      if (!bundle) return res.status(400).json({ error: "That bundle isn't available." });
      const own = await AgentPrice.findOne({ agent: req.agent._id, carrier: network, gb }).lean();
      amount = walletPurchasePrice({
        role: req.agent.role,
        agentPrice: own?.price,
        platformPrice: bundle.price,
      });
    }

    const booked = await withMongoTransaction(async (session) => {
      const agent = await Agent.findOneAndUpdate(
        { _id: req.agent._id, wallet: { $gte: amount } },
        { $inc: { wallet: -amount } },
        { new: true, session }
      );
      if (!agent) return null;

      const ref = `DP-${randomUUID()}`;
      const [transaction] = await Transaction.create(
        [
          {
            agentId: agent._id,
            agent: agent.name,
            type: "purchase",
            description: `${network} ${gb}GB · data purchase · ${phone}`,
            amount: -amount,
            reference: `${ref}-purchase`,
          },
        ],
        { session, ordered: true }
      );
      const [order] = await Order.create(
        [
          {
            agent: agent._id,
            ref,
            customer: phone,
            phone,
            carrier: network,
            bundle: `${gb} GB`,
            gb,
            amount,
            status: "pending",
            reversal: {
              agent: agent._id,
              agentName: agent.name,
              agentWalletAdjustment: amount,
            },
          },
        ],
        { session, ordered: true }
      );
      return { agent, transaction, order };
    });

    if (!booked) {
      return res.status(400).json({ error: "Insufficient wallet balance. Add funds to continue." });
    }

    const fulfilment = await fulfilOrder(booked.order);
    const [settledOrder, settledAgent] = await Promise.all([
      Order.findById(booked.order._id),
      Agent.findById(req.agent._id),
    ]);
    if (["failed", "refunded"].includes(settledOrder?.status)) {
      const reason =
        String(fulfilment.message || "")
          .replace(/\s*your wallet has been refunded\.?\s*$/i, "")
          .replace(/[.\s]+$/, "")
          .trim() || "the provider rejected it";
      return res.status(502).json({
        error: `We couldn't deliver that bundle: ${reason}. Your wallet has been refunded.`,
        data: { agent: publicAgent(settledAgent || booked.agent) },
      });
    }

    res.status(201).json({
      data: {
        agent: publicAgent(settledAgent || booked.agent),
        transaction: booked.transaction,
        order: {
          ref: booked.order.ref,
          status: settledOrder?.status || fulfilment.status,
          phone,
          network,
          gb,
          amount,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
