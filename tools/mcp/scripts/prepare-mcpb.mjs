#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { distEntry, mcpRoot } from "./mcp-client.mjs";

const buildRoot = path.join(mcpRoot, ".mcpb-build", "bask-stream");
const serverDir = path.join(buildRoot, "server");
const forceInstall = process.argv.includes("--force-install");

function run(command, args, cwd) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  return result.status ?? 1;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  }
  catch {
    return false;
  }
}

if (!(await exists(distEntry))) {
  console.error("Built MCP server not found. Run npm run build first.");
  process.exit(1);
}

await fs.mkdir(serverDir, { recursive: true });

await fs.copyFile(distEntry, path.join(serverDir, "index.js"));
await fs.copyFile(path.join(mcpRoot, "package.json"), path.join(buildRoot, "package.json"));
await fs.copyFile(path.join(mcpRoot, "package-lock.json"), path.join(buildRoot, "package-lock.json"));
await fs.copyFile(path.join(mcpRoot, "mcpb", "manifest.example.json"), path.join(buildRoot, "manifest.json"));

const dependenciesPresent =
  await exists(path.join(buildRoot, "node_modules", "@modelcontextprotocol", "sdk")) &&
  await exists(path.join(buildRoot, "node_modules", "ws")) &&
  await exists(path.join(buildRoot, "node_modules", "@msgpack", "msgpack"));

if (dependenciesPresent && !forceInstall) {
  console.log("Bundle dependencies already present. Skipping npm install. Use npm run prepare:mcpb -- --force-install to reinstall.");
}
else {
  const status = run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-bin-links"], buildRoot);
  if (status !== 0) {
    process.exit(status);
  }
}

console.log(`\nMCPB build folder ready: ${buildRoot}`);
console.log("Next:");
console.log("  npm install -g @anthropic-ai/mcpb");
console.log(`  cd "${buildRoot}"`);
console.log("  mcpb pack");
