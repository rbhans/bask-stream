// Streamable HTTP, for MCP clients that can't start the server themselves (claude.ai custom
// connectors, Claude Duet). Stateless: each POST to /mcp gets a fresh MCP server, and they all share
// the one station connection. Every request must carry the token, as `Authorization: Bearer <token>`
// or, for clients that can't send headers, in the path (/mcp/<token>). Listens on 127.0.0.1 unless
// told otherwise; a tunnel (cloudflared, Tailscale Funnel) puts it on the internet.
import { createHash, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"

const MIN_TOKEN = 32
const MAX_BODY = 4 * 1024 * 1024

/** Port, host and token from BASKSTREAM_HTTP_PORT / _HOST / _TOKEN; throws when the token is missing or short. */
export function httpSettings() {
  const env = (name) => (process.env[name] ?? "").trim()
  const token = env("BASKSTREAM_HTTP_TOKEN")
  if (token.length < MIN_TOKEN) {
    throw new Error(`Set BASKSTREAM_HTTP_TOKEN to a secret of at least ${MIN_TOKEN} characters (e.g. \`openssl rand -hex 32\`); every request must carry it.`)
  }
  const port = env("BASKSTREAM_HTTP_PORT") === "" ? 8787 : Number(env("BASKSTREAM_HTTP_PORT"))
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`BASKSTREAM_HTTP_PORT "${env("BASKSTREAM_HTTP_PORT")}" isn't a port number.`)
  return { token, port, host: env("BASKSTREAM_HTTP_HOST") || "127.0.0.1" }
}

/**
 * Serves MCP at /mcp. newServer() makes the McpServer for one request; onInitialize(clientInfo)
 * hears who connected, since a stateless server never sees initialize and initialized together.
 * Resolves to the listening http.Server.
 */
export function serveHttp({ newServer, onInitialize, token, port, host }) {
  const expected = digest(token)
  const http = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "")
      const [, base, inPath, ...rest] = path.split("/")
      if (base !== "mcp" || rest.length) return reply(res, 404, "Not found.")
      const header = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]
      const given = header ?? inPath ?? ""
      if (!given || !timingSafeEqual(digest(given), expected)) {
        console.error(`baskStream: refused ${req.method} ${inPath ? "/mcp/…" : "/mcp"} (${given ? "wrong" : "no"} token)`)
        return reply(res, 401, "Unauthorized.", { "WWW-Authenticate": 'Bearer realm="baskStream"' })
      }
      if (req.method !== "POST") return reply(res, 405, "Use POST; this server keeps no sessions or streams.", { Allow: "POST" })

      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch (error) {
        return reply(res, error.status ?? 400, error.status ? error.message : "The body isn't JSON.", {}, -32700)
      }
      for (const message of [body].flat()) {
        if (message?.method === "initialize") onInitialize?.(message.params?.clientInfo)
      }

      const server = newServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on("close", () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (error) {
      console.error(`baskStream: ${error?.stack ?? error}`)
      if (!res.headersSent) reply(res, 500, "Internal error.", {}, -32603)
    }
  })
  return new Promise((resolve, reject) => {
    http.once("error", reject)
    http.listen(port, host, () => resolve(http))
  })
}

const digest = (text) => createHash("sha256").update(String(text)).digest()

/** A JSON-RPC error response with no request id. */
function reply(res, status, message, headers = {}, code = -32000) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers })
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }))
}

/** The request body as text; past MAX_BODY the rest is read and dropped, and it rejects with 413. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size <= MAX_BODY) chunks.push(chunk)
    })
    req.on("end", () => {
      if (size > MAX_BODY) reject(Object.assign(new Error("The request is too large."), { status: 413 }))
      else resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", reject)
  })
}
