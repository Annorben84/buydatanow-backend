/**
 * Gate database-backed routes until the current function instance has a live
 * MongoDB connection. Vercel may invoke the Express app during a cold start,
 * so model queries must never race mongoose.connect().
 */
export function createDatabaseReadyMiddleware({ connect, state, logger = console, timeoutMs = 4000 }) {
  return async function databaseReady(req, res, next) {
    let timeoutId;
    try {
      await Promise.race([
        connect(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`MongoDB connection timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
          timeoutId.unref?.();
        }),
      ]);
      if (state() !== "connected") {
        throw new Error("MongoDB connection is not ready");
      }
      next();
    } catch (err) {
      logger.error("Database unavailable:", err?.message || err);
      return res.status(503).json({
        error: "Database temporarily unavailable. Please try again shortly.",
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };
}
