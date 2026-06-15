#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decode, encode } from "@msgpack/msgpack";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";
import { z, type ZodRawShape } from "zod";

type JsonRecord = Record<string, unknown>;
type ResponseFormat = "json" | "markdown";

interface BaskStreamConfig {
  stationUrl: string;
  username?: string;
  password?: string;
  verifyTls: boolean;
  timeoutMs: number;
  allowWrites: boolean;
  allowAlarmActions: boolean;
}

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const responseFormat = z.enum(["json", "markdown"]).default("json")
  .describe("Response text format. structuredContent is always returned.");
const connectionFields = {
  station_url: z.string().url().optional()
    .describe("Optional station URL override, for example https://192.168.0.125."),
  user: z.string().min(1).optional()
    .describe("Optional Niagara username override. Password still comes from config or environment."),
  response_format: responseFormat
} satisfies ZodRawShape;

const metadataMode = z.enum(["none", "full"]).default("none");
const pointSnapshotField = z.enum([
  "point",
  "ok",
  "display",
  "type",
  "valueType",
  "value",
  "displayValue",
  "status",
  "timestamp",
  "facets",
  "enumOrdinal",
  "enumTag",
  "enumDisplay",
  "enumOptions"
]);

const rawMutationOps = new Set([
  "write",
  "ack_alarm",
  "ack_alarms",
  "clear_alarm",
  "clear_alarms"
]);
const rawWriteOps = new Set(["write"]);
const rawAlarmActionOps = new Set(["ack_alarm", "ack_alarms", "clear_alarm", "clear_alarms"]);

const config = await loadConfig();

const server = new McpServer({
  name: "baskstream-mcp-server",
  version: "0.1.0"
});

function boolFrom(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  return fallback;
}

function numberFrom(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

async function readJsonIfExists(filePath: string): Promise<JsonRecord> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as JsonRecord;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function loadConfig(): Promise<BaskStreamConfig> {
  const configPath = process.env.BASKSTREAM_CONFIG || path.join(packageRoot, "config.json");
  const fileConfig = await readJsonIfExists(configPath);
  return {
    stationUrl: String(
      process.env.BASKSTREAM_STATION_URL ||
      process.env.NIAGARA_URL ||
      fileConfig.stationUrl ||
      "https://localhost"
    ).replace(/\/+$/, ""),
    username: stringOrUndefined(process.env.BASKSTREAM_USER || process.env.NIAGARA_USER || fileConfig.username),
    password: stringOrUndefined(
      process.env.BASKSTREAM_PASSWORD ||
      process.env.NIAGARA_PASSWORD ||
      process.env.STREAM_PASSWORD ||
      fileConfig.password
    ),
    verifyTls: boolFrom(process.env.BASKSTREAM_VERIFY_TLS ?? fileConfig.verifyTls, false),
    timeoutMs: Math.max(1000, numberFrom(process.env.BASKSTREAM_TIMEOUT_MS ?? fileConfig.timeoutMs, 45000)),
    allowWrites: boolFrom(process.env.BASKSTREAM_ALLOW_WRITES ?? fileConfig.allowWrites, false),
    allowAlarmActions: boolFrom(
      process.env.BASKSTREAM_ALLOW_ALARM_ACTIONS ?? fileConfig.allowAlarmActions,
      false
    )
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function configFor(params: JsonRecord): BaskStreamConfig {
  return {
    ...config,
    stationUrl: String(params.station_url || config.stationUrl).replace(/\/+$/, ""),
    username: stringOrUndefined(params.user) || config.username
  };
}

function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function storeCookies(cookies: Map<string, string>, headers: http.IncomingHttpHeaders): void {
  const raw = headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const header of values) {
    const pair = header.split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index > 0) {
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
}

function parseScram(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(",")) {
    const index = part.indexOf("=");
    if (index > 0) {
      out[part.slice(0, index)] = part.slice(index + 1);
    }
  }
  return out;
}

function prepUsername(value: string): string {
  return String(value).normalize("NFKC").replace(/=/g, "=3D").replace(/,/g, "=2C");
}

function hmac(key: Buffer, text: string): Buffer {
  return crypto.createHmac("sha256", key).update(text, "utf8").digest();
}

function sha256(buffer: Buffer): Buffer {
  return crypto.createHash("sha256").update(buffer).digest();
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) {
    out[i] = a[i] ^ b[i];
  }
  return out;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rawDataToBytes(data: WebSocket.RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data as ArrayBuffer);
}

class BaskStreamClient {
  private readonly stationUrl: URL;
  private readonly cookies = new Map<string, string>();
  private ws: WebSocket | null = null;

  constructor(private readonly clientConfig: BaskStreamConfig) {
    this.stationUrl = new URL(clientConfig.stationUrl);
  }

  async request(method: string, requestPath: string, body = "", headers: Record<string, string> = {}): Promise<HttpResponse> {
    const url = new URL(requestPath, this.stationUrl);
    const transport = url.protocol === "https:" ? https : http;
    const timeoutMs = this.clientConfig.timeoutMs;

    return new Promise((resolve, reject) => {
      const req = transport.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        method,
        path: `${url.pathname}${url.search}`,
        rejectUnauthorized: this.clientConfig.verifyTls,
        timeout: timeoutMs,
        headers: {
          Host: url.host,
          Cookie: cookieHeader(this.cookies),
          ...headers,
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {})
        }
      }, (res) => {
        storeCookies(this.cookies, res.headers);
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8")
        }));
      });
      req.on("timeout", () => {
        req.destroy(new Error(`HTTP ${method} ${requestPath} timed out after ${timeoutMs}ms.`));
      });
      req.on("error", reject);
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  async healthStatus(): Promise<JsonRecord> {
    const response = await this.request("GET", "/stream/health");
    return {
      status: response.status,
      location: response.headers.location,
      body: parseMaybeJson(response.body)
    };
  }

  async login(): Promise<JsonRecord> {
    const username = this.clientConfig.username;
    const password = this.clientConfig.password;
    if (!username || !password) {
      throw new Error("Set BASKSTREAM_USER and BASKSTREAM_PASSWORD, or provide them in tools/mcp/config.json.");
    }

    const existing = await this.request("GET", "/stream/health");
    if (existing.status === 200) {
      return parseMaybeJsonRecord(existing.body);
    }

    await this.request("GET", "/prelogin");
    const userStep = await this.request(
      "POST",
      "/login",
      `j_username=${encodeURIComponent(username)}`,
      { "Content-Type": "application/x-www-form-urlencoded" }
    );
    if (userStep.status !== 200 || !userStep.body.includes("j_security_check")) {
      throw new Error(`Niagara username step failed with HTTP ${userStep.status}.`);
    }

    const nonce = crypto.randomBytes(16).toString("base64");
    const clientFirstBare = `n=${prepUsername(username)},r=${nonce}`;
    const serverFirstResponse = await this.request(
      "POST",
      "/j_security_check/",
      `action=sendClientFirstMessage&clientFirstMessage=n,,${clientFirstBare}`,
      { "Content-Type": "application/x-niagara-login-support" }
    );
    if (serverFirstResponse.status !== 200) {
      throw new Error(`SCRAM first message failed with HTTP ${serverFirstResponse.status}.`);
    }

    const serverFirst = serverFirstResponse.body.trim();
    const parsed = parseScram(serverFirst);
    if (!parsed.r?.startsWith(nonce) || !parsed.s || !parsed.i) {
      throw new Error("Invalid SCRAM server first message.");
    }

    const salted = crypto.pbkdf2Sync(
      Buffer.from(String(password).normalize("NFKC"), "utf8"),
      Buffer.from(parsed.s, "base64"),
      Number(parsed.i),
      32,
      "sha256"
    );
    const clientFinalNoProof = `c=biws,r=${parsed.r}`;
    const authMessage = `${clientFirstBare},${serverFirst},${clientFinalNoProof}`;
    const clientKey = hmac(salted, "Client Key");
    const proof = xor(clientKey, hmac(sha256(clientKey), authMessage)).toString("base64");

    const finalResponse = await this.request(
      "POST",
      "/j_security_check/",
      `action=sendClientFinalMessage&clientFinalMessage=${clientFinalNoProof},p=${proof}`,
      { "Content-Type": "application/x-niagara-login-support" }
    );
    if (finalResponse.status !== 200) {
      throw new Error(`SCRAM final message failed with HTTP ${finalResponse.status}.`);
    }

    await this.request("GET", "/j_security_check/");
    const health = await this.request("GET", "/stream/health");
    if (health.status !== 200) {
      throw new Error(`Health check failed after login with HTTP ${health.status}.`);
    }
    return parseMaybeJsonRecord(health.body);
  }

  async connect(): Promise<void> {
    const wsUrl = new URL(this.stationUrl.toString());
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/stream";
    wsUrl.search = "";
    this.ws = new WebSocket(wsUrl, {
      headers: {
        Cookie: cookieHeader(this.cookies)
      },
      origin: this.stationUrl.origin,
      rejectUnauthorized: this.clientConfig.verifyTls,
      handshakeTimeout: this.clientConfig.timeoutMs
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.ws?.off("open", onOpen);
        this.ws?.off("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.ws?.once("open", onOpen);
      this.ws?.once("error", onError);
    });
  }

  async call(op: string, fields: JsonRecord = {}): Promise<JsonRecord> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Station WebSocket is not connected.");
    }
    const id = stringOrUndefined(fields.id) || `${op}-${crypto.randomBytes(4).toString("hex")}`;
    const frame = { ...fields, op, id };

    return new Promise<JsonRecord>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`${op} timed out waiting for response id=${id}.`));
      }, this.clientConfig.timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ws?.off("message", onMessage);
        this.ws?.off("error", onError);
        this.ws?.off("close", onClose);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Station WebSocket closed before a response arrived."));
      };

      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        if (!isBinary) {
          return;
        }
        const decoded = decode(rawDataToBytes(data));
        if (!isRecord(decoded)) {
          return;
        }
        if (decoded.id !== id) {
          return;
        }
        cleanup();
        if (decoded.error || decoded.op === "error") {
          reject(new Error(JSON.stringify(decoded, null, 2)));
          return;
        }
        resolve(decoded);
      };

      this.ws?.on("message", onMessage);
      this.ws?.once("error", onError);
      this.ws?.once("close", onClose);
      this.ws?.send(encode(frame), { binary: true }, (error) => {
        if (error) {
          cleanup();
          reject(error);
        }
      });
    });
  }

  close(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close();
    }
    this.ws = null;
  }
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  }
  catch {
    return value.slice(0, 2000);
  }
}

function parseMaybeJsonRecord(value: string): JsonRecord {
  const parsed = parseMaybeJson(value);
  return isRecord(parsed) ? parsed : { body: parsed };
}

async function withClient<T>(params: JsonRecord, fn: (client: BaskStreamClient, cfg: BaskStreamConfig) => Promise<T>): Promise<T> {
  const cfg = configFor(params);
  const client = new BaskStreamClient(cfg);
  try {
    await client.login();
    await client.connect();
    return await fn(client, cfg);
  }
  finally {
    client.close();
  }
}

async function withHttpClient<T>(params: JsonRecord, fn: (client: BaskStreamClient, cfg: BaskStreamConfig) => Promise<T>): Promise<T> {
  const cfg = configFor(params);
  const client = new BaskStreamClient(cfg);
  return fn(client, cfg);
}

function assertWritesAllowed(cfg: BaskStreamConfig): void {
  if (!cfg.allowWrites) {
    throw new Error("Point writes are disabled. Set BASKSTREAM_ALLOW_WRITES=true or allowWrites=true in config.json.");
  }
}

function assertAlarmActionsAllowed(cfg: BaskStreamConfig): void {
  if (!cfg.allowAlarmActions) {
    throw new Error(
      "Alarm ack/clear actions are disabled. Set BASKSTREAM_ALLOW_ALARM_ACTIONS=true or allowAlarmActions=true in config.json."
    );
  }
}

function toolResponse(data: JsonRecord, format: ResponseFormat = "json", title = "baskStream result") {
  const text = format === "markdown" ? markdownFor(data, title) : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: data
  };
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    structuredContent: { ok: false, error: message }
  };
}

function markdownFor(data: JsonRecord, title: string): string {
  const lines = [`# ${title}`, ""];
  const summary = data.summary;
  if (Array.isArray(summary)) {
    for (const item of summary) {
      lines.push(`- ${String(item)}`);
    }
    lines.push("");
  }
  else if (typeof summary === "string") {
    lines.push(summary, "");
  }
  lines.push("```json", JSON.stringify(data, null, 2), "```");
  return lines.join("\n");
}

function registerTool(
  name: string,
  options: {
    title: string;
    description: string;
    inputSchema: ZodRawShape;
    readOnly: boolean;
    destructive?: boolean;
    idempotent?: boolean;
  },
  handler: (params: JsonRecord) => Promise<JsonRecord>
): void {
  server.registerTool(
    name,
    {
      title: options.title,
      description: options.description,
      inputSchema: options.inputSchema,
      annotations: {
        readOnlyHint: options.readOnly,
        destructiveHint: options.destructive ?? !options.readOnly,
        idempotentHint: options.idempotent ?? options.readOnly,
        openWorldHint: true
      }
    },
    async (params) => {
      try {
        const data = await handler(params as JsonRecord);
        return toolResponse(data, (params as JsonRecord).response_format as ResponseFormat | undefined, options.title);
      }
      catch (error) {
        return errorResponse(error);
      }
    }
  );
}

function nodeOrd(node: JsonRecord): string {
  return String(node.slotPath || node.ord || "");
}

function nodeName(node: JsonRecord): string {
  return String(node.display || node.name || nodeOrd(node));
}

function nodeType(node: JsonRecord): string {
  return String(node.typeSpec || node.description || "");
}

function nodeClassification(node: JsonRecord): JsonRecord {
  const metadata = isRecord(node.metadata) ? node.metadata : {};
  return isRecord(metadata.classification) ? metadata.classification : {};
}

function compactNode(node: unknown): JsonRecord {
  if (!isRecord(node)) {
    return {};
  }
  const classification = nodeClassification(node);
  return {
    ord: nodeOrd(node),
    name: nodeName(node),
    type: nodeType(node),
    kind: node.kind,
    status: node.status,
    ok: node.ok,
    features: node.features,
    operations: node.operations,
    classification
  };
}

function searchNodes(searchResponse: JsonRecord): JsonRecord[] {
  const result = isRecord(searchResponse.result) ? searchResponse.result : {};
  return asArray(result.nodes).filter(isRecord);
}

function countBy(values: unknown[], keyFn: (item: unknown) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of values) {
    const key = keyFn(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function operationFields(params: JsonRecord, names: string[]): JsonRecord {
  const out: JsonRecord = {};
  for (const name of names) {
    if (params[name] !== undefined) {
      out[name] = params[name];
    }
  }
  return out;
}

registerTool(
  "baskstream_diagnose_connection",
  {
    title: "Diagnose baskStream Connection",
    description: "Checks /stream/health before and after Niagara login and optionally confirms WebSocket capabilities.",
    inputSchema: {
      ...connectionFields,
      connect_websocket: z.boolean().default(true)
        .describe("When true, also opens /stream and calls capabilities after login.")
    },
    readOnly: true
  },
  async (params) => withHttpClient(params, async (client, cfg) => {
    const beforeLogin = await client.healthStatus();
    const loginHealth = await client.login();
    let capabilities: unknown = null;
    if (params.connect_websocket !== false) {
      await client.connect();
      capabilities = await client.call("capabilities");
      client.close();
    }
    return {
      ok: true,
      stationUrl: cfg.stationUrl,
      verifyTls: cfg.verifyTls,
      beforeLogin,
      loginHealth,
      capabilities,
      summary: [
        `Station URL: ${cfg.stationUrl}`,
        `Pre-login health status: ${String(beforeLogin.status)}`,
        "Login and health check completed.",
        params.connect_websocket !== false ? "WebSocket capabilities call completed." : "WebSocket check skipped."
      ]
    };
  })
);

registerTool(
  "baskstream_health",
  {
    title: "Read baskStream Health",
    description: "Reads /stream/health. Set login=true to authenticate first and return the authenticated health payload.",
    inputSchema: {
      ...connectionFields,
      login: z.boolean().default(false)
    },
    readOnly: true
  },
  async (params) => withHttpClient(params, async (client, cfg) => ({
    ok: true,
    stationUrl: cfg.stationUrl,
    health: params.login ? await client.login() : await client.healthStatus()
  }))
);

registerTool(
  "baskstream_capabilities",
  {
    title: "Read baskStream Capabilities",
    description: "Calls capabilities to discover supported operations, limits, schemas, point snapshot fields, and graphics flags.",
    inputSchema: connectionFields,
    readOnly: true
  },
  async (params) => withClient(params, async (client) => ({
    ok: true,
    response: await client.call("capabilities")
  }))
);

registerTool(
  "baskstream_browse",
  {
    title: "Browse baskStream Node",
    description: "Browses a station ORD and returns the node plus children up to the requested depth.",
    inputSchema: {
      ...connectionFields,
      base: z.string().default("slot:/Drivers"),
      depth: z.number().int().min(0).max(8).default(1),
      metadata: metadataMode
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => ({
    ok: true,
    response: await client.call("browse", operationFields(params, ["base", "depth", "metadata"]))
  }))
);

registerTool(
  "baskstream_describe",
  {
    title: "Describe baskStream Node",
    description: "Describes a single station ORD without expanding children. Use for precise node metadata.",
    inputSchema: {
      ...connectionFields,
      ord: z.string().describe("Station ORD, for example slot:/Drivers/LonNetwork."),
      metadata: metadataMode.default("full")
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => ({
    ok: true,
    response: await client.call("describe", operationFields(params, ["ord", "metadata"]))
  }))
);

registerTool(
  "baskstream_search",
  {
    title: "Search baskStream Branch",
    description: "Searches a guarded station branch for nodes matching query, feature, operation, and metadata filters.",
    inputSchema: {
      ...connectionFields,
      base: z.string().default("slot:/Drivers"),
      query: z.string().default(""),
      features: z.array(z.string()).optional(),
      operations: z.array(z.string()).optional(),
      metadata: metadataMode,
      depth: z.number().int().min(0).max(128).default(32),
      limit: z.number().int().min(1).max(5000).default(250),
      maxVisited: z.number().int().min(1).max(200000).default(50000),
      timeoutMillis: z.number().int().min(100).max(30000).default(5000)
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => ({
    ok: true,
    response: await client.call("search", operationFields(params, [
      "base",
      "query",
      "features",
      "operations",
      "metadata",
      "depth",
      "limit",
      "maxVisited",
      "timeoutMillis"
    ]))
  }))
);

registerTool(
  "baskstream_read_points",
  {
    title: "Read baskStream Points",
    description: "Reads one or more point/value ORDs through the batch point snapshot operation.",
    inputSchema: {
      ...connectionFields,
      points: z.array(z.string()).min(1).max(1000),
      fields: z.array(pointSnapshotField).optional()
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => ({
    ok: true,
    response: await client.call("read", operationFields(params, ["points", "fields"]))
  }))
);

registerTool(
  "baskstream_describe_write",
  {
    title: "Describe baskStream Writes",
    description: "Returns writable-point capabilities without writing. Use before any write action.",
    inputSchema: {
      ...connectionFields,
      points: z.array(z.string()).min(1).max(1000)
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => ({
    ok: true,
    response: await client.call("describe_write", operationFields(params, ["points"]))
  }))
);

registerTool(
  "baskstream_write_point",
  {
    title: "Write baskStream Point",
    description: "Writes a writable point. Requires BASKSTREAM_ALLOW_WRITES=true and Niagara write permission.",
    inputSchema: {
      ...connectionFields,
      point: z.string(),
      action: z.enum(["set", "override", "auto", "emergency_override", "emergency_auto"]),
      value: z.unknown().optional(),
      durationSec: z.number().int().min(1).optional()
    },
    readOnly: false,
    destructive: true,
    idempotent: false
  },
  async (params) => withClient(params, async (client, cfg) => {
    assertWritesAllowed(cfg);
    return {
      ok: true,
      response: await client.call("write", operationFields(params, ["point", "action", "value", "durationSec"]))
    };
  })
);

registerTool(
  "baskstream_describe_history",
  {
    title: "Describe baskStream History",
    description: "Describes history availability for a point or history ORD without loading records.",
    inputSchema: {
      ...connectionFields,
      ord: z.string()
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => ({
    ok: true,
    response: await client.call("describe_history", operationFields(params, ["ord"]))
  }))
);

registerTool(
  "baskstream_read_history",
  {
    title: "Read baskStream History",
    description: "Reads bounded history records for a point or history ORD.",
    inputSchema: {
      ...connectionFields,
      ord: z.string(),
      start: z.number().int().optional(),
      end: z.number().int().optional(),
      limit: z.number().int().min(1).max(5000).default(1000)
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => ({
    ok: true,
    response: await client.call("read_history", operationFields(params, ["ord", "start", "end", "limit"]))
  }))
);

registerTool(
  "baskstream_read_schedule",
  {
    title: "Read baskStream Schedule",
    description: "Reads a Niagara schedule ORD and optional effective timestamp.",
    inputSchema: {
      ...connectionFields,
      ord: z.string(),
      at: z.number().int().optional()
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => ({
    ok: true,
    response: await client.call("read_schedule", operationFields(params, ["ord", "at"]))
  }))
);

registerTool(
  "baskstream_read_alarms",
  {
    title: "Read baskStream Alarms",
    description: "Reads a bounded alarm snapshot by scope and optional source ORD.",
    inputSchema: {
      ...connectionFields,
      scope: z.enum(["open", "ack_pending", "all"]).default("open"),
      source: z.string().optional(),
      limit: z.number().int().min(1).max(5000).default(500)
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => ({
    ok: true,
    response: await client.call("read_alarms", operationFields(params, ["scope", "source", "limit"]))
  }))
);

registerTool(
  "baskstream_ack_alarms",
  {
    title: "Acknowledge baskStream Alarms",
    description: "Acknowledges one or more alarm UUIDs. Requires BASKSTREAM_ALLOW_ALARM_ACTIONS=true.",
    inputSchema: {
      ...connectionFields,
      uuids: z.array(z.string()).min(1),
      source: z.string().optional()
    },
    readOnly: false,
    destructive: false,
    idempotent: true
  },
  async (params) => withClient(params, async (client, cfg) => {
    assertAlarmActionsAllowed(cfg);
    return {
      ok: true,
      response: await client.call("ack_alarms", operationFields(params, ["uuids", "source"]))
    };
  })
);

registerTool(
  "baskstream_clear_alarms",
  {
    title: "Clear baskStream Alarms",
    description: "Force-clears one or more alarm UUIDs. Requires BASKSTREAM_ALLOW_ALARM_ACTIONS=true.",
    inputSchema: {
      ...connectionFields,
      uuids: z.array(z.string()).min(1),
      source: z.string().optional()
    },
    readOnly: false,
    destructive: true,
    idempotent: false
  },
  async (params) => withClient(params, async (client, cfg) => {
    assertAlarmActionsAllowed(cfg);
    return {
      ok: true,
      response: await client.call("clear_alarms", operationFields(params, ["uuids", "source"]))
    };
  })
);

registerTool(
  "baskstream_subscription_status",
  {
    title: "Read baskStream Subscription Status",
    description: "Returns subscription diagnostics for the current short-lived MCP station session.",
    inputSchema: {
      ...connectionFields,
      includePoints: z.boolean().default(false)
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => ({
    ok: true,
    response: await client.call("subscription_status", operationFields(params, ["includePoints"]))
  }))
);

registerTool(
  "baskstream_inventory",
  {
    title: "Summarize baskStream Inventory",
    description: "Searches a station branch and returns compact counts plus representative nodes for AI-oriented station understanding.",
    inputSchema: {
      ...connectionFields,
      base: z.string().default("slot:/Drivers"),
      depth: z.number().int().min(0).max(128).default(32),
      query: z.string().default(""),
      limit: z.number().int().min(1).max(5000).default(500),
      maxVisited: z.number().int().min(1).max(200000).default(50000),
      maxItems: z.number().int().min(1).max(100).default(40)
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => {
    const response = await client.call("search", {
      base: params.base,
      query: params.query,
      depth: params.depth,
      metadata: "full",
      limit: params.limit,
      maxVisited: params.maxVisited,
      timeoutMillis: 10000
    });
    const nodes = searchNodes(response);
    const maxItems = Number(params.maxItems || 40);
    const points = nodes.filter((node) => Boolean(nodeClassification(node).isPoint));
    const schedules = nodes.filter((node) => Boolean(nodeClassification(node).isSchedule));
    const histories = nodes.filter((node) => Boolean(nodeClassification(node).hasHistory));
    const alarms = nodes.filter((node) => Boolean(nodeClassification(node).hasAlarm));
    const devices = nodes.filter((node) => Boolean(nodeClassification(node).isDriverDevice));
    return {
      ok: true,
      base: params.base,
      result: response.result,
      counts: {
        returned: nodes.length,
        byKind: countBy(nodes, (node) => isRecord(node) ? String(node.kind || "unknown") : "unknown"),
        points: points.length,
        schedules: schedules.length,
        historyCapable: histories.length,
        alarmCapable: alarms.length,
        driverDevices: devices.length
      },
      examples: {
        devices: devices.slice(0, maxItems).map(compactNode),
        points: points.slice(0, maxItems).map(compactNode),
        schedules: schedules.slice(0, maxItems).map(compactNode),
        historyCapable: histories.slice(0, maxItems).map(compactNode)
      },
      summary: [
        `Returned ${nodes.length} node(s) under ${String(params.base)}.`,
        `${points.length} point(s), ${devices.length} driver device(s), ${schedules.length} schedule(s).`,
        `${histories.length} history-capable node(s), ${alarms.length} alarm-capable node(s).`
      ]
    };
  })
);

registerTool(
  "baskstream_summarize_equipment_branch",
  {
    title: "Summarize baskStream Equipment Branch",
    description: "Summarizes likely equipment, devices, point containers, and point evidence under one station branch.",
    inputSchema: {
      ...connectionFields,
      base: z.string(),
      depth: z.number().int().min(0).max(128).default(16),
      limit: z.number().int().min(1).max(5000).default(1000),
      maxItems: z.number().int().min(1).max(100).default(50)
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => {
    const response = await client.call("search", {
      base: params.base,
      depth: params.depth,
      metadata: "full",
      limit: params.limit,
      maxVisited: 100000,
      timeoutMillis: 10000
    });
    const nodes = searchNodes(response);
    const maxItems = Number(params.maxItems || 50);
    const equipment = nodes.filter((node) => {
      const classification = nodeClassification(node);
      return Boolean(classification.isDriverDevice) ||
        String(classification.equipmentCertainty || "unknown") !== "unknown";
    });
    const pointContainers = nodes.filter((node) => {
      const ord = nodeOrd(node).toLowerCase();
      return ord.endsWith("/points") || nodeName(node).toLowerCase() === "points";
    });
    const points = nodes.filter((node) => Boolean(nodeClassification(node).isPoint));
    return {
      ok: true,
      base: params.base,
      counts: {
        returned: nodes.length,
        equipmentCandidates: equipment.length,
        pointContainers: pointContainers.length,
        points: points.length
      },
      equipmentCandidates: equipment.slice(0, maxItems).map(compactNode),
      pointContainers: pointContainers.slice(0, maxItems).map(compactNode),
      samplePoints: points.slice(0, maxItems).map(compactNode),
      summary: [
        `Found ${equipment.length} equipment/device candidate(s) under ${String(params.base)}.`,
        `Found ${points.length} point node(s) and ${pointContainers.length} point container(s).`
      ]
    };
  })
);

registerTool(
  "baskstream_summarize_histories",
  {
    title: "Summarize baskStream Histories",
    description: "Finds history-capable nodes under a branch and returns compact descriptors.",
    inputSchema: {
      ...connectionFields,
      base: z.string().default("slot:/Drivers"),
      depth: z.number().int().min(0).max(128).default(32),
      limit: z.number().int().min(1).max(5000).default(500),
      maxItems: z.number().int().min(1).max(100).default(40)
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => {
    const response = await client.call("search", {
      base: params.base,
      depth: params.depth,
      metadata: "full",
      operations: ["read_history"],
      limit: params.limit,
      maxVisited: 100000,
      timeoutMillis: 10000
    });
    const nodes = searchNodes(response);
    return {
      ok: true,
      base: params.base,
      count: nodes.length,
      histories: nodes.slice(0, Number(params.maxItems || 40)).map(compactNode),
      summary: [`Found ${nodes.length} history-capable node(s) under ${String(params.base)}.`]
    };
  })
);

registerTool(
  "baskstream_summarize_alarms",
  {
    title: "Summarize baskStream Alarms",
    description: "Reads a bounded alarm snapshot and returns compact counts plus sample records.",
    inputSchema: {
      ...connectionFields,
      scope: z.enum(["open", "ack_pending", "all"]).default("open"),
      source: z.string().optional(),
      limit: z.number().int().min(1).max(5000).default(500),
      maxItems: z.number().int().min(1).max(100).default(40)
    },
    readOnly: true
  },
  async (params) => withClient(params, async (client) => {
    const response = await client.call("read_alarms", operationFields(params, ["scope", "source", "limit"]));
    const alarmEnvelope = isRecord(response.alarms) ? response.alarms : {};
    const alarms = asArray(alarmEnvelope.alarms).filter(isRecord);
    return {
      ok: true,
      scope: params.scope,
      source: params.source,
      count: alarmEnvelope.count ?? alarms.length,
      bySource: countBy(alarms, (alarm) => isRecord(alarm) ? String(alarm.source || alarm.sourceOrd || "unknown") : "unknown"),
      sample: alarms.slice(0, Number(params.maxItems || 40)),
      response,
      summary: [`Read ${String(alarmEnvelope.count ?? alarms.length)} ${String(params.scope || "open")} alarm record(s).`]
    };
  })
);

registerTool(
  "baskstream_call_raw",
  {
    title: "Call Raw baskStream Operation",
    description: "Calls an arbitrary request/response baskStream operation. Mutating ops require the matching mutation flag.",
    inputSchema: {
      ...connectionFields,
      op: z.string().min(1),
      fields: z.record(z.unknown()).default({})
    },
    readOnly: false,
    destructive: true,
    idempotent: false
  },
  async (params) => withClient(params, async (client, cfg) => {
    const op = String(params.op);
    if (rawMutationOps.has(op)) {
      if (rawWriteOps.has(op)) {
        assertWritesAllowed(cfg);
      }
      if (rawAlarmActionOps.has(op)) {
        assertAlarmActionsAllowed(cfg);
      }
    }
    const fields = isRecord(params.fields) ? params.fields : {};
    return {
      ok: true,
      response: await client.call(op, fields)
    };
  })
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
