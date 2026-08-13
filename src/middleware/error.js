export function notFound(req, res) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
}

// Express recognizes error middleware by its four-argument signature.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err, req, res, next) {
  console.error("[error]", err.message);

  if (err.name === "ValidationError") {
    return res.status(422).json({ error: "Validation failed", details: err.errors });
  }
  if (err.name === "CastError") {
    return res.status(400).json({ error: `Invalid ${err.path}: ${err.value}` });
  }
  if (err.code === 11000) {
    return res.status(409).json({ error: "Duplicate value", keyValue: err.keyValue });
  }
  res.status(err.status || 500).json({ error: err.message || "Server error" });
}
