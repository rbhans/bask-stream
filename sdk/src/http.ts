import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { BaskStreamError, CLIENT_ERRORS } from "./errors.js";

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface StationHttpOptions {
  /** Station base URL, e.g. https://192.168.0.126 */
  station: string;
  /** Verify the station's TLS certificate. Niagara stations often use self-signed certificates. */
  verifyTls?: boolean;
  /** Extra CA certificate(s) to trust. */
  ca?: string | Buffer;
  timeoutMs?: number;
  /** Restore a previously saved session. */
  cookies?: Record<string, string>;
}

/** HTTP side of a station connection: cookies, Niagara's SCRAM login and the health endpoint. */
export class StationHttp {
  readonly url: URL;
  readonly verifyTls: boolean;
  readonly ca?: string | Buffer;
  readonly timeoutMs: number;
  private readonly cookies = new Map<string, string>();

  constructor(options: StationHttpOptions) {
    this.url = new URL(options.station);
    this.verifyTls = options.verifyTls ?? true;
    this.ca = options.ca;
    this.timeoutMs = options.timeoutMs ?? 30000;
    for (const [key, value] of Object.entries(options.cookies ?? {})) this.cookies.set(key, value);
  }

  /** The current session cookies, for saving a session between runs. */
  getCookies(): Record<string, string> {
    return Object.fromEntries(this.cookies);
  }

  cookieHeader(): string {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  request(method: string, path: string, body = "", headers: Record<string, string> = {}): Promise<HttpResponse> {
    const url = new URL(path, this.url);
    const transport = url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          method,
          path: `${url.pathname}${url.search}`,
          rejectUnauthorized: this.verifyTls,
          ca: this.ca,
          timeout: this.timeoutMs,
          headers: {
            Host: url.host,
            Cookie: this.cookieHeader(),
            ...headers,
            ...(body ? { "Content-Length": Buffer.byteLength(body) } : {})
          }
        },
        (res) => {
          this.storeCookies(res.headers);
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("error", reject);
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) req.destroy(new Error("HTTP response exceeds 8 MiB."));
            else chunks.push(Buffer.from(chunk));
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        }
      );
      req.on("timeout", () => req.destroy(new Error(`HTTP ${method} ${path} timed out after ${this.timeoutMs} ms.`)));
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  /** The service's /stream/health JSON, or null when the session is not logged in. */
  async health(): Promise<Record<string, unknown> | null> {
    const response = await this.request("GET", "/stream/health");
    if (response.status !== 200) return null;
    return JSON.parse(response.body) as Record<string, unknown>;
  }

  /** Metrics text from /stream/metrics (OpenMetrics format). */
  async metrics(): Promise<string> {
    const response = await this.request("GET", "/stream/metrics");
    if (response.status !== 200) throw new BaskStreamError(CLIENT_ERRORS.sessionExpired, `Metrics returned HTTP ${response.status}.`);
    return response.body;
  }

  /**
   * Niagara web login (SCRAM-SHA-256), verifying the station's signature. Reuses an existing
   * session when its cookies are still valid.
   */
  async login(username: string, password: string): Promise<Record<string, unknown>> {
    const existing = await this.health();
    if (existing) return existing;

    await this.request("GET", "/prelogin");
    const userStep = await this.request("POST", "/login", `j_username=${encodeURIComponent(username)}`, {
      "Content-Type": "application/x-www-form-urlencoded"
    });
    if (userStep.status !== 200 || !userStep.body.includes("j_security_check")) {
      throw new BaskStreamError(CLIENT_ERRORS.loginFailed, `Niagara username step failed with HTTP ${userStep.status}.`);
    }

    const nonce = crypto.randomBytes(16).toString("base64");
    const clientFirstBare = `n=${prepUsername(username)},r=${nonce}`;
    const first = await this.request("POST", "/j_security_check/", `action=sendClientFirstMessage&clientFirstMessage=n,,${clientFirstBare}`, {
      "Content-Type": "application/x-niagara-login-support"
    });
    if (first.status !== 200) throw new BaskStreamError(CLIENT_ERRORS.loginFailed, `Login failed at the first SCRAM step (HTTP ${first.status}).`);

    const serverFirst = first.body.trim();
    const parsed = parseScram(serverFirst);
    const iterations = Number(parsed.i);
    if (!parsed.r?.startsWith(nonce) || parsed.r.length <= nonce.length || !parsed.s || !Number.isInteger(iterations) || iterations < 1 || iterations > 1000000) {
      throw new BaskStreamError(CLIENT_ERRORS.loginFailed, "The station sent an invalid SCRAM message.");
    }

    const salted = crypto.pbkdf2Sync(Buffer.from(password.normalize("NFKC"), "utf8"), Buffer.from(parsed.s, "base64"), iterations, 32, "sha256");
    const clientFinalNoProof = `c=biws,r=${parsed.r}`;
    const authMessage = `${clientFirstBare},${serverFirst},${clientFinalNoProof}`;
    const clientKey = hmac(salted, "Client Key");
    const proof = xor(clientKey, hmac(sha256(clientKey), authMessage)).toString("base64");

    const final = await this.request("POST", "/j_security_check/", `action=sendClientFinalMessage&clientFinalMessage=${clientFinalNoProof},p=${proof}`, {
      "Content-Type": "application/x-niagara-login-support"
    });
    if (final.status !== 200) throw new BaskStreamError(CLIENT_ERRORS.loginFailed, "Login failed: wrong username or password.");
    const serverFinal = parseScram(final.body.trim());
    const expected = hmac(hmac(salted, "Server Key"), authMessage);
    const signature = Buffer.from(serverFinal.v || "", "base64");
    if (serverFinal.e || signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
      throw new BaskStreamError(CLIENT_ERRORS.loginFailed, "The station's login signature did not verify.");
    }

    await this.request("GET", "/j_security_check/");
    const health = await this.health();
    if (!health) throw new BaskStreamError(CLIENT_ERRORS.loginFailed, "Logged in, but /stream/health is not reachable. Is BASkStreamService running?");
    return health;
  }

  private storeCookies(headers: http.IncomingHttpHeaders): void {
    const raw = headers["set-cookie"];
    for (const header of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      const pair = header.split(";", 1)[0];
      const index = pair.indexOf("=");
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
}

function parseScram(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(",")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index)] = part.slice(index + 1);
  }
  return out;
}

function prepUsername(value: string): string {
  return value.normalize("NFKC").replace(/=/g, "=3D").replace(/,/g, "=2C");
}

function hmac(key: Buffer, text: string): Buffer {
  return crypto.createHmac("sha256", key).update(text, "utf8").digest();
}

function sha256(buffer: Buffer): Buffer {
  return crypto.createHash("sha256").update(buffer).digest();
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
}
