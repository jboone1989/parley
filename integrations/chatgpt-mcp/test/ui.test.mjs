import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as reducer from "../room-state.mjs";
import * as session from "../panel-session.mjs";

class Element {
  children = []; listeners = {}; dataset = {}; value = ""; textContent = "";
  scrollHeight = 1000; scrollTop = 100; clientHeight = 200; disabled = false;
  get options() { return this.children; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren() { this.children = []; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  insertBefore(node, before) {
    node.remove(); node.parent = this;
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
  }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  click() { if (!this.disabled) return this.listeners.click?.(); }
}

function harness(saved = {}) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  get("target").value = "both";
  let persisted = JSON.stringify(saved);
  const storage = { getItem: () => persisted, setItem: (_, value) => { persisted = value; } };
  let tool = async name => name === "list_rooms" ? { rooms: ["default", "other"] } : { room: { busy: [] }, entries: [] };
  class App {
    connect() { return new Promise(() => {}); }
    async callServerTool(request) { return { structuredContent: await tool(request.name, request.arguments) }; }
  }
  const source = readFileSync(new URL("../ui.mjs", import.meta.url), "utf8").replace(/^import .*\n/gm, "");
  const context = vm.createContext({
    ...reducer, ...session, App, window: { sessionStorage: storage },
    document: { getElementById: get, createElement: () => new Element(), visibilityState: "visible" },
    setTimeout,
  });
  vm.runInContext(source + "\nthis.api = { app, state, panel, selectRoom, loadRooms, loadRoom, render };", context);
  return { ...context.api, get, setTool: handler => { tool = handler; }, saved: () => JSON.parse(persisted) };
}

test("room and per-room drafts survive reopening and a room-list response", async () => {
  const ui = harness({ room: "chosen", drafts: { chosen: "中文草稿", other: "另一条" } });
  await ui.loadRooms();
  assert.equal(ui.state.room, "chosen");
  assert.equal(ui.get("room").value, "chosen");
  assert.equal(ui.get("draft").value, "中文草稿");
  ui.selectRoom("other");
  assert.equal(ui.get("draft").value, "另一条");
  ui.selectRoom("chosen");
  assert.equal(ui.get("draft").value, "中文草稿");
  assert.equal(ui.saved().room, "chosen");
});

test("IME candidate confirmation and Shift+Enter never send a message", () => {
  assert.equal(session.shouldSend({ key: "Enter", isComposing: true }), false);
  assert.equal(session.shouldSend({ key: "Enter", keyCode: 229 }), false);
  assert.equal(session.shouldSend({ key: "Enter", shiftKey: true }), false);
  assert.equal(session.shouldSend({ key: "Enter" }), true);
});

test("a send acknowledgement preserves new typing and prevents duplicate submits", async () => {
  const ui = harness(); let acknowledge, calls = 0;
  ui.setTool(async name => {
    if (name === "send_message") { calls++; return new Promise(resolve => { acknowledge = resolve; }); }
    return { room: { busy: [] }, entries: [] };
  });
  ui.get("draft").value = "先发送";
  const pending = ui.get("send").click();
  await ui.get("send").listeners.click();
  assert.equal(calls, 1);
  ui.get("draft").value = "继续写的新内容";
  acknowledge({ ok: true }); await pending;
  assert.equal(ui.get("draft").value, "继续写的新内容");
});

test("switching rooms during send never clears the new room's draft", async () => {
  const ui = harness({ drafts: { other: "别的房间草稿" } }); let acknowledge;
  ui.setTool(async name => name === "send_message" ? new Promise(resolve => { acknowledge = resolve; }) : {});
  ui.get("draft").value = "旧房间发送";
  const pending = ui.get("send").click();
  ui.selectRoom("other");
  acknowledge({ ok: true }); await pending;
  assert.equal(ui.get("draft").value, "别的房间草稿");
  ui.selectRoom("default");
  assert.equal(ui.get("draft").value, "");
});

test("a late snapshot cannot replace the currently selected room", async () => {
  const ui = harness(); let complete;
  ui.setTool(() => new Promise(resolve => { complete = resolve; }));
  const pending = ui.loadRoom();
  ui.selectRoom("other");
  complete({ entries: [{ n: 1, text: "stale" }], room: { busy: [] } });
  await pending;
  assert.equal(ui.state.entries.length, 0);
});

test("stream updates keep existing message nodes and the reader's scroll position", () => {
  const ui = harness();
  reducer.applyRoomEvent(ui.state, { type: "stream", agent: "claude", text: "原文" });
  ui.render(); const node = ui.get("messages").children[0];
  reducer.applyRoomEvent(ui.state, { type: "stream", agent: "claude", from: 2, delta: " $&" });
  ui.render();
  assert.equal(ui.get("messages").children[0], node);
  assert.equal(node.children[1].textContent, "原文 $&");
  assert.equal(ui.get("messages").scrollTop, 100);
});

test("storage failure does not prevent chatting", () => {
  const unavailable = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } };
  assert.equal(session.restorePanel(unavailable).room, "default");
  assert.doesNotThrow(() => session.savePanel(unavailable, { room: "default", drafts: {} }));
});
