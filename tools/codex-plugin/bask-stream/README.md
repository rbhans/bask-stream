# baskStream for Codex

This plugin bundles the baskStream MCP 0.2.0 server, its production dependencies, connection setup, and station workflow skills. Node 20 or newer is required. It uses the existing baskStream service on Niagara.

## Connect once

From the installed plugin folder, run:

```sh
node scripts/configure.mjs
```

Enter the Niagara HTTPS address, username, and password. The password is hidden during entry. The connection is saved to `~/.bask-stream/config.json`, outside the plugin and its update cache. Unix permissions are owner-only; on Windows keep this file in your private user profile. This is a local credential file, not an operating-system credential vault.

For a private CA or self-signed station, get the PEM certificate from the station administrator and add `--ca /path/to/issuer-or-station.pem`. The certificate must match the hostname and be valid. Trust applies only to this MCP. Do not fetch and silently trust an unknown certificate from a failed connection. Public certificates need no `--ca` option.

Start a new Codex task and ask it to check the Niagara connection. No station is contacted during installation or setup.

## More than one station

Use one workspace per station. Run `scripts/init-station-workspace.mjs <folder>` to create small context files and a credential-file ignore rule. Existing files are preserved. Configure with `--config <folder>/station.connection.json`, then set `BASK_STREAM_WORKSPACE=<folder>` or `BASKSTREAM_CONFIG=<file>` in the MCP environment. A global connection works without workspace selection.

Configuration is loaded at MCP startup. Restart the MCP/start a new task after changing it. Tool arguments cannot redirect stored credentials to another station or username.

## Permissions and tools

Reads cover discovery, points, histories, schedules, alarms, tags and relations. Tag tools need the corresponding API 1.5 station operations. Always check capabilities; the plugin does not upgrade Niagara.

| Action | Config flag | Environment setting |
| --- | --- | --- |
| Point writes | `allowWrites` | `BASKSTREAM_ALLOW_WRITES` |
| Alarm acknowledge/clear | `allowAlarmActions` | `BASKSTREAM_ALLOW_ALARM_ACTIONS` |
| Tag/relation edits | `allowTagWrites` | `BASKSTREAM_ALLOW_TAG_WRITES` |
| Advanced raw tool visibility | `allowRawOperations` | `BASKSTREAM_ALLOW_RAW` |

All start false. Enabled operations still require the user's request and Niagara permissions. Raw access enforces the specific mutation flag and rejects unknown operations. Each tool uses a short-lived WebSocket; this is not a persistent monitoring feed. Preserve truncation and per-entry failures in results.

## Updating older installs

Old `BASK_STREAM_*` URL, username, password, timeout, TLS and point-mutation settings are accepted, as are legacy `rejectUnauthorized`, `requestTimeoutMs`, `enableMutations`, and `allowedOrdPrefixes` fields. Explicit old TLS bypass settings remain honored; new setup always enables verification. Legacy mutations enable point writes only. Alarm/model edits need their separate flags.

Lookup order: explicit config path, selected workspace's `station.connection.json`, MCP-local `config.json` for standalone installs, then `~/.bask-stream/config.json`. Environment values override file values. Select multi-station workspace/config paths explicitly instead of relying on a plugin's working directory.

## Packaging

In `tools/mcp`, run `npm run package:codex`. It creates a temporary `bask-stream` folder with the plugin, compiled MCP, locked production dependencies and public project API reference. It never copies connection files or passwords. The source template needs packaging before installation. `build-info.json` records the source base revision and whether working-tree changes were included.
