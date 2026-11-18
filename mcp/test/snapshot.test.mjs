// px_snapshot, the bundled server against the baskStream SDK's fake station (which serves a
// solid-colour page at /ord): the picture comes back as an image with the page's details as JSON.
// The picture tests need Chrome, Chromium or Edge on this computer and are skipped without one.
//
// Uses the fake station in ../sdk/test and the SDK's build for findBrowser, so run the SDK's
// npm ci and npm run build (or npm test) first.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const repo = resolve(fileURLToPath(import.meta.url), "..", "..", "..")
const bundle = join(repo, "mcp", "dist", "baskstream", "server", "index.mjs")
const sdkTest = join(repo, "sdk", "test")
const { startFakeStation, USER, PASSWORD } = await import(join(sdkTest, "fake-station.mjs"))
const { findBrowser } = await import(join(sdkTest, "..", "dist", "index.js"))

let hasBrowser = true
try {
  findBrowser()
} catch {
  hasBrowser = false
}
const withBrowser = hasBrowser ? {} : { skip: "no Chrome, Chromium or Edge on this computer" }

let station
const clients = []

async function serverWith(env = {}) {
  const client = new Client({ name: "Claude Code", version: "1" })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    env: { PATH: process.env.PATH, BASKSTREAM_CONFIG_DIR: mkdtempSync(join(tmpdir(), "baskstream-test-")), BASKSTREAM_STATION: station.url, BASKSTREAM_USERNAME: USER, BASKSTREAM_PASSWORD: PASSWORD, ...env },
    stderr: "pipe",
  }))
  clients.push(client)
  return client
}

before(async () => {
  station = await startFakeStation()
})
after(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await station.close()
})

test("px_snapshot is a read-only tool that takes a page", async () => {
  const { tools } = await (await serverWith()).listTools()
  const snapshot = tools.find((t) => t.name === "px_snapshot")
  assert.ok(snapshot, "listed")
  assert.equal(snapshot.annotations.readOnlyHint, true)
  assert.deepEqual(snapshot.inputSchema.required, ["page"])
})

test("returns the page as a PNG image with its details", withBrowser, async () => {
  const mcp = await serverWith()
  const result = await mcp.callTool({ name: "px_snapshot", arguments: { page: "^px/Home.px", width: 400, height: 300, settleSeconds: 0 } })
  assert.ok(!result.isError, result.content?.[0]?.text)
  const [about, image] = result.content
  const details = JSON.parse(about.text)
  assert.equal(details.page, "file:^px/Home.px")
  assert.equal(details.title, "Fake Px")
  assert.equal(details.httpStatus, 200)
  assert.equal(details.window, "400x300")
  assert.ok(details.consoleErrors.some((text) => text.includes("fake widget warning")))
  assert.equal(image.type, "image")
  assert.equal(image.mimeType, "image/png")
  const png = Buffer.from(image.data, "base64")
  assert.equal(png.toString("ascii", 1, 4), "PNG")
  assert.equal(png.readUInt32BE(16), 400, "width from the PNG header")
  assert.equal(png.readUInt32BE(20), 300, "height from the PNG header")
  assert.equal(station.state.pages.at(-1), "file:^px/Home.px")
})

test("several frames come back as several images", withBrowser, async () => {
  const mcp = await serverWith()
  const result = await mcp.callTool({ name: "px_snapshot", arguments: { page: "slot:/Drivers/Net/VAV_01", view: "Graphic", width: 320, height: 240, settleSeconds: 0, frames: 2, intervalSeconds: 0.5 } })
  assert.ok(!result.isError, result.content?.[0]?.text)
  assert.equal(result.content.filter((c) => c.type === "image").length, 2)
  assert.equal(JSON.parse(result.content[0].text).page, "station:|slot:/Drivers/Net/VAV_01|view:Graphic")
})

test("without a browser the tool says what to install", async () => {
  const mcp = await serverWith({ BASKSTREAM_BROWSER: "/nowhere/chrome" })
  const result = await mcp.callTool({ name: "px_snapshot", arguments: { page: "^px/Home.px" } })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /\/nowhere\/chrome doesn't exist/)
})
