import test from "node:test";
import assert from "node:assert/strict";
import { correctRefunds } from "../correct-ruth-order-refunds.mjs";

const refs = ["DP-d6374323-9598-42e3-a7b7-cb06ea0ee483", "DP-7759a363-5407-4e1a-9b12-f45ddad1b83c"];
const buyer = "6a92d165ace39fa249ada323";
const admin = "6a92d165ace39fa249ada324";
const money = (value) => Math.round(value * 100) / 100;
const equal = (a, b) => a instanceof Date && b instanceof Date ? +a === +b : String(a) === String(b);
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value?.$in) return value.$in.some((item) => equal(row[key], item));
    if (value?.$gte !== undefined) return row[key] >= value.$gte;
    return equal(row[key], value);
  });
}
function fixture() {
  const state = { writes: 0, failOrderWrite: false, data: {
    agents: [{ _id: buyer, name: "Buyer", wallet: 138.71 }, { _id: admin, name: "Admin", role: "superadmin", wallet: 50 }],
    customers: [{ _id: "customer", agent: buyer, phone: "0241234567", orders: 3, spent: 100 }],
    orders: refs.map((ref) => ({ _id: ref, ref, agent: buyer, status: "refunded", reversedAt: new Date("2026-10-17T11:30:00Z"), amount: 42.45, platformEarning: 1.24, paymentProvider: "wallet", phone: "0241234567", carrier: "MTN", gb: 10, reversal: { agentWalletAdjustment: 42.45, platformWalletAdjustment: -1.24 } })),
    transactions: refs.flatMap((ref) => [
      { _id: `${ref}-purchase`, reference: `${ref}-purchase`, type: "purchase", amount: -42.45, agentId: buyer },
      { _id: `${ref}-platform`, reference: `${ref}-platform`, type: "commission", amount: 1.24, agentId: admin },
      { _id: `${ref}-refund-agent`, reference: `${ref}-refund-agent`, type: "refund", amount: 42.45, agentId: buyer },
      { _id: `${ref}-refund-platform`, reference: `${ref}-refund-platform`, type: "refund", amount: -1.24, agentId: admin },
    ]), logs: [],
  } };
  const write = (options) => { assert.equal(options.session, "test-session"); state.writes++; };
  const db = { collection: (name) => ({
    find: (filter) => ({ toArray: async () => structuredClone(state.data[name].filter((row) => matches(row, filter))) }),
    findOne: async (filter) => structuredClone(state.data[name].find((row) => matches(row, filter))),
    updateOne: async (filter, update, options) => {
      write(options);
      if (name === "orders" && state.failOrderWrite) throw new Error("Injected database failure");
      const row = state.data[name].find((row) => matches(row, filter));
      if (!row) return { modifiedCount: 0 };
      Object.assign(row, update.$set);
      for (const [key, amount] of Object.entries(update.$inc || {})) row[key] += amount;
      for (const key of Object.keys(update.$unset || {})) delete row[key];
      return { modifiedCount: 1 };
    },
    insertMany: async (rows, options) => {
      write(options);
      for (const row of rows) {
        if (state.data[name].some((entry) => entry.reference === row.reference)) throw new Error("Duplicate ledger reference");
        state.data[name].push(structuredClone(row));
      }
    },
    insertOne: async (row, options) => { write(options); state.data[name].push(structuredClone(row)); },
  }) };
  const live = new Map(refs.map((ref) => [ref, { ok: true, providerRef: ref, status: "processing", raw: "processing", network: "MTN", capacity: "10GB", message: "Processing" }]));
  const transact = async (work) => {
    const snapshot = structuredClone(state.data);
    try { return await work("test-session"); }
    catch (error) { state.data = snapshot; throw error; }
  };
  state.run = (apply = true) => correctRefunds(db, live, { apply, transact });
  return state;
}

test("approved correction restores both orders and balances atomically, retaining refund history", async () => {
  const state = fixture();
  const preview = await state.run(false);
  assert.equal(state.writes, 0);
  assert.equal(preview.walletAfter, 53.81);
  const result = await state.run();
  assert.equal(result.buyerDebit, 84.90);
  assert.equal(money(state.data.agents[0].wallet), 53.81);
  assert.equal(money(state.data.agents[1].wallet), 52.48);
  assert.ok(state.data.orders.every((row) => row.status === "processing" && !row.reversedAt && row.providerRef === row.ref));
  assert.equal(state.data.customers[0].orders, 5);
  assert.equal(money(state.data.customers[0].spent), 184.90);
  assert.equal(state.data.transactions.length, 12);
  assert.equal(state.data.logs.length, 2);
  assert.equal(state.data.transactions.filter((row) => row.type === "refund" && row.reference.includes("before-refund-correction")).length, 4);
  for (const ref of refs) assert.ok(!state.data.transactions.some((row) => row.reference === `${ref}-refund-agent`), "A future genuine failure must have a free refund reference");
  const writes = state.writes;
  assert.equal((await state.run()).alreadyApplied, true);
  assert.equal(state.writes, writes);
  assert.equal(money(state.data.agents[0].wallet), 53.81);
});

test("insufficient balance stops the entire correction before any writes", async () => {
  const state = fixture();
  state.data.agents[0].wallet = 80;
  await assert.rejects(state.run(), /balance is below/);
  assert.equal(state.writes, 0);
  assert.ok(state.data.orders.every((row) => row.status === "refunded"));
});

test("a mismatched refund ledger stops both corrections", async () => {
  const state = fixture();
  state.data.transactions[6].amount = 40;
  await assert.rejects(state.run(), /invalid refund-agent/);
  assert.equal(state.writes, 0);
});

test("a failure after debit rolls back wallets, ledger entries, and order status", async () => {
  const state = fixture();
  const before = structuredClone(state.data);
  state.failOrderWrite = true;
  await assert.rejects(state.run(), /Injected database failure/);
  assert.deepEqual(state.data, before);
});
