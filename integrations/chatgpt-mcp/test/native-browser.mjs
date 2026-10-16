// Optional real-browser integration test of the original UI against a stub MCP
// host. No model calls, provider login, or production mutation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { buildNativeHtml } from "../native-html.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, "package.json") : import.meta.url);
const { chromium } = require("playwright");
const nativeRoot = process.env.PARLEY_NATIVE_UI || resolve(root, "../../ui");
const providers = Object.fromEntries(["claude", "codex"].map(id => [id, {
  label: id === "claude" ? "Claude" : "Codex", avatar: id[0].toUpperCase(), color: "#55aaff",
  fields: ["command", "model", "effort", id === "claude" ? "permissionMode" : "sandbox"], models: [], efforts: [],
}]));
const rooms = new Map(), events = new Map(), calls = [];
function makeRoom(name) {
  const room = {
    name, dir: "/test/rooms/" + name, workspace: "/test/rooms/" + name + "/workspace", git: null,
    cfg: { mode: "talk", defaultAgent: "claude", hopBudget: 4, accounting: "automatic", pairRounds: 0, timeoutMs: 900000,
      projectDir: null, roomNote: null, agents: { claude: { provider: "claude", command: "claude", lurk: false, permissionMode: "default" }, codex: { provider: "codex", command: "codex", lurk: false, sandbox: "read-only" } } },
    providers, seats: ["claude", "codex"], seatInfo: Object.fromEntries(Object.entries(providers).map(([id,p]) => [id, { ...p, provider: id, sessions: "resume" }])),
    agents: { claude: { linked: true, command: { ok: true } }, codex: { linked: true, command: { ok: true } } },
    busy: [], busyInfo: [], queue: [], queued: 0, queuedDispatches: 0, queuePaused: false, working: false,
    pair: null, workingPair: null, cancelledDeliveries: {}, interruptedResponses: {}, resolvedErrors: {}, lurkOutcomes: [], hopRuns: [],
  };
  rooms.set(name, { room, entries: [], receipts: [] }); events.set(name, []);
  return rooms.get(name);
}
makeRoom("default");
const publish = (room, event) => events.get(room).push({ ...event, seq: events.get(room).length + 1 });
const snap = name => ({ ...structuredClone(rooms.get(name)), cursor: events.get(name).length, streams: {} });
const response = json => ({ status: 200, headers: { "content-type": "application/json", "x-parley-runtime-protocol": "12" }, json });
async function invoke(name, args) {
  calls.push({ name, args });
  if (name === "get_room") return snap(args.room);
  if (name === "watch_room") {
    await new Promise(resolve => setTimeout(resolve, 40));
    const all = events.get(args.room) || [];
    return { connected: true, resync: false, cursor: all.length, events: all.filter(e => e.seq > args.after) };
  }
  assert.equal(name, "native_request");
  const url = new URL(args.path, "http://test"), body = args.body || {};
  if (url.pathname === "/api/rooms" && args.method === "GET") return response({ rooms: [...rooms.keys()].map(name => ({ name, mode: "talk" })), providers });
  if (url.pathname === "/api/rooms") { makeRoom(body.name); return response({ ok: true }); }
  if (url.pathname === "/api/room") return response(snap(url.searchParams.get("name")));
  if (url.pathname === "/api/doctor") return response({ seats: {} });
  if (url.pathname === "/api/room/summary") return response({ room: rooms.get(url.searchParams.get("name")).room });
  if (url.pathname === "/api/message") {
    const data = rooms.get(body.room), n = data.entries.length + 1;
    const entry = { n, kind: "user", author: "user", text: body.text, target: "claude", ts: "2026-10-17T01:10:00" };
    data.entries.push(entry); publish(body.room, { type: "entry", entry });
    publish(body.room, { type: "status", agent: "claude", phase: "start", runId: "browser-test" });
    publish(body.room, { type: "stream", agent: "claude", text: "原样 $&" });
    setTimeout(() => {
      const entry = { n: n+1, kind: "agent", author: "claude", text: "原样 $&\n浏览器回复", ts: "2026-10-17T01:10:01" };
      data.entries.push(entry); publish(body.room, { type: "stream", agent: "claude", from: 5, delta: "\n浏览器回复" });
      publish(body.room, { type: "entry", entry }); publish(body.room, { type: "status", agent: "claude", phase: "done", runId: "browser-test" });
    }, 250);
    return response({ ok: true, target: "claude" });
  }
  if (url.pathname === "/api/room/rename") {
    const data = rooms.get(body.room), log = events.get(body.room);
    rooms.delete(body.room); events.delete(body.room); data.room.name = body.to;
    rooms.set(body.to, data); events.set(body.to, log); return response({ name: body.to });
  }
  if (url.pathname === "/api/room/delete") {
    rooms.delete(body.room); events.delete(body.room); return response({ rooms: [...rooms.keys()] });
  }
  if (url.pathname === "/api/config") {
    Object.assign(rooms.get(body.room).room.cfg, body.config); return response(rooms.get(body.room).room);
  }
  if (url.pathname === "/api/transcript") return { status: 200, headers: { "content-type": "text/markdown", "x-parley-runtime-protocol": "12" }, base64: Buffer.from("# 中文 transcript $&\n").toString("base64") };
  throw Error("Unhandled test route " + args.path);
}
const fakeSdk = `class App { async connect() {} async callServerTool({name, arguments:args}) { return {structuredContent:await window.__testCall(name,args)}; } }\n`;
const transport = fakeSdk + readFileSync(join(root, "native-transport.mjs"), "utf8")
  .replace(/^import .*\n/gm, "").replace(/\bexport /g, "");
const html = buildNativeHtml(root, nativeRoot, transport);
const server = createServer((req,res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const browser = await chromium.launch({ headless: true,
  ...(process.env.PARLEY_TEST_CHROMIUM ? { executablePath: process.env.PARLEY_TEST_CHROMIUM } : {}),
  args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = []; page.on("pageerror", error => { errors.push(error.message); console.error("native browser page error:", error.message); });
  await page.exposeFunction("__testCall", invoke);
  await page.goto("http://127.0.0.1:"+server.address().port);
  await page.locator("#seat1 option").first().waitFor({ state: "attached" });
  const create = async name => {
    await page.locator("#addRoomBtn").click(); await page.locator("#newRoomInput").fill(name);
    await page.locator("#newRoomCreate").click(); await page.waitForFunction(name => document.getElementById("roomTitle").textContent === name, name);
  };
  console.log("native browser: creating rooms");
  await create("session-a"); await page.locator("#input").fill("会话 A 的草稿");
  await create("session-b"); await page.locator("#input").fill("会话 B 的草稿");
  await page.getByRole("button", { name: "session-a", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("input").value === "会话 A 的草稿");
  await page.getByRole("button", { name: "session-b", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("input").value === "会话 B 的草稿");
  await page.reload(); await page.waitForFunction(() => document.getElementById("roomTitle").textContent === "session-b");
  assert.equal(await page.locator("#input").inputValue(), "会话 B 的草稿");
  console.log("native browser: room switching, drafts and reload passed");
  await page.locator("#input").fill("发送测试");
  await page.locator("#fileInput").setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("附件原文 $&") });
  await page.locator("#sendBtn").click();
  await page.getByText("浏览器回复", { exact: false }).waitFor();
  assert.equal(Buffer.from(calls.find(c => c.args?.path === "/api/message").args.body.files[0].data,"base64").toString(), "附件原文 $&");
  console.log("native browser: sending, stream and attachment passed");
  await page.locator("#settingsBtn").click(); await page.locator("#overlay").waitFor({state:"visible"});
  await page.locator("#s_roomnote").fill("Room note 原样"); await page.locator("#mSave").click();
  await page.locator("#overlay").waitFor({ state: "hidden" });
  assert.equal(rooms.get("session-b").room.cfg.roomNote, "Room note 原样");
  console.log("native browser: settings passed");
  await page.locator(".room-item").filter({hasText:"session-b"}).hover();
  await page.getByRole("button",{name:"Rename session-b",exact:true}).click();
  await page.locator("dialog input").fill("session-renamed"); await page.locator("dialog button[type=submit]").click();
  await page.locator("dialog button[type=submit]").click();
  await page.waitForFunction(() => document.getElementById("roomTitle").textContent === "session-renamed");
  await page.locator(".room-item").filter({hasText:"session-renamed"}).hover();
  await page.getByRole("button",{name:"Delete session-renamed",exact:true}).click();
  await page.locator("dialog button[type=submit]").click();
  await page.waitForFunction(() => document.getElementById("roomTitle").textContent !== "session-renamed");
  const downloadEvent=page.waitForEvent("download"); await page.locator("#dlTranscript").click(); const download=await downloadEvent;
  assert.equal(readFileSync(await download.path(),"utf8"),"# 中文 transcript $&\n");
  for(const viewport of [{width:375,height:812},{width:768,height:1024},{width:1440,height:900}]) {
    await page.setViewportSize(viewport); assert.ok(await page.locator("#input").isVisible());
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,createdRooms:2,roomSwitchDrafts:true,reload:true,sendAndStream:true,attachment:true,settings:true,rename:true,delete:true,transcript:true,responsiveSizes:3}));
} finally { await browser.close(); server.close(); }
