# MCP and Codex plugin update

The standalone MCP is now 0.2.0. The Codex plugin packages that same build and locked production dependencies, with no dependency on the Niagara module checkout. Niagara source, JARs, signing and station configuration were not changed.

## Changes

- Added typed `read_tags`, `write_tags`, and `write_relations` tools for API 1.5. Model edits require their own opt-in, separate from point writes and alarm actions. The raw tool also enforces these gates and rejects unsupported operations.
- Default TLS verification is enabled; setup accepts an administrator-provided PEM certificate for private trust. HTTP and WebSocket connections use the same trust settings. Existing explicit TLS bypass settings remain supported for compatibility.
- Stored credentials cannot be redirected using another station URL or username in tool arguments. Legacy environment names and explicit ORD restrictions remain supported.
- SCRAM validates server nonce, bounds the iteration count and checks the final server signature. Invalid MessagePack becomes a tool error instead of crashing the server. Response size limits and cleanup cover HTTP/WS failures.
- Discovery limits match the documented station depth limits. Equipment/history summaries preserve truncation evidence. The doctor now reads the current diagnosis response shape.
- Added a hidden-password connection wizard, secure defaults, owner-only Unix config permissions, and a workspace initializer that preserves existing files. Saved connections live outside the plugin cache. Passwords remain in a local private config file, not an OS credential vault.
- Updated standalone setup examples to enable TLS verification. The Windows helper accepts a certificate file; it has not been run on Windows in this task.

## Validation

TypeScript build passed. Four test groups passed against both source output and the self-contained plugin launcher:

1. Secure defaults, legacy settings, exact password preservation, credential origin and operation/ORD policy.
2. MCP stdio tool discovery, tag request forwarding, malformed MessagePack recovery, raw mutation rejection and schema validation.
3. Local TLS/SCRAM fixture: unknown certificate rejected before HTTP, supplied CA accepted, bad server signature rejected.
4. Setup writes a private config; repeated workspace initialization preserves user notes and credentials.

Both skills and the final plugin manifest passed the bundled Codex validators. The no-station doctor exposed 23 tools with raw access hidden.

## Installed copy

Installed from the existing personal marketplace as `bask-stream@caveman-repo`, version `0.2.0+codex.20260911004011`. The previous plugin is preserved at `/Users/benhansen/plugins/bask-stream.backup-20260910-1740`.

Start a new Codex task to load the installed tools. Run `node /Users/benhansen/plugins/bask-stream/scripts/configure.mjs` in a terminal to enter station details privately. For a private certificate add `--ca /path/to/certificate.pem`. A live station test has not been performed; no URL/login was configured in this task.

Repository source changes remain uncommitted. The source plugin is a packaging template; use `npm run package:codex` from `tools/mcp` to produce a fresh distributable bundle.
