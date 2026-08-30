import test from "node:test";
import assert from "node:assert/strict";

import { createMaintenanceModeMiddleware } from "../src/middleware/maintenanceMode.js";

function response() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function run(path, method = "GET", enabled = true) {
  const middleware = createMaintenanceModeMiddleware({ getMode: async () => enabled });
  const res = response();
  let continued = false;
  await middleware({ path, method }, res, () => {
    continued = true;
  });
  return { res, continued };
}

test("blocks agent and customer APIs during maintenance", async () => {
  const { res, continued } = await run("/wallet/spend", "POST");
  assert.equal(continued, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["Retry-After"], "60");
  assert.equal(res.body.code, "MAINTENANCE_MODE");
});

test("keeps public settings and Superadmin access available", async () => {
  for (const [path, method] of [
    ["/settings", "GET"],
    ["/auth/admin/login", "POST"],
    ["/auth/me", "GET"],
    ["/admin/settings", "PUT"],
  ]) {
    const { continued } = await run(path, method);
    assert.equal(continued, true, `${method} ${path} should remain available`);
  }
});

test("passes all requests when maintenance is disabled", async () => {
  const { continued } = await run("/wallet/spend", "POST", false);
  assert.equal(continued, true);
});
