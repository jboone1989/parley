import test from "node:test";
import assert from "node:assert/strict";
import { ParleyBridge, validRoom, validTarget } from "../bridge.mjs";

test("validates room and target identifiers", () => {
  assert.equal(validRoom(), "default");
  assert.equal(validTarget("BOTH"), "both");
  assert.throws(() => validRoom("../private"), /Invalid/);
  assert.throws(() => validTarget("everyone"), /Target/);
});

test("reads the Parley loopback page token and forwards only locally", async t => {
  const prior = globalThis.fetch;
  t.after(() => { globalThis.fetch = prior; });
  let count = 0;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).endsWith("/")) return new Response('<meta name="parley-token" content="local"><meta name="parley-runtime-protocol" content="12">');
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:4141\/api\//);
    assert.equal(opts.headers["x-parley-token"], "local");
    assert.equal(opts.headers["x-parley-runtime-protocol"], "12");
    count++;
    return Response.json({ ok: true, entries: [] });
  };
  const bridge = new ParleyBridge();
  assert.deepEqual((await bridge.snapshot("default")).entries, []);
  assert.equal((await bridge.send({ text: "hello" })).ok, true);
  assert.equal(count, 2);
});

test("renews local session token after Parley restart", async t => {
  const prior = globalThis.fetch;
  t.after(() => { globalThis.fetch = prior; });
  let count = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/")) {
      count++;
      return new Response('<meta name="parley-token" content="key' + count + '"><meta name="parley-runtime-protocol" content="12">');
    }
    if (count === 1) return Response.json({ error: "expired" }, { status: 403 });
    return Response.json({ ok: true });
  };
  assert.equal((await new ParleyBridge().rooms()).ok, true);
  assert.equal(count, 2);
});

test("rejects invalid outgoing messages before performing network calls", async () => {
  const bridge = new ParleyBridge();
  await assert.rejects(bridge.send({ room: "../etc", text: "hello" }), /Invalid/);
  await assert.rejects(bridge.send({ target: "everyone", text: "hello" }), /Target/);
  await assert.rejects(bridge.send({ text: " " }), /Message/);
});

test("bounded room event log supports gap detection", async () => {
  const bridge = new ParleyBridge();
  const channel = { room:"default", seq:0, events:[], waiters:new Set(), connected:true, running:true };
  bridge.channels.set("default", channel);
  for (let i=0; i<350; i++) bridge.publish(channel, {type:"status", index:i});
  const result = await bridge.watch({ room:"default", after:0, waitMs:0 });
  assert.equal(result.cursor, 350);
  assert.equal(result.resync, true);
  assert.equal(result.events.length, 100);
  assert.equal(result.events.at(-1).index, 349);
});
