import { Router } from "express";

import { Agent } from "./models/index.js";
import {
  hashPassword,
  comparePassword,
  signToken,
  publicAgent,
  requireAuth,
} from "./lib/auth.js";
import { recordLog } from "./lib/audit.js";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Canonical phone form for storage/lookup — digits only (drops spaces, +, dashes). */
const normalizePhone = (v) => String(v || "").replace(/\D/g, "");

/** POST /api/auth/register — create an agent account and return a session token. */
router.post("/register", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    // Store the phone digit-normalized so agents can later sign in with it
    // regardless of how they type the separators.
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || "");

    if (name.length < 2) return res.status(400).json({ error: "Please enter your name." });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    const existing = await Agent.findOne({ email });
    if (existing) return res.status(409).json({ error: "An account with that email already exists." });

    const passwordHash = await hashPassword(password);
    const agent = await Agent.create({ name, email, phone, passwordHash });

    const token = signToken(agent._id);
    res.status(201).json({ data: { token, agent: publicAgent(agent) } });
  } catch (err) {
    // Duplicate key from the unique index (race between the check and create).
    if (err?.code === 11000) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    next(err);
  }
});

/**
 * POST /api/auth/login — verify credentials and return a session token. The
 * identifier can be an email OR a phone number (`identifier`, with `email` kept
 * as a fallback for older clients).
 */
router.post("/login", async (req, res, next) => {
  try {
    const identifier = String(req.body.identifier ?? req.body.email ?? req.body.phone ?? "").trim();
    const password = String(req.body.password || "");

    if (!identifier || !password) {
      return res.status(400).json({ error: "Enter your email or phone and password." });
    }

    // Look the account up by email when it looks like one, otherwise by phone.
    // Phone is matched both as typed and digit-normalized so formatting differs
    // safely; the normalized form is empty-guarded so blank phones never match.
    let query;
    if (EMAIL_RE.test(identifier)) {
      query = { email: identifier.toLowerCase() };
    } else {
      const digits = normalizePhone(identifier);
      const phones = [identifier];
      if (digits) phones.push(digits);
      query = { phone: { $in: phones } };
    }

    // Need the hash for this one comparison — it's `select:false` by default.
    const agent = await Agent.findOne(query).select("+passwordHash");
    // Compare even when no account/hash to keep timing uniform, then fail generically.
    const ok = agent?.passwordHash
      ? await comparePassword(password, agent.passwordHash)
      : await comparePassword(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinva");

    if (!agent || !ok) return res.status(401).json({ error: "Invalid email/phone or password." });
    if (agent.status === "suspended") return res.status(403).json({ error: "Account suspended." });

    const token = signToken(agent._id);
    res.json({ data: { token, agent: publicAgent(agent) } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/admin/login — superadmin sign-in for the /admin console.
 * Non-admin accounts get the same generic 401 as bad credentials, so the
 * endpoint doesn't reveal which emails hold admin access.
 */
router.post("/admin/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const agent = await Agent.findOne({ email }).select("+passwordHash");
    const ok = agent?.passwordHash
      ? await comparePassword(password, agent.passwordHash)
      : await comparePassword(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinva");

    if (!agent || !ok || agent.role !== "superadmin") {
      recordLog("warning", `Failed admin sign-in · ${email || "(no email)"}`, "auth", { email });
      return res.status(401).json({ error: "Invalid email or password." });
    }
    if (agent.status === "suspended") return res.status(403).json({ error: "Account suspended." });

    const token = signToken(agent._id);
    recordLog("info", `Admin signed in · ${agent.name}`, "auth", { email: agent.email });
    res.json({ data: { token, agent: publicAgent(agent) } });
  } catch (err) {
    next(err);
  }
});

/** GET /api/auth/me — return the currently authenticated agent. */
router.get("/me", requireAuth, (req, res) => {
  res.json({ data: { agent: publicAgent(req.agent) } });
});

export default router;
