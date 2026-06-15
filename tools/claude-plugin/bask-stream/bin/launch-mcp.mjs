#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.resolve(pluginRoot, "..", "..", "mcp", "dist", "index.js");

if (!fs.existsSync(serverEntry)) {
  console.error(`baskStream MCP server is not built: ${serverEntry}`);
  console.error("Run npm run setup from tools/mcp first.");
  process.exit(1);
}

const child = spawn(process.execPath, [serverEntry], {
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

