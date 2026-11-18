#!/usr/bin/env node
// Builds the baskStream MCP server and packs it as a Claude Desktop Extension:
//
//   dist/baskstream/server/index.mjs   the server in one file, with the SDK (../sdk/src) bundled in
//   dist/baskstream/manifest.json      the extension manifest, tools listed from the server itself
//   dist/baskStream.mcpb               the packed extension (a zip of the two)
//
//   node build.mjs        (npm run build)
//
// The version is package.json's. The build starts the bundle and asks it for its tools, so a
// bundle that doesn't start fails the build.
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const here = dirname(fileURLToPath(import.meta.url))
const sdk = join(here, "..", "sdk", "src")
const version = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version
const out = join(here, "dist", "baskstream")
const bundle = join(out, "server", "index.mjs")
const mcpb = join(here, "dist", "baskStream.mcpb")

rmSync(join(here, "dist"), { recursive: true, force: true })
await build({
  entryPoints: [join(here, "src", "server.mjs")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  alias: { "@basidekick/baskstream": join(sdk, "index.ts") },
  nodePaths: [join(here, "node_modules")],
  external: ["bufferutil", "utf-8-validate"],
  // ws and other CommonJS dependencies call require() for Node built-ins.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  define: { __VERSION__: JSON.stringify(version) },
  legalComments: "eof",
  logLevel: "warning",
})
writeFileSync(bundle, readFileSync(bundle, "utf8").replace(/"__VERSION__"/g, JSON.stringify(version)))

/** Starts the bundle with no station configured and asks it for its tools. */
function listTools() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [bundle], { env: { PATH: process.env.PATH, BASKSTREAM_CONFIG_DIR: join(out, "no-config") }, stdio: ["pipe", "pipe", "inherit"] })
    let buffer = ""
    const timer = setTimeout(() => { child.kill(); reject(new Error("The server didn't answer tools/list within 10 s.")) }, 10000)
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n")
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        const message = JSON.parse(line)
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" })
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
        } else if (message.id === 2) {
          clearTimeout(timer)
          child.kill()
          resolvePromise(message.result.tools)
        }
      }
    })
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "build", version } } })
  })
}
const tools = await listTools()

// name and author.name stay as they are: Claude Desktop knows an installed extension by them, so a
// new build installs over the old one.
const manifest = {
  manifest_version: "0.3",
  name: "baskstream",
  display_name: "baskStream",
  version,
  description: "A Niagara 4 station through its BASkStreamService: find and read points, live values, history, alarms, schedules, commands, and pictures of Px pages.",
  long_description: [
    "Connects Claude to one Niagara 4 station running the baskStream module (BASkStreamService).",
    "Claude can find and read points, watch live values, read history, alarms and schedules, and command points, acknowledge alarms and edit schedules. It always identifies itself to the station as an AI agent, so the station's agent rules apply: changes need a reason, and point writes can become proposals a person approves in Workbench or bask. Niagara roles and the BASkStreamService agent settings are the limits.",
    "Claude can also see a Px page as a person does in a web browser, with live values (px_snapshot), to check a page after changing it. This needs Chrome, Chromium or Microsoft Edge on this computer.",
    "Artifact pages you own can call it too (as host:baskStream), to show live station values in the Claude desktop app.",
    "Use a dedicated Niagara user for Claude, listed in agentUsers on BASkStreamService, with a role covering only what Claude should touch.",
  ].join("\n\n"),
  author: { name: "BASidekick" },
  server: {
    type: "node",
    entry_point: "server/index.mjs",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/index.mjs"],
      env: {
        BASKSTREAM_STATION: "${user_config.station}",
        BASKSTREAM_USERNAME: "${user_config.username}",
        BASKSTREAM_PASSWORD: "${user_config.password}",
        BASKSTREAM_INSECURE: "${user_config.allow_self_signed}",
      },
    },
  },
  tools: tools.map((t) => ({ name: t.name, description: t.description })),
  keywords: ["niagara", "baskstream", "bas", "bms", "hvac", "building automation"],
  compatibility: { claude_desktop: ">=0.10.0", platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=20.0.0" } },
  user_config: {
    station: { type: "string", title: "Station address", description: "The station's web address, e.g. https://192.168.0.126", required: true },
    username: { type: "string", title: "Niagara user", description: "The user Claude acts as. Best a dedicated user listed in agentUsers on BASkStreamService.", required: true },
    password: { type: "string", title: "Password", description: "Kept in your system keychain.", sensitive: true, required: true },
    allow_self_signed: { type: "boolean", title: "Allow self-signed certificate", description: "Most stations use one. Turn off if the station has a trusted certificate.", default: true, required: false },
  },
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")

mkdirSync(dirname(mcpb), { recursive: true })
execFileSync("zip", ["-q", "-r", "-X", mcpb, "manifest.json", "server"], { cwd: out })
const kb = (path) => (readFileSync(path).length / 1024).toFixed(0)
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`)
console.log(`wrote ${relative(here, mcpb)} (${kb(mcpb)} KB; server ${kb(bundle)} KB), version ${version}`)
