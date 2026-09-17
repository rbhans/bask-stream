import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface BaskStreamConfig {
  stationUrl: string;
  username?: string;
  password?: string;
  verifyTls: boolean;
  ca?: string;
  timeoutMs: number;
  allowWrites: boolean;
  allowAlarmActions: boolean;
  allowTagWrites: boolean;
  allowRawOperations: boolean;
  allowedOrdPrefixes?: string[];
}

function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
  }
  throw new Error("Invalid boolean in baskStream connection configuration.");
}

export function stationOrigin(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Station URL must be an HTTP(S) origin without credentials, query, or path.");
  }
  return url.origin;
}

export async function loadConfig(packageRoot: string, env = process.env): Promise<BaskStreamConfig> {
  const workspace = env.BASK_STREAM_WORKSPACE || env.CODEX_WORKSPACE_ROOT || env.WORKSPACE_ROOT || process.cwd();
  const explicit = env.BASKSTREAM_CONFIG || env.BASK_STREAM_MCP_CONFIG;
  const candidates = explicit ? [explicit] : [
    path.join(workspace, "station.connection.json"),
    path.join(packageRoot, "config.json"),
    path.join(os.homedir(), ".bask-stream", "config.json")
  ];
  let file: Record<string, unknown> = {};
  let configDir = process.cwd();
  for (const candidate of candidates) {
    try {
      file = JSON.parse(await fs.readFile(candidate, "utf8"));
      if (!file || Array.isArray(file) || typeof file !== "object") throw new Error("Connection config must be an object.");
      configDir = path.dirname(path.resolve(candidate));
      break;
    } catch (error) {
      if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Unable to load baskStream connection config: ${candidate}`);
    }
  }
  const stationUrl = String(env.BASKSTREAM_STATION_URL || env.BASK_STREAM_URL || env.NIAGARA_URL || file.stationUrl || "");
  const timeoutMs = Number(env.BASKSTREAM_TIMEOUT_MS ?? env.BASK_STREAM_REQUEST_TIMEOUT_MS ?? file.timeoutMs ?? file.requestTimeoutMs ?? 45000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("timeoutMs must be between 1000 and 120000.");
  const caFile = env.BASKSTREAM_CA_FILE || file.caFile;
  const prefixes = env.BASK_STREAM_ALLOWED_ORD_PREFIXES?.split(",").map(s => s.trim()) || file.allowedOrdPrefixes;
  if (prefixes !== undefined && (!Array.isArray(prefixes) || !prefixes.every(s => typeof s === "string" && s.length > 0))) {
    throw new Error("allowedOrdPrefixes must be a list of non-empty strings.");
  }
  return {
    stationUrl: stationUrl ? stationOrigin(stationUrl) : "",
    username: String(env.BASKSTREAM_USER || env.BASK_STREAM_USERNAME || env.NIAGARA_USER || file.username || "") || undefined,
    password: String(env.BASKSTREAM_PASSWORD || env.BASK_STREAM_PASSWORD || env.NIAGARA_PASSWORD || env.STREAM_PASSWORD || file.password || "") || undefined,
    verifyTls: boolean(env.BASKSTREAM_VERIFY_TLS ?? env.BASK_STREAM_REJECT_UNAUTHORIZED ?? file.verifyTls ?? file.rejectUnauthorized, true),
    ca: caFile ? await fs.readFile(path.resolve(configDir, String(caFile)), "utf8") : undefined,
    timeoutMs,
    allowedOrdPrefixes: prefixes as string[] | undefined,
    allowWrites: boolean(env.BASKSTREAM_ALLOW_WRITES ?? env.BASK_STREAM_ENABLE_MUTATIONS ?? file.allowWrites ?? file.enableMutations, false),
    allowAlarmActions: boolean(env.BASKSTREAM_ALLOW_ALARM_ACTIONS ?? file.allowAlarmActions, false),
    allowTagWrites: boolean(env.BASKSTREAM_ALLOW_TAG_WRITES ?? file.allowTagWrites, false),
    allowRawOperations: boolean(env.BASKSTREAM_ALLOW_RAW ?? file.allowRawOperations, false)
  };
}

export function assertOrdScope(config: BaskStreamConfig, fields: Record<string, unknown>): void {
  const prefixes = config.allowedOrdPrefixes;
  if (!prefixes) return;
  const ordFields = new Set(["point", "points", "ord", "ords", "base", "source", "endpoint"]);
  function walk(value: unknown, key: string): void {
    if (Array.isArray(value)) { value.forEach(item => walk(item, key)); return; }
    if (value && typeof value === "object") { Object.entries(value).forEach(([k,v]) => walk(v,k)); return; }
    if (ordFields.has(key) && typeof value === "string"
        && (!prefixes!.some(prefix => value.startsWith(prefix)) || value.includes("|") || /(?:^|\/)\.{1,2}(?:\/|$)/.test(value))) {
      throw new Error("Requested ORD is outside the configured MCP scope.");
    }
  }
  walk(fields, "");
}

export function configFor(config: BaskStreamConfig, params: Record<string, unknown>): BaskStreamConfig {
  if (!config.stationUrl) throw new Error("No station configured. Run the plugin connection setup first.");
  if (params.station_url && stationOrigin(String(params.station_url)) !== config.stationUrl) {
    throw new Error("Station override does not match the configured station. Configure a separate connection before switching stations.");
  }
  if (params.user && params.user !== config.username) throw new Error("User override does not match the configured credentials.");
  return config;
}

const reads = new Set(["ping", "capabilities", "browse", "describe", "search", "read", "describe_write",
  "read_history", "describe_history", "read_schedule", "read_alarms", "read_tags", "subscription_status"]);
export function assertOperationAllowed(config: BaskStreamConfig, op: string): void {
  if (reads.has(op)) return;
  if (op === "write" && config.allowWrites) return;
  if (["ack_alarm", "ack_alarms", "clear_alarm", "clear_alarms"].includes(op) && config.allowAlarmActions) return;
  if (["write_tags", "write_relations"].includes(op) && config.allowTagWrites) return;
  throw new Error(`Operation '${op}' is disabled or unsupported by this MCP. Enable its specific mutation setting locally if needed.`);
}
