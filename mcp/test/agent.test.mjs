// The agent path against the baskStream SDK's fake station (API 1.10): the server declares itself
// an agent, writes become proposals with their reason, and the proposal shows in list_proposals.
//
// Uses the fake station in ../sdk/test, so install the SDK's packages first (npm ci in sdk).
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
const POINT = "slot:/Drivers/Net/VAV_01/points/SpaceTemp"

let station, mcp
before(async () => {
  station = await startFakeStation()
  mcp = new Client({ name: "Claude Code", version: "1" })
  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    env: { PATH: process.env.PATH, BASKSTREAM_CONFIG_DIR: mkdtempSync(join(tmpdir(), "baskstream-test-")), BASKSTREAM_STATION: station.url, BASKSTREAM_USERNAME: USER, BASKSTREAM_PASSWORD: PASSWORD, BASKSTREAM_MODEL: "test-model" },
    stderr: "pipe",
  }))
})
after(async () => {
  await mcp.close().catch(() => {})
  await station.close()
})

async function call(name, args = {}) {
  const result = await mcp.callTool({ name, arguments: args })
  const text = result.content?.[0]?.text ?? ""
  if (result.isError) throw new Error(text)
  return JSON.parse(text)
}

test("declares itself an agent under the MCP client's name", async () => {
  const status = await call("station_status")
  assert.equal(status.apiVersion, "1.10")
  assert.equal(status.agents.isAgent, true)
  assert.equal(status.agents.approvalRequired, true)
  assert.equal(status.actor.name, "Claude Code")
  assert.equal(status.actor.model, "test-model")
  assert.equal(station.state.logins, 1, "the agent reconnect reuses the session")
})

test("a write becomes a proposal carrying the reason", async () => {
  const { results } = await call("write_points", { writes: [{ point: POINT, action: "override", value: 72, durationMinutes: 30 }], reason: "Room 204 is too cold" })
  assert.equal(results[0].ok, true)
  assert.equal(results[0].outcome, "proposed")
  assert.equal(results[0].proposal.reason, "Room 204 is too cold")
  assert.equal(results[0].now, undefined, "a proposal isn't read back as written")
  const { proposals } = await call("list_proposals", { status: "pending" })
  assert.equal(proposals[0].id, results[0].proposal.id)
  assert.equal(proposals[0].actor.name, "Claude Code")
})

test("an agent can't approve its own proposal", async () => {
  await assert.rejects(call("baskstream_call", { op: "approve_proposal", fields: { proposal: "P1" } }), /agent_cannot_approve/)
})
