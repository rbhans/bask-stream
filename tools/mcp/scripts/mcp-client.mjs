#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const distEntry = path.join(mcpRoot, "dist", "index.js");

export function requireBuiltServer() {
  if (!fs.existsSync(distEntry)) {
    throw new Error(`Built MCP server not found at ${distEntry}. Run npm run build first.`);
  }
}

export async function withMcpClient(callback, options = {}) {
  requireBuiltServer();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry],
    cwd: mcpRoot,
    env: process.env,
    stderr: options.stderr ?? "pipe"
  });
  const client = new Client({
    name: options.name ?? "baskstream-mcp-script",
    version: "0.1.0"
  });

  await client.connect(transport);
  try {
    return await callback(client);
  }
  finally {
    await client.close();
  }
}

export function hasStationEnv() {
  return Boolean(
    (process.env.BASKSTREAM_STATION_URL || process.env.NIAGARA_URL) &&
    (process.env.BASKSTREAM_USER || process.env.NIAGARA_USER) &&
    (process.env.BASKSTREAM_PASSWORD || process.env.NIAGARA_PASSWORD || process.env.STREAM_PASSWORD)
  );
}

