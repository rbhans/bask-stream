import chalk from "chalk";
import { BaskStreamClient, BaskStreamError, StationHttp } from "@basidekick/baskstream";
import { getProfile, type Profile } from "./config.js";

type Outcome = "ok" | "warn" | "fail" | "skip";
interface Check {
  name: string;
  outcome: Outcome;
  detail: string;
  fix?: string;
}

const MARK: Record<Outcome, string> = { ok: chalk.green("✓"), warn: chalk.yellow("!"), fail: chalk.red("✗"), skip: chalk.dim("–") };

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS|SSL|certificate/i;

const TLS_TEXT: [RegExp, string][] = [
  [/SELF_SIGNED|self.signed/i, "the station uses a self-signed certificate"],
  [/EXPIRED/i, "the station's certificate has expired"],
  [/ALTNAME|hostname/i, "the certificate is for a different host name"],
  [/UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/i, "the certificate is not from a trusted authority"]
];

function describeNetworkError(error: unknown): { tls: boolean; text: string } {
  const e = error as { code?: string; message?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code ?? "";
  const raw = `${code} ${e.message ?? String(error)}`;
  const friendly = TLS_TEXT.find(([pattern]) => pattern.test(raw))?.[1];
  return { tls: TLS_CODES.test(raw), text: friendly ?? `${code ? `${code}: ` : ""}${(e.message ?? String(error)).split(";")[0]}` };
}

/**
 * Walks through everything bask needs, stopping at the first thing that blocks the rest, and says
 * how to fix it. Uses the saved profile, or a station URL with no login.
 */
export async function runDoctor(profileName: string | undefined, stationArg: string | undefined, insecureArg: boolean): Promise<boolean> {
  const checks: Check[] = [];
  const print = (check: Check) => {
    checks.push(check);
    console.log(`  ${MARK[check.outcome]} ${check.name.padEnd(18)} ${check.outcome === "ok" ? check.detail : chalk.dim(check.detail)}`);
    if (check.fix) console.log(`    ${" ".repeat(18)} ${chalk.cyan("→")} ${check.fix}`);
  };
  const finish = () => {
    const failed = checks.filter((c) => c.outcome === "fail").length;
    const loggedOut = checks.some((c) => c.name === "Session" && c.outcome === "skip");
    console.log();
    if (failed) console.log(`  ${chalk.red(`${failed} problem${failed === 1 ? "" : "s"} found.`)}`);
    else if (loggedOut) console.log(`  ${chalk.green("The station looks ready.")} Log in with ${chalk.bold(`bask login ${profile.station} -u <user>${profile.insecure ? " --insecure" : ""}`)}`);
    else console.log(`  ${chalk.green("All good.")} Run ${chalk.bold("bask")} to open the dashboard.`);
    return failed === 0;
  };

  // 1. Which station.
  let profile: Profile = { station: "" };
  let name = "";
  if (stationArg) {
    const url = new URL(/^https?:\/\//.test(stationArg) ? stationArg : `https://${stationArg}`);
    profile = { station: url.origin, insecure: insecureArg };
    print({ name: "Station", outcome: "ok", detail: `${url.origin} (no saved profile used)` });
  } else {
    try {
      ({ name, profile } = getProfile(profileName));
      print({ name: "Profile", outcome: "ok", detail: `${name} · ${profile.username ?? "?"} @ ${profile.station}${profile.insecure ? " · self-signed allowed" : ""}` });
    } catch (error) {
      print({ name: "Profile", outcome: "fail", detail: (error as Error).message, fix: "bask login https://<station> -u <user> --insecure" });
      return finish();
    }
  }

  const http = new StationHttp({ station: profile.station, verifyTls: !profile.insecure, cookies: profile.cookies, timeoutMs: 10000 });
  const host = http.url.host;

  // 2. Reachable, with TLS accepted.
  const started = Date.now();
  let prelogin;
  try {
    prelogin = await http.request("GET", "/prelogin");
    print({ name: "Reachable", outcome: "ok", detail: `${host} answered in ${Date.now() - started} ms` });
  } catch (error) {
    const { tls, text } = describeNetworkError(error);
    if (tls) {
      print({ name: "Reachable", outcome: "ok", detail: `${host} answered` });
      print({
        name: "Certificate",
        outcome: "fail",
        detail: text,
        fix: profile.insecure ? "The station's certificate could not be used even with --insecure; check the station's TLS setup." : `Allow it (normal for Niagara stations): bask login ${profile.station} -u ${profile.username ?? "<user>"} --insecure`
      });
    } else {
      print({
        name: "Reachable",
        outcome: "fail",
        detail: text,
        fix: /ECONNREFUSED/.test(text)
          ? `Nothing is listening on ${host}. Is the station running, and is the web service on this port?`
          : /ENOTFOUND|EAI_AGAIN/.test(text)
            ? "The host name does not resolve. Check the address."
            : "Check the address, VPN and firewall between here and the station."
      });
    }
    return finish();
  }
  if (http.url.protocol === "https:") {
    print({ name: "Certificate", outcome: profile.insecure ? "warn" : "ok", detail: profile.insecure ? `not verified (self-signed allowed by ${stationArg ? "--insecure" : "this profile"})` : "trusted" });
  }

  // 3. The station's own web login page (every Niagara web login goes through it).
  if (prelogin.status >= 500) {
    const reason = /<pre>([^<]*)<\/pre>/.exec(prelogin.body)?.[1];
    print({
      name: "Login page",
      outcome: "fail",
      detail: `the station's login page returns HTTP ${prelogin.status}${reason ? ` (${reason})` : ""}`,
      fix: "Browser logins fail too. In Workbench: Config → Services → WebService → Login Template, set it back to the default."
    });
    return finish();
  }
  print({ name: "Login page", outcome: "ok", detail: `HTTP ${prelogin.status}` });

  // 4. Session and the baskStream service.
  if (!profile.cookies) {
    print({ name: "Session", outcome: stationArg ? "skip" : "fail", detail: "not logged in", fix: stationArg ? undefined : `bask login ${profile.station} -u ${profile.username ?? "<user>"}${profile.insecure ? " --insecure" : ""}` });
    return finish();
  }
  const health = await http.request("GET", "/stream/health");
  if (health.status === 404) {
    print({ name: "Session", outcome: "ok", detail: "logged in" });
    print({ name: "baskStream", outcome: "fail", detail: "/stream/health not found", fix: "Install the baskStream module and add BASkStreamService to the station (servletName stream)." });
    return finish();
  }
  if (health.status !== 200) {
    print({ name: "Session", outcome: "fail", detail: `expired or not accepted (HTTP ${health.status})`, fix: `bask login ${profile.station} -u ${profile.username ?? "<user>"}${profile.insecure ? " --insecure" : ""}` });
    return finish();
  }
  let info: Record<string, unknown> = {};
  try {
    info = JSON.parse(health.body) as Record<string, unknown>;
  } catch {}
  print({ name: "Session", outcome: "ok", detail: "logged in" });
  print({ name: "baskStream", outcome: "ok", detail: `service running${info.apiVersion ? ` · API ${info.apiVersion}` : ""}` });

  // 5. The WebSocket itself.
  let client: BaskStreamClient | undefined;
  try {
    const opened = Date.now();
    client = await BaskStreamClient.connect({ station: profile.station, verifyTls: !profile.insecure, cookies: profile.cookies, reconnect: false, timeoutMs: 10000 });
    const connectMs = Date.now() - opened;
    const pinged = Date.now();
    await client.ping();
    const caps = client.capabilities;
    print({ name: "WebSocket", outcome: "ok", detail: `connected in ${connectMs} ms · ping ${Date.now() - pinged} ms` });
    print({
      name: "Access",
      outcome: "ok",
      detail: `user ${caps.authenticatedUser ?? "?"} · service writes ${caps.writesEnabled ? "on" : "off"} · model edits ${(caps.modelEditing as { enabled?: boolean } | undefined)?.enabled ? "on" : "off"}`
    });
  } catch (error) {
    const code = error instanceof BaskStreamError ? ` [${error.code}]` : "";
    print({
      name: "WebSocket",
      outcome: "fail",
      detail: `${(error as Error).message}${code}`,
      fix: "HTTP works but the WebSocket does not: check proxies or firewalls for WebSocket upgrades, and the service's allowedOrigins and requireAuthorizationHeader settings."
    });
  } finally {
    client?.close();
  }
  return finish();
}
