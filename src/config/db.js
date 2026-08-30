import mongoose from "mongoose";
import dns from "node:dns";
import net from "node:net";

// --- Reliable DNS across flaky networks AND containers ----------------------
// Atlas uses mongodb+srv, so connecting takes two DNS steps: an SRV/TXT lookup
// (the driver calls dns.promises.resolveSrv/resolveTxt) and then a per-shard
// host lookup via dns.lookup() → getaddrinfo → the OS resolver. Either step can
// fail on its own: a hotspot gateway that times out breaks the second with
// EAI_AGAIN, while a locked-down container resolver can break the first.
//
// So each patched call tries pinned public DNS first, then falls back to the
// platform resolver. The fallback is the important half — pinning alone (via a
// global dns.setServers) makes an SRV failure fatal, because c-ares then has
// nothing else to try and Atlas becomes unreachable. Set DNS_PIN=off to opt out
// entirely and use the platform resolver only.
const DNS_SERVERS = ["8.8.8.8", "1.1.1.1"];
const DNS_OVER_HTTPS_URL = "https://dns.google/resolve";
const pinDns = String(process.env.DNS_PIN || "").toLowerCase() !== "off";

const resolver = new dns.Resolver();
const promiseResolver = new dns.promises.Resolver();
try {
  resolver.setServers(DNS_SERVERS);
  promiseResolver.setServers(DNS_SERVERS);
} catch {
  // ignore — the fallbacks below still cover us
}

const osLookup = dns.lookup;

/** Pinned resolver first, platform resolver second. */
function withPlatformFallback(api) {
  const platform = dns.promises[api].bind(dns.promises);
  return async function resolveWithFallback(hostname) {
    try {
      return await promiseResolver[api](hostname);
    } catch {
      try {
        return await platform(hostname);
      } catch (platformError) {
        // Some Windows/corporate networks allow normal A lookups and HTTPS but
        // reject the SRV/TXT DNS packets MongoDB Atlas requires. DNS-over-HTTPS
        // preserves Atlas discovery on those networks without changing the URI.
        try {
          return await resolveWithDnsOverHttps(api, hostname);
        } catch {
          throw platformError;
        }
      }
    }
  };
}

async function resolveWithDnsOverHttps(api, hostname) {
  const type = api === "resolveSrv" ? "SRV" : "TXT";
  const url = `${DNS_OVER_HTTPS_URL}?name=${encodeURIComponent(hostname)}&type=${type}`;
  const response = await fetch(url, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`DNS-over-HTTPS failed (${response.status})`);

  const payload = await response.json();
  if (payload.Status !== 0 || !Array.isArray(payload.Answer)) {
    throw new Error(`DNS-over-HTTPS returned status ${payload.Status}`);
  }

  return api === "resolveSrv"
    ? parseDohSrvAnswers(payload.Answer)
    : parseDohTxtAnswers(payload.Answer);
}

export function parseDohSrvAnswers(answers) {
  return answers
    .filter((answer) => answer.type === 33 && typeof answer.data === "string")
    .map((answer) => {
      const [priority, weight, port, ...nameParts] = answer.data.trim().split(/\s+/);
      return {
        priority: Number(priority),
        weight: Number(weight),
        port: Number(port),
        name: nameParts.join(" ").replace(/\.$/, ""),
      };
    })
    .filter((answer) => answer.name && Number.isFinite(answer.port));
}

export function parseDohTxtAnswers(answers) {
  return answers
    .filter((answer) => answer.type === 16 && typeof answer.data === "string")
    .map((answer) => {
      const chunks = [];
      answer.data.replace(/"((?:\\.|[^"\\])*)"/g, (_match, chunk) => {
        chunks.push(chunk.replace(/\\(.)/g, "$1"));
        return _match;
      });
      return chunks.length ? chunks : [answer.data];
    });
}

if (pinDns) {
  dns.lookup = patchedLookup;
  // The driver reaches for these through `dns.promises`, so patch them there —
  // the callback-style dns.resolveSrv is never consulted.
  dns.promises.resolveSrv = withPlatformFallback("resolveSrv");
  dns.promises.resolveTxt = withPlatformFallback("resolveTxt");
}

function patchedLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  } else if (typeof options === "number") {
    options = { family: options };
  }
  options = options || {};

  // Literal IPs (or empty host) need no DNS — hand straight to the OS resolver.
  if (!hostname || net.isIP(hostname)) return osLookup(hostname, options, callback);

  const family = options.family || 0;
  const wantAll = options.all === true;

  const run = async () => {
    const out = [];
    if (family === 0 || family === 4) {
      try {
        for (const a of await resolver.resolve4(hostname)) out.push({ address: a, family: 4 });
      } catch {
        // no A records / transient — try AAAA or fall back below
      }
    }
    if (family === 6 || (family === 0 && out.length === 0)) {
      try {
        for (const a of await resolver.resolve6(hostname)) out.push({ address: a, family: 6 });
      } catch {
        // no AAAA records / transient — fall back below
      }
    }
    return out;
  };

  run()
    .then((addrs) => {
      if (!addrs.length) return osLookup(hostname, options, callback); // hosts file, localhost, …
      if (wantAll) return callback(null, addrs);
      callback(null, addrs[0].address, addrs[0].family);
    })
    .catch(() => osLookup(hostname, options, callback));
}

/** Connect to MongoDB. Throws if the connection can't be established. */
// Fail queries fast when there's no live connection instead of buffering 10s.
mongoose.set("strictQuery", true);
mongoose.set("bufferCommands", false);

// Attach connection listeners ONCE. Without an 'error' listener, a transient
// driver error (e.g. a DNS blip during topology monitoring, AFTER the initial
// connect) is emitted as an unhandled 'error' event — which throws and crashes
// the process (exit 1). Logging it here keeps the API alive; the driver
// auto-reconnects on its own.
let listenersAttached = false;
function attachConnectionListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  const c = mongoose.connection;
  c.on("error", (err) => console.error("✗ MongoDB connection error:", err?.message || err));
  c.on("disconnected", () => console.warn("… MongoDB disconnected — the driver will keep retrying."));
  c.on("reconnected", () => console.log("✓ MongoDB reconnected"));
}

/**
 * Connect, retrying a few times on transient DNS/network errors (EAI_AGAIN and
 * friends) so a momentary blip at boot doesn't leave the API without a DB.
 */
export async function connectDB(uri, { retries = 4, delayMs = 2000 } = {}) {
  attachConnectionListeners();
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
      return mongoose.connection;
    } catch (err) {
      lastErr = err;
      if (attempt > retries) break;
      console.warn(
        `  DNS/connect hiccup (${err.code || err.message}) — retrying ${attempt}/${retries}…`
      );
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
  throw lastErr;
}

export function dbState() {
  // 0 disconnected, 1 connected, 2 connecting, 3 disconnecting
  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  return states[mongoose.connection.readyState] ?? "unknown";
}
