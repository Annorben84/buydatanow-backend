/**
 * Like `crud`, but every operation is scoped to the authenticated agent
 * (`req.agent`, set by `requireAuth`). Lists/reads only return the agent's own
 * documents, creates stamp ownership, and updates/deletes can't touch another
 * agent's records. This is what makes the portal multi-tenant.
 *
 * @param {import("mongoose").Model} Model
 * @param {string} ownerField  field on the model that holds the owning agent id
 */
export function crudScoped(Model, ownerField = "agent") {
  const owner = (req) => ({ [ownerField]: req.agent._id });

  return {
    list: async (req, res, next) => {
      try {
        const docs = await Model.find(owner(req)).sort({ createdAt: -1 }).lean();
        res.json({ data: docs, count: docs.length });
      } catch (err) {
        next(err);
      }
    },
    get: async (req, res, next) => {
      try {
        const doc = await Model.findOne({ _id: req.params.id, ...owner(req) }).lean();
        if (!doc) return res.status(404).json({ error: "Not found" });
        res.json({ data: doc });
      } catch (err) {
        next(err);
      }
    },
    create: async (req, res, next) => {
      try {
        // Spread body first, then force ownership so a client can't spoof it.
        const doc = await Model.create({ ...req.body, ...owner(req) });
        res.status(201).json({ data: doc });
      } catch (err) {
        next(err);
      }
    },
    update: async (req, res, next) => {
      try {
        const patch = { ...req.body };
        delete patch[ownerField]; // ownership is immutable via the API
        const doc = await Model.findOneAndUpdate({ _id: req.params.id, ...owner(req) }, patch, {
          new: true,
          runValidators: true,
        });
        if (!doc) return res.status(404).json({ error: "Not found" });
        res.json({ data: doc });
      } catch (err) {
        next(err);
      }
    },
    remove: async (req, res, next) => {
      try {
        const doc = await Model.findOneAndDelete({ _id: req.params.id, ...owner(req) });
        if (!doc) return res.status(404).json({ error: "Not found" });
        res.json({ data: { id: req.params.id, deleted: true } });
      } catch (err) {
        next(err);
      }
    },
  };
}
