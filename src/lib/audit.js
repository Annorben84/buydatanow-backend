import { Log } from "../models/index.js";

/**
 * Record a platform audit event. Fire-and-forget: never throws and never blocks
 * the request path — a logging failure must not fail the action being logged.
 *
 * @param {"error"|"warning"|"info"} level
 * @param {string} message  Human-readable summary (shown on the Logs page).
 * @param {string} source   Origin tag, e.g. "auth", "admin/agents".
 * @param {object} [meta]   Optional structured context.
 */
export async function recordLog(level, message, source = "system", meta) {
  try {
    await Log.create({ level, message, source, meta });
  } catch (err) {
    console.error("[audit] failed to record log:", err.message);
  }
}
