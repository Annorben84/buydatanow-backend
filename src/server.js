import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";

import { connectDB, dbState } from "./config/db.js";
import { ensureSuperadmin } from "./lib/auth.js";
import { paystackMode, paystackConfigured } from "./lib/paystackApi.js";
import { netpluseStatus } from "./lib/netpluseApi.js";
import { startFulfilmentPoller } from "./lib/fulfilment.js";
import routes from "./routes.js";
import authRoutes from "./authRoutes.js";
import adminRoutes from "./adminRoutes.js";
import walletRoutes from "./walletRoutes.js";
import paystackRoutes from "./paystackRoutes.js";
import storefrontPaymentRoutes from "./storefrontPaymentRoutes.js";
import { paystackWebhook } from "./paystackWebhook.js";
import { createDatabaseReadyMiddleware } from "./middleware/databaseReady.js";
import { maintenanceMode } from "./middleware/maintenanceMode.js";
import { notFound, errorHandler } from "./middleware/error.js";

const app = express();
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const IS_VERCEL = Boolean(process.env.VERCEL);

let databaseConnectionPromise = null;
let databaseInitialized = false;
let databaseRetryTimer = null;

async function connectDatabase() {
  if (dbState() === "connected") return;
  if (databaseConnectionPromise) return databaseConnectionPromise;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  databaseConnectionPromise = (async () => {
    // Let a later invocation retry instead of keeping one serverless request in
    // the long retry loop used by a normal always-on process.
    await connectDB(uri, { retries: IS_VERCEL ? 0 : 4 });
    console.log("✓ MongoDB connected");

    if (!databaseInitialized) {
      await ensureSuperadmin();
      databaseInitialized = true;

      // This is durable on an always-on host and best-effort per warm Vercel
      // instance. The recovery work is idempotent, so overlapping warm
      // instances cannot dispatch the same pending order twice.
      startFulfilmentPoller();
    }
  })().finally(() => {
    databaseConnectionPromise = null;
  });

  return databaseConnectionPromise;
}

const requireDatabase = createDatabaseReadyMiddleware({
  connect: connectDatabase,
  state: dbState,
});

app.use(cors({ origin: CLIENT_URL.split(",").map((s) => s.trim()), credentials: true }));
// Signature verification needs the untouched bytes, so this route must be
// registered before the global JSON parser.
app.post(
  "/api/paystack/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  requireDatabase,
  paystackWebhook
);
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
    fulfilment: netpluseStatus(),
    time: new Date().toISOString(),
  });
});

// Authentication and every route below it query MongoDB. During a Vercel cold
// start, wait for the shared connection before any Mongoose model can run.
app.use("/api", requireDatabase);
app.use("/api", maintenanceMode);

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/wallet/paystack", paystackRoutes);
app.use("/api/wallet", walletRoutes);
// Mounted before the legacy catch-all routes so unsafe historical purchase
// handlers can never be reached.
app.use("/api", storefrontPaymentRoutes);
app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

// Transient network/DNS blips (e.g. EAI_AGAIN) can surface as stray rejections
// from the driver's background work. Log them instead of letting them terminate
// the API — the MongoDB driver reconnects on its own.
process.on("unhandledRejection", (err) => {
  console.error("⚠ Unhandled rejection:", err?.message || err);
});

// Vercel discovers the default export and runs it as one Fluid Compute
// Function. Long-running hosts still use the normal port listener.
if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`→ BuyDataNow API listening on port ${PORT}`);
    console.log(`  CORS origin: ${CLIENT_URL}`);
    console.log(`  Paystack: ${paystackConfigured() ? `${paystackMode()} mode` : "not configured"}`);
    console.log(`  Fulfilment (Netpluse): ${netpluseStatus()}`);
  });
}

function handleDatabaseStartupFailure(err) {
  console.error("✗ MongoDB connection failed:", err.message);
  console.error("  DB routes return 503 until the connection succeeds.");
  console.error("  Check MONGODB_URI and MongoDB Atlas Network Access.");

  if (!IS_VERCEL && !databaseRetryTimer) {
    databaseRetryTimer = setTimeout(() => {
      databaseRetryTimer = null;
      void connectDatabase().catch(handleDatabaseStartupFailure);
    }, 30000);
    databaseRetryTimer.unref?.();
  }
}

// Start warming MongoDB immediately. A request arriving during the cold start
// awaits this same promise through requireDatabase above.
void connectDatabase().catch(handleDatabaseStartupFailure);

export default app;
