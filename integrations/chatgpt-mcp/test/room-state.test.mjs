import test from "node:test";
import assert from "node:assert/strict";
import { createRoomState, applyRoomSnapshot, applyRoomEvent, visibleStreams } from "../room-state.mjs";

test("native keyframes and offset deltas preserve all text verbatim", () => {
  const state = createRoomState();
  const parts = ["第一段：", "原样输出 😀", "\n保留 **Markdown**、$& 和空格  "];
  applyRoomEvent(state, { type: "stream", agent: "claude", text: parts[0] });
  for (const delta of parts.slice(1)) {
    applyRoomEvent(state, { type: "stream", agent: "claude", from: state.streams.claude.length, delta });
  }
  assert.equal(state.streams.claude, parts.join(""));
  assert.equal(visibleStreams(state)[0][1], parts.join(""));
});

test("a missing delta waits for a keyframe instead of corrupting text", () => {
  const state = createRoomState();
  applyRoomEvent(state, { type: "stream", agent: "codex", text: "abc" });
  applyRoomEvent(state, { type: "stream", agent: "codex", from: 8, delta: "wrong" });
  assert.equal(state.streams.codex, "abc");
  applyRoomEvent(state, { type: "stream", agent: "codex", text: "abcdefghi" });
  assert.equal(state.streams.codex, "abcdefghi");
});

test("persisted agent entry replaces its live bubble even without top-level agent", () => {
  const state = createRoomState();
  applyRoomEvent(state, { type: "stream", agent: "claude", text: "正文" });
  const entry = { n: 7, kind: "agent", author: "claude", text: "正文" };
  applyRoomEvent(state, { type: "entry", entry });
  applyRoomEvent(state, { type: "entry", entry });
  assert.deepEqual(state.entries, [entry]);
  assert.deepEqual(visibleStreams(state), []);
  assert.deepEqual(state.busy, {});
});

test("pass controls never appear as reply bubbles and nested receipts finish the run", () => {
  const state = createRoomState();
  applyRoomEvent(state, { type: "stream", agent: "codex", text: "[pass]" });
  assert.deepEqual(visibleStreams(state), []);
  applyRoomEvent(state, { type: "receipt", receipt: { agent: "codex", outcome: "pass" } });
  assert.deepEqual(state.streams, {});
  assert.deepEqual(state.busy, {});
});

test("every terminal phase clears live output", () => {
  for (const phase of ["done", "idle", "stopped", "cancelled", "error"]) {
    const state = createRoomState();
    applyRoomEvent(state, { type: "status", agent: "claude", phase: "start", runId: "r1" });
    applyRoomEvent(state, { type: "stream", agent: "claude", text: "partial" });
    applyRoomEvent(state, { type: "status", agent: "claude", phase, runId: "r1" });
    assert.deepEqual(state.streams, {}, phase);
    assert.deepEqual(state.busy, {}, phase);
  }
});

test("a stale completion cannot clear the next run", () => {
  const state = createRoomState();
  applyRoomEvent(state, { type: "status", agent: "claude", phase: "start", runId: "r2" });
  applyRoomEvent(state, { type: "stream", agent: "claude", text: "new reply" });
  applyRoomEvent(state, { type: "status", agent: "claude", phase: "done", runId: "r1" });
  assert.equal(state.streams.claude, "new reply");
});

test("native busy arrays use agent names and idle snapshots clear both agents", () => {
  const state = createRoomState();
  applyRoomSnapshot(state, { room: { busy: ["claude", "codex"] }, entries: [] });
  assert.deepEqual(state.busy, { claude: true, codex: true });
  applyRoomEvent(state, { type: "stream", agent: "claude", text: "[pass]" });
  applyRoomEvent(state, { type: "stream", agent: "codex", text: "unfinished" });
  applyRoomEvent(state, { type: "room", room: { busy: [], working: false } });
  assert.deepEqual(state.streams, {});
  assert.deepEqual(state.busy, {});
});

test("a snapshot requested before a new event preserves newer output", () => {
  const state = createRoomState();
  applyRoomEvent(state, { type: "entry", entry: { n: 2, kind: "user", text: "new" } });
  applyRoomEvent(state, { type: "stream", agent: "claude", text: "live" });
  applyRoomSnapshot(state, { room: { busy: [] }, entries: [{ n: 1, kind: "user", text: "old" }] }, { preserveLive: true });
  assert.equal(state.streams.claude, "live");
  assert.deepEqual(state.entries.map(entry => entry.n), [1, 2]);
});

test("the recorded pass-to-done lifecycle ends with one final reply per agent", () => {
  const state = createRoomState();
  for (const [index, agent] of ["claude", "codex"].entries()) {
    applyRoomEvent(state, { type: "status", agent, phase: "start", runId: agent + "1" });
    applyRoomEvent(state, { type: "stream", agent, text: "UI_SEND_OK " });
    applyRoomEvent(state, { type: "stream", agent, from: 11, delta: agent });
    applyRoomEvent(state, { type: "entry", entry: { n: index + 1, kind: "agent", author: agent, text: "UI_SEND_OK " + agent } });
    applyRoomEvent(state, { type: "status", agent, phase: "attention", runId: agent + "2" });
    applyRoomEvent(state, { type: "stream", agent, text: "[pass]" });
    applyRoomEvent(state, { type: "lurk", agent, spoke: false });
    applyRoomEvent(state, { type: "status", agent, phase: "done", runId: agent + "2" });
  }
  assert.equal(state.entries.length, 2);
  assert.deepEqual(visibleStreams(state), []);
  assert.deepEqual(state.busy, {});
});
