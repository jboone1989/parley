import { App } from "@modelcontextprotocol/ext-apps";
import { createRoomState, applyRoomSnapshot, applyRoomEvent, visibleStreams } from "./room-state.mjs";
import { restorePanel, savePanel, shouldSend } from "./panel-session.mjs";

const app = new App({ name: "Parley Chat", version: "0.1.2" });
const $ = id => document.getElementById(id);
let storage;
try { storage = window.sessionStorage; } catch { /* Sandboxed host. */ }
const panel = restorePanel(storage);
const state = createRoomState(panel.room);
const rows = new Map();
let generation = 0;
let revision = 0;
let userSelectedRoom = false;
const error = message => { $("error").textContent = message || ""; };

function rememberDraft() {
  panel.room = state.room;
  panel.drafts[state.room] = $("draft").value;
  savePanel(storage, panel);
}

function ensureRoomOption(name) {
  const select = $("room");
  if (![...select.options].some(option => option.value === name)) {
    const option = document.createElement("option");
    option.value = name; option.textContent = name; select.append(option);
  }
  select.value = name;
}

function selectRoom(room) {
  if (room !== state.room) {
    rememberDraft(); generation++; revision++;
    Object.assign(state, createRoomState(room), { connected: state.connected });
    $("draft").value = panel.drafts[room] || "";
    $("messages").scrollTop = 0;
  }
  ensureRoomOption(room); rememberDraft(); render();
}

async function call(name, params = {}) {
  const result = await app.callServerTool({ name, arguments: params });
  if (result.isError) throw Error(result.content?.find(item => item.type === "text")?.text || "Tool failed");
  if (result.structuredContent) return result.structuredContent;
  try { return JSON.parse(result.content?.find(item => item.type === "text")?.text || "{}"); }
  catch { return {}; }
}

function bubble(key, entry, streaming = false) {
  let item = rows.get(key);
  if (!item) {
    item = document.createElement("article");
    const author = document.createElement("div");
    author.className = "author";
    const body = document.createElement("div");
    body.className = "body";
    item.append(author, body);
    rows.set(key, item);
  }
  const who = String(entry.author || entry.agent || entry.kind || "system");
  item.className = "item" + (who === "user" ? " mine" : "");
  const label = ({ user: "你", claude: "Claude", codex: "Codex" }[who] || who) + (streaming ? " · 正在生成" : "");
  const text = String(entry.text ?? entry.body ?? "");
  if (item.children[0].textContent !== label) item.children[0].textContent = label;
  if (item.children[1].textContent !== text) item.children[1].textContent = text;
  return item;
}

function render() {
  const el = $("messages");
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 70;
  const wanted = new Map();
  for (const entry of state.entries.slice(-150)) wanted.set("entry:" + entry.n, bubble("entry:" + entry.n, entry));
  for (const [agent, text] of visibleStreams(state)) wanted.set("live:" + agent, bubble("live:" + agent, { agent, text }, true));
  if (!wanted.size) wanted.set("empty", bubble("empty", { kind: "system", text: "暂无消息" }));
  for (const [key, node] of rows) {
    if (!wanted.has(key)) { node.remove(); rows.delete(key); }
  }
  // Keep existing message nodes and the user's scroll position during streaming.
  if (!el.dataset.ready) { el.replaceChildren(); el.dataset.ready = "true"; }
  let index = 0;
  for (const node of wanted.values()) {
    if (el.children[index] !== node) el.insertBefore(node, el.children[index] || null);
    index++;
  }
  if (atBottom) el.scrollTop = el.scrollHeight;
  $("busy").textContent = Object.keys(state.busy).filter(agent => state.busy[agent]).join(" · ");
}

async function loadRoom() {
  const room = state.room, epoch = generation, before = revision;
  const snapshot = await call("get_room", { room });
  if (epoch !== generation || room !== state.room) return;
  applyRoomSnapshot(state, snapshot, { preserveLive: before !== revision });
  render();
}

async function loadRooms() {
  const result = await call("list_rooms");
  const names = (result.rooms || []).map(room => typeof room === "string" ? room : room.name).filter(Boolean);
  const select = $("room");
  select.replaceChildren();
  for (const name of names.length ? names : ["default"]) {
    const option = document.createElement("option");
    option.value = name; option.textContent = name; select.append(option);
  }
  ensureRoomOption(state.room);
}

async function poll() {
  while (state.connected) {
    if (document.visibilityState === "hidden") { await new Promise(resolve => setTimeout(resolve, 1200)); continue; }
    const room = state.room, epoch = generation;
    try {
      const result = await call("watch_room", { room, after: state.cursor, waitMs: 3000 });
      if (epoch !== generation || room !== state.room) continue;
      let resync = !!result.resync;
      if (!resync) for (const event of result.events || []) { revision++; resync = applyRoomEvent(state, event) || resync; }
      const previousCursor = state.cursor;
      state.cursor = result.cursor ?? state.cursor;
      if (resync) {
        try { await loadRoom(); }
        catch (err) { state.cursor = previousCursor; throw err; }
      }
      if (epoch !== generation) continue;
      $("state").textContent = result.connected ? "实时连接" : "正在重连";
      render();
    } catch (err) {
      if (epoch !== generation) continue;
      $("state").textContent = "连接中断"; error(err.message);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

$("target").addEventListener("change", () => {
  $("solo").disabled = $("target").value === "both";
  if ($("solo").disabled) $("solo").checked = false;
});
$("solo").disabled = $("target").value === "both";
$("draft").value = panel.drafts[state.room] || "";
$("draft").addEventListener("input", rememberDraft);
$("send").addEventListener("click", async () => {
  const draft = $("draft").value, message = draft.trim(), room = state.room;
  if (!message || $("send").disabled) return;
  const button = $("send"); button.disabled = true; error("");
  try {
    await call("send_message", { room, target: $("target").value, text: message, solo: $("target").value !== "both" && $("solo").checked });
    if (state.room === room && $("draft").value === draft) $("draft").value = "";
    if (panel.drafts[room] === draft) delete panel.drafts[room];
    rememberDraft();
    if (state.room === room) await loadRoom().catch(err => error("消息已发送，记录刷新失败：" + err.message));
  } catch (err) { error(err.message); }
  finally { button.disabled = false; }
});
$("draft").addEventListener("keydown", event => {
  if (shouldSend(event)) { event.preventDefault(); $("send").click(); }
});
$("stop").addEventListener("click", async () => {
  try { await call("stop_reply", { room: state.room, agent: null }); await loadRoom(); }
  catch (err) { error(err.message); }
});
$("refresh").addEventListener("click", () => loadRoom().catch(err => error(err.message)));
$("room").addEventListener("change", async event => {
  userSelectedRoom = true;
  selectRoom(event.target.value); error("");
  await loadRoom().catch(err => error(err.message));
});
app.ontoolresult = result => {
  const snapshot = result.structuredContent;
  if (!snapshot?.entries) return;
  const room = snapshot.activeRoom || snapshot.room?.name || state.room;
  if (room !== state.room && userSelectedRoom) return;
  selectRoom(room);
  applyRoomSnapshot(state, snapshot); render();
};
(async () => {
  try { await app.connect(); await loadRooms(); await loadRoom(); state.connected = true; poll(); }
  catch (err) { error(err.message); $("state").textContent = "未连接"; }
})();
