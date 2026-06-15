# baskStream Codex Plugin Template

This is a repo-local Codex plugin template for the baskStream MCP server.

This project is not affiliated with, endorsed by, or sponsored by Tridium, Honeywell, Anthropic, OpenAI, Claude, Codex, or any MCP client vendor. Use it only with Niagara stations you are authorized to access.

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
$env:BASKSTREAM_ALLOW_RAW = "false"
```

The launcher delegates to `tools/mcp/dist/index.js`, so there is only one MCP implementation to maintain.

Keep AI prompts and outputs clear of Tridium source, decompiled code, binary internals, license keys, proprietary documentation, vulnerability findings, and benchmark/evaluation results. Leave `BASKSTREAM_ALLOW_RAW=false` outside controlled local debugging.
