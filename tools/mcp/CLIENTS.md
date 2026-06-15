# baskStream MCP Client Matrix

Build once, then choose the client-specific install path.

This project is not affiliated with, endorsed by, or sponsored by Tridium, Honeywell, Anthropic, OpenAI, Claude, Codex, or any MCP client vendor.

```powershell
cd C:\path\to\NiagaraFalls\tools\mcp
npm run setup
npm run print-config
```

## Best Default Paths

| Client | Best path | Config shape |
| --- | --- | --- |
| Claude Desktop | `.mcpb` bundle when distributing to non-developers; manual MCP JSON while developing | `manifest.json` inside MCPB |
| Claude Code | `claude mcp add` for one machine, plugin template for team repeatability | `mcpServers` |
| Codex | Codex plugin template | `.codex-plugin/plugin.json` plus `.mcp.json` |
| VS Code / Copilot | `.vscode/mcp.json` or user MCP config | `servers` |
| Cursor | `.cursor/mcp.json` or global `~/.cursor/mcp.json` | `mcpServers` |
| Windsurf / Cascade | `~/.codeium/windsurf/mcp_config.json` or MCP settings UI | `mcpServers` |
| Cline | `~/.cline/mcp.json` or extension MCP settings UI | `mcpServers` |
| Hermes Agent | `~/.hermes/config.yaml` | `mcp_servers` |
| Augment | Settings Panel import from JSON | `mcpServers` |
| Other stdio MCP clients | Generic MCP JSON | Usually `mcpServers` |

## Ready-To-Edit Examples

Templates live under `tools/mcp/examples/`:

- `generic-mcp.json`
- `claude-code.mcp.json`
- `vscode.mcp.json`
- `cursor.mcp.json`
- `windsurf.mcp_config.json`
- `cline.mcp.json`
- `hermes.config.yaml`
- `augment-import.json`

Use `npm run print-config` when you want the same shapes with the absolute path for the current machine.

## Windows Non-Developer Setup

PowerShell:

```powershell
cd C:\path\to\NiagaraFalls\tools\mcp
.\scripts\install-windows.ps1 -StationUrl "https://<station>" -User "<niagara-user>"
```

For a read-only install, leave `-AllowWrites` and `-AllowAlarmActions` off.

## Security Defaults

- Use this MCP only with Niagara stations you are authorized to access.
- Keep `BASKSTREAM_ALLOW_WRITES=false` unless point writes are intended.
- Keep `BASKSTREAM_ALLOW_ALARM_ACTIONS=false` unless alarm acknowledgement or clear is intended.
- Keep `BASKSTREAM_ALLOW_RAW=false`; the raw operation tool is hidden unless explicitly enabled for controlled local debugging.
- Use a least-privilege Niagara user.
- Prefer client settings, environment variables, MCPB user config, or local ignored files for credentials.
- Do not commit real passwords in any example file.
- Do not provide Tridium source code, decompiled code, binary internals, license keys, proprietary documentation, vulnerability findings, or benchmark/evaluation results to AI tools.
- Do not imply Tridium, Honeywell, Anthropic, OpenAI, Claude, Codex, or Official MCP Registry endorsement in distribution copy.

## Client Notes

- VS Code uses `servers`, not `mcpServers`.
- Cursor and Windsurf support environment-variable interpolation in MCP config. Use OS-level environment variables for credentials.
- Cline's local config supports `disabled` and `autoApprove`; keep `autoApprove` empty for this MCP until you are comfortable with the workflow.
- Hermes can use `tools.include` or `tools.exclude` if you want a stricter read-only profile.
- Augment can import a normal `mcpServers` JSON block and also offers MCP Tool Search to reduce visible tool clutter.

## Reference Basis

This matrix is based on these client docs and should be rechecked if a client changes its MCP configuration format:

- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Code plugins: https://code.claude.com/docs/en/plugins
- Claude Desktop extensions: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- MCPB manifest and CLI: https://github.com/modelcontextprotocol/mcpb
- MCP security best practices: https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
- Tridium Niagara EULA: https://www.tridium.com/us/en/eula
- VS Code MCP configuration: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- Cursor MCP: https://cursor.com/docs/mcp.md
- Windsurf/Cascade MCP: https://docs.devin.ai/desktop/cascade/mcp
- Cline MCP: https://docs.cline.bot/mcp/mcp-overview
- Hermes MCP config: https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference
- Augment MCP: https://docs.augmentcode.com/setup-augment/mcp
