# bask

Command line and terminal dashboard for baskStream on Niagara 4 stations.

## Install

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/rbhans/bask-stream/main/cli/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/rbhans/bask-stream/main/cli/install.ps1 | iex
```

This downloads a single executable from the latest `bask-v*` [release](https://github.com/rbhans/bask-stream/releases), checks it against the release's `SHA256SUMS`, and puts it in `~/.local/bin` (Windows: `%LOCALAPPDATA%\Programs\bask`, added to your user PATH). No Node needed. Set `BASK_VERSION` for a specific version or `BASK_INSTALL_DIR` for another folder. To uninstall, delete that file and `~/.config/baskstream`.

## Use

```bash
bask login https://192.168.0.126 -u test --insecure   # asks for the password; saves only the session
bask                                                   # full-screen dashboard
```

## Dashboard

`1 Browse` station tree with live details · `2 Watch` live values with sparklines · `3 Alarms` open alarms, live · `4 History` rollup chart · `5 Status` station, limits and traffic. `?` shows every key; `q` quits.

It is read-only unless started with `--allow-writes`; then `o`/`s`/`a` command watched points and `a`/`A` acknowledge alarms, each after a y/N confirmation.

## Commands

| Command | |
|---|---|
| `bask login <station> -u <user> [--insecure] [--name <profile>]` | Log in and save a profile |
| `bask profiles` · `bask use <profile>` · `bask logout [--remove]` | Manage saved stations |
| `bask status` | Station, user, limits, traffic |
| `bask browse [ord] [-d depth]` · `bask search <text> [--kind point]` | Explore |
| `bask read <ords...>` | Current values |
| `bask watch <ords...> [--plain]` | Live values (dashboard, or one line per change) |
| `bask history <ord> [--since 7d] [--until now] [--rollup 1h]` | Records or rollups |
| `bask alarms [--scope open] [--class c] [--unacked] [-f]` | Alarms, newest first; `-f` follows |
| `bask ack\|clear <uuids...>` or `--class/--unacked/--since` | Needs `--allow-writes`; confirms; `--dry-run` previews |
| `bask write <ord> <set\|override\|auto\|emergency_override\|emergency_auto> [value] [--for 30m]` | Needs `--allow-writes`; confirms |
| `bask schedule <ord> [--days 7]` | Current output and upcoming changes |
| `bask call <op> '<json>'` | Any operation (gated ones need `--allow-writes`) |
| `bask metrics` | OpenMetrics text |

`-o json` or `-o csv` on any listing command; `-p <profile>` picks a station. ORDs may drop the `slot:/` prefix.

- Profiles live in `~/.config/baskstream/profiles.json` (mode 0600; `BASKSTREAM_CONFIG_DIR` overrides). The password is never saved: it is prompted, or read from `BASKSTREAM_PASSWORD` if you set it.
- `--insecure` accepts a self-signed station certificate.

## Build

```bash
npm install
npm test
npm run compile
```

To publish a release, bump `version` in `package.json`, commit, and push a matching tag (`git tag bask-v0.1.0 && git push origin bask-v0.1.0`). The [release workflow](../.github/workflows/release-bask.yml) tests, builds Windows/macOS/Linux executables, and attaches them with checksums.

`npm run compile` produces a single executable `bin/bask` with Bun (about 60 MB, no Node needed). For another platform: `bun scripts/compile.mjs --target=bun-windows-x64 --outfile=bin/bask.exe` (or `bun-linux-x64`, `bun-darwin-arm64`).
