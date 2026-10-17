// Optional real-browser integration test of the original UI against a stub MCP
// host. No model calls, provider login, or production mutation.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { PanelSessions } from "../panel-auth.mjs";
import { createPanelHandler } from "../panel-server.mjs";
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
const useDirect = process.env.PARLEY_TEST_DIRECT === "1";
let sessions, htmlOrigin, modeRequestGate;
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
async function invoke(name, args, source = "mcp") {
  calls.push({ name, args, source });
  if (name === "panel_session") {
    if (!useDirect) throw Error("direct connection disabled for fallback acceptance");
    return { _meta: { panelSession: sessions.issue(args.origin) } };
  }
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
  if (url.pathname === "/api/room") return response({ ...snap(url.searchParams.get("name")),
    panel: {rooms:{rooms:[...rooms.keys()].map(name=>({name,mode:"talk"})),providers}},
  });
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
    if (body.config?.mode && modeRequestGate) await modeRequestGate;
    Object.assign(rooms.get(body.room).room.cfg, body.config); return response({room: rooms.get(body.room).room});
  }
  if (url.pathname === "/api/transcript") return { status: 200, headers: { "content-type": "text/markdown", "x-parley-runtime-protocol": "12" }, base64: Buffer.from("# 中文 transcript $&\n").toString("base64") };
  throw Error("Unhandled test route " + args.path);
}
const fakeSdk = `class App { async connect() {} async callServerTool({name, arguments:args}) { const value=await window.__testCall(name,args); return name === "panel_session" ? value : {structuredContent:value}; } }\n`;
const directSource = readFileSync(join(root,"direct-client.mjs"),"utf8").replace(/\bexport /g, "");
const transport = fakeSdk + directSource + "\n" + readFileSync(join(root, "native-transport.mjs"), "utf8")
  .replace(/^import .*\n/gm, "").replace(/\bexport /g, "");
const html = buildNativeHtml(root, nativeRoot, transport);
const server = createServer((req,res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
htmlOrigin="http://127.0.0.1:"+server.address().port;
let handlePanel;
const panelServer=createServer(async(req,res)=>{
  if(req.url.startsWith("/panel/")){await handlePanel(req,res);return;}
  const chunks=[];for await(const part of req)chunks.push(part);
  const result=await invoke("native_request",{path:req.url,method:req.method,...(chunks.length?{body:JSON.parse(Buffer.concat(chunks))}:{})},"upstream");
  res.writeHead(result.status,result.headers);
  res.end(result.base64===undefined?JSON.stringify(result.json):Buffer.from(result.base64,"base64"));
});
await new Promise(resolve=>panelServer.listen(0,"127.0.0.1",resolve));
const panelOrigin="http://127.0.0.1:"+panelServer.address().port;
sessions=new PanelSessions({origin:panelOrigin,allowLocal:true});
const testBridge={base:panelOrigin,auth:{token:"fixture-only",protocol:"12"},
  snapshot:async name=>snap(name),rooms:async()=>({rooms:[...rooms.keys()].map(name=>({name,mode:"talk"})),providers}),
  watch:async args=>invoke("watch_room",args,"upstream"),
};
handlePanel=createPanelHandler({bridge:testBridge,sessions});
const browser = await chromium.launch({ headless: true,
  ...(process.env.PARLEY_TEST_CHROMIUM ? { executablePath: process.env.PARLEY_TEST_CHROMIUM } : {}),
  args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const startupCall = calls.length;
  const errors = []; page.on("pageerror", error => { errors.push(error.message); console.error("native browser page error:", error.message); });
  await page.exposeFunction("__testCall", (name,args)=>invoke(name,args));
  await page.goto("http://127.0.0.1:"+server.address().port);
  await page.locator("#seat1 option").first().waitFor({ state: "attached" });
  const startup=calls.slice(startupCall).filter(c=>c.name==="native_request");
  if (!useDirect) assert.equal(startup.filter(c=>c.args.path.startsWith("/api/room?")).length,1,"startup must not duplicate its snapshot");
  if (!useDirect) assert.equal(startup.filter(c=>c.args.path==="/api/rooms").length,0,"room list must come with the snapshot");
  console.log("native browser: startup uses one snapshot with bundled room list");
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

  let releaseMode;
  modeRequestGate=new Promise(resolve=>{releaseMode=resolve;});
  await page.locator('.mbtn[data-m="work"]').click();
  await page.locator("dialog button[type=submit]").click();
  await page.locator('.mbtn[data-m="work"][aria-busy="true"]').waitFor();
  assert.ok(await page.locator('.mbtn[data-m="talk"]').isDisabled());
  assert.ok(await page.locator('.mbtn[data-m="talk"]').evaluate(el=>el.classList.contains("active")));
  releaseMode(); modeRequestGate=null;
  await page.locator('.mbtn[data-m="work"].active:not([aria-busy])').waitFor();
  assert.ok(await page.locator("#transportStatus").isVisible());
  assert.match(await page.locator("#transportStatus").innerText(),useDirect?/直连（HTTPS）/:/备用连接/);
  assert.ok((await page.evaluate(()=>window.__parleyPerformance())).lastRequest.elapsedMs>=0);
  console.log("native browser: mode feedback is immediate and saved mode updates without SSE");

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
  const phone = await browser.newPage({ viewport: {width:390,height:844}, isMobile:true, hasTouch:true });
  phone.on("pageerror", error => errors.push(error.message));
  await phone.exposeFunction("__testCall", (name,args)=>invoke(name,args));
  await phone.goto("http://127.0.0.1:"+server.address().port);
  await phone.locator("#pills .pill").first().waitFor();
  const inside = async selector => {
    const box = await phone.locator(selector).boundingBox();
    const size = phone.viewportSize();
    assert.ok(box && box.x >= -1 && box.y >= -1 && box.x+box.width <= size.width+1 && box.y+box.height <= size.height+1, selector+" outside viewport: "+JSON.stringify(box));
  };
  for (const width of [320,375,390,430]) {
    await phone.setViewportSize({width,height:844});
    await inside("#input"); await inside("#sendBtn");
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page must not overflow horizontally");
    assert.ok((await phone.locator("header").boundingBox()).height <= 120, "header must leave room for chat");
  }
  await phone.setViewportSize({width:390,height:844});
  await phone.locator("#navToggle").tap();
  await phone.locator("#addRoomBtn").tap(); await phone.locator("#newRoomInput").fill("phone-session");
  await phone.locator("#newRoomCreate").tap();
  await phone.waitForFunction(() => document.getElementById("roomTitle").textContent === "phone-session");
  await phone.locator("#navToggle").tap();
  assert.ok(await phone.getByRole("button",{name:"Rename phone-session",exact:true}).isVisible(), "rename must work without hover");
  await phone.getByRole("button",{name:"session-a",exact:true}).tap();
  await phone.waitForFunction(() => document.getElementById("roomTitle").textContent === "session-a");
  await phone.locator("#input").fill("手机换行");
  const beforeSend = calls.filter(c => c.args?.path === "/api/message").length;
  await phone.locator("#input").press("End"); await phone.locator("#input").press("Enter");
  assert.equal(await phone.locator("#input").inputValue(),"手机换行\n");
  assert.equal(calls.filter(c => c.args?.path === "/api/message").length,beforeSend,"phone Enter must not send");
  await phone.locator("#sendBtn").tap(); await phone.getByText("浏览器回复",{exact:false}).waitFor();
  await phone.locator("#mobileOptions summary").tap(); await phone.locator("#hopBtn").tap();
  await phone.locator("#hopMenu").waitFor({state:"visible"});
  await phone.locator("#hopMenu [data-hop-choice=solo]").tap();
  await phone.locator("#settingsBtn").tap();
  await phone.locator("#overlay").waitFor({state:"visible"});
  const columns = await phone.locator(".modal .mgrid").first().evaluate(el => getComputedStyle(el).gridTemplateColumns);
  assert.equal(columns.trim().split(/\s+/).length,1,"phone settings must use one column");
  await phone.locator("#mCancel").scrollIntoViewIfNeeded(); await phone.locator("#mCancel").tap();
  await phone.locator("#overlay").waitFor({state:"hidden"});
  await phone.setViewportSize({width:390,height:420});
  await inside("#input"); await inside("#sendBtn");
  await phone.setViewportSize({width:844,height:390}); await inside("#sendBtn");
  assert.ok(await phone.locator("#navToggle").isVisible(),"landscape phone must keep the drawer layout");
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),"landscape must not overflow horizontally");
  await phone.setViewportSize({width:390,height:844});
  if (process.env.PARLEY_SCREENSHOTS) {
    mkdirSync(process.env.PARLEY_SCREENSHOTS,{recursive:true});
    await phone.waitForFunction(() => !document.body.classList.contains("nav-open") && document.getElementById("sidebar").getBoundingClientRect().right <= 0);
    await phone.screenshot({path:join(process.env.PARLEY_SCREENSHOTS,"phone-chat.png")});
    await phone.locator("#navToggle").tap();
    await phone.waitForFunction(() => document.getElementById("sidebar").getBoundingClientRect().left >= -1);
    await phone.screenshot({path:join(process.env.PARLEY_SCREENSHOTS,"phone-rooms.png")});
    await phone.locator("#mobileNavClose").tap();
  }
  await phone.setViewportSize({width:1100,height:800});
  await phone.locator("header #modeToggle").waitFor({state:"visible"});
  assert.equal(await phone.locator("header #modeToggle").count(),1,"desktop mode control must return to header");
  assert.equal(await phone.locator("#chipsRow > #hopWrap").count(),1,"desktop continuation control must return");
  await phone.close();
  console.log("mobile browser: touch rooms, newline/send, options, single-column settings, keyboard-sized viewport and desktop restoration passed");
  assert.deepEqual(errors,[]);
  if(useDirect){
    assert.equal(calls.filter(c=>c.source==="mcp" && ["native_request","watch_room","get_room"].includes(c.name)).length,0,"all UI operations and live output must avoid MCP after authorization");
    assert.ok(calls.some(c=>c.source==="mcp"&&c.name==="panel_session"));
    console.log("direct browser: authorized HTTP and SSE; zero business API or watch calls through MCP");
  }
  console.log(JSON.stringify({ok:true,createdRooms:2,roomSwitchDrafts:true,reload:true,sendAndStream:true,attachment:true,settings:true,rename:true,delete:true,transcript:true,responsiveSizes:3}));
} finally { await browser.close(); server.close(); panelServer.closeAllConnections(); panelServer.close(); }
