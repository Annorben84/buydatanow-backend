import test from "node:test";
import assert from "node:assert/strict";

import { parseDohSrvAnswers, parseDohTxtAnswers } from "../src/config/db.js";

test("parses DNS-over-HTTPS Atlas SRV records for the MongoDB driver", () => {
  assert.deepEqual(
    parseDohSrvAnswers([
      { type: 33, data: "0 5 27017 shard.example.mongodb.net." },
    ]),
    [{ priority: 0, weight: 5, port: 27017, name: "shard.example.mongodb.net" }]
  );
});

test("parses DNS-over-HTTPS TXT records into driver-compatible chunks", () => {
  assert.deepEqual(
    parseDohTxtAnswers([{ type: 16, data: '"authSource=admin&replicaSet=test"' }]),
    [["authSource=admin&replicaSet=test"]]
  );
});
