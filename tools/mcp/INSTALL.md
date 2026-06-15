# baskStream MCP Install Guide

This guide is Windows-first because most Niagara workstations will be Windows. The same MCP server also works on macOS and Linux.

The MCP server is a local stdio process. It does not replace the Niagara module or the companion app. It gives AI clients a controlled bridge into the station through the existing baskStream WebSocket API.

## Prerequisites

- BASkStreamService is installed and running in the Niagara station.
- Niagara WebService is running and reachable from the client machine.
- Node.js 18 or newer is installed for the repo-local stdio server, setup scripts, and manual client configs. Claude Desktop desktop extensions (`.mcpb`) can use Claude Desktop's bundled Node runtime.
- The client can reach `https://<station>/stream/health` after login.
- A Niagara user exists with only the permissions the AI workflow should have.

Do not commit station credentials. Put them in the MCP client settings, local environment variables, or a local ignored `tools/mcp/config.json`.

## Windows Quick Start

PowerShell:

```powershell
cd C:\path\to\NiagaraFalls\tools\mcp
npm run setup

$env:BASKSTREAM_STATION_URL = "https://<station>"
$env:BASKSTREAM_USER = "<niagara-user>"
$env:BASKSTREAM_PASSWORD = "<niagara-password>"
$env:BASKSTREAM_VERIFY_TLS = "false"
$env:BASKSTREAM_ALLOW_WRITES = "false"
$env:BASKSTREAM_ALLOW_ALARM_ACTIONS = "false"

npm run doctor
npm run print-config
```

Or use the helper script:

```powershell
cd C:\path\to\NiagaraFalls\tools\mcp
.\scripts\install-windows.ps1 -StationUrl "https://<station>" -User "<niagara-user>"
```

If `npm install` fails on a mounted or shared filesystem, `npm run setup` retries with `--no-bin-links`.

If dependencies are already present, `npm run setup` skips reinstalling them to avoid mounted-volume rename errors. Force a reinstall only when needed:

```powershell
npm run setup -- --force-install
```

## Generic MCP Clients

Use this shape for clients that accept an `mcpServers` JSON block:

```json
{
  "mcpServers": {
    "baskstream": {
      "command": "node",
      "args": ["C:\\path\\to\\NiagaraFalls\\tools\\mcp\\dist\\index.js"],
      "env": {
        "BASKSTREAM_STATION_URL": "https://<station>",
        "BASKSTREAM_USER": "<niagara-user>",
        "BASKSTREAM_PASSWORD": "<niagara-password>",
        "BASKSTREAM_VERIFY_TLS": "false",
        "BASKSTREAM_ALLOW_WRITES": "false",
        "BASKSTREAM_ALLOW_ALARM_ACTIONS": "false"
      }
    }
  }
}
```

Run `npm run print-config` to print a config using the actual path on the current machine.

For client-specific config files, see [CLIENTS.md](CLIENTS.md) and the templates in `examples/`.

## VS Code / Copilot

VS Code uses a different root key than most MCP clients:

```json
{
  "servers": {
    "baskstream": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\NiagaraFalls\\tools\\mcp\\dist\\index.js"]
    }
  }
}
```

Use `.vscode/mcp.json` for a workspace config or MCP: Open User Configuration for a user-level config. The template in `examples/vscode.mcp.json` uses VS Code input variables so credentials are prompted instead of hardcoded.

## Cursor

Cursor uses `.cursor/mcp.json` for project config or `~/.cursor/mcp.json` for global config:

```json
{
  "mcpServers": {
    "baskstream": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\NiagaraFalls\\tools\\mcp\\dist\\index.js"],
      "env": {
        "BASKSTREAM_STATION_URL": "${env:BASKSTREAM_STATION_URL}",
        "BASKSTREAM_USER": "${env:BASKSTREAM_USER}",
        "BASKSTREAM_PASSWORD": "${env:BASKSTREAM_PASSWORD}"
      }
    }
  }
}
```

Set the referenced environment variables in Windows before launching Cursor.

## Windsurf / Cascade

Windsurf/Cascade uses `~/.codeium/windsurf/mcp_config.json` with the usual `mcpServers` shape. Use `examples/windsurf.mcp_config.json`, or paste the Windsurf section from `npm run print-config`.

## Cline

Cline can open its MCP settings JSON from the extension UI, or use `~/.cline/mcp.json` for the CLI. Use `examples/cline.mcp.json` and keep `autoApprove` empty until the workflow is proven.

## Augment

Augment can import a normal `mcpServers` JSON block from its MCP settings panel. Use `examples/augment-import.json`.

## Claude Code

Claude Code supports local stdio MCP servers with `claude mcp add ... -- <command> [args...]`.

PowerShell:

```powershell
claude mcp add `
  --env BASKSTREAM_STATION_URL="https://<station>" `
  --env BASKSTREAM_USER="<niagara-user>" `
  --env BASKSTREAM_PASSWORD="<niagara-password>" `
  --env BASKSTREAM_VERIFY_TLS="false" `
  --env BASKSTREAM_ALLOW_WRITES="false" `
  --env BASKSTREAM_ALLOW_ALARM_ACTIONS="false" `
  --transport stdio `
  baskstream -- node "C:\path\to\NiagaraFalls\tools\mcp\dist\index.js"
```

Then check it:

```powershell
claude mcp list
claude mcp get baskstream
```

Inside Claude Code, use `/mcp` to confirm the server is connected.

## Hermes Agent

Hermes reads MCP servers from `~/.hermes/config.yaml`.

```yaml
mcp_servers:
  baskstream:
    command: "node"
    args:
      - "C:\\path\\to\\NiagaraFalls\\tools\\mcp\\dist\\index.js"
    env:
      BASKSTREAM_STATION_URL: "https://<station>"
      BASKSTREAM_USER: "<niagara-user>"
      BASKSTREAM_PASSWORD: "<niagara-password>"
      BASKSTREAM_VERIFY_TLS: "false"
      BASKSTREAM_ALLOW_WRITES: "false"
      BASKSTREAM_ALLOW_ALARM_ACTIONS: "false"
    enabled: true
    timeout: 120
    connect_timeout: 60
```

Start Hermes after editing the file:

```powershell
hermes chat
```

Hermes also supports `tools.include` and `tools.exclude` if you want a read-only profile that hides mutation tools from the model.

## Claude Desktop

Easiest non-developer Claude Desktop install target: package this server as an MCP Bundle (`.mcpb`). MCPB is a zip-based bundle with `manifest.json`, the server entry point, and dependencies. Claude Desktop on Windows and macOS can install private `.mcpb` files, and sensitive user config can be marked sensitive so Claude Desktop stores it in the operating system's secure storage.

Current repo status:

- The MCP server is already Node-based and stdio-based, which matches the MCPB recommendation.
- Manual MCP JSON works today in clients that accept stdio configs.
- `tools/mcp/mcpb/manifest.example.json` defines station URL, username, password, TLS verification, point writes, and alarm actions as install-time user config fields.
- `npm run prepare:mcpb` creates an ignored `.mcpb-build/bask-stream/` folder with `server/index.js`, the manifest, package metadata, and production dependencies.
- If the bundle dependencies are already present, `prepare:mcpb` skips reinstalling them. Use `npm run prepare:mcpb -- --force-install` only when the bundle `node_modules` is stale.

Build path for a private `.mcpb`:

```powershell
cd C:\path\to\NiagaraFalls\tools\mcp
npm run build
npm run prepare:mcpb
npm install -g @anthropic-ai/mcpb
cd .mcpb-build\bask-stream
mcpb pack
```

For active development, the manual config path is still easier to inspect and debug. Use MCPB when you want a cleaner install for non-developer users.

## Codex Plugin Template

The repo includes a small Codex plugin template at:

```text
tools/codex-plugin/bask-stream/
```

It includes:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `bin/launch-mcp.mjs`
- one focused station workflow skill

Build the MCP first:

```powershell
cd C:\path\to\NiagaraFalls\tools\mcp
npm run setup
```

Then load or package the plugin from `tools/codex-plugin/bask-stream/` according to your Codex plugin workflow.

## Claude Code Plugin Template

Claude Code also has plugin support. The repo includes a matching template at:

```text
tools/claude-plugin/bask-stream/
```

Test it locally:

```powershell
claude --plugin-dir C:\path\to\NiagaraFalls\tools\claude-plugin\bask-stream
```

The plugin uses `${CLAUDE_PLUGIN_ROOT}` to launch the same MCP server from `tools/mcp/dist/index.js`. Build the MCP before testing.

## Write Access

The MCP exposes write-capable tools, but they are disabled by default.

Enable point writes:

```powershell
$env:BASKSTREAM_ALLOW_WRITES = "true"
```

Enable alarm acknowledge and clear:

```powershell
$env:BASKSTREAM_ALLOW_ALARM_ACTIONS = "true"
```

Still follow this workflow:

1. Call `baskstream_diagnose_connection`.
2. Call `baskstream_capabilities`.
3. Call `baskstream_describe_write` for the target point.
4. Only call `baskstream_write_point` if the described action is supported.

This matches the companion app pattern: write controls are based on `describe_write`, not on broad metadata alone.

## Client Design Pattern

Keep the MCP guidance generic for any baskStream/Niagara client:

- Apps and dashboards should use the baskStream WebSocket API directly for live views and long-lived subscriptions.
- AI clients should use the MCP for diagnostics, discovery, summaries, bounded reads, and explicit operator-driven writes.
- Check `/stream/health` before opening a WebSocket.
- Call `capabilities` early and adapt to the deployed API version.
- Use `describe_history` before `read_history` and `read_schedule` only when the operation is supported.
- Gate write controls with `describe_write`; do not infer write UI from point metadata alone.

## Troubleshooting

- `npm run doctor -- --no-station` only checks local MCP startup.
- `npm run doctor` checks the station too when station env vars are set.
- `npm run setup -- --force-install` forces dependency reinstall if `node_modules` is stale.
- `npm run prepare:mcpb -- --force-install` forces MCPB bundle dependency reinstall if the ignored bundle folder is stale.
- For self-signed Niagara certificates, set `BASKSTREAM_VERIFY_TLS=false` in development.
- If the station health check returns a redirect or unauthorized status, verify credentials and WebService.
- If tools are missing in a client, restart the AI client and confirm the path points at `tools/mcp/dist/index.js`.

## References

- MCP: https://modelcontextprotocol.io/docs/getting-started/intro
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Code plugins: https://code.claude.com/docs/en/plugins
- Claude Desktop local MCP servers and desktop extensions: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- MCPB manifest spec: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
- Hermes Agent MCP: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
- VS Code MCP: https://code.visualstudio.com/docs/agent-customization/mcp-servers
- VS Code MCP configuration reference: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- Cursor MCP: https://cursor.com/docs/mcp.md
- Windsurf/Cascade MCP: https://docs.devin.ai/desktop/cascade/mcp
- Cline MCP: https://docs.cline.bot/mcp/mcp-overview
- Augment MCP: https://docs.augmentcode.com/setup-augment/mcp
