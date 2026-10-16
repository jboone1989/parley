import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "Parley", version: "0.2.0" });
const seeds = new Map();
let activeRoom, started = false;
const stored = key => { try { return sessionStorage.getItem(key); } catch { return null; } };
const remember = (key, value) => { try { sessionStorage.setItem(key, value); } catch {} };

async function call(name, args) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw Error(result.content?.find(item => item.type === "text")?.text || "Parley request failed");
  return result.structuredContent || JSON.parse(result.content?.find(item => item.type === "text")?.text || "{}");
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
    result = await call("native_request", { path: url.pathname + url.search, method: options.method || "GET", ...(body === undefined ? {} : { body }) });
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
  close() { this.readyState = 2; }
  seed() {
    const snapshot = seeds.get(this.room);
    for (const [agent, text] of Object.entries(snapshot?.streams || {})) this.emit("message", { type: "stream", agent, text });
  }
  async run() {
    await pause(0);
    if (this.readyState === 2) return;
    this.readyState = 1; this.emit("open"); this.seed();
    while (this.readyState !== 2) {
      try {
        const result = await call("watch_room", { room: this.room, after: this.cursor, waitMs: 3000 });
        if (this.readyState === 2) return;
        if (result.resync) {
          const previous = seeds.get(this.room);
          await window.__parleyNative?.refreshAfterGap();
          if (this.readyState === 2) return;
          const snapshot = seeds.get(this.room);
          if (!snapshot || snapshot === previous || !Number.isInteger(snapshot.cursor)) throw Error("Room resynchronization failed");
          this.cursor = snapshot.cursor;
          this.seed();
        } else {
          for (const event of result.events || []) { if (this.readyState === 2) return; this.emit("message", event); }
          this.cursor = result.cursor;
        }
        if (!result.connected && this.readyState === 1) { this.readyState = 0; this.emit("error"); }
        else if (result.connected && this.readyState === 0) { this.readyState = 1; this.emit("open"); }
      } catch {
        if (this.readyState === 2) return;
        this.readyState = 0; this.emit("error"); await pause(1500);
      }
    }
  }
}
window.EventSource = NativeEventSource;

app.ontoolresult = result => {
  const snapshot = result.structuredContent;
  if (!snapshot?.activeRoom) return;
  activeRoom = snapshot.activeRoom;
  if (started && window.__parleyNative?.room !== activeRoom) window.__parleyNative.loadRoom(activeRoom);
};

async function boot() {
  await app.connect();
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
