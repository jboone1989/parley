# ChatGPT MCP adapter for Parley

Private MCP Apps extension for Parley 1.2.1. Uses existing Claude Code and Codex CLI subscriptions, not separate model API keys.

## Features
- ChatGPT embedded conversation panel for Claude, Codex and both
- Send messages, list rooms, read history, stop replies
- SSE-backed incremental updates with bounded cursor and resynchronization
- Authenticated private MCP Streamable HTTP endpoint

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
