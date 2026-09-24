import { Agent, Transaction } from "../models/index.js";
import { withMongoTransaction } from "./mongoTransaction.js";

const money = (value) => Math.round(Number(value) * 100) / 100;

export const MAX_ADMIN_CREDIT_GHS = 100000;

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

/** Validate and normalize one manual superadmin wallet credit request. */
export function validateAdminCredit(body = {}) {
  const amount = money(body.amount);
  const reason = String(body.reason || "").trim().replace(/\s+/g, " ");
  const requestId = String(body.requestId || "").trim();

  if (!Number.isFinite(amount) || amount < 1 || amount > MAX_ADMIN_CREDIT_GHS) {
    throw httpError(
      `Enter an amount from ₵1 to ₵${MAX_ADMIN_CREDIT_GHS.toLocaleString()}.`,
      400
    );
  }
  if (reason.length < 3 || reason.length > 160) {
    throw httpError("Enter a reason between 3 and 160 characters.", 400);
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
    throw httpError("Invalid credit request ID.", 400);
  }

  return { amount, reason, requestId };
}

/**
 * Credit an agent and create the matching funding ledger row atomically.
 * The caller-provided request ID makes browser/network retries exactly-once.
 */
export function creditAgentWallet({ agentId, amount, reason, requestId, adminName }) {
  const reference = `ADMIN-CREDIT-${requestId}`;

  return withMongoTransaction(async (session) => {
    const existing = await Transaction.findOne({ reference }).session(session);
    if (existing) {
      if (String(existing.agentId) !== String(agentId) || money(existing.amount) !== amount) {
        throw httpError("That credit request ID was already used for another credit.", 409);
      }
      const agent = await Agent.findById(agentId).session(session);
      if (!agent) throw httpError("Agent not found.", 404);
      return { agent, transaction: existing, alreadyCredited: true };
    }

    const agent = await Agent.findOneAndUpdate(
      { _id: agentId, role: { $ne: "superadmin" } },
      { $inc: { wallet: amount } },
      { new: true, session }
    );
    if (!agent) {
      const account = await Agent.findById(agentId).session(session);
      if (!account) throw httpError("Agent not found.", 404);
      throw httpError("Only agent wallets can be credited.", 409);
    }

    const [transaction] = await Transaction.create(
      [
        {
          agentId: agent._id,
          agent: agent.name,
          type: "funding",
          description: `Admin wallet credit · ${reason} · by ${adminName || "Superadmin"}`,
          amount,
          reference,
        },
      ],
      { session, ordered: true }
    );

    return { agent, transaction, alreadyCredited: false };
  });
}
