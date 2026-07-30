import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";

import { connectDB, dbState } from "./config/db.js";
import { ensureSuperadmin } from "./lib/auth.js";
import { paystackMode, paystackConfigured } from "./lib/paystackApi.js";
import { remaStatus } from "./lib/remaApi.js";
import { startFulfilmentPoller } from "./lib/fulfilment.js";
import routes from "./routes.js";
import authRoutes from "./authRoutes.js";
import adminRoutes from "./adminRoutes.js";
import walletRoutes from "./walletRoutes.js";
import paystackRoutes from "./paystackRoutes.js";
import { notFound, errorHandler } from "./middleware/error.js";

const app = express();
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

app.use(cors({ origin: CLIENT_URL.split(",").map((s) => s.trim()), credentials: true }));
app.use(express.json());
app.use(morgan("dev"));

app.get("/", (req, res) => {
  res.json({ name: "BuyDataNow API", status: "ok", docs: "/api/health" });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    db: dbState(),
    paystack: paystackConfigured() ? paystackMode() : "not-configured",
    fulfilment: remaStatus(),
    time: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/wallet/paystack", paystackRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

// Transient network/DNS blips (e.g. EAI_AGAIN) can surface as stray rejections
// from the driver's background work. Log them instead of letting them terminate
// the API — the MongoDB driver reconnects on its own.
process.on("unhandledRejection", (err) => {
  console.error("⚠ Unhandled rejection:", err?.message || err);
});

// Open the port FIRST, then reach for Mongo. Render (like most container
// hosts) only marks a deploy live once the port is open and the health check
// answers, and it kills the instance if that takes too long. connectDB spends
// up to ~70s retrying an unreachable DSN, so connecting first held the port
// shut past that window: the deploy failed and every request to the service
// hung with no response at all. The API is worth serving before the DB is up —
// /api/health reports `db` state, and the driver reconnects on its own.
app.listen(PORT, () => {
  console.log(`→ BuyDataNow API listening on port ${PORT}`);
  console.log(`  CORS origin: ${CLIENT_URL}`);
  console.log(`  Paystack: ${paystackConfigured() ? `${paystackMode()} mode` : "not configured"}`);
  console.log(`  Fulfilment (Rema Data): ${remaStatus()}`);
});

async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("⚠ MONGODB_URI is not set — add it to backend/.env. DB routes will error.");
    return;
  }
  try {
    await connectDB(uri);
    console.log("✓ MongoDB connected");
    await ensureSuperadmin();
    // Rema accepts orders as "pending" and delivers moments later, so poll
    // the ones still in flight and settle (or refund) them.
    startFulfilmentPoller();
  } catch (err) {
    console.error("✗ MongoDB connection failed:", err.message);
    console.error("  The API is up, but DB routes will error until this is fixed.");
    console.error("  On a hosted deploy this is usually the database firewall:");
    console.error("  Atlas → Network Access must allow the host's outbound IPs.");
  }
}

connectDatabase();
