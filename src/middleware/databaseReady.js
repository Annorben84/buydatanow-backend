/**
 * Gate database-backed routes until the current function instance has a live
 * MongoDB connection. Vercel may invoke the Express app during a cold start,
 * so model queries must never race mongoose.connect().
 */
export function createDatabaseReadyMiddleware({ connect, state, logger = console }) {
  return async function databaseReady(req, res, next) {
    try {
      await connect();
      if (state() !== "connected") {
        throw new Error("MongoDB connection is not ready");
      }
      next();
    } catch (err) {
      logger.error("Database unavailable:", err?.message || err);
      return res.status(503).json({
        error: "Database temporarily unavailable. Please try again shortly.",
      });
    }
  };
}
