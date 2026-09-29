// A small in-process stand-in for a station: Niagara SCRAM login, /stream/health and the /stream
// WebSocket with a handful of operations. Enough to exercise the client without a real station.
import crypto from "node:crypto";
import http from "node:http";
import { decode, encode } from "@msgpack/msgpack";
import { WebSocketServer } from "ws";

export const USER = "test";
export const PASSWORD = "secret-pass";
const SALT = crypto.randomBytes(16);
const ITERATIONS = 4096;

const node = (name, kind, extra = {}) => ({ name, display: name, kind, typeSpec: kind === "point" ? "control:NumericWritable" : "baja:Folder", hasChildren: kind !== "point", status: "{ok}", ...extra });
const TREE = {
  "slot:/": { ...node("station", "container"), children: ["slot:/Drivers", "slot:/Services"] },
  "slot:/Drivers": { ...node("Drivers", "container"), children: ["slot:/Drivers/Net"] },
  "slot:/Services": { ...node("Services", "container"), children: [] },
  "slot:/Drivers/Net": { ...node("Net", "container"), children: ["slot:/Drivers/Net/VAV_01"] },
  "slot:/Drivers/Net/VAV_01": { ...node("VAV_01", "component"), children: ["slot:/Drivers/Net/VAV_01/points"] },
  "slot:/Drivers/Net/VAV_01/points": { ...node("points", "container"), children: ["slot:/Drivers/Net/VAV_01/points/SpaceTemp", "slot:/Drivers/Net/VAV_01/points/DamperPos"] },
  "slot:/Drivers/Net/VAV_01/points/SpaceTemp": node("SpaceTemp", "point", { writable: true }),
  "slot:/Drivers/Net/VAV_01/points/DamperPos": node("DamperPos", "point", { writable: true })
};
const ALARMS = [
  { uuid: "a-1", timestamp: Date.now() - 60000, priority: 50, alarmClass: "critical", sourceState: "offnormal", ackState: "unacked", sources: ["slot:/Drivers/Net/VAV_01/points/SpaceTemp"], data: { msgText: "Space temp high" } },
  { uuid: "a-2", timestamp: Date.now() - 3600000, priority: 150, alarmClass: "default", sourceState: "normal", ackState: "unacked", sources: ["slot:/Drivers/Net/VAV_01/points/DamperPos"], data: { msgText: "Damper stuck" } }
];

export async function startFakeStation() {
  const sessions = new Set();
  const scram = new Map();
  const state = { sockets: new Set(), groups: new Map(), logins: 0, requests: [] };
  const salted = crypto.pbkdf2Sync(PASSWORD, SALT, ITERATIONS, 32, "sha256");
  const hmac = (key, text) => crypto.createHmac("sha256", key).update(text).digest();

  const cookieOf = (req) => /JSESSIONID=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  const loggedIn = (req) => sessions.has(cookieOf(req));

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    let sid = cookieOf(req);
    if (!sid) {
      sid = crypto.randomUUID();
      res.setHeader("Set-Cookie", `JSESSIONID=${sid}; Path=/; HttpOnly`);
    }
    if (req.url === "/stream/health") {
      if (!sessions.has(sid)) return void res.writeHead(302, { Location: "/prelogin" }).end();
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, apiVersion: "1.7" }));
    }
    if (req.url === "/stream/metrics") {
      if (!sessions.has(sid)) return void res.writeHead(302).end();
      return void res.writeHead(200).end("baskstream_requests_total 3\n# EOF\n");
    }
    if (req.url === "/prelogin") return void res.writeHead(200).end("<html>login</html>");
    if (req.url === "/login") return void res.writeHead(200).end('<form action="j_security_check">');
    if (req.url === "/j_security_check/" && req.method === "GET") {
      if (scram.get(sid)?.done) sessions.add(sid);
      return void res.writeHead(200).end("ok");
    }
    if (req.url === "/j_security_check/") {
      const params = new URLSearchParams(body.replace(/\+/g, "%2B"));
      if (params.get("action") === "sendClientFirstMessage") {
        const bare = params.get("clientFirstMessage").slice(3);
        const clientNonce = /r=([^,]+)/.exec(bare)[1];
        const serverFirst = `r=${clientNonce}${crypto.randomBytes(12).toString("base64")},s=${SALT.toString("base64")},i=${ITERATIONS}`;
        scram.set(sid, { bare, serverFirst });
        return void res.writeHead(200).end(serverFirst);
      }
      const pending = scram.get(sid);
      const final = params.get("clientFinalMessage");
      const withoutProof = final.slice(0, final.lastIndexOf(",p="));
      const proof = Buffer.from(final.slice(final.lastIndexOf(",p=") + 3), "base64");
      const auth = `${pending.bare},${pending.serverFirst},${withoutProof}`;
      const clientKey = hmac(salted, "Client Key");
      const expected = Buffer.alloc(32);
      const signature = hmac(crypto.createHash("sha256").update(clientKey).digest(), auth);
      for (let i = 0; i < 32; i += 1) expected[i] = clientKey[i] ^ signature[i];
      if (!proof.equals(expected)) return void res.writeHead(403).end("e=invalid-proof");
      pending.done = true;
      state.logins += 1;
      return void res.writeHead(200).end(`v=${hmac(hmac(salted, "Server Key"), auth).toString("base64")}`);
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/stream" || !loggedIn(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.sockets.add(ws);
      ws.on("close", () => state.sockets.delete(ws));
      ws.on("message", (data) => handle(ws, decode(data)));
    });
  });

  const value = (point) => ({ point, ok: true, valueType: "numeric", value: 72.5, status: "{ok}", timestamp: Date.now() });
  const send = (ws, frame) => ws.send(encode(frame));

  function handle(ws, request) {
    state.requests.push(request);
    const { op, id } = request;
    switch (op) {
      case "ping":
        return send(ws, { op: "pong", id });
      case "capabilities":
        return send(ws, { op: "capabilities_result", id, capabilities: { apiVersion: "1.7", limits: { heartbeatIntervalSec: 30 } } });
      case "read":
        return send(ws, { op: "read_result", id, points: request.points.map(value) });
      case "replace_subscriptions":
        state.groups.set(request.group, request.points);
        return send(ws, { op: "subscriptions_replaced", id, group: request.group, points: request.points, leaseSec: request.leaseSec });
      case "renew_subscriptions":
        if (!state.groups.has(request.group)) return send(ws, { op: "error", id, code: "group_not_found", message: "Subscription group not found." });
        return send(ws, { op: "subscriptions_renewed", id, group: request.group });
      case "release_subscriptions":
        state.groups.delete(request.group);
        return send(ws, { op: "subscriptions_released", id, group: request.group });
      case "write":
        return send(ws, { op: "error", id, code: "writes_disabled", message: "Writes are disabled on this service." });
      case "browse": {
        const base = request.base ?? "slot:/";
        return send(ws, { op: "browse_result", id, node: { ...TREE[base], ord: base, children: (TREE[base]?.children ?? []).map((ord) => ({ ...TREE[ord], ord, children: undefined })) } });
      }
      case "search":
        return send(ws, { op: "search_result", id, result: { count: 1, nodes: [{ ...TREE["slot:/Drivers/Net/VAV_01/points/SpaceTemp"], ord: "slot:/Drivers/Net/VAV_01/points/SpaceTemp" }] } });
      case "read_alarms":
      case "subscribe_alarms":
        return send(ws, { op: op === "read_alarms" ? "alarms_result" : "alarms_subscribed", id, alarms: { count: ALARMS.length, alarms: ALARMS } });
      case "ack_alarms":
        return send(ws, { op: "alarm_action_result", id, alarms: { action: "ack", matched: (request.uuids ?? []).length, count: (request.uuids ?? []).length, dryRun: request.dryRun, alarms: (request.uuids ?? []).map((uuid) => ({ uuid, ok: true })) } });
      case "read_history_rollup": {
        const buckets = [];
        for (let t = request.start; t < request.end; t += request.interval) {
          const v = 70 + 3 * Math.sin((t / 3600000) * 0.5);
          buckets.push({ start: t, count: 4, min: v - 0.5, max: v + 0.5, sum: v * 4, avg: v, first: v, last: v });
        }
        return send(ws, { op: "history_rollup_result", id, rollup: { interval: request.interval, histories: [{ historyId: "/Station/SpaceTemp", buckets, bucketCount: buckets.length, truncated: false }] } });
      }
      case "subscription_status":
        return send(ws, { op: "subscription_status_result", id, session: { pointSubscriptions: 2, subscriptionGroups: state.groups.size }, limits: {}, groups: [] });
      case "slow":
        return; // never replies
      default:
        return send(ws, { op: "error", id, code: "unsupported_op", message: `Unsupported op: ${op}` });
    }
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    /** Pushes a server-initiated frame to every open socket. */
    push(frame) {
      for (const ws of state.sockets) send(ws, frame);
    },
    /** Drops every socket, as a station restart would. */
    dropAll({ forgetGroups = true } = {}) {
      if (forgetGroups) state.groups.clear();
      for (const ws of state.sockets) ws.terminate();
    },
    expireSessions() {
      sessions.clear();
    },
    async close() {
      for (const ws of state.sockets) ws.terminate();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
