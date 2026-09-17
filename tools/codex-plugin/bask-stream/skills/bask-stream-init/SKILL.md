---
name: bask-stream-init
description: Set up the baskStream Codex plugin connection or initialize a station workspace, including URL, account, and trusted certificate configuration.
---

# Connect baskStream

Use the scripts bundled with this plugin. Resolve paths from this installed skill's directory: the plugin root is two directories above it. Never assume a developer checkout or a particular username.

1. For a new station project, run `scripts/init-station-workspace.mjs <user-selected-folder>` with Node. Existing files are preserved.
2. Open a terminal for the user to run `node <plugin-root>/scripts/configure.mjs`. It prompts for URL, username and a hidden password. Do not ask for passwords in chat or put them in command arguments.
3. Setup saves the default connection in `~/.bask-stream/config.json` with owner-only Unix permissions. Windows users should keep it in their private user profile. Use `--config <path>/station.connection.json` for a specific workspace, and set `BASK_STREAM_WORKSPACE` or `BASKSTREAM_CONFIG` in the Codex environment to select it. Config is read when the MCP starts.
4. For a self-signed station or company CA, obtain the PEM certificate from the station administrator through a trusted channel. Pass `--ca <issuer-or-station.pem>` to setup. TLS hostname and certificate validation remain enabled. Do not automatically trust a certificate fetched from an unverified connection or switch verification off to make setup pass.
5. Start a new Codex task to load the connection. When the user asks to test it, call `baskstream_diagnose_connection` followed by capabilities. On failure, report the error and stop station calls.

Writes, alarm actions, model/tag edits and raw operations start disabled. Change their separate local configuration flags only when requested. Permission to set up this plugin does not imply permission to write station points or change Niagara's certificate configuration.

Read `../../README.md` for config migration. Keep stable station facts and their dates in `station.context/`; never write secrets there. The initializer does not create a live connection or test a station.
