// The bundled server in --http mode (what a claude.ai custom connector talks to) against the
// baskStream SDK's fake station (API 1.10): the token gates every request, by header or in the
// path; the tools are the same as over stdio; and the station knows the agent by the first
// client's name.
//
// Uses the fake station in ../sdk/test, so install the SDK's packages first (npm ci in sdk).
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const repo = resolve(fileURLToPath(import.meta.url), "..", "..", "..")
const bundle = join(repo, "mcp", "dist", "baskstream", "server", "index.mjs")
const sdkTest = join(repo, "sdk", "test")
const { startFakeStation, USER, PASSWORD } = await import(join(sdkTest, "fake-station.mjs"))
const TOKEN = "t".repeat(16) + "0123456789abcdef0123"
const POINT = "slot:/Drivers/Net/VAV_01/points/SpaceTemp"

/** Starts the bundle with --http; resolves to { child, url, stderr } once it's listening. */
function startHttp(env) {
  const child = spawn(process.execPath, [bundle, "--http"], {
    env: { PATH: process.env.PATH, BASKSTREAM_CONFIG_DIR: mkdtempSync(join(tmpdir(), "baskstream-test-")), BASKSTREAM_HTTP_PORT: "0", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  })
  let stderr = ""
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line within 10 s:\n${stderr}`)), 10000)
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      const url = /MCP on (http:\/\/\S+\/mcp)/.exec(stderr)?.[1]
      if (url) {
        clearTimeout(timer)
        resolvePromise({ child, url, get stderr() { return stderr } })
      }
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      reject(Object.assign(new Error(`exited ${code}:\n${stderr}`), { code, stderr }))
    })
  })
}

async function connect(url, headers = {}, name = "Claude") {
  const client = new Client({ name, version: "1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  return client
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content?.[0]?.text ?? ""
  if (result.isError) throw new Error(text)
  return JSON.parse(text)
}

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "1" } } })
const post = (url, headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: initialize })

let station, server
const clients = []
before(async () => {
  station = await startFakeStation()
  server = await startHttp({ BASKSTREAM_HTTP_TOKEN: TOKEN, BASKSTREAM_STATION: station.url, BASKSTREAM_USERNAME: USER, BASKSTREAM_PASSWORD: PASSWORD })
})
after(async () => {
  for (const client of clients) await client.close().catch(() => {})
  server?.child.kill()
  await station?.close()
})

test("refuses to start without a long enough token", async () => {
  for (const token of [undefined, "short"]) {
    const error = await startHttp(token ? { BASKSTREAM_HTTP_TOKEN: token } : {}).then(() => null, (e) => e)
    assert.equal(error?.code, 1)
    assert.match(error.stderr, /BASKSTREAM_HTTP_TOKEN/)
  }
})

test("every request needs the token", async () => {
  for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: `Basic ${TOKEN}` }]) {
    const res = await post(server.url, headers)
    assert.equal(res.status, 401, JSON.stringify(headers))
    assert.match(res.headers.get("www-authenticate"), /^Bearer/)
  }
  assert.equal((await post(`${server.url}/wrong`)).status, 401)
  assert.doesNotMatch(server.stderr, new RegExp(TOKEN), "the token is never logged")
})

test("only POST /mcp is served", async () => {
  const auth = { Authorization: `Bearer ${TOKEN}` }
  assert.equal((await post(server.url.replace(/\/mcp$/, "/other"), auth)).status, 404)
  assert.equal((await post(`${server.url}/${TOKEN}/more`)).status, 404)
  const get = await fetch(server.url, { headers: auth })
  assert.equal(get.status, 405)
  assert.equal(get.headers.get("allow"), "POST")
  const bad = await fetch(server.url, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{not json" })
  assert.equal(bad.status, 400)
})

test("with the token as a bearer header, the tools are the same as over stdio", async () => {
  const client = await connect(server.url, { Authorization: `Bearer ${TOKEN}` }, "Claude Duet")
  clients.push(client)
  const { tools } = await client.listTools()
  assert.equal(tools.length, 23)
  const status = await call(client, "station_status")
  assert.equal(status.connected, true)
  assert.equal(status.agents.isAgent, true)
  assert.equal(status.actor.name, "Claude Duet", "the agent is named for the first client")
})

test("with the token in the path, calls share the one station connection", async () => {
  const client = await connect(`${server.url}/${TOKEN}`, {}, "Another client")
  clients.push(client)
  const status = await call(client, "station_status")
  assert.equal(status.actor.name, "Claude Duet", "a later client doesn't rename the agent")
  assert.equal(station.state.logins, 1, "one login for every request")
  const { results } = await call(client, "write_points", { writes: [{ point: POINT, action: "set", value: 70 }], reason: "Testing the HTTP transport" })
  assert.equal(results[0].outcome, "proposed")
})
