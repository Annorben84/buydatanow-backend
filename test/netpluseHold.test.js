import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

process.env.NETPLUSE_API_KEY = "np_test_hold";
process.env.NETPLUSE_FULFILMENT = "on";
const { Agent, Customer, Log, Order, Payment, Transaction } = await import("../src/models/index.js");
const { mapProviderStatus } = await import("../src/lib/netpluseApi.js");
const { fulfilOrder, syncNetpluseOrder, syncPendingOrders } = await import("../src/lib/fulfilment.js");

function query(value) {
  const result = Promise.resolve(value);
  for (const method of ["session", "sort", "lean", "limit"]) result[method] = () => query(value);
  return result;
}

function fixture(t, status = "processing") {
  const state = {
    upstreamStatus: "on-hold", requests: [], queries: [], ledger: [],
    agent: { _id: "agent1", name: "Agent", wallet: 10, commissionAvailable: 0 },
    admin: { _id: "admin1", name: "Admin", wallet: 20 },
    payment: { amount: 5, chargedAmount: 5, gatewayFee: 0, status: "fulfilling" },
    order: {
      _id: "order1", ref: "DP-held", agent: "agent1", status, provider: "netpluse",
      providerRef: status === "pending" ? "" : "NP-held", phone: "0241234567", carrier: "MTN",
      gb: 1, amount: 5, earning: 1, platformEarning: 0.5, settlementModel: "platform_collected",
      paymentReference: "PAY-held", reversal: { agent: "agent1", credit: 5 },
      save: async () => {},
    },
  };
  const session = { withTransaction: async (work) => work(), endSession: async () => {} };
  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(Order, "findOneAndUpdate", (filter, update) => {
    if (filter.status && filter.status !== state.order.status) return query(null);
    if (filter.earningsSettledAt === null && state.order.earningsSettledAt) return query(null);
    if (filter.$or && state.order.reversedAt) return query(null);
    Object.assign(state.order, update.$set);
    return query(state.order);
  });
  t.mock.method(Order, "findById", () => query(state.order));
  t.mock.method(Order, "find", (filter) => {
    state.queries.push(filter);
    return query(filter.provider === "netpluse" && filter.status.$in.includes(state.order.status) ? [state.order] : []);
  });
  t.mock.method(Agent, "findById", () => query(state.agent));
  t.mock.method(Agent, "findOne", () => query(state.admin));
  t.mock.method(Agent, "updateOne", async (filter, update) => {
    const account = filter._id === state.agent._id ? state.agent : state.admin;
    for (const [key, amount] of Object.entries(update.$inc)) account[key] = (account[key] || 0) + amount;
  });
  t.mock.method(Agent, "findByIdAndUpdate", async (_id, update) => {
    state.agent.wallet += update.$inc.wallet;
    return state.agent;
  });
  t.mock.method(Payment, "findOne", () => query(state.payment));
  t.mock.method(Payment, "updateOne", async (_filter, update) => Object.assign(state.payment, update.$set));
  t.mock.method(Customer, "updateOne", async () => {});
  t.mock.method(Transaction, "create", async (rows) => state.ledger.push(...rows));
  t.mock.method(Log, "create", async () => {});
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const path = new URL(url).pathname;
    state.requests.push({ path, method: options.method || "GET" });
    const data = path.endsWith("/packages")
      ? { packages: [{ network: "mtn", capacity: "1GB", price: 3.5 }] }
      : { data: { status: state.upstreamStatus, reference: "NP-held", price: 3.5 } };
    return { ok: true, status: 200, json: async () => data };
  });
  return state;
}

test("recognizes provider hold spellings and accepts the saved order state", async () => {
  for (const status of ["on-hold", "on_hold", "On Hold", " ON HOLD ", "onhold", "hold", "held"]) {
    assert.equal(mapProviderStatus(status), "on_hold");
  }
  assert.equal(mapProviderStatus("queued"), "processing");
  await new Order({ status: "on_hold" }).validate();
});

test("an order accepted on hold is not refunded or dispatched again", async (t) => {
  const state = fixture(t, "pending");
  const first = await fulfilOrder(state.order);
  const repeated = await fulfilOrder(state.order);
  assert.equal(first.status, "on_hold");
  assert.equal(repeated.alreadyDispatched, true);
  assert.equal(state.order.providerStatus, "on-hold");
  assert.equal(state.requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(state.agent.wallet, 10);
  assert.equal(state.payment.status, "fulfilling");
  assert.equal(state.order.reversedAt, undefined);
  assert.equal(state.order.earningsSettledAt, undefined);
  assert.deepEqual(state.ledger, []);
});

test("processing orders move onto hold, resume, and settle delivery earnings once", async (t) => {
  const state = fixture(t);
  const held = await syncNetpluseOrder(state.order);
  assert.equal(held.status, "on_hold");
  assert.equal(state.order.status, "on_hold");
  assert.match(held.message, /on hold/);
  assert.deepEqual(state.ledger, []);
  state.upstreamStatus = "processing";
  await syncNetpluseOrder(state.order);
  assert.equal(state.order.status, "processing");
  state.upstreamStatus = "On Hold";
  await syncNetpluseOrder(state.order);
  state.upstreamStatus = "delivered";
  await syncNetpluseOrder(state.order);
  await syncNetpluseOrder(state.order);
  assert.equal(state.order.status, "completed");
  assert.ok(state.order.deliveredAt instanceof Date);
  assert.equal(state.agent.commissionAvailable, 1);
  assert.equal(state.admin.wallet, 20.5);
  assert.equal(state.payment.status, "fulfilled");
  assert.equal(state.ledger.length, 2);
});

test("a held order that later fails is refunded once", async (t) => {
  const state = fixture(t, "on_hold");
  state.upstreamStatus = "failed";
  await syncNetpluseOrder(state.order);
  await syncNetpluseOrder(state.order);
  assert.equal(state.order.status, "refunded");
  assert.equal(state.agent.wallet, 15);
  assert.equal(state.admin.wallet, 20);
  assert.equal(state.payment.status, "refunded");
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0].type, "refund");
});

test("held orders keep being checked by the background poller", async (t) => {
  const state = fixture(t, "on_hold");
  const result = await syncPendingOrders();
  assert.equal(result.checked, 1);
  assert.equal(state.order.status, "on_hold");
  assert.ok(state.queries.some((filter) => filter.provider === "netpluse" && filter.status.$in.includes("on_hold")));
  assert.deepEqual(state.requests.map((request) => request.method), ["GET"]);
  assert.deepEqual(state.ledger, []);
});

test("a temporary provider outage leaves a held order active", async (t) => {
  const state = fixture(t, "on_hold");
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Temporary outage"); });
  const result = await syncNetpluseOrder(state.order);
  assert.equal(result.ok, false);
  assert.equal(state.order.status, "on_hold");
  assert.equal(state.order.reversedAt, undefined);
  assert.deepEqual(state.ledger, []);
});

test("a stale hold response does not reopen a delivered or refunded order", async (t) => {
  const state = fixture(t, "completed");
  await syncNetpluseOrder(state.order);
  assert.equal(state.order.status, "completed");
  state.order.status = "refunded";
  await syncNetpluseOrder(state.order);
  assert.equal(state.order.status, "refunded");
  assert.deepEqual(state.ledger, []);
});
