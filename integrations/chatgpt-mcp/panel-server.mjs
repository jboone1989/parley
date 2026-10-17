import { nativeRequest } from "./native-api.mjs";
import { validRoom } from "./bridge.mjs";
import { validOrigin } from "./panel-auth.mjs";

const MAX_BODY = 9 * 1024 * 1024;
const failure = (status, message) => Object.assign(Error(message), { status });
function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { if (!over) reject(failure(413, "Request is too large")); over = true; chunks.length = 0; }
      else if (!over) chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(failure(400, "Invalid JSON")); }
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { reject(failure(408, "Request timed out")); req.destroy(); });
  });
}
async function request(req, res, bridge) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw failure(415, "JSON required");
  if (Number(req.headers["content-length"]) > MAX_BODY) { req.resume(); throw failure(413, "Request is too large"); }
  const body = await readBody(req);
  if (!body || typeof body !== "object" || !["GET", "POST"].includes(body.method)) throw failure(400, "Invalid native request");
  const began = performance.now();
  const result = await nativeRequest(bridge, body);
  res.setHeader("server-timing", "parley;dur=" + (performance.now() - began).toFixed(1));
  json(res, 200, result);
}
async function events(req, res, bridge, session, url) {
  const room = validRoom(url.searchParams.get("room"));
  let cursor = Number(url.searchParams.get("after") || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw failure(400, "Invalid event cursor");
  if (session.streams >= 2) throw failure(429, "Too many event streams");
  session.streams++;
  let closed = false;
  const abort = new AbortController();
  const end = () => { closed = true; if (!res.writableEnded) res.end(); };
  res.on("close", () => { closed = true; abort.abort(); });
  const expiry = setTimeout(end, Math.min(60000, Math.max(1, session.expiresAt - Date.now())));
  try {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform", "x-accel-buffering": "no" });
    res.flushHeaders(); res.write(": connected\n\n");
    while (!closed && Date.now() < session.expiresAt) {
      const update = await bridge.watch({ room, after: cursor, waitMs: 8000, signal: abort.signal });
      if (closed) break;
      if (!res.write("event: update\ndata: " + JSON.stringify(update) + "\n\n")) {
        // A stalled client reconnects from its acknowledged cursor; never
        // accumulate an unbounded output queue on the server.
        end(); break;
      }
      cursor = update.cursor;
      if (update.resync) break;
    }
  } finally { clearTimeout(expiry); abort.abort(); session.streams--; end(); }
}
export function createPanelHandler({ bridge, sessions }) {
  return async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/panel/")) return false;
    const origin = req.headers.origin;
    if (!validOrigin(origin, sessions.allowLocal)) { json(res, 403, { error: "Origin required" }); return true; }
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-expose-headers", "Server-Timing");
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600" });
      res.end(); return true;
    }
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const session = sessions.verify(token, origin);
    if (!session || url.searchParams.has("token")) { json(res, 401, { error: "Panel session expired" }); return true; }
    if (!sessions.admit(session)) { json(res, 429, { error: "Panel request limit reached" }); return true; }
    session.active++;
    try {
      if (url.pathname === "/panel/ping" && req.method === "GET") json(res, 200, { ok: true });
      else if (url.pathname === "/panel/request" && req.method === "POST") await request(req, res, bridge);
      else if (url.pathname === "/panel/events" && req.method === "GET") await events(req, res, bridge, session, url);
      else json(res, 404, { error: "Unknown panel route" });
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 400, { error: error.status ? error.message : "Parley request failed" });
      else if (!res.writableEnded) res.end();
    } finally { session.active--; }
    return true;
  };
}
