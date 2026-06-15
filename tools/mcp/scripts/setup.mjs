#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const forceInstall = process.argv.includes("--force-install");

function run(command, args) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  return result.status ?? 1;
}

function requireNode18() {
  const major = Number(process.versions.node.split(".", 1)[0]);
  if (!Number.isFinite(major) || major < 18) {
    console.error(`Node.js 18 or newer is required. Current version: ${process.version}`);
    process.exit(1);
  }
}

requireNode18();

let status = 0;
const dependenciesPresent =
  fs.existsSync("node_modules/@modelcontextprotocol/sdk") &&
  fs.existsSync("node_modules/typescript");

if (dependenciesPresent && !forceInstall) {
  console.log("Dependencies already present. Skipping npm install. Use npm run setup -- --force-install to reinstall.");
}
else {
  status = run("npm", ["install"]);
  if (status !== 0) {
    console.warn("\nnpm install failed. Retrying with --no-bin-links for shared or mounted filesystems.");
    status = run("npm", ["install", "--no-bin-links"]);
  }

  if (status !== 0) {
    process.exit(status);
  }
}

status = run("npm", ["run", "build"]);
if (status !== 0) {
  process.exit(status);
}

status = run("node", ["scripts/doctor.mjs", "--no-station"]);
process.exit(status);
