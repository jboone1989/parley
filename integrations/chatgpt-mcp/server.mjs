import { createServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { ParleyBridge } from "./bridge.mjs";
import { verifyRequest, authenticationChallenge, resourceMetadata, oauthEnabled } from "./auth.mjs";
import { nativeRequest } from "./native-api.mjs";
import { PanelSessions, panelOrigin } from "./panel-auth.mjs";
import { createPanelHandler } from "./panel-server.mjs";
import { buildNativeHtml } from "./native-html.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const uri = "ui://parley/native-direct-v2.html";
const widget = buildNativeHtml(root);
const bridge = new ParleyBridge();
const panelSessions = new PanelSessions();
const handlePanel = createPanelHandler({ bridge, sessions: panelSessions });
const securitySchemes = oauthEnabled() ? [{ type: "oauth2", scopes: ["parley:access"] }] : undefined;
const roomSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).default("default");
const reply = (value, note) => ({
  structuredContent: value,
  content: [{ type: "text", text: note || JSON.stringify(value).slice(0, 15000) }],
});
function makeMcp() {
  const mcp = new McpServer({ name: "parley-chatgpt", version: "0.1.0" });
  registerAppResource(mcp, "Parley chat", uri, {}, async () => ({
    contents: [{
      uri, mimeType: RESOURCE_MIME_TYPE, text: widget,
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [panelOrigin], resourceDomains: [] } },
        "openai/ui": { availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "fullscreen" },
        "openai/widgetDescription": "Original Parley interface: multiple rooms, settings, attachments, pair review and live output" },
    }],
  }));
  const secure = {
    ...(securitySchemes ? { securitySchemes } : {}),
    _meta: { "openai/widgetAccessible": true },
  };
  registerAppTool(mcp, "open_room", {
    title: "Open Parley room", description: "Open the persistent Parley chat panel once when requested. Reuse the existing panel for subsequent messages; do not reopen it to read or send replies.",
    inputSchema: { room: roomSchema }, ...secure,
    _meta: {
      ...secure._meta,
      ui: { resourceUri: uri },
      "openai/outputTemplate": uri,
      "openai/ui": { entrypoints: [{ type: "global", title: "Parley" }] },
    },
  }, async ({ room }) => ({ ...reply({ ...(await bridge.snapshot(room)), activeRoom: room }, "Opened room " + room),
    _meta: { panelSession: panelSessions.issue("https://web-sandbox.oaiusercontent.com") },
  }));
  mcp.registerTool("list_rooms", {
    title: "List rooms", description: "List available Parley conversations",
    inputSchema: {}, ...secure,
  }, async () => reply(await bridge.rooms()));
  mcp.registerTool("get_room", {
    title: "Read room", description: "Read Parley conversation history and agent statuses",
    inputSchema: { room: roomSchema }, ...secure,
  }, async ({ room }) => reply(await bridge.snapshot(room)));
  mcp.registerTool("send_message", {
    title: "Send message", description: "Send user text to Claude, Codex, or both; starts real CLI agent turns",
    inputSchema: {
      room: roomSchema, target: z.enum(["claude", "codex", "both"]).default("both"),
      text: z.string().min(1).max(12000), solo: z.boolean().default(false),
    }, ...secure,
  }, async args => reply(await bridge.send(args), "Message accepted. Read the room or watch for replies."));
  mcp.registerTool("watch_room", {
    title: "Watch replies", description: "Incremental SSE updates with resumable cursor",
    inputSchema: {
      room: roomSchema, after: z.number().int().nonnegative().default(0),
      waitMs: z.number().int().min(0).max(8000).default(3000),
    }, ...secure,
  }, async args => reply(await bridge.watch(args)));
  mcp.registerTool("stop_reply", {
    title: "Stop reply", description: "Stop Claude, Codex, or both",
    inputSchema: { room: roomSchema, agent: z.enum(["claude", "codex"]).nullable().default(null) }, ...secure,
  }, async args => reply(await bridge.stop(args)));
  mcp.registerTool("panel_session", {
    title: "Connect Parley panel",
    description: "Authorize a ten-minute, origin-bound direct connection for the existing Parley panel.",
    inputSchema: { origin: z.string().url() }, ...secure,
    _meta: { ...secure._meta, ui: { visibility: ["app"] } },
  }, async ({ origin }) => ({
    content: [{ type: "text", text: "Panel connection authorized" }],
    structuredContent: { ready: true },
    _meta: { panelSession: panelSessions.issue(origin) },
  }));
  mcp.registerTool("native_request", {
    title: "Use native Parley features",
    description: "Pass through the original Parley API: create/rename/delete rooms, configure agents and modes, manage pair review, queues and sleep, upload attachments and download transcripts. Reuses the existing panel.",
    inputSchema: { path: z.string(), method: z.enum(["GET", "POST"]).default("GET"), body: z.unknown().optional() },
    ...secure,
  }, async args => reply(await nativeRequest(bridge, args), "Native Parley response"));
  return mcp;
}
const port = Number(process.env.PARLEY_PLUGIN_PORT || 8787);
const server = createServer(async (req, res) => {
  if (await handlePanel(req, res)) return;
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ ok: true, name: "parley-chatgpt" }));
  }
  if (pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
    const metadata = resourceMetadata();
    if (metadata) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(metadata));
    }
  }
  if (pathname !== "/mcp" || !["GET", "POST", "DELETE"].includes(req.method)) {
    res.writeHead(404); return res.end("Not found");
  }
  if (!await verifyRequest(req)) {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": authenticationChallenge() });
    return res.end(JSON.stringify({ error: "Authentication required" }));
  }
  const mcp = makeMcp();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, enableJsonResponse: true,
  });
  res.on("close", () => { transport.close(); mcp.close(); });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("MCP request error:", err?.message || "unknown error");
    if (!res.headersSent) { res.writeHead(500); res.end("Internal server error"); }
  }
});
server.listen(port, "127.0.0.1", () => console.log("Parley MCP listening on 127.0.0.1:" + port));
