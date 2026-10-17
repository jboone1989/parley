import test from "node:test";
import assert from "node:assert/strict";
import { nativeRequest, NATIVE_ROUTES } from "../native-api.mjs";

const bridge = () => ({ base: "http://127.0.0.1:4141", auth: { token: "server-only", protocol: "12" },
  snapshot: async name => ({ room: { name }, entries: [], cursor: 7, streams: {} }) });

test("all native business routes retain their method, fields, status and protocol", async t => {
  const prior = globalThis.fetch; t.after(() => { globalThis.fetch = prior; });
  const seen = new Set();
  globalThis.fetch = async (url, options) => {
    const route = options.method + " " + url.pathname; seen.add(route);
    assert.equal(options.headers["x-parley-token"], "server-only");
    assert.equal(options.headers["x-parley-runtime-protocol"], "12");
    assert.equal(options.redirect, "error");
    if (options.method === "POST") assert.deepEqual(JSON.parse(options.body), { room: "test", arbitraryNativeField: [1, "中"] });
    return Response.json({ native: true }, { status: 202, headers: {
      "x-parley-runtime-protocol": "12", "x-parley-token": "must-not-leave-server",
    } });
  };
  for (const route of NATIVE_ROUTES) {
    const [method, path] = route.split(" ");
    const result = await nativeRequest(bridge(), { method, path,
      ...(method === "POST" ? { body: { room: "test", arbitraryNativeField: [1, "中"] } } : {}) });
    if (path === "/api/room") assert.equal(result.json.cursor, 7);
    else { assert.equal(result.status, 202); assert.equal(result.json.native, true); }
    assert.equal(result.headers["x-parley-token"], undefined);
  }
  assert.equal(seen.size, NATIVE_ROUTES.size - 1);
});

test("attachments and transcript downloads preserve exact bytes and MIME", async t => {
  const prior = globalThis.fetch; t.after(() => { globalThis.fetch = prior; });
  const bytes = Buffer.from([0, 255, 128, 13, 10, 36, 38]);
  globalThis.fetch = async () => new Response(bytes, { headers: {
    "content-type": "application/octet-stream", "content-disposition": "attachment; filename=test.bin", "x-parley-runtime-protocol": "12",
  } });
  const result = await nativeRequest(bridge(), { path: "/api/attachment?room=test&id=abc" });
  assert.deepEqual(Buffer.from(result.base64, "base64"), bytes);
  assert.equal(result.headers["content-type"], "application/octet-stream");
  assert.equal(result.headers["content-disposition"], "attachment; filename=test.bin");
});

test("foreign origins, traversal, OS actions and unsupported routes cannot be proxied", async () => {
  for (const path of ["https://evil.test/api/config", "/api/../secret", "/api/%2e%2e/secret", "/api/rooms#x", "/api/rooms\\evil", "/api/events", "/api/open", "/api/pickfolder"]) {
    await assert.rejects(nativeRequest(bridge(), { path, method: "POST", body: {} }));
  }
  await assert.rejects(nativeRequest(bridge(), { path: "/api/rooms", method: "DELETE" }));
  await assert.rejects(nativeRequest(bridge(), { path: "/api/rooms", body: {} }));
});

test("native errors stay native responses instead of pretending success", async t => {
  const prior = globalThis.fetch; t.after(() => { globalThis.fetch = prior; });
  globalThis.fetch = async () => Response.json({ error: "room already exists" }, { status: 409, headers: { "x-parley-runtime-protocol": "12" } });
  const result = await nativeRequest(bridge(), { path: "/api/rooms", method: "POST", body: { name: "existing" } });
  assert.equal(result.status, 409);
  assert.equal(result.json.error, "room already exists");
});

test("panel bootstrap bundles room listing without changing ordinary snapshots", async () => {
  const value=bridge();let listings=0;
  value.rooms=async()=>{listings++;return {rooms:[{name:"test"}]};};
  const bundled=await nativeRequest(value,{path:"/api/room?name=test&panel=1"});
  assert.deepEqual(bundled.json.panel.rooms.rooms,[{name:"test"}]);
  assert.equal(bundled.json.cursor,7);assert.equal(listings,1);
  assert.equal((await nativeRequest(value,{path:"/api/room?name=test"})).json.panel,undefined);
  value.rooms=async()=>{throw Error("temporary listing error");};
  assert.equal((await nativeRequest(value,{path:"/api/room?name=test&panel=1"})).json.room.name,"test");
});
