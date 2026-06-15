#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { distEntry, hasStationEnv, mcpRoot, withMcpClient } from "./mcp-client.mjs";

const noStation = process.argv.includes("--no-station");

function ok(message) {
  console.log(`OK  ${message}`);
}

function warn(message) {
  console.warn(`WARN ${message}`);
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function requireNode18() {
  const major = Number(process.versions.node.split(".", 1)[0]);
  if (!Number.isFinite(major) || major < 18) {
    fail(`Node.js 18 or newer is required. Current version: ${process.version}`);
    return;
  }
  ok(`Node.js ${process.version}`);
}

function inspectLocalFiles() {
  if (fs.existsSync(distEntry)) {
    ok(`built server exists: ${distEntry}`);
  }
  else {
    fail(`built server missing: ${distEntry}`);
  }
  ok(`MCP folder: ${mcpRoot}`);
}

async function inspectMcpServer() {
  await withMcpClient(async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    ok(`MCP starts and exposes ${names.length} tools`);

    for (const required of [
      "baskstream_diagnose_connection",
      "baskstream_capabilities",
      "baskstream_read_points",
      "baskstream_describe_write",
      "baskstream_write_point"
    ]) {
      if (names.includes(required)) {
        ok(`tool available: ${required}`);
      }
      else {
        fail(`missing tool: ${required}`);
      }
    }

    const rawEnabled = ["1", "true", "yes", "on"].includes(String(process.env.BASKSTREAM_ALLOW_RAW || "").toLowerCase());
    if (rawEnabled && !names.includes("baskstream_call_raw")) {
      fail("BASKSTREAM_ALLOW_RAW=true but raw operation tool is missing");
    }
    else if (!rawEnabled && names.includes("baskstream_call_raw")) {
      fail("raw operation tool is exposed without BASKSTREAM_ALLOW_RAW=true");
    }
    else if (rawEnabled) {
      ok("raw operation tool available by explicit opt-in");
    }
    else {
      ok("raw operation tool hidden by default");
    }

    if (noStation) {
      warn("station probe skipped by --no-station");
      return;
    }

    if (!hasStationEnv()) {
      warn("station probe skipped; set BASKSTREAM_STATION_URL, BASKSTREAM_USER, and BASKSTREAM_PASSWORD to test Niagara connectivity");
      return;
    }

    const result = await client.callTool({
      name: "baskstream_diagnose_connection",
      arguments: {
        connect_websocket: true,
        response_format: "json"
      }
    });
    const structured = result.structuredContent;
    const healthStatus = structured?.health?.status;
    const websocketOk = structured?.websocket?.ok;
    if (healthStatus === 200 && websocketOk) {
      ok(`station health 200 and WebSocket connected for ${structured?.stationUrl ?? "configured station"}`);
    }
    else {
      fail(`station probe did not fully pass: ${JSON.stringify(structured)}`);
    }
  });
}

requireNode18();
inspectLocalFiles();

try {
  await inspectMcpServer();
}
catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
