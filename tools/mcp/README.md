# baskStream MCP Server

Local stdio MCP server for AI access to a baskStream-enabled Niagara station.

The MCP uses the same contract as every other baskStream client:

1. Niagara web login.
2. `GET /stream/health`.
3. Authenticated MessagePack WebSocket calls to `/stream`.

It is intentionally separate from `baskStream-rt/` so Node dependencies never enter the Niagara module build.

## Install

```bash
cd tools/mcp
npm run setup
```

`npm run setup` installs dependencies, retries with `--no-bin-links` on mounted/shared filesystems, builds the server, and verifies the MCP starts.

For the Windows-first install guide and client-specific setup examples, see [INSTALL.md](INSTALL.md).

For a client-by-client matrix and ready-to-edit snippets, see [CLIENTS.md](CLIENTS.md) and `examples/`.

## Configure

Prefer MCP client environment settings so station credentials stay in the local client configuration and do not land in git:

```json
{
  "mcpServers": {
    "baskstream": {
      "command": "node",
      "args": ["/absolute/path/to/NiagaraFalls/tools/mcp/dist/index.js"],
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

For terminal runs, export the same values before starting the server:

```bash
export BASKSTREAM_STATION_URL="https://<station>"
export BASKSTREAM_USER="<niagara-user>"
export BASKSTREAM_PASSWORD="<station-password>"
export BASKSTREAM_VERIFY_TLS="false"
```

Optional mutation flags:

```bash
export BASKSTREAM_ALLOW_WRITES="true"
export BASKSTREAM_ALLOW_ALARM_ACTIONS="true"
```

You can also copy `config.example.json` to `config.json` in this folder. `config.json` is ignored by git. Environment variables override the config file.

## Run

```bash
npm run start
```

For MCP clients, use the settings block from the Configure section and point `args` at the built `dist/index.js` file.

Print client-specific snippets for the current machine:

```bash
npm run print-config
```

Windows helper:

```powershell
.\scripts\install-windows.ps1 -StationUrl "https://<station>" -User "<niagara-user>"
```

Check local startup and, when station environment variables are present, station connectivity:

```bash
npm run doctor
```

Prepare a Claude Desktop / MCPB bundle folder:

```bash
npm run build
npm run prepare:mcpb
```

## Test With Inspector

```bash
cd tools/mcp
npm run build
npm run inspector
```

Start with:

1. `baskstream_diagnose_connection`
2. `baskstream_capabilities`
3. `baskstream_browse` with `base: "slot:/Drivers"`
4. `baskstream_inventory`

## Tools

Read-only:

- `baskstream_diagnose_connection`
- `baskstream_health`
- `baskstream_capabilities`
- `baskstream_browse`
- `baskstream_describe`
- `baskstream_search`
- `baskstream_read_points`
- `baskstream_describe_write`
- `baskstream_read_history`
- `baskstream_describe_history`
- `baskstream_read_schedule`
- `baskstream_read_alarms`
- `baskstream_subscription_status`
- `baskstream_inventory`
- `baskstream_summarize_equipment_branch`
- `baskstream_summarize_histories`
- `baskstream_summarize_alarms`

Mutation-capable:

- `baskstream_write_point` requires `BASKSTREAM_ALLOW_WRITES=true`.
- `baskstream_ack_alarms` and `baskstream_clear_alarms` require `BASKSTREAM_ALLOW_ALARM_ACTIONS=true`.
- `baskstream_call_raw` can call arbitrary request/response operations. Mutating raw operations are blocked unless the matching mutation flag is enabled.

## Notes

- The MCP opens short-lived station WebSocket sessions per tool call. It is for AI workflows, diagnostics, discovery, reads, writes, and summaries.
- Long-lived COV subscriptions are still better handled by the companion app or a production client that owns a persistent WebSocket.
- Niagara permissions still apply. Use a least-privilege Niagara user.
- For self-signed stations, keep `verifyTls` false only in development or controlled bench environments.
- Plugin templates are included under `tools/codex-plugin/bask-stream/` and `tools/claude-plugin/bask-stream/`; both delegate to this single MCP implementation.
