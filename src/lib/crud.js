/** Build standard REST handlers for a Mongoose model. */
export function crud(Model) {
  return {
    list: async (req, res, next) => {
      try {
        const docs = await Model.find().sort({ createdAt: -1 }).lean();
        res.json({ data: docs, count: docs.length });
      } catch (err) {
        next(err);
      }
    },
    get: async (req, res, next) => {
      try {
        const doc = await Model.findById(req.params.id).lean();
        if (!doc) return res.status(404).json({ error: "Not found" });
        res.json({ data: doc });
      } catch (err) {
        next(err);
      }
    },
    create: async (req, res, next) => {
      try {
        const doc = await Model.create(req.body);
        res.status(201).json({ data: doc });
      } catch (err) {
        next(err);
      }
    },
    update: async (req, res, next) => {
      try {
        const doc = await Model.findByIdAndUpdate(req.params.id, req.body, {
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
        const doc = await Model.findByIdAndDelete(req.params.id);
        if (!doc) return res.status(404).json({ error: "Not found" });
        res.json({ data: { id: req.params.id, deleted: true } });
      } catch (err) {
        next(err);
      }
    },
  };
}
