import { Router } from "express";
import { requireAuth, publicAgent } from "./lib/auth.js";
import { Agent } from "./models/Agent.js";
import { CheckerPurchase } from "./models/CheckerPurchase.js";
import { AgentCheckerMargin } from "./models/AgentCheckerMargin.js";
import { checkerCatalog, reserveCheckerPurchase, syncCheckerPurchase, publicCheckerPurchase } from "./lib/checkerPurchases.js";

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

router.get("/margins", async (req, res, next) => {
  try {
    const [catalog, margins] = await Promise.all([checkerCatalog("agent"), AgentCheckerMargin.find({ agent: req.agent._id }).lean()]);
    res.json({ data: catalog.map((row) => {
      const margin = margins.find((item) => item.type === row.type)?.margin || 0;
      return { type: row.type, name: row.name, platformPrice: row.unitPrice, margin, sellingPrice: Math.round((row.unitPrice + margin) * 100) / 100 };
    }) });
  } catch (error) { next(error); }
});

router.put("/margins/:type", async (req, res, next) => {
  try {
    const { type } = req.params;
    const margin = req.body?.margin;
    if (!["waec", "bece"].includes(type) || typeof margin !== "number" || !Number.isFinite(margin) || margin < 0 || margin > 1000) {
      return res.status(400).json({ error: "Choose WAEC or BECE and a margin from GHS 0.00 to 1,000.00." });
    }
    const saved = await AgentCheckerMargin.findOneAndUpdate({ agent: req.agent._id, type }, { $set: { margin: Math.round(margin * 100) / 100 } }, { upsert: true, new: true, runValidators: true });
    res.json({ data: { type: saved.type, margin: saved.margin } });
  } catch (error) { next(error); }
});

router.get("/", async (req, res, next) => {
  try {
    const data = await checkerCatalog(req.agent.role);
    res.json({ data: data.map((row) => ({ type: row.type, name: row.name, description: row.description, available: row.available, unitPrice: row.unitPrice, maxQuantity: row.maxQuantity })) });
  } catch (error) { next(error); }
});

router.post("/purchase", async (req, res, next) => {
  try {
    const purchase = await reserveCheckerPurchase(req.agent, req.body);
    try { await syncCheckerPurchase(purchase._id); } catch { /* Recover through the buyer's status request. */ }
    const saved = await CheckerPurchase.findById(purchase._id).select("+pins");
    const buyer = await Agent.findById(req.agent._id);
    res.json({ data: { purchase: publicCheckerPurchase(saved, true), agent: publicAgent(buyer) } });
  } catch (error) { next(error); }
});

router.get("/history", async (req, res, next) => {
  try {
    const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
    const limit = 20;
    const filter = { agent: req.agent._id, channel: { $ne: "public" } };
    if (["waec", "bece"].includes(req.query.type)) filter.type = req.query.type;
    const [rows, total] = await Promise.all([
      CheckerPurchase.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
      CheckerPurchase.countDocuments(filter),
    ]);
    res.json({ data: { items: rows.map((row) => publicCheckerPurchase(row)), page, total, limit } });
  } catch (error) { next(error); }
});

router.get("/:reference", async (req, res, next) => {
  try {
    const filter = { agent: req.agent._id, reference: req.params.reference, channel: { $ne: "public" } };
    const purchase = await CheckerPurchase.findOne(filter);
    if (!purchase) return res.status(404).json({ error: "Checker purchase not found." });
    try { await syncCheckerPurchase(purchase._id); } catch { /* Keep saved purchases available during provider outages. */ }
    const saved = await CheckerPurchase.findOne(filter).select("+pins");
    res.json({ data: publicCheckerPurchase(saved, true) });
  } catch (error) { next(error); }
});

export default router;
