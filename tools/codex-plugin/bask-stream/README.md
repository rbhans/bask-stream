# baskStream Codex Plugin Template

This is a repo-local Codex plugin template for the baskStream MCP server.

Build the MCP first:

```powershell
cd C:\path\to\NiagaraFalls\tools\mcp
npm run setup
```

Configure station credentials in the Codex environment, not in this repo:

```powershell
$env:BASKSTREAM_STATION_URL = "https://<station>"
$env:BASKSTREAM_USER = "<niagara-user>"
$env:BASKSTREAM_PASSWORD = "<niagara-password>"
$env:BASKSTREAM_VERIFY_TLS = "false"
$env:BASKSTREAM_ALLOW_WRITES = "false"
$env:BASKSTREAM_ALLOW_ALARM_ACTIONS = "false"
```

The launcher delegates to `tools/mcp/dist/index.js`, so there is only one MCP implementation to maintain.

