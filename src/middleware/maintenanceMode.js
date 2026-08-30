import { getSettings } from "../lib/settings.js";

const CACHE_MS = 2_000;
let cachedMode = false;
let cacheExpiresAt = 0;

async function readMaintenanceMode() {
  if (Date.now() < cacheExpiresAt) return cachedMode;
  const settings = await getSettings();
  cachedMode = Boolean(settings.maintenanceMode);
  cacheExpiresAt = Date.now() + CACHE_MS;
  return cachedMode;
}

/** Make an admin toggle visible to the next request immediately. */
export function invalidateMaintenanceModeCache() {
  cacheExpiresAt = 0;
}

const isExempt = (req) => {
  const path = req.path || "";
  return (
    req.method === "OPTIONS" ||
    (req.method === "GET" && path === "/settings") ||
    path === "/auth/admin/login" ||
    path === "/auth/me" ||
    path === "/admin" ||
    path.startsWith("/admin/")
  );
};

export function createMaintenanceModeMiddleware({ getMode = readMaintenanceMode } = {}) {
  return async function maintenanceMode(req, res, next) {
    try {
      if (isExempt(req) || !(await getMode())) return next();
      res.set("Retry-After", "60");
      return res.status(503).json({
        error: "The platform is temporarily offline for scheduled maintenance. Please try again shortly.",
        code: "MAINTENANCE_MODE",
        maintenanceMode: true,
      });
    } catch (error) {
      next(error);
    }
  };
}

export const maintenanceMode = createMaintenanceModeMiddleware();
