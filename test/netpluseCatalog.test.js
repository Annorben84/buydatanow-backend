import test from "node:test";
import assert from "node:assert/strict";

test("checks an order with the documented Netpluse reference endpoint", async () => {
  const originalKey = process.env.NETPLUSE_API_KEY;
  const originalBase = process.env.NETPLUSE_BASE_URL;
  const originalFetch = global.fetch;
  let request;

  process.env.NETPLUSE_API_KEY = "np_test_order_status";
  process.env.NETPLUSE_BASE_URL = "https://netpluse.shop/api/v1";
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        reference: "NPAPI-1234-abc",
        network: "MTN",
        capacity: "1GB",
        status: "completed",
        createdAt: "2026-06-15T10:24:00.000Z",
      }),
    };
  };

  try {
    const { netpluseOrderStatus } = await import(
      `../src/lib/netpluseApi.js?order-status-test=${Date.now()}`
    );
    const result = await netpluseOrderStatus("NPAPI-1234-abc");

    assert.equal(request.url, "https://netpluse.shop/api/v1/order-status/NPAPI-1234-abc");
    assert.equal(request.options.headers["x-api-key"], "np_test_order_status");
    assert.deepEqual(result, {
      ok: true,
      providerRef: "NPAPI-1234-abc",
      status: "completed",
      raw: "completed",
      network: "MTN",
      capacity: "1GB",
      createdAt: "2026-06-15T10:24:00.000Z",
      message: "",
      cost: 0,
    });
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NETPLUSE_API_KEY;
    else process.env.NETPLUSE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.NETPLUSE_BASE_URL;
    else process.env.NETPLUSE_BASE_URL = originalBase;
  }
});

test("live-only catalog reads never fall back to cached Netpluse costs", async () => {
  const originalKey = process.env.NETPLUSE_API_KEY;
  const originalFetch = global.fetch;

  process.env.NETPLUSE_API_KEY = "np_test_catalog";
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      packages: [{ network: "mtn", capacity: "1GB", price: 4.4, validity: "30 days" }],
    }),
  });

  try {
    const { netpluseCatalog } = await import(
      `../src/lib/netpluseApi.js?catalog-test=${Date.now()}`
    );

    const fresh = await netpluseCatalog({ force: true, allowStale: false });
    assert.equal(fresh[0].carrier, "MTN");
    assert.equal(fresh[0].cost, 4.4);

    global.fetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "Netpluse catalog is unavailable." }),
    });

    const cached = await netpluseCatalog({ force: true });
    assert.equal(cached[0].cost, 4.4);

    await assert.rejects(
      () => netpluseCatalog({ force: true, allowStale: false }),
      /Netpluse catalog is unavailable/
    );
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NETPLUSE_API_KEY;
    else process.env.NETPLUSE_API_KEY = originalKey;
  }
});

test("normalizes live WAEC checker pricing from Netpluse", async () => {
  const originalKey = process.env.NETPLUSE_API_KEY;
  const originalFetch = global.fetch;

  process.env.NETPLUSE_API_KEY = "np_test_checkers";
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      checkers: [
        {
          id: "waec",
          name: "WAEC Result Checker",
          description: "Check WASSCE results",
          price: 17.5,
          available: true,
        },
      ],
    }),
  });

  try {
    const { netpluseCheckers } = await import(
      `../src/lib/netpluseApi.js?checker-test=${Date.now()}`
    );
    const rows = await netpluseCheckers();
    assert.deepEqual(rows[0], {
      id: "waec",
      name: "WAEC Result Checker",
      description: "Check WASSCE results",
      price: 17.5,
      available: true,
    });
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NETPLUSE_API_KEY;
    else process.env.NETPLUSE_API_KEY = originalKey;
  }
});
