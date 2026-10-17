import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

process.env.NETPLUSE_API_KEY = "np_test_hold";
process.env.NETPLUSE_FULFILMENT = "on";
const { Agent, Bundle, Customer, Log, Order, Payment, Transaction } = await import("../src/models/index.js");
const { mapProviderStatus } = await import("../src/lib/netpluseApi.js");
const { fulfilOrder, reverseOrder, syncNetpluseOrder, syncPendingOrders } = await import("../src/lib/fulfilment.js");
const { default: walletRouter } = await import("../src/walletRoutes.js");

function query(value) {
  const result = Promise.resolve(value);
  for (const method of ["session", "sort", "lean", "limit"]) result[method] = () => query(value);
  return result;
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
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
      save: async function () { Object.assign(state.order, this); },
    },
  };
  const session = { withTransaction: async (work) => work(), endSession: async () => {} };
  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(Order, "findOneAndUpdate", (filter, update) => {
    if (filter.status?.$in ? !filter.status.$in.includes(state.order.status) : filter.status && filter.status !== state.order.status) return query(null);
    if (filter.reversedAt === null && state.order.reversedAt) return query(null);
    if (filter.earningsSettledAt === null && state.order.earningsSettledAt) return query(null);
    if (filter.$or && state.order.reversedAt) return query(null);
    Object.assign(state.order, update.$set);
    return query({ ...state.order });
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
    const request = { path, method: options.method || "GET" };
    if (options.body) request.reference = JSON.parse(options.body).reference;
    state.requests.push(request);
    if (path.includes("/order-status/")) {
      state.beforeLookupResponse?.();
      if (state.lookupResponse) return state.lookupResponse;
    }
    if (path.endsWith("/purchase")) {
      state.beforePurchaseResponse?.();
      if (state.purchaseResponse) return state.purchaseResponse;
    }
    const data = path.endsWith("/packages")
      ? { packages: [{ network: "mtn", capacity: "1GB", price: 3.5 }] }
      : { data: { status: state.upstreamStatus, reference: "NP-held", price: 3.5 } };
    return response(data);
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

test("an uncertain purchase is recovered by its original reference without another purchase", async (t) => {
  const state = fixture(t);
  state.order.providerRef = "";
  state.upstreamStatus = "processing";
  const result = await syncNetpluseOrder(state.order);
  assert.equal(result.status, "processing");
  assert.equal(state.order.providerRef, "NP-held");
  assert.deepEqual(state.requests, [{ path: "/api/v1/order-status/DP-held", method: "GET" }]);
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("temporary purchase errors never refund an order that may have been accepted", async (t) => {
  for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
    await t.test(String(status), async (t) => {
      const state = fixture(t, "pending");
      state.purchaseResponse = response({ error: "Request could not be completed." }, status);
      const result = await fulfilOrder(state.order);
      assert.equal(result.indeterminate, true);
      assert.equal(state.order.status, "processing");
      assert.equal(state.order.reversedAt, undefined);
      assert.equal(state.agent.wallet, 10);
      assert.equal(state.payment.status, "fulfilling");
      assert.deepEqual(state.ledger, []);
    });
  }
});

test("a phone throttle reported as a failed purchase remains uncertain", async (t) => {
  const state = fixture(t, "pending");
  state.purchaseResponse = response({
    status: "failed", message: "This phone number has too many recent orders. Please wait a few minutes.",
  });
  const result = await fulfilOrder(state.order);
  assert.equal(result.indeterminate, true);
  assert.equal(state.order.status, "processing");
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("a phone throttle in a status response does not fail or refund a known order", async (t) => {
  const state = fixture(t);
  state.lookupResponse = response({
    status: "failed", message: "This phone number has too many recent orders. Please wait a few minutes.",
  });
  const result = await syncNetpluseOrder(state.order);
  assert.equal(result.ok, false);
  assert.equal(state.order.status, "processing");
  assert.equal(state.order.reversedAt, undefined);
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("an uncertain status lookup never triggers a purchase retry or refund", async (t) => {
  for (const status of [429, 503]) {
    await t.test(String(status), async (t) => {
      const state = fixture(t);
      state.order.providerRef = "";
      state.lookupResponse = response({ error: "Please try again later." }, status);
      await syncNetpluseOrder(state.order);
      assert.equal(state.order.status, "processing");
      assert.deepEqual(state.requests, [{ path: "/api/v1/order-status/DP-held", method: "GET" }]);
      assert.equal(state.agent.wallet, 10);
      assert.deepEqual(state.ledger, []);
    });
  }
});

test("a confirmed missing order can retry once with its original idempotency key", async (t) => {
  const state = fixture(t);
  state.order.providerRef = "";
  state.upstreamStatus = "processing";
  state.lookupResponse = response({ error: "Order not found" }, 404);
  await syncNetpluseOrder(state.order);
  state.lookupResponse = null;
  await syncNetpluseOrder(state.order);
  assert.equal(state.order.providerRef, "NP-held");
  assert.deepEqual(state.requests.filter((request) => request.method === "POST").map((request) => request.reference), ["DP-held"]);
  assert.equal(state.requests[0].path, "/api/v1/order-status/DP-held");
  assert.deepEqual(state.ledger, []);
});

test("a throttled retry is checked again by reference instead of being refunded", async (t) => {
  const state = fixture(t);
  state.order.providerRef = "";
  state.lookupResponse = response({ error: "Order not found" }, 404);
  state.purchaseResponse = response({ error: "This phone number has too many recent orders. Please wait a few minutes." }, 429);
  await syncNetpluseOrder(state.order);
  assert.equal(state.order.status, "processing");
  assert.equal(state.order.reversedAt, undefined);
  state.lookupResponse = null;
  state.upstreamStatus = "processing";
  await syncNetpluseOrder(state.order);
  assert.equal(state.order.providerRef, "NP-held");
  assert.equal(state.requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("a definite initial rejection still refunds the buyer exactly once", async (t) => {
  const state = fixture(t, "pending");
  state.purchaseResponse = response({ error: "Invalid recipient" }, 422);
  await fulfilOrder(state.order);
  await fulfilOrder(state.order);
  assert.equal(state.order.status, "refunded");
  assert.equal(state.agent.wallet, 15);
  assert.equal(state.ledger.length, 1);
});

test("a delayed failure cannot refund an order another worker completed", async (t) => {
  const state = fixture(t);
  const stale = { ...state.order };
  state.upstreamStatus = "failed";
  state.beforeLookupResponse = () => { state.order.status = "completed"; };
  const result = await syncNetpluseOrder(stale);
  assert.equal(result.status, "completed");
  assert.equal(state.order.status, "completed");
  assert.equal(state.order.reversedAt, undefined);
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("a delayed processing response cannot reopen an already refunded order", async (t) => {
  const state = fixture(t);
  const stale = { ...state.order };
  state.upstreamStatus = "processing";
  state.beforeLookupResponse = () => {
    state.order.status = "refunded";
    state.order.reversedAt = new Date();
    state.order.providerMessage = "Confirmed delivery failure; refunded.";
  };
  await syncNetpluseOrder(stale);
  assert.equal(state.order.status, "refunded");
  assert.equal(state.order.providerMessage, "Confirmed delivery failure; refunded.");
  assert.deepEqual(state.ledger, []);
});

test("a delayed purchase response cannot replace a concurrent completed status", async (t) => {
  const state = fixture(t, "pending");
  state.upstreamStatus = "processing";
  state.beforePurchaseResponse = () => { state.order.status = "completed"; };
  const result = await fulfilOrder(state.order);
  assert.equal(result.status, "completed");
  assert.equal(state.order.status, "completed");
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("a stale reversal cannot refund a delivered order", async (t) => {
  const state = fixture(t, "failed");
  const stale = { ...state.order };
  state.order.status = "completed";
  assert.equal(await reverseOrder(stale), false);
  assert.equal(state.order.status, "completed");
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("orders still processing or held cannot be reversed directly", async (t) => {
  for (const status of ["processing", "on_hold"]) {
    const state = fixture(t, status);
    assert.equal(await reverseOrder(state.order), false);
    assert.equal(state.order.status, status);
    assert.equal(state.agent.wallet, 10);
    assert.deepEqual(state.ledger, []);
  }
});

test("a rejected retry cannot prove that the original timed-out purchase failed", async (t) => {
  const state = fixture(t);
  state.order.providerRef = "";
  state.lookupResponse = response({ error: "Order not found" }, 404);
  state.purchaseResponse = response({ error: "Invalid recipient" }, 422);
  await syncNetpluseOrder(state.order);
  assert.equal(state.order.status, "processing");
  assert.equal(state.order.reversedAt, undefined);
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("conflicting provider states cannot turn processing delivery into a refund", async (t) => {
  const state = fixture(t);
  state.lookupResponse = response({ reference: "NP-held", status: "failed", providerStatus: "processing" });
  await syncNetpluseOrder(state.order);
  assert.equal(state.order.status, "processing");
  assert.equal(state.order.reversedAt, undefined);
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("a legacy failed order is restored when the provider still has it processing", async (t) => {
  const state = fixture(t, "failed");
  state.upstreamStatus = "processing";
  assert.equal(await reverseOrder(state.order), false);
  assert.equal(state.order.status, "processing");
  assert.equal(state.order.reversedAt, undefined);
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("a failed purchase response cannot refund an order that its lookup finds processing", async (t) => {
  const state = fixture(t, "pending");
  state.purchaseResponse = response({ status: "failed", reference: "NP-held", message: "Delivery failed" });
  state.upstreamStatus = "processing";
  const result = await fulfilOrder(state.order);
  assert.equal(result.status, "processing");
  assert.equal(state.order.status, "processing");
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("an unavailable confirmation endpoint cannot refund a previously failed order", async (t) => {
  const state = fixture(t, "failed");
  state.lookupResponse = response({ error: "Service unavailable" }, 503);
  assert.equal(await reverseOrder(state.order), false);
  assert.equal(state.order.status, "failed");
  assert.equal(state.order.reversedAt, undefined);
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("delivery discovered during reversal settles earnings instead of refunding", async (t) => {
  const state = fixture(t, "failed");
  state.upstreamStatus = "completed";
  assert.equal(await reverseOrder(state.order), false);
  assert.equal(state.order.status, "completed");
  assert.equal(state.agent.wallet, 10);
  assert.equal(state.agent.commissionAvailable, 1);
  assert.equal(state.admin.wallet, 20.5);
  assert.equal(state.payment.status, "fulfilled");
  assert.ok(state.ledger.every((row) => row.type !== "refund"));
});

test("concurrent confirmed failures credit the wallet only once", async (t) => {
  const state = fixture(t);
  state.upstreamStatus = "failed";
  await Promise.all([syncNetpluseOrder({ ...state.order }), syncNetpluseOrder({ ...state.order })]);
  assert.equal(state.order.status, "refunded");
  assert.equal(state.agent.wallet, 15);
  assert.equal(state.ledger.filter((row) => row.type === "refund").length, 1);
});

test("cancellation before dispatch preserves its status and refunds once", async (t) => {
  const state = fixture(t, "cancelled");
  assert.equal(await reverseOrder({ ...state.order }), true);
  assert.equal(await reverseOrder({ ...state.order, reversedAt: undefined }), false);
  assert.equal(state.order.status, "cancelled");
  assert.equal(state.agent.wallet, 15);
  assert.equal(state.ledger.length, 1);
  assert.equal(state.requests.length, 0);
});

test("a nested phone throttle cannot be hidden by a generic purchase error", async (t) => {
  const state = fixture(t, "pending");
  state.purchaseResponse = response({
    message: "Purchase rejected", data: { status: "failed", error: "This phone number has too many recent orders." },
  }, 400);
  const result = await fulfilOrder(state.order);
  assert.equal(result.indeterminate, true);
  assert.equal(state.order.status, "processing");
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("a throttled legacy failure without a saved provider reference is checked before refunding", async (t) => {
  const state = fixture(t, "failed");
  state.order.providerRef = "";
  state.order.providerMessage = "This phone number has too many recent orders.";
  state.upstreamStatus = "processing";
  assert.equal(await reverseOrder(state.order), false);
  assert.equal(state.order.status, "processing");
  assert.equal(state.order.providerRef, "NP-held");
  assert.deepEqual(state.requests, [{ path: "/api/v1/order-status/DP-held", method: "GET" }]);
  assert.equal(state.agent.wallet, 10);
  assert.deepEqual(state.ledger, []);
});

test("wallet checkout reports a refund only after the wallet reversal commits", async (t) => {
  const handler = walletRouter.stack.find((layer) => layer.route?.path === "/spend").route.stack[0].handle;
  for (const confirmed of [false, true]) {
    await t.test(confirmed ? "confirmed refund" : "unconfirmed refund", async (t) => {
      const state = fixture(t, "pending");
      state.purchaseResponse = confirmed
        ? response({ error: "Invalid recipient" }, 422)
        : response({ status: "failed", reference: "NP-held", message: "Delivery failed" });
      state.lookupResponse = response({ error: "Status temporarily unavailable" }, 503);
      t.mock.method(Bundle, "findOne", () => query({ carrier: "MTN", gb: 1, price: 5, cost: 3.5, active: true }));
      t.mock.method(Agent, "findOneAndUpdate", async (_filter, update) => {
        state.agent.wallet += update.$inc.wallet;
        return state.agent;
      });
      t.mock.method(Order, "create", async ([fields]) => {
        state.order = { ...fields, _id: "order1" };
        return [state.order];
      });
      t.mock.method(Transaction, "create", async (rows) => { state.ledger.push(...rows); return rows; });
      let status;
      let result;
      const res = { status: (code) => { status = code; return res; }, json: (body) => { result = body; } };
      await handler({ agent: { _id: "agent1", role: "agent" }, body: { network: "MTN", gb: 1, phone: "0241234567" } }, res, (error) => { throw error; });
      assert.equal(status, 502);
      if (confirmed) {
        assert.match(result.error, /Your wallet has been refunded/);
        assert.equal(state.agent.wallet, 10);
        assert.equal(state.order.status, "refunded");
      } else {
        assert.match(result.error, /refund has not been confirmed/);
        assert.doesNotMatch(result.error, /Your wallet has been refunded/);
        assert.equal(state.agent.wallet, 5);
        assert.equal(state.order.status, "failed");
      }
    });
  }
});
