#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import { distEntry, mcpRoot } from "./mcp-client.mjs";

const serverPath = path.resolve(distEntry);
const repoRoot = path.resolve(mcpRoot, "..", "..");
const codexPluginRoot = path.join(repoRoot, "tools", "codex-plugin", "bask-stream");
const claudePluginRoot = path.join(repoRoot, "tools", "claude-plugin", "bask-stream");
const commonEnv = {
  BASKSTREAM_STATION_URL: "https://<station>",
  BASKSTREAM_USER: "<niagara-user>",
  BASKSTREAM_PASSWORD: "<niagara-password>",
  BASKSTREAM_VERIFY_TLS: "false",
  BASKSTREAM_ALLOW_WRITES: "false",
  BASKSTREAM_ALLOW_ALARM_ACTIONS: "false",
  BASKSTREAM_ALLOW_RAW: "false"
};

function json(value) {
  return JSON.stringify(value, null, 2);
}

function psPath(value) {
  return value.replace(/`/g, "``");
}

function section(title) {
  console.log(`\n# ${title}\n`);
}

section("Generic MCP JSON");
console.log(json({
  mcpServers: {
    baskstream: {
      command: "node",
      args: [serverPath],
      env: commonEnv
    }
  }
}));

section("VS Code .vscode/mcp.json");
console.log(json({
  inputs: [
    {
      id: "baskstream-station-url",
      type: "promptString",
      description: "Niagara station URL, for example https://station-host"
    },
    {
      id: "baskstream-user",
      type: "promptString",
      description: "Niagara username"
    },
    {
      id: "baskstream-password",
      type: "promptString",
      description: "Niagara password",
      password: true
    }
  ],
  servers: {
    baskstream: {
      type: "stdio",
      command: "node",
      args: [serverPath],
      env: {
        BASKSTREAM_STATION_URL: "${input:baskstream-station-url}",
        BASKSTREAM_USER: "${input:baskstream-user}",
        BASKSTREAM_PASSWORD: "${input:baskstream-password}",
        BASKSTREAM_VERIFY_TLS: "false",
        BASKSTREAM_ALLOW_WRITES: "false",
        BASKSTREAM_ALLOW_ALARM_ACTIONS: "false",
        BASKSTREAM_ALLOW_RAW: "false"
      }
    }
  }
}));

section("Cursor .cursor/mcp.json");
console.log(json({
  mcpServers: {
    baskstream: {
      type: "stdio",
      command: "node",
      args: [serverPath],
      env: {
        BASKSTREAM_STATION_URL: "${env:BASKSTREAM_STATION_URL}",
        BASKSTREAM_USER: "${env:BASKSTREAM_USER}",
        BASKSTREAM_PASSWORD: "${env:BASKSTREAM_PASSWORD}",
        BASKSTREAM_VERIFY_TLS: "${env:BASKSTREAM_VERIFY_TLS}",
        BASKSTREAM_ALLOW_WRITES: "${env:BASKSTREAM_ALLOW_WRITES}",
        BASKSTREAM_ALLOW_ALARM_ACTIONS: "${env:BASKSTREAM_ALLOW_ALARM_ACTIONS}",
        BASKSTREAM_ALLOW_RAW: "${env:BASKSTREAM_ALLOW_RAW}"
      }
    }
  }
}));

section("Windsurf / Cascade ~/.codeium/windsurf/mcp_config.json");
console.log(json({
  mcpServers: {
    baskstream: {
      command: "node",
      args: [serverPath],
      env: {
        BASKSTREAM_STATION_URL: "${env:BASKSTREAM_STATION_URL}",
        BASKSTREAM_USER: "${env:BASKSTREAM_USER}",
        BASKSTREAM_PASSWORD: "${env:BASKSTREAM_PASSWORD}",
        BASKSTREAM_VERIFY_TLS: "${env:BASKSTREAM_VERIFY_TLS}",
        BASKSTREAM_ALLOW_WRITES: "${env:BASKSTREAM_ALLOW_WRITES}",
        BASKSTREAM_ALLOW_ALARM_ACTIONS: "${env:BASKSTREAM_ALLOW_ALARM_ACTIONS}",
        BASKSTREAM_ALLOW_RAW: "${env:BASKSTREAM_ALLOW_RAW}"
      }
    }
  }
}));

section("Cline ~/.cline/mcp.json");
console.log(json({
  mcpServers: {
    baskstream: {
      command: "node",
      args: [serverPath],
      env: commonEnv,
      disabled: false,
      autoApprove: []
    }
  }
}));

section("Claude Code PowerShell");
console.log(`claude mcp add \`
  --env BASKSTREAM_STATION_URL="https://<station>" \`
  --env BASKSTREAM_USER="<niagara-user>" \`
  --env BASKSTREAM_PASSWORD="<niagara-password>" \`
  --env BASKSTREAM_VERIFY_TLS="false" \`
  --env BASKSTREAM_ALLOW_WRITES="false" \`
  --env BASKSTREAM_ALLOW_ALARM_ACTIONS="false" \`
  --env BASKSTREAM_ALLOW_RAW="false" \`
  --transport stdio \`
  baskstream -- node "${psPath(serverPath)}"`);

section("Hermes ~/.hermes/config.yaml");
console.log(`mcp_servers:
  baskstream:
    command: "node"
    args:
      - "${serverPath.replaceAll("\\", "\\\\")}"
    env:
      BASKSTREAM_STATION_URL: "https://<station>"
      BASKSTREAM_USER: "<niagara-user>"
      BASKSTREAM_PASSWORD: "<niagara-password>"
      BASKSTREAM_VERIFY_TLS: "false"
      BASKSTREAM_ALLOW_WRITES: "false"
      BASKSTREAM_ALLOW_ALARM_ACTIONS: "false"
      BASKSTREAM_ALLOW_RAW: "false"
    enabled: true
    timeout: 120
    connect_timeout: 60`);

section("Augment Import From JSON");
console.log(json({
  mcpServers: {
    baskstream: {
      command: "node",
      args: [serverPath],
      env: commonEnv
    }
  }
}));

section("Codex Plugin");
console.log(`Plugin template:
${codexPluginRoot}

Before loading it, build the MCP server:
cd "${psPath(mcpRoot)}"
npm run setup`);

section("Claude Code Plugin");
console.log(`Plugin template:
${claudePluginRoot}

Test locally:
claude --plugin-dir "${psPath(claudePluginRoot)}"

Inside Claude Code, run /mcp to confirm baskstream is connected.`);

section("Claude Desktop MCPB");
console.log(`Prepare a private MCPB bundle folder:
cd "${psPath(mcpRoot)}"
npm run build
npm run prepare:mcpb

Then package it:
cd "${psPath(path.join(mcpRoot, ".mcpb-build", "bask-stream"))}"
mcpb pack`);
