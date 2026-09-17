#!/usr/bin/env node

// The packaged plugin owns its MCP build and dependencies. No checkout paths.
await import("../mcp/dist/index.js");
