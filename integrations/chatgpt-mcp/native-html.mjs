import { readFileSync } from "node:fs";
import { join } from "node:path";

const scriptText = value => value.replace(/<\/script/gi, "<\\/script");

export function nativeAppSource(source) {
  // Business logic and rendering stay upstream. Only browser-host facilities
  // unavailable in an embedded MCP App are redirected to the host adapter.
  return source
    .replace('new URLSearchParams(location.search).get("room") || "default"', '__initialRoom || "default"')
    .replace(/\bhistory\.replaceState\(/g, "window.__parleyHistory(")
    .replace(/\bconfirm\(/g, "await window.__parleyConfirm(")
    .replace(/\bprompt\(/g, "await window.__parleyPrompt(")
    .replace('async function loadRoom(name) {', 'let __roomLoad = 0;\nasync function loadRoom(name) {\n  const __load = ++__roomLoad;\n  window.__parleySaveDraft?.();')
    .replace('data = await api("/api/room?name=" + encodeURIComponent(name));', 'data = await api("/api/room?name=" + encodeURIComponent(name));\n    if (__load !== __roomLoad) return;')
    .replace('if (name === "default") throw e;', 'if (__load !== __roomLoad) return;\n    if (name === "default") throw e;')
    .replace('state.room = roomName;', 'state.room = roomName;\n  window.__parleyRestoreDraft?.(roomName);')
    // The MCP bridge subscribes before reading the snapshot and replays from
    // that boundary, so the upstream HTTP-to-SSE gap fetch is redundant here.
    .replace('connect(true);\n  await refreshRooms();', 'connect(false);\n  await refreshRooms();')
    .replaceAll('input.value = ""; autosize(); hideMention();', 'input.value = ""; autosize(); hideMention(); window.__parleySaveDraft?.();')
    .replace('input.value = text; autosize();', 'input.value = text; autosize(); window.__parleySaveDraft?.();')
    .replace('Opening the folder picker… If Windows keeps it behind, choose ‘Parley — Choose a project folder’ from the taskbar.', '选择 Parley 服务器上的项目文件夹。')
    .replace('📁 Workspace opened in Explorer — check the taskbar if it isn\'t in front.', '服务器工作目录已显示。')
    .replace('🗂️ Room folder opened in Explorer — check the taskbar if it isn\'t in front.', '服务器会话目录已显示。');
}

export function buildNativeHtml(root, nativeRoot = join(root, "../../ui"), transportOverride) {
  const html = readFileSync(join(nativeRoot, "index.html"), "utf8");
  const css = readFileSync(join(nativeRoot, "styles.css"), "utf8");
  const source = nativeAppSource(readFileSync(join(nativeRoot, "app.js"), "utf8"));
  const mobileCss = readFileSync(join(root, "mobile.css"), "utf8");
  const mobileScript = readFileSync(join(root, "mobile.mjs"), "utf8");
  const transport = transportOverride ?? readFileSync(join(root, "public/widget.bundle.js"), "utf8");
  const launch = `window.__parleyStart = function(__initialRoom) {\n${source}\n` +
    'window.__parleyNative = { loadRoom, refreshAfterGap, get room() { return state.room; } };\n};';
  return html
    .replace("<!--PARLEY_TOKEN-->", '<meta name="parley-token" content="mcp-transport">')
    .replace("<!--PARLEY_RUNTIME_PROTOCOL-->", '<meta name="parley-runtime-protocol" content="12">')
    .replace(/<link rel="stylesheet" href="\/ui\/styles\.css[^\"]*">/, () => `<style>${css}</style><style>${mobileCss}</style>`)
    .replace(/<script src="\/ui\/app\.js[^\"]*"><\/script>/, () =>
      `<script>${scriptText(launch)}</script><script>${scriptText(mobileScript)}</script><script>${scriptText(transport)}</script>`);
}
