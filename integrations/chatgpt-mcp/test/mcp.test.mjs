import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = dirname(dirname(fileURLToPath(import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("real MCP initializes and lists all tools without exposing unauthenticated access", async t => {
  const port = await unusedPort();
  const origin = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd, env: { ...process.env, PARLEY_PLUGIN_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errorOutput = "";
  child.stderr.on("data", part => { errorOutput += String(part).slice(-4000); });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* process still starting */ }
    await pause(100);
  }
  assert.equal(ready, true, "MCP server failed to start: " + errorOutput.slice(-1500));
  const unauthorized = await fetch(origin + "/mcp", { signal: AbortSignal.timeout(1000) });
  assert.equal(unauthorized.status, 401);

  const bearer = readFileSync(join(cwd, ".bridge-secret"), "utf8").trim();
  const request = async (id, method, params) => {
    const response = await fetch(origin + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + bearer,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(response.status, 200, method + " failed");
    const result = await response.json();
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    return result.result;
  };
  const session = await request(1, "initialize", {
    protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "mcp-smoke", version: "1" },
  });
  assert.equal(session.serverInfo.name, "parley-chatgpt");
  const listed = await request(2, "tools/list", {});
  assert.deepEqual(listed.tools.map(x => x.name).sort(), [
    "get_room", "list_rooms", "native_request", "open_room", "panel_session", "send_message", "stop_reply", "watch_room",
  ]);
  const sessionTool = listed.tools.find(tool => tool.name === "panel_session");
  assert.deepEqual(sessionTool._meta.ui.visibility, ["app"]);
  const credential = await request(4,"tools/call",{name:"panel_session",arguments:{origin:"https://web-sandbox.oaiusercontent.com"}});
  assert.equal(credential.structuredContent.ready,true);
  assert.ok(credential._meta.panelSession.token.length>=40);
  assert.ok(!JSON.stringify(credential.content).includes(credential._meta.panelSession.token));
  assert.equal(credential.structuredContent.token,undefined);
  const opener = listed.tools.find(tool => tool.name === "open_room");
  const uri = opener._meta.ui.resourceUri;
  assert.equal(opener._meta["openai/outputTemplate"], uri);
  assert.deepEqual(opener._meta["openai/ui"].entrypoints, [
    { type: "global", title: "Parley" },
  ]);
  for (const tool of listed.tools) {
    assert.equal(tool._meta["openai/widgetAccessible"], true, tool.name);
    if (tool.name !== "open_room") {
      assert.equal(tool._meta.ui?.resourceUri, undefined, tool.name + " must not remount the chat");
    }
  }
  const resource = await request(3, "resources/read", { uri });
  const html = resource.contents.find(content => content.uri === uri);
  assert.ok(html._meta.ui.csp.connectDomains.includes("https://parley-panel.livingruntime.com"));
  assert.equal(html.mimeType, "text/html;profile=mcp-app");
  for (const id of ["input", "sendBtn", "addRoomBtn", "roomList", "overlay", "fileInput"]) {
    assert.ok(html.text.includes('id="' + id + '"'), "Original Parley control missing: " + id);
  }
  const bundle = readFileSync(join(cwd, "public/widget.bundle.js"), "utf8");
  assert.ok(html.text.includes(bundle), "UI resource must preserve bundled JavaScript verbatim");
  // A saved ChatGPT tool definition can still request the previous UI URI.
  const legacyUri = "ui://parley/native-v1.html";
  const legacyResource = await request(5, "resources/read", { uri: legacyUri });
  const legacyHtml = legacyResource.contents.find(content => content.uri === legacyUri);
  assert.ok(legacyHtml, "Previously advertised UI URI must remain readable");
  assert.equal(legacyHtml.text, html.text);
  assert.deepEqual(legacyHtml._meta.ui.csp, html._meta.ui.csp);

});
