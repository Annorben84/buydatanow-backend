import test from "node:test";
import assert from "node:assert/strict";

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
