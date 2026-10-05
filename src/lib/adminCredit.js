import { Agent, Payment } from "../models/index.js";
import { verifyWalletTopup } from "./walletTopupRecovery.js";

const money = (value) => Math.round(Number(value) * 100) / 100;

export const MAX_ADMIN_CREDIT_GHS = 100000;

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

/** Validate a superadmin's request to settle a recorded Paystack deposit. */
export function validateAdminCredit(body = {}) {
  const amount = money(body.amount);
  const reason = String(body.reason || "").trim().replace(/\s+/g, " ");
  const reference = String(body.reference || "").trim();

  if (!Number.isFinite(amount) || amount < 1 || amount > MAX_ADMIN_CREDIT_GHS) {
    throw httpError(
      `Enter an amount from ₵1 to ₵${MAX_ADMIN_CREDIT_GHS.toLocaleString()}.`,
      400
    );
  }
  if (reason.length < 3 || reason.length > 160) {
    throw httpError("Enter a reason between 3 and 160 characters.", 400);
  }
  if (!/^[A-Za-z0-9._=-]{1,100}$/.test(reference)) {
    throw httpError("Enter a valid Paystack reference.", 400);
  }

  return { amount, reason, reference };
}

/**
 * Share the same payment settlement claim as webhooks and automatic recovery.
 * A Paystack deposit can only credit its recorded owner and principal once.
 */
export async function creditAgentWallet({ agentId, amount, reference }) {
  const account = await Agent.findById(agentId).lean();
  if (!account) throw httpError("Agent not found.", 404);
  if (account.role === "superadmin") {
    throw httpError("Only agent wallets can be credited.", 409);
  }

  const payment = await Payment.findOne({ reference }).lean();
  if (!payment) {
    throw httpError("Paystack reference not found. Use the reference from this user's wallet deposit.", 404);
  }
  if (payment.provider !== "paystack" || payment.purpose !== "wallet_topup") {
    throw httpError("This reference is not a Paystack wallet top-up.", 400);
  }
  if (String(payment.agent) !== String(agentId)) {
    throw httpError("This Paystack payment belongs to another user.", 409);
  }
  if (money(payment.amount) !== amount) {
    throw httpError(
      `Enter the deposit amount of ₵${money(payment.amount).toFixed(2)}, excluding Paystack fees.`,
      400
    );
  }

  const settled = await verifyWalletTopup(reference, { agentId });
  if (settled.status !== "success") {
    throw httpError(
      `Paystack has not confirmed a successful deposit (${settled.status}). No wallet credit was applied.`,
      409
    );
  }
  const transaction = settled.transaction;
  if (
    !transaction ||
    transaction.type !== "topup" ||
    String(transaction.agentId) !== String(agentId) ||
    money(transaction.amount) !== amount
  ) {
    throw httpError("This payment has no matching wallet top-up credit. Review its settlement before retrying.", 409);
  }

  const agent = await Agent.findById(agentId).lean();
  if (!agent) throw httpError("Agent not found.", 404);

  return { agent, transaction, alreadyCredited: settled.alreadySettled };
}
