import test from "node:test";
import assert from "node:assert/strict";
import { ParleyBridge, validRoom, validTarget } from "../bridge.mjs";

function offlineBridge() {
  const bridge = new ParleyBridge();
  bridge.runEventStream = async () => {};
  return bridge;
}

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
  const bridge = offlineBridge();
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
  await assert.rejects(bridge.send({ target: "both", solo: true, text: "hello" }), /Solo/);
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
  assert.equal(result.events.at(-1).index, 149);
});

test("a backlog spanning multiple pages delivers every delta without advancing past it", async () => {
  const bridge = offlineBridge(), channel = bridge.channel("default");
  bridge.publish(channel, { type: "stream", agent: "claude", text: "" });
  for (let index = 0; index < 240; index++) bridge.publish(channel, {
    type: "stream", agent: "claude", from: index, delta: "字",
  });
  let cursor = 0, text = "";
  const seen = [];
  while (cursor < channel.seq) {
    const page = await bridge.watch({ after: cursor, waitMs: 0 });
    assert.equal(page.resync, false);
    for (const event of page.events) {
      seen.push(event.seq);
      if (event.text !== undefined) text = event.text;
      else { assert.equal(event.from, text.length); text += event.delta; }
    }
    cursor = page.cursor;
  }
  assert.equal(seen.length, 241);
  assert.equal(new Set(seen).size, 241);
  assert.equal(text, "字".repeat(240));
});

test("a cursor from before adapter restart requests immediate resynchronization", async () => {
  const result = await offlineBridge().watch({ after: 999, waitMs: 8000 });
  assert.equal(result.resync, true);
  assert.equal(result.cursor, 0);
});

test("refresh restores unfinished text and preserves events arriving during the snapshot", async () => {
  const bridge = offlineBridge(), channel = bridge.channel("default");
  bridge.publish(channel, { type: "status", agent: "claude", phase: "start", runId: "r1" });
  bridge.publish(channel, { type: "stream", agent: "claude", text: "原样 $&" });
  bridge.call = async () => {
    bridge.publish(channel, { type: "stream", agent: "claude", from: 5, delta: " 后续" });
    return { entries: [], room: { busy: ["claude"], busyInfo: [{ agent: "claude", runId: "r1" }] } };
  };
  const snapshot = await bridge.snapshot("default");
  assert.equal(snapshot.cursor, 2);
  assert.equal(snapshot.streams.claude, "原样 $&");
  const next = await bridge.watch({ after: snapshot.cursor, waitMs: 0 });
  assert.equal(next.events[0].delta, " 后续");
  bridge.call = async () => ({ entries: [], room: { busy: [] } });
  assert.deepEqual((await bridge.snapshot("default")).streams, {});
});

test("a snapshot does not restore text from a previous agent run", async () => {
  const bridge = offlineBridge(), channel = bridge.channel("default");
  bridge.publish(channel, { type: "status", agent: "claude", phase: "start", runId: "old" });
  bridge.publish(channel, { type: "stream", agent: "claude", text: "old output" });
  bridge.call = async () => ({ entries: [], room: { busy: ["claude"], busyInfo: [{ agent: "claude", runId: "new" }] } });
  assert.deepEqual((await bridge.snapshot("default")).streams, {});
});
