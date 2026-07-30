import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { Agent } from "../models/index.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

if (!process.env.JWT_SECRET) {
  console.warn("⚠ JWT_SECRET is not set — using an insecure dev default. Set it in backend/.env.");
}

/** Hash a plaintext password for storage. */
export function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

/** Compare a plaintext password against a stored hash. */
export function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/** Sign a JWT carrying the agent's id. */
export function signToken(agentId) {
  return jwt.sign({ sub: String(agentId) }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/** Public-safe view of an agent (no passwordHash — it isn't selected anyway). */
export function publicAgent(doc) {
  const a = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(a._id),
    name: a.name,
    email: a.email,
    phone: a.phone,
    wallet: a.wallet,
    revenue: a.revenue,
    tier: a.tier,
    status: a.status,
    role: a.role || "agent",
    createdAt: a.createdAt,
  };
}

/**
 * Express middleware: require a valid Bearer token. On success attaches the
 * authenticated agent to `req.agent`; otherwise responds 401.
 */
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Not authenticated" });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const agent = await Agent.findById(payload.sub);
    if (!agent) return res.status(401).json({ error: "Account no longer exists" });
    if (agent.status === "suspended") return res.status(403).json({ error: "Account suspended" });

    req.agent = agent;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Express middleware: `requireAuth` plus a superadmin role check. Use on
 * admin-only routes; responds 403 for authenticated non-admin accounts.
 */
export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.agent?.role !== "superadmin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  });
}

/**
 * Ensure the superadmin account from ADMIN_EMAIL/ADMIN_PASSWORD exists.
 * Creates it on first boot; promotes an existing account with that email if
 * needed (existing passwords are left untouched). Call after the DB connects.
 */
export async function ensureSuperadmin() {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";

  if (!email || !password) {
    console.warn("⚠ ADMIN_EMAIL / ADMIN_PASSWORD not set — no superadmin account provisioned.");
    return;
  }

  const existing = await Agent.findOne({ email });
  if (existing) {
    if (existing.role !== "superadmin") {
      existing.role = "superadmin";
      await existing.save();
      console.log(`✓ Promoted ${email} to superadmin`);
    }
    return;
  }

  await Agent.create({
    name: process.env.ADMIN_NAME || "Super Admin",
    email,
    passwordHash: await hashPassword(password),
    role: "superadmin",
  });
  console.log(`✓ Superadmin account created (${email})`);
}
