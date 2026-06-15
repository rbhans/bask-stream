# baskStream Claude Code Plugin Template

Claude Code can load MCP servers from plugins. This template keeps the MCP implementation in `tools/mcp` and only provides plugin metadata, a launcher, and one focused skill.

This project is not affiliated with, endorsed by, or sponsored by Tridium, Honeywell, Anthropic, OpenAI, Claude, Codex, or any MCP client vendor. Use it only with Niagara stations you are authorized to access.

Build the MCP:

```powershell
cd C:\path\to\NiagaraFalls\tools\mcp
npm run setup
```

Set station environment variables:

```powershell
$env:BASKSTREAM_STATION_URL = "https://<station>"
$env:BASKSTREAM_USER = "<niagara-user>"
$env:BASKSTREAM_PASSWORD = "<niagara-password>"
$env:BASKSTREAM_VERIFY_TLS = "false"
$env:BASKSTREAM_ALLOW_WRITES = "false"
$env:BASKSTREAM_ALLOW_ALARM_ACTIONS = "false"
$env:BASKSTREAM_ALLOW_RAW = "false"
```

Test locally:

```powershell
claude --plugin-dir C:\path\to\NiagaraFalls\tools\claude-plugin\bask-stream
```

Inside Claude Code, run `/mcp` and confirm `baskstream` is connected.

Keep AI prompts and outputs clear of Tridium source, decompiled code, binary internals, license keys, proprietary documentation, vulnerability findings, and benchmark/evaluation results. Leave `BASKSTREAM_ALLOW_RAW=false` outside controlled local debugging.
