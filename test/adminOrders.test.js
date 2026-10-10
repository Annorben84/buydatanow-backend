import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.JWT_SECRET = "admin-orders-test-only";
const { Agent, Order } = await import("../src/models/index.js");
const { signToken } = await import("../src/lib/auth.js");
const { default: router } = await import("../src/adminRoutes.js");

const accounts = [
  { _id: "admin", name: "Platform Owner", role: "superadmin", status: "active" },
  { _id: "ama", name: "Ama Mensah", email: "ama@example.test", role: "agent", status: "active" },
  { _id: "kwame", name: "Kwame Owusu", email: "kwame@example.test", role: "agent", status: "active" },
];

function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((condition) => matches(row, condition));
    if (value instanceof RegExp) return value.test(String(row[key] ?? ""));
    if (value?.$in) return value.$in.includes(row[key]);
    return row[key] === value;
  });
}

function query(rows) {
  let result = [...rows];
  return {
    select() { return this; },
    sort() { result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b._id.localeCompare(a._id)); return this; },
    skip(count) { result = result.slice(count); return this; },
    limit(count) { result = result.slice(0, count); return this; },
    populate() {
      result = result.map((row) => ({ ...row, agent: accounts.find((agent) => agent._id === row.agent) || null }));
      return this;
    },
    lean: async () => result,
  };
}

function order(id, agent, fields = {}) {
  return {
    _id: id, ref: `ORDER-${id}`, agent, store: "", customer: "Customer", phone: "0241234567",
    carrier: "MTN", bundle: "1 GB", amount: 5, status: "completed", createdAt: "2026-10-08T10:00:00Z",
    ...fields,
  };
}

async function fixture(t, orders) {
  const state = { reads: 0 };
  t.mock.method(Agent, "findById", async (id) => accounts.find((agent) => agent._id === id));
  t.mock.method(Agent, "find", (filter) => query(accounts.filter((agent) => matches(agent, filter))));
  t.mock.method(Order, "find", (filter) => {
    state.reads++;
    return query(orders.filter((row) => matches(row, filter)));
  });
  t.mock.method(Order, "countDocuments", async (filter) => orders.filter((row) => matches(row, filter)).length);

  const app = express();
  app.use("/api/admin", router);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  state.get = async (params = "", account = "admin") => {
    const headers = account ? { Authorization: `Bearer ${signToken(account)}` } : {};
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/orders${params}`, { headers });
    return { status: response.status, body: await response.json() };
  };
  return state;
}

test("superadmin sees orders from every agent and portal with owner details, newest first", async (t) => {
  const state = await fixture(t, [
    order("1", "ama", { store: "Ama Store", status: "failed" }),
    order("2", "kwame", { store: "Kwame Store", status: "cancelled" }),
    order("3", "admin", { createdAt: "2026-10-08T11:00:00Z" }),
    order("4", "deleted-agent", { status: "refunded" }),
  ]);
  const { status, body: { data } } = await state.get();
  assert.equal(status, 200);
  assert.equal(data.total, 4);
  assert.deepEqual(data.items.map((row) => row.ref), ["ORDER-3", "ORDER-4", "ORDER-2", "ORDER-1"]);
  assert.deepEqual(data.items.map((row) => row.agentName), ["Platform Owner", "—", "Kwame Owusu", "Ama Mensah"]);
  assert.equal(data.items[3].agent, "ama");
  assert.equal(data.items[3].agentEmail, "ama@example.test");
  assert.equal(data.items[1].agent, null);
});

test("older orders remain reachable after the first 50 records", async (t) => {
  const orders = Array.from({ length: 51 }, (_, index) => order(String(index).padStart(3, "0"), "ama"));
  const state = await fixture(t, orders);
  const first = (await state.get()).body.data;
  const second = (await state.get("?page=2")).body.data;
  assert.equal(first.total, 51);
  assert.equal(first.items.length, 50);
  assert.equal(second.page, 2);
  assert.equal(second.pageSize, 50);
  assert.deepEqual(second.items.map((row) => row.ref), ["ORDER-000"]);
  assert.ok(!first.items.some((row) => row.ref === "ORDER-000"));
});

test("search and filters include agent names, phones, stores and literal reference characters", async (t) => {
  const state = await fixture(t, [
    order("1", "ama", { store: "Ama Shop", status: "processing", carrier: "Telecel", paymentReference: "PAY-[1]" }),
    order("2", "kwame", { store: "Kwame Shop", phone: "0207654321" }),
  ]);
  for (const q of ["Ama Mensah", "Ama Shop", "0241234567", "PAY-[1]", "ORDER-1"]) {
    const result = await state.get(`?q=${encodeURIComponent(q)}&status=processing&carrier=Telecel`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.items.map((row) => row.ref), ["ORDER-1"]);
  }
  const none = (await state.get("?q=.&status=completed")).body.data;
  assert.equal(none.total, 0, "a period must be treated as a literal search character");
  const mismatch = (await state.get("?q=Ama&carrier=MTN")).body.data;
  assert.equal(mismatch.total, 0);
});

test("invalid filters are rejected before reading orders", async (t) => {
  const state = await fixture(t, []);
  for (const params of ["?page=0", "?page=1.5", "?page=abc", "?page=1000001", "?status=unknown", "?carrier=unknown"]) {
    assert.equal((await state.get(params)).status, 400);
  }
  assert.equal(state.reads, 0);
});

test("on-hold orders appear across agents and can be filtered separately", async (t) => {
  const state = await fixture(t, [
    order("1", "ama", { status: "on_hold", providerRef: "NP-held-1" }),
    order("2", "kwame", { status: "on_hold", store: "Kwame Shop" }),
    order("3", "ama", { status: "processing" }),
  ]);
  assert.equal((await state.get()).body.data.total, 3);
  const result = await state.get("?status=on_hold");
  assert.equal(result.status, 200);
  assert.equal(result.body.data.total, 2);
  assert.deepEqual(result.body.data.items.map((row) => row.ref), ["ORDER-2", "ORDER-1"]);
});

test("ordinary agents and unauthenticated requests cannot read platform orders", async (t) => {
  const state = await fixture(t, [order("1", "ama")]);
  assert.equal((await state.get("", "ama")).status, 403);
  assert.equal((await state.get("", null)).status, 401);
  assert.equal(state.reads, 0);
});
