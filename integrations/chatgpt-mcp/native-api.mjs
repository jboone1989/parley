// The complete public Parley HTTP surface, excluding the streaming endpoint
// (watch_room handles it) and desktop-only OS dialogs (adapted in the panel).
export const NATIVE_ROUTES = new Set([
  "GET /api/rooms", "POST /api/rooms", "GET /api/room", "GET /api/room/summary",
  "GET /api/doctor", "GET /api/attachment", "GET /api/transcript",
  "POST /api/message", "POST /api/ask", "POST /api/retry", "POST /api/stop",
  "POST /api/pair/continue", "POST /api/seat/sleep", "POST /api/queue/cancel",
  "POST /api/queue/pause", "POST /api/queue/retry", "POST /api/new",
  "POST /api/config", "POST /api/room/rename", "POST /api/room/delete",
]);

export async function nativeRequest(bridge, { path, method = "GET", body }, retry = true) {
  if (typeof path !== "string" || !path.startsWith("/api/") || /[\\#]/.test(path)) {
    throw Error("Only native Parley API paths are allowed");
  }
  const url = new URL(path, bridge.base);
  if (url.origin !== new URL(bridge.base).origin || !NATIVE_ROUTES.has(method + " " + url.pathname)) {
    throw Error("Unsupported native Parley route");
  }
  url.searchParams.delete("token"); url.searchParams.delete("protocol");
  if (method === "GET" && body !== undefined) throw Error("GET requests cannot include a body");
  if (method === "GET" && url.pathname === "/api/room") {
    const snapshot = await bridge.snapshot(url.searchParams.get("name") || "default");
    return { status: 200, headers: { "content-type": "application/json", "x-parley-runtime-protocol": bridge.auth.protocol }, json: snapshot };
  }
  const { token, protocol } = bridge.auth || await bridge.refreshAuth();
  const response = await fetch(url, {
    method, redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { "x-parley-token": token, "x-parley-runtime-protocol": protocol,
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 403 && retry) {
    await bridge.refreshAuth();
    return nativeRequest(bridge, { path, method, body }, false);
  }
  const headers = {};
  for (const name of ["content-type", "content-disposition", "x-parley-runtime-protocol"]) {
    if (response.headers.has(name)) headers[name] = response.headers.get(name);
  }
  const result = { status: response.status, headers };
  if ((headers["content-type"] || "").includes("application/json")) result.json = await response.json();
  else result.base64 = Buffer.from(await response.arrayBuffer()).toString("base64");
  if (response.ok && method === "POST" && ["/api/room/rename", "/api/room/delete"].includes(url.pathname)) {
    bridge.retireRoom?.(body?.room);
  }
  return result;
}
