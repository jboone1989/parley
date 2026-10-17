# Claude Connector (independent MCP bridge)

A small Claude Code CLI bridge for ChatGPT. Not coupled to Parley, Codex, GitHub, or LivingRuntime: the MCP caller decides how to use Claude. It uses the **server owner's existing Claude Code login** and does not copy account credentials into plugin files.

## Tools

| Tool | Purpose |
| ---- | ------- |
| `claude_ask` | Start a Claude turn and wait up to `wait_ms` (defaults to 90 seconds). Returns result or a job ID to continue reading. |
| `claude_start` | Start a nonblocking Claude CLI invocation and return a job ID. |
| `claude_read` | Read incremental events after an event cursor, result, and Claude session ID. |
| `claude_sessions` | List tracked resumable session IDs and working directories. |
| `claude_stop` | Send SIGTERM to a running job's process group. |

Both existing CLI session IDs (`--resume`) and bridge-managed sessions work. Claude jobs may run in an approved `cwd` under one of `CLAUDE_ALLOWED_ROOTS`, so review vs discussion or development is a caller decision. The bridge never uses a shell to execute CLI input and does not expose an arbitrary command tool.

## Local development

Node.js >=20. `npm test` uses a mocked Claude CLI; it does not require a real subscription.

```sh
npm test
MCP_ACCESS_TOKEN='replace-with-long-random-secret' \
CLAUDE_ALLOWED_ROOTS=/home/ubuntu/src \
CLAUDE_MCP_HOST=127.0.0.1 CLAUDE_MCP_PORT=8791 \
node src/server.mjs
```

Install/login to `claude` *as the same OS account* that runs the service; check `claude auth status` directly in a trusted terminal. No API key or OAuth login is collected by this bridge. Do not paste credentials into ChatGPT.

The service binds `127.0.0.1` by default. **Never expose port 8791 directly.** Attach an authenticated reverse proxy / Cloudflare Access application to `/mcp` before DNS routing. Auth is checked by the bridge on every request. Supported modes:

- `MCP_ACCESS_TOKEN`: fixed bearer secret for service-to-service/test clients only. Avoid storing this in publicly shared plugin manifests.
- `CLOUDFLARE_TEAM_DOMAIN` and `CLOUDFLARE_ACCESS_AUD`: validate the `Cf-Access-Jwt-Assertion` issued by Cloudflare Access, including signature/JWKS, issuer, audience, and expiration. Protect the hostname with a Cloudflare Access app. This is appropriate for ChatGPT plugin OAuth DCR when enabled by your Access setup.

At least one auth method must be configured. Keep the Cloudflare tunnel upstream local only. If `CLOUDFLARE_*` auth is used, test the full OAuth connection from ChatGPT after deployment.

## Example systemd user unit

```ini
[Unit]
Description=Claude Code MCP connector
After=network-online.target
[Service]
Type=simple
WorkingDirectory=/home/ubuntu/src/claude-connector
Environment=CLAUDE_MCP_HOST=127.0.0.1
Environment=CLAUDE_MCP_PORT=8791
Environment=CLAUDE_ALLOWED_ROOTS=/home/ubuntu/src
EnvironmentFile=%h/.config/claude-connector.env
ExecStart=/usr/bin/node /home/ubuntu/src/claude-connector/src/server.mjs
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
```

Protect the environment file (`chmod 600`), verify the Node.js path used by the service with `command -v node`, and do not include Claude credentials or bearer secrets in this repository.

## MCP wire protocol

The `/mcp` endpoint serves Streamable HTTP JSON responses to MCP `initialize`, `tools/list`, `tools/call`, and `notifications/initialized`. It does not currently implement SSE server push or MCP tasks. For incremental Claude output, use `claude_start` followed by `claude_read` with the returned `cursor`. ChatGPT's native conversation may display collected updates but per-token rendering is not guaranteed by the host.

## Deployment status

Creating the source files and passing mock tests **does not** mean the remote endpoint is deployed. A real end-to-end test must verify: `claude` login, service listener, Cloudflare Access OAuth, plugin MCP tools discovery, and at least one real `claude_ask` returning a Claude session ID.
