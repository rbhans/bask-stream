// The one station connection: settings from the environment (the extension's settings), or a
// saved `bask login` profile; connects on first use and declares itself an AI agent each time,
// so the station's agent rules apply (reasons, proposals, limits).
import { readFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { BaskStreamClient, BaskStreamError } from "@basidekick/baskstream"
import { friendly } from "./normalize.mjs"

/** An env value, or "" when unset or left as an unexpanded ${…} placeholder. */
const env = (name) => {
  const value = (process.env[name] ?? "").trim()
  return /^\$\{.*\}$/.test(value) ? "" : value
}
const yes = (value) => /^(1|true|yes|on)$/i.test(value)

function stationOrigin(raw) {
  const text = String(raw ?? "").trim()
  let url
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`)
  } catch {
    throw new Error(`"${text}" isn't a valid station address.`)
  }
  if (url.protocol === "wss:") url.protocol = "https:"
  if (url.protocol === "ws:") url.protocol = "http:"
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Use an http(s):// station address.")
  if (url.username || url.password) throw new Error("Don't put credentials in the station address.")
  return url.origin
}

function baskProfile(name) {
  const dir = process.env.BASKSTREAM_CONFIG_DIR || join(homedir(), ".config", "baskstream")
  let store
  try {
    store = JSON.parse(readFileSync(join(dir, "profiles.json"), "utf8"))
  } catch {
    return null
  }
  const key = name || store.current
  const profile = key ? store.profiles?.[key] : null
  return profile ? { name: key, ...profile } : null
}

/**
 * Where to connect, from BASKSTREAM_STATION / _USERNAME / _PASSWORD / _INSECURE, else the bask
 * profile named by BASKSTREAM_PROFILE (or bask's current one). null when neither is set.
 */
export function loadConfig() {
  const station = env("BASKSTREAM_STATION")
  if (station) {
    return {
      source: "settings",
      station: stationOrigin(station),
      username: env("BASKSTREAM_USERNAME"),
      password: env("BASKSTREAM_PASSWORD"),
      insecure: yes(env("BASKSTREAM_INSECURE")),
    }
  }
  const profile = baskProfile(env("BASKSTREAM_PROFILE"))
  if (!profile) return null
  return {
    source: `bask profile "${profile.name}"`,
    station: stationOrigin(profile.station),
    username: profile.username ?? "",
    password: env("BASKSTREAM_PASSWORD"),
    insecure: Boolean(profile.insecure),
    cookies: profile.cookies,
  }
}

export const SETUP = [
  "baskStream isn't set up yet.",
  "In the Claude desktop app: Settings → Extensions → baskStream → Configure. Enter the station address (https://…), the Niagara user Claude should act as, and its password.",
  "Recommended: a dedicated Niagara user for Claude, listed in agentUsers on BASkStreamService, with a role covering only what Claude should touch.",
  "Outside the desktop app, run `bask login <station> -u <user>` once instead; the server uses that saved session.",
].join("\n")

export class Station {
  constructor() {
    this.config = loadConfig()
    this.client = null
    this.connecting = null
    this.actor = { kind: "agent", name: "Claude", onBehalfOf: safeUser() }
    this.lastError = null
  }

  /**
   * Who the server acts for, from the MCP client's own name. Only before the first connect: over
   * HTTP several clients share the connection, and the station knows the agent by the first.
   */
  setClient(info) {
    if (this.client || this.connecting) return
    if (info?.name) this.actor.name = info.name
    if (env("BASKSTREAM_MODEL")) this.actor.model = env("BASKSTREAM_MODEL")
  }

  /** The connected client, connecting on first use (one attempt at a time). */
  async connect() {
    if (this.client) return this.client
    if (!this.config) throw new Error(SETUP)
    if (!this.connecting) {
      const { station, username, password, insecure, cookies } = this.config
      const options = { station, username: username || undefined, password: password ? () => password : undefined, verifyTls: !insecure, cookies }
      this.connecting = (async () => {
        // Declaring an actor needs API 1.8; on an older station it would fail the connect. So look
        // first, then reconnect as a declared agent (same session, no second login) where it can.
        let client = await BaskStreamClient.connect(options)
        this.agentDeclared = declaresActors(client.capabilities)
        if (this.agentDeclared) {
          const session = client.http.getCookies()
          client.close()
          client = await BaskStreamClient.connect({ ...options, cookies: session, actor: this.actor })
        }
        return client
      })()
        .then((client) => {
          client.on("error", (error) => (this.lastError = friendly(error)))
          client.on("reconnected", () => (this.lastError = null))
          this.client = client
          this.lastError = null
          return client
        })
        .catch((error) => {
          this.lastError = friendly(error)
          throw new Error(this.lastError)
        })
        .finally(() => (this.connecting = null))
    }
    return this.connecting
  }

  /** Runs fn(client), turning failures into messages a person can act on. */
  async use(fn) {
    const client = await this.connect()
    try {
      return await fn(client)
    } catch (error) {
      if (error instanceof BaskStreamError) throw new Error(friendly(error))
      throw error
    }
  }

  close() {
    this.client?.close()
  }
}

/** True when the station takes declare_actor (API 1.8 and later). */
function declaresActors(caps = {}) {
  const ops = caps.operations ?? caps.supportedOperations
  if (Array.isArray(ops)) return ops.includes("declare_actor")
  if (caps.agents) return true
  const [major, minor] = String(caps.apiVersion ?? "0").split(".").map(Number)
  return major > 1 || (major === 1 && minor >= 8)
}

function safeUser() {
  try {
    return userInfo().username
  } catch {
    return undefined
  }
}
