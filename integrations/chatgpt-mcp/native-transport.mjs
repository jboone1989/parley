import { App } from "@modelcontextprotocol/ext-apps";
import { PanelTransport } from "./direct-client.mjs";
const browserFetch = window.fetch?.bind(window);
let direct, initialPanelSession;

const app = new App({ name: "Parley", version: "0.2.0" });
const seeds = new Map();
let activeRoom, started = false;
const stored = key => { try { return sessionStorage.getItem(key); } catch { return null; } };
const remember = (key, value) => { try { sessionStorage.setItem(key, value); } catch {} };

// Keep background watches out of the interactive request queue. Some hosts
// serialize tool calls, so a long poll can otherwise delay every button.
const foreground = [], background = [], reads = new Map(), readCache = new Map();
let dispatching = false, generation = 0, foregroundCount = 0;
const performance = { directCalls: 0, calls: 0, queuedMs: 0, remoteMs: 0, cacheHits: 0, mergedReads: 0 };
window.__parleyPerformance = () => ({ ...performance, mode: direct?.ready ? "direct" : "mcp", foregroundPending: foregroundCount });
function dispatch() {
  if (dispatching) return;
  const task = foreground.shift() || background.shift();
  if (!task) return;
  dispatching = true;
  const began = Date.now(); performance.queuedMs += began - task.queuedAt;
  performance.calls++;
  Promise.resolve().then(() => app.callServerTool({ name: task.name, arguments: task.args }))
    .then(result => {
      if (result.isError) throw Error(result.content?.find(item => item.type === "text")?.text || "Parley request failed");
      if (task.name === "panel_session") return result._meta?.panelSession;
      return result.structuredContent || JSON.parse(result.content?.find(item => item.type === "text")?.text || "{}");
    }).then(task.resolve, task.reject).finally(() => {
      performance.remoteMs += Date.now() - began;
      if (task.name !== "watch_room") foregroundCount--;
      dispatching = false; dispatch();
    });
}
function call(name, args) {
  return new Promise((resolve, reject) => {
    if (name !== "watch_room") foregroundCount++;
    (name === "watch_room" ? background : foreground).push({ name, args, resolve, reject, queuedAt: Date.now() });
    dispatch();
  });
}
function transportStatus(ready, connecting = false) {
  let status = document.getElementById("transportStatus");
  if (!status) {
    status = document.createElement("div"); status.id = "transportStatus"; status.setAttribute("role", "status");
    status.style.cssText = "padding:6px 12px;font-size:12px;color:var(--text-dim);background:var(--bg2)";
    document.querySelector("header").after(status);
  }
  status.hidden = ready;
  status.textContent = connecting ? "正在连接 Parley…" : "直连暂不可用，正在使用备用连接。";
  if (!connecting && !ready) {
    const retry = document.createElement("button"); retry.textContent = "重试直连";
    retry.style.cssText = "text-decoration:underline;margin-left:8px;min-height:32px";
    retry.onclick = async () => {
      retry.disabled = true;
      try { await direct.connect(); readCache.clear(); transportStatus(true); }
      catch { transportStatus(false); }
    };
    status.append(retry);
  }
}
async function nativeRemote(args) {
  if (direct?.ready) {
    try { performance.directCalls++; return await direct.request(args); }
    catch (error) {
      direct.ready = false; transportStatus(false);
      if (args.method !== "GET") throw Error("操作结果未确认，请检查会话状态后再重试。");
    }
  }
  return call("native_request", args);
}
function nativeRead(url) {
  const path = url.pathname + url.search, key = generation + ":" + path;
  const cached = readCache.get(path);
  if (cached && cached.until > Date.now()) { performance.cacheHits++; return Promise.resolve(cached.value); }
  if (reads.has(key)) { performance.mergedReads++; return reads.get(key); }
  const revision = generation;
  const outgoing = new URL(url);
  if (url.pathname === "/api/room") outgoing.searchParams.set("panel", "1");
  const pending = nativeRemote({ path: outgoing.pathname + outgoing.search, method: "GET" }).then(value => {
    if (revision === generation && value.status === 200) {
      const ttl = url.pathname === "/api/rooms" ? 2000 : url.pathname === "/api/doctor" ? 30000 : 0;
      if (ttl) readCache.set(path, { value, until: Date.now() + ttl });
      if (value.json?.panel?.rooms) readCache.set("/api/rooms", {
        value: { ...value, json: value.json.panel.rooms }, until: Date.now() + 2000,
      });
    }
    return value;
  }).finally(() => reads.delete(key));
  reads.set(key, pending); return pending;
}

// Embedded sandboxes do not reliably allow blocking alert/confirm/prompt.
// Keep the original questions and decisions, presented in accessible dialogs.
let dialogTail = Promise.resolve();
export function askDialog(message, value) {
  const result = dialogTail.then(() => new Promise(resolve => {
    const dialog = document.createElement("dialog"), form = document.createElement("form");
    form.method = "dialog";
    const label = document.createElement("p"); label.textContent = message;
    label.style.whiteSpace = "pre-wrap"; form.append(label);
    let input;
    if (value !== undefined) {
      input = document.createElement("input"); input.value = value; input.style.width = "100%";
      input.setAttribute("aria-label", message); form.append(input);
    }
    const cancel = document.createElement("button"), ok = document.createElement("button");
    cancel.type = "button"; cancel.textContent = "取消"; ok.type = "submit"; ok.textContent = "确认";
    form.append(cancel, ok); dialog.append(form); document.body.append(dialog);
    dialog.style.cssText = "max-width:min(560px,94vw);padding:20px;border-radius:12px;border:1px solid #888;background:Canvas;color:CanvasText";
    let done = false;
    const finish = accepted => {
      if (done) return; done = true; dialog.close(); dialog.remove();
      resolve(value === undefined ? accepted : (accepted ? input.value : null));
    };
    cancel.onclick = () => finish(false);
    form.onsubmit = event => { event.preventDefault(); finish(true); };
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    dialog.showModal(); (input || ok).focus();
  }));
  dialogTail = result.catch(() => {}); return result;
}
window.__parleyConfirm = message => askDialog(message);
window.__parleyPrompt = (message, value = "") => askDialog(message, value);
window.__parleySaveDraft = () => {
  const room = window.__parleyNative?.room, input = document.getElementById("input");
  if (room && input) remember("parley.native.draft:" + room, input.value);
};
window.__parleyRestoreDraft = room => {
  const input = document.getElementById("input");
  if (input) {
    input.value = stored("parley.native.draft:" + room) || "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
};
window.__parleyHistory = (_state, _title, path) => {
  const room = new URL(path, "https://parley.invalid/").searchParams.get("room") || "default";
  remember("parley.native.room", room);
};

export async function nativeFetch(path, options = {}) {
  const url = new URL(String(path), "https://parley.invalid/");
  if (url.origin !== "https://parley.invalid") throw Error("External network requests are not supported");
  const body = options.body === undefined ? undefined : JSON.parse(options.body);
  let result;
  if (url.pathname === "/api/pickfolder") {
    const path = await askDialog("输入 Parley 服务器上的项目文件夹路径", body?.start || "");
    result = { status: 200, headers: { "x-parley-runtime-protocol": "12" }, json: path ? { path } : { cancelled: true } };
  } else if (url.pathname === "/api/open") {
    const snapshot = await call("get_room", { room: body.room });
    const path = body.what === "workspace" ? snapshot.room.workspace : snapshot.room.dir;
    await askDialog("文件夹位于 Parley 服务器：\n" + path);
    result = { status: 200, headers: { "x-parley-runtime-protocol": "12" }, json: { ok: true, path } };
  } else {
    if ((options.method || "GET") === "GET") result = await nativeRead(url);
    else {
      generation++; readCache.clear();
      try {
        result = await nativeRemote({ path: url.pathname + url.search, method: options.method, ...(body === undefined ? {} : { body }) });
      } finally { generation++; readCache.clear(); }
    }
  }
  if (url.pathname === "/api/room" && result.status === 200 && result.json?.room) {
    seeds.set(result.json.room.name, result.json);
  }
  const bytes = result.base64 === undefined ? JSON.stringify(result.json) : Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
  return new Response(bytes, { status: result.status, headers: result.headers });
}
window.fetch = nativeFetch;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export class NativeEventSource extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
  CONNECTING = 0; OPEN = 1; CLOSED = 2;
  readyState = 0; withCredentials = false; onopen = null; onerror = null; onmessage = null;
  constructor(url) {
    super(); this.url = String(url);
    this.room = new URL(this.url, "https://parley.invalid/").searchParams.get("room") || "default";
    this.cursor = seeds.get(this.room)?.cursor || 0;
    this.run();
  }
  emit(name, data) {
    const event = name === "message" ? new MessageEvent(name, { data: JSON.stringify(data) }) : new Event(name);
    this["on" + name]?.(event); this.dispatchEvent(event);
  }
  close() { this.readyState = 2; this.controller?.abort(); }
  seed() {
    const snapshot = seeds.get(this.room);
    for (const [agent, text] of Object.entries(snapshot?.streams || {})) this.emit("message", { type: "stream", agent, text });
  }
  async update(result) {
    if (this.readyState === 2) return false;
    if (result.resync) {
      const previous = seeds.get(this.room); readCache.clear();
      await window.__parleyNative?.refreshAfterGap();
      if (this.readyState === 2) return false;
      const snapshot = seeds.get(this.room);
      if (!snapshot || snapshot === previous || !Number.isInteger(snapshot.cursor)) throw Error("Room resynchronization failed");
      this.cursor = snapshot.cursor; this.seed();
    } else {
      for (const event of result.events || []) { if (this.readyState === 2) return false; this.emit("message", event); }
      this.cursor = result.cursor;
    }
    if (!result.connected && this.readyState === 1) { this.readyState = 0; this.emit("error"); }
    else if (result.connected && this.readyState === 0) { this.readyState = 1; this.emit("open"); }
    return !result.resync;
  }
  async run() {
    await pause(0);
    if (this.readyState === 2) return;
    this.readyState = 1; this.emit("open"); this.seed();
    while (this.readyState !== 2) {
      try {
        if (direct?.ready) {
          this.controller = new AbortController();
          for await (const result of direct.events({ room: this.room, after: this.cursor, signal: this.controller.signal })) {
            if (!await this.update(result)) break;
          }
          if (this.readyState !== 2) await pause(100);
        } else {
          if (foregroundCount || document.visibilityState === "hidden") { await pause(250); continue; }
          const result = await call("watch_room", { room: this.room, after: this.cursor, waitMs: 0 });
          await this.update(result);
          if (this.readyState !== 2) await pause(result.events?.length ? 100 : 1500);
        }
      } catch {
        if (this.readyState === 2) return;
        if (direct?.ready) { direct.ready = false; transportStatus(false); }
        this.readyState = 0; this.emit("error"); await pause(1500);
      }
    }
  }
}
window.EventSource = NativeEventSource;

app.ontoolresult = result => {
  if (result._meta?.panelSession) initialPanelSession = result._meta.panelSession;
  const snapshot = result.structuredContent;
  if (!snapshot?.activeRoom) return;
  activeRoom = snapshot.activeRoom;
  if (started && window.__parleyNative?.room !== activeRoom) window.__parleyNative.loadRoom(activeRoom);
};

async function boot() {
  await app.connect();
  direct = new PanelTransport({ fetch: browserFetch, authorize: async () => {
    if (initialPanelSession?.origin === window.location.origin && initialPanelSession.expiresAt > Date.now() + 30000) {
      const session = initialPanelSession; initialPanelSession = null; return session;
    }
    return call("panel_session", { origin: window.location.origin });
  }});
  transportStatus(false, true);
  try { await direct.connect(); transportStatus(true); }
  catch { transportStatus(false); }
  window.__parleyStart(activeRoom || stored("parley.native.room") || "default"); started = true;
  window.__parleySetupMobile?.();
  // Original actions now show a server path, rather than opening a file manager
  // on a different computer. All other native controls keep their upstream UI.
  const wsLabel = document.getElementById("openWsLabel");
  if (wsLabel) wsLabel.textContent = "Workspace path";
  const roomButton = document.getElementById("openRoomDir");
  if (roomButton) roomButton.textContent = "🗂 Room folder path";
  const input = document.getElementById("input");
  input?.addEventListener("input", window.__parleySaveDraft);
  // Stop IME Enter before the upstream mention/send keyboard handlers run.
  input?.addEventListener("keydown", event => {
    if (event.isComposing || event.keyCode === 229) event.stopImmediatePropagation();
  }, true);
}
boot().catch(err => {
  const banner = document.getElementById("runtimeBanner");
  banner.style.display = "block"; banner.textContent = "Parley 连接失败：" + err.message;
});
