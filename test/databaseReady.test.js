import test from "node:test";
import assert from "node:assert/strict";

import { createDatabaseReadyMiddleware } from "../src/middleware/databaseReady.js";

function responseDouble() {
  return {
    statusCode: null,
    body: null,
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

test("waits for MongoDB before continuing to a model-backed route", async () => {
  const events = [];
  const middleware = createDatabaseReadyMiddleware({
    connect: async () => {
      events.push("connect");
      await Promise.resolve();
      events.push("connected");
    },
    state: () => "connected",
    logger: { error() {} },
  });

  await middleware({}, responseDouble(), () => events.push("next"));

  assert.deepEqual(events, ["connect", "connected", "next"]);
});

test("returns 503 and never runs the route when MongoDB cannot connect", async () => {
  let nextCalled = false;
  const response = responseDouble();
  const middleware = createDatabaseReadyMiddleware({
    connect: async () => {
      throw new Error("connection refused");
    },
    state: () => "disconnected",
    logger: { error() {} },
  });

  await middleware({}, response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, {
    error: "Database temporarily unavailable. Please try again shortly.",
  });
});
