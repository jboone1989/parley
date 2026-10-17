# Native Parley in ChatGPT

Private MCP Apps extension for Parley 1.2.1. Uses existing Claude Code and Codex CLI subscriptions, not separate model API keys.

## Features
The panel embeds the repository's original `ui/index.html`, `ui/styles.css` and
`ui/app.js`. It does not maintain a second simplified conversation UI. Original
controls and business logic cover creating, switching, renaming and deleting
rooms; Talk/Work modes; provider/model/effort settings; automatic-turn limits;
Pair review; lurk; seat sleep/wake; queues; scoped stop/retry; attachments;
transcript downloads; receipts and token usage.

`native_request` forwards the complete native business API through the existing
authenticated loopback bridge. `watch_room` adapts SSE to resumable MCP polling,
including backlogs, restarts and partial-output snapshots. The original six
chat tools remain available for direct model use.

## Using the panel
Open the Parley panel once and keep using it. The native sidebar's **+** creates
another room; each room has separate history, settings and CLI sessions. Switching
rooms does not create another ChatGPT panel. Per-room text drafts and the selected
room survive reload when the host allows session storage. Chinese IME candidate
confirmation does not send a message.

The remote deployment requires three host adaptations: blocking confirm/prompt
dialogs become in-panel dialogs with the same questions; the OS folder chooser
becomes a server-path input; opening an OS file manager displays the server path.
All confirmations remain explicit. Browser notifications and downloads depend on
the ChatGPT host's browser permissions. The resource supports inline/fullscreen
and prefers fullscreen for the full native interface.

The panel follows native Parley's public output events; it does not expose hidden
model reasoning or create a new ChatGPT assistant turn when an agent finishes.
ChatGPT can retrieve replies through get_room/watch_room. A closed or suspended
panel stops polling and resumes from server history when opened again.

## Direct panel connection
The panel uses an authenticated HTTPS API and a persistent SSE stream on
`https://parley-panel.livingruntime.com/panel`. Publish that hostname through the
existing Cloudflare Tunnel to the same loopback adapter at `127.0.0.1:8787`.
The existing MCP hostname retains its Cloudflare Access/OAuth policy.

The `panel_session` tool is app-only and available only through the authenticated
MCP connection. It issues an origin-bound ten-minute credential in tool-result
`_meta`, never in model-visible content. The browser keeps it only in memory and
sends it in Authorization headers; no credentials appear in URLs or storage.
SSE reconnects from its acknowledged cursor, renews authorization through MCP
when needed, and closes on expiry. Native API methods and route allowlists still
apply. Cross-origin requests require a matching session origin; the direct path
uses no third-party cookies.

If the direct connection cannot be established, the UI shows the fallback state
and retains the existing MCP transport. A failed write is never automatically
replayed through another transport, because its outcome may be unknown.
`PARLEY_PANEL_ORIGIN` overrides the direct HTTPS origin. The component's CSP
permits this origin, and its versioned resource URI invalidates the previous UI.

## Install
Install this directory under /home/ubuntu/ferro-prod/parley/plugin on the AIHOT overseas host. Keep the original Parley server running at 127.0.0.1:4141. With Node.js >= 20 and both authenticated CLI binaries already available:

    npm install
    npm run build
    npm test
    node server.mjs

The plugin listens at 127.0.0.1:8787 by default. GET /healthz returns 200. Requests to /mcp without credentials return 401. For service supervision see parley-mcp.service; adjust paths if deploying elsewhere.

## ChatGPT connection
Use Cloudflare Tunnel to expose ONLY the MCP adapter at http://127.0.0.1:8787, not native Parley at port 4141. Protect the hostname with a Cloudflare Access MCP application and Managed OAuth; restrict the policy to your identity.

Configure the server environment with PARLEY_CF_ACCESS_TEAM and PARLEY_CF_ACCESS_AUD from your Access app. The bridge validates the Cloudflare Access JWT signature, issuer and audience. Do not treat an unverified header as proof of identity.

Alternative: External OAuth 2.1 with PARLEY_OAUTH_ISSUER, PARLEY_OAUTH_AUDIENCE, PARLEY_MCP_PUBLIC_URL, and optionally PARLEY_OAUTH_JWKS_URL. Do not configure both modes at once. PKCE and provider registration must be configured at the provider.

After deployment and OAuth validation, the user explicitly installs a custom MCP app in ChatGPT using its HTTPS /mcp URL. This repository alone does not perform ChatGPT account installation.

## Security and limitations
Parley stays bound to 127.0.0.1 and retains its own per-process token and Host/Origin checks. The adapter retrieves this token only on the server. The development Bearer secret is generated into .bridge-secret (0600), which is gitignored; never expose it publicly.

The widget uses MCP tool calls, not direct browser requests to Parley, to send/receive messages. The widget may stop polling when closed; persisted room history remains available. CI checks source/tests/build, but final Cloudflare OAuth and ChatGPT widget rendering require live integration tests.

This adapter lives only in the user's Parley fork and does not alter the upstream runtime.

## Tests
`npm run build && npm test` checks the actual MCP transport, authorization,
embedded native controls and JavaScript, complete route coverage, binary
attachments, stream recovery and the browser transport shim. With the repository's
root development dependencies and Chromium installed, run
`node test/native-browser.mjs` for an original-UI browser test covering two rooms,
draft switching/reload, sending/streaming, attachments, settings, rename/delete,
transcript downloads and three viewport sizes. It uses a stub MCP host and spends
no provider tokens. GitHub Actions runs that browser test as well.
