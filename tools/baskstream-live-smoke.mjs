#!/usr/bin/env node

import crypto from "node:crypto";
import https from "node:https";
import tls from "node:tls";

const stationUrl = new URL(process.env.NIAGARA_URL || "https://192.168.0.125");
const host = stationUrl.hostname;
const port = Number(stationUrl.port || 443);
const username = process.env.NIAGARA_USER || "admin";
const password = process.env.NIAGARA_PASSWORD || process.env.STREAM_PASSWORD;
const pointBase = process.env.STREAM_POINT_BASE || "slot:/Drivers/LonNetwork/Floor1/AHU_01/points";
const points = {
  numeric: process.env.STREAM_NUMERIC_POINT || `${pointBase}/TestPoint`,
  bool: process.env.STREAM_BOOL_POINT || `${pointBase}/TestBool`,
  enum: process.env.STREAM_ENUM_POINT || `${pointBase}/TestEnum`,
  string: process.env.STREAM_STRING_POINT || `${pointBase}/TestString`
};
const scheduleOrd = process.env.STREAM_SCHEDULE_ORD || "slot:/Schedules/BooleanSchedule";
const historyOrd = process.env.STREAM_HISTORY_ORD || "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/SpaceTemp";

if (!password) {
  throw new Error("Set NIAGARA_PASSWORD or STREAM_PASSWORD before running the live smoke test.");
}

const cookies = new Map();
let nextId = 0;
const started = Date.now();

function line(label, value) {
  const suffix = value === undefined ? "" : ` ${JSON.stringify(value, null, 2)}`;
  console.log(`[${new Date().toISOString()}] ${label}${suffix}`);
}

function cookieHeader() {
  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function storeCookies(headers) {
  for (const raw of headers["set-cookie"] || []) {
    const pair = raw.split(";")[0];
    const index = pair.indexOf("=");
    if (index > 0) {
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
}

function request(method, path, body = "", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host,
      port,
      method,
      path,
      rejectUnauthorized: false,
      headers: {
        Host: host,
        Cookie: cookieHeader(),
        ...headers,
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {})
      }
    }, (res) => {
      storeCookies(res.headers);
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function parseScram(value) {
  const out = {};
  for (const part of value.split(",")) {
    const index = part.indexOf("=");
    if (index > 0) {
      out[part.slice(0, index)] = part.slice(index + 1);
    }
  }
  return out;
}

function prepUsername(value) {
  return String(value).normalize("NFKC").replace(/=/g, "=3D").replace(/,/g, "=2C");
}

function hmac(key, text) {
  return crypto.createHmac("sha256", key).update(text, "utf8").digest();
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest();
}

function xor(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] ^ b[i];
  }
  return out;
}

async function login() {
  await request("GET", "/prelogin");
  const userStep = await request(
    "POST",
    "/login",
    `j_username=${encodeURIComponent(username)}`,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  if (userStep.status !== 200 || !userStep.body.includes("j_security_check")) {
    throw new Error(`Username step failed with HTTP ${userStep.status}.`);
  }

  const nonce = crypto.randomBytes(16).toString("base64");
  const clientFirstBare = `n=${prepUsername(username)},r=${nonce}`;
  const serverFirstResponse = await request(
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
    throw new Error(`Invalid SCRAM server first message: ${serverFirst}`);
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

  const finalResponse = await request(
    "POST",
    "/j_security_check/",
    `action=sendClientFinalMessage&clientFinalMessage=${clientFinalNoProof},p=${proof}`,
    { "Content-Type": "application/x-niagara-login-support" }
  );
  if (finalResponse.status !== 200) {
    throw new Error(`SCRAM final message failed with HTTP ${finalResponse.status}.`);
  }

  await request("GET", "/j_security_check/");
  const health = await request("GET", "/stream/health");
  if (health.status !== 200) {
    throw new Error(`Health check failed after login with HTTP ${health.status}.`);
  }
  return JSON.parse(health.body);
}

const decoder = new TextDecoder();
const bytes = (...values) => Buffer.from(values);
const join = (parts) => Buffer.concat(parts.map((part) => Buffer.from(part)));

function encodeMsgpack(value) {
  if (value == null) {
    return bytes(0xc0);
  }
  if (typeof value === "boolean") {
    return bytes(value ? 0xc3 : 0xc2);
  }
  if (typeof value === "string") {
    const encoded = Buffer.from(value, "utf8");
    if (encoded.length <= 31) {
      return join([bytes(0xa0 | encoded.length), encoded]);
    }
    if (encoded.length <= 255) {
      return join([bytes(0xd9, encoded.length), encoded]);
    }
    return join([bytes(0xda, encoded.length >> 8, encoded.length & 255), encoded]);
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      if (value >= 0 && value <= 127) {
        return bytes(value);
      }
      if (value >= -32 && value < 0) {
        return bytes(256 + value);
      }
      if (value >= -128 && value <= 127) {
        return bytes(0xd0, value & 255);
      }
      if (value >= -32768 && value <= 32767) {
        return bytes(0xd1, (value >> 8) & 255, value & 255);
      }
      if (value >= -2147483648 && value <= 2147483647) {
        return bytes(0xd2, (value >> 24) & 255, (value >> 16) & 255, (value >> 8) & 255, value & 255);
      }
      const out = Buffer.alloc(9);
      out[0] = 0xd3;
      out.writeBigInt64BE(BigInt(value), 1);
      return out;
    }
    const out = Buffer.alloc(9);
    out[0] = 0xcb;
    out.writeDoubleBE(value, 1);
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length <= 15) {
      return join([bytes(0x90 | value.length), ...value.map(encodeMsgpack)]);
    }
    return join([bytes(0xdc, value.length >> 8, value.length & 255), ...value.map(encodeMsgpack)]);
  }
  const entries = Object.entries(value);
  const body = [];
  for (const [key, item] of entries) {
    body.push(encodeMsgpack(key), encodeMsgpack(item));
  }
  if (entries.length <= 15) {
    return join([bytes(0x80 | entries.length), ...body]);
  }
  return join([bytes(0xde, entries.length >> 8, entries.length & 255), ...body]);
}

function decodeMsgpack(buffer) {
  let offset = 0;
  const take = (length) => {
    const out = buffer.subarray(offset, offset + length);
    offset += length;
    return out;
  };
  const read = () => {
    const tag = buffer[offset++];
    if (tag <= 0x7f) return tag;
    if (tag >= 0xe0) return tag - 256;
    if ((tag & 0xe0) === 0xa0) return decoder.decode(take(tag & 31));
    if ((tag & 0xf0) === 0x90) return Array.from({ length: tag & 15 }, read);
    if ((tag & 0xf0) === 0x80) {
      const out = {};
      for (let i = 0; i < (tag & 15); i++) out[read()] = read();
      return out;
    }
    switch (tag) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xca: { const out = buffer.readFloatBE(offset); offset += 4; return out; }
      case 0xcb: { const out = buffer.readDoubleBE(offset); offset += 8; return out; }
      case 0xcc: return buffer[offset++];
      case 0xcd: { const out = buffer.readUInt16BE(offset); offset += 2; return out; }
      case 0xce: { const out = buffer.readUInt32BE(offset); offset += 4; return out; }
      case 0xcf: { const out = Number(buffer.readBigUInt64BE(offset)); offset += 8; return out; }
      case 0xd0: { const out = buffer.readInt8(offset); offset += 1; return out; }
      case 0xd1: { const out = buffer.readInt16BE(offset); offset += 2; return out; }
      case 0xd2: { const out = buffer.readInt32BE(offset); offset += 4; return out; }
      case 0xd3: { const out = Number(buffer.readBigInt64BE(offset)); offset += 8; return out; }
      case 0xd9: { const length = buffer[offset++]; return decoder.decode(take(length)); }
      case 0xda: { const length = buffer.readUInt16BE(offset); offset += 2; return decoder.decode(take(length)); }
      case 0xdb: { const length = buffer.readUInt32BE(offset); offset += 4; return decoder.decode(take(length)); }
      case 0xdc: { const length = buffer.readUInt16BE(offset); offset += 2; return Array.from({ length }, read); }
      case 0xdd: { const length = buffer.readUInt32BE(offset); offset += 4; return Array.from({ length }, read); }
      case 0xde: {
        const length = buffer.readUInt16BE(offset);
        offset += 2;
        const out = {};
        for (let i = 0; i < length; i++) out[read()] = read();
        return out;
      }
      case 0xdf: {
        const length = buffer.readUInt32BE(offset);
        offset += 4;
        const out = {};
        for (let i = 0; i < length; i++) out[read()] = read();
        return out;
      }
      default:
        throw new Error(`Unsupported MessagePack byte 0x${tag.toString(16)}.`);
    }
  };
  return read();
}

function websocketFrame(payload, opcode = 2) {
  const length = payload.length;
  let head;
  if (length < 126) {
    head = bytes(0x80 | opcode, 0x80 | length);
  }
  else if (length <= 65535) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(length, 2);
  }
  else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = crypto.randomBytes(4);
  const body = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    body[i] = payload[i] ^ mask[i % 4];
  }
  return Buffer.concat([head, mask, body]);
}

function parseFrames(state, onMessage) {
  while (state.buffer.length >= 2) {
    const opcode = state.buffer[0] & 15;
    let length = state.buffer[1] & 127;
    let offset = 2;
    if (length === 126) {
      if (state.buffer.length < 4) return;
      length = state.buffer.readUInt16BE(2);
      offset = 4;
    }
    else if (length === 127) {
      if (state.buffer.length < 10) return;
      length = Number(state.buffer.readBigUInt64BE(2));
      offset = 10;
    }

    const masked = Boolean(state.buffer[1] & 128);
    let mask = null;
    if (masked) {
      if (state.buffer.length < offset + 4) return;
      mask = state.buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (state.buffer.length < offset + length) return;

    const payload = Buffer.from(state.buffer.subarray(offset, offset + length));
    state.buffer = state.buffer.subarray(offset + length);
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    if (opcode === 2) {
      onMessage(payload);
    }
    else if (opcode === 8) {
      throw new Error("WebSocket closed by server.");
    }
    else if (opcode === 9) {
      state.socket.write(websocketFrame(payload, 10));
    }
  }
}

function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      socket.write(
        "GET /stream HTTP/1.1\r\n" +
        `Host: ${host}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n" +
        `Cookie: ${cookieHeader()}\r\n` +
        `Origin: ${stationUrl.origin}\r\n` +
        "\r\n"
      );
    });
    socket.on("error", reject);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf("\r\n\r\n");
      if (index < 0) return;
      const head = buffer.subarray(0, index).toString("utf8");
      if (!head.includes(" 101 ")) {
        reject(new Error(`WebSocket upgrade failed:\n${head}`));
        return;
      }
      socket.removeAllListeners("data");
      resolve({ socket, initial: buffer.subarray(index + 4) });
    });
  });
}

async function openClient() {
  const ws = await connectWebSocket();
  return new BaskStreamClient(ws.socket, ws.initial);
}

class BaskStreamClient {
  constructor(socket, initial) {
    this.socket = socket;
    this.state = { socket, buffer: initial };
    this.pending = new Map();
    this.cov = [];
    this.alarmCov = [];
    this.modelCov = [];
    socket.on("data", (chunk) => {
      this.state.buffer = Buffer.concat([this.state.buffer, chunk]);
      parseFrames(this.state, (payload) => this.onMessage(decodeMsgpack(payload)));
    });
    parseFrames(this.state, (payload) => this.onMessage(decodeMsgpack(payload)));
  }

  onMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      pending.resolve(message);
      return;
    }
    if (message.op === "cov") {
      this.cov.push(message);
    }
    if (message.op === "alarm_cov") {
      this.alarmCov.push(message);
    }
    if (message.op === "model_cov") {
      this.modelCov.push(message);
    }
  }

  send(op, fields = {}, timeoutMillis = 12000) {
    const id = String(++nextId);
    this.socket.write(websocketFrame(encodeMsgpack({ op, id, ...fields })));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} timed out.`));
      }, timeoutMillis);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
  }

  fire(op, fields = {}) {
    this.socket.write(websocketFrame(encodeMsgpack({ op, ...fields })));
  }

  close() {
    this.socket.end();
  }
}

function testValueFor(snapshot, kind, suffix = "") {
  if (kind === "numeric") {
    return Number(snapshot.value || 0) + 1;
  }
  if (kind === "bool") {
    if (typeof snapshot.value === "boolean") {
      return !snapshot.value;
    }
    return String(snapshot.value).toLowerCase() !== "true";
  }
  if (kind === "string") {
    return `baskStream live smoke ${Date.now()}${suffix}`;
  }
  throw new Error(`No test value strategy for ${kind}.`);
}

function equivalent(actual, expected) {
  if (typeof expected === "number") {
    return Math.abs(Number(actual) - expected) < 0.000001;
  }
  return String(actual) === String(expected);
}

function summarizePoint(point) {
  if (!point) {
    return null;
  }
  return {
    point: point.point,
    ok: point.ok,
    valueType: point.valueType,
    value: point.value,
    displayValue: point.displayValue,
    status: point.status,
    facets: point.facets,
    enumOrdinal: point.enumOrdinal,
    enumTag: point.enumTag,
    enumOptions: point.enumOptions,
    action: point.action,
    activeLevel: point.activeLevel,
    code: point.code,
    message: point.message
  };
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function assertNodeStatus(node, label) {
  if (!isObject(node)) {
    throw new Error(`${label} missing node object.`);
  }
  if (!hasOwn(node, "status")) {
    throw new Error(`${label} missing status.`);
  }
  if (!hasOwn(node, "ok")) {
    throw new Error(`${label} missing ok.`);
  }
}

function assertNodeMetadata(node, label, options = {}) {
  if (options.expectStatus) {
    assertNodeStatus(node, label);
  }

  const metadata = node?.metadata;
  if (!isObject(metadata)) {
    throw new Error(`${label} missing metadata object.`);
  }
  if (!isObject(metadata.classification)) {
    throw new Error(`${label} missing metadata.classification.`);
  }
  if (!isObject(metadata.parent)) {
    throw new Error(`${label} missing metadata.parent object.`);
  }
  if (!Array.isArray(metadata.ancestors)) {
    throw new Error(`${label} missing metadata.ancestors array.`);
  }
  if (!isObject(metadata.driver)) {
    throw new Error(`${label} missing metadata.driver object.`);
  }
  if (!isObject(metadata.point)) {
    throw new Error(`${label} missing metadata.point object.`);
  }
  if (!Array.isArray(metadata.tags)) {
    throw new Error(`${label} missing metadata.tags array.`);
  }
  if (!Array.isArray(metadata.relations)) {
    throw new Error(`${label} missing metadata.relations array.`);
  }

  if (options.expectParent && !metadata.parent.slotPath) {
    throw new Error(`${label} missing parent slotPath.`);
  }
  if (options.expectParent) {
    if (!isObject(metadata.parent)) {
      throw new Error(`${label} parent missing summary.`);
    }
  }
  if (options.expectDistinctParent && node?.slotPath && metadata.parent.slotPath === node.slotPath) {
    throw new Error(`${label} parent slotPath matched the node slotPath.`);
  }
  if (options.expectPoint && metadata.classification.isPoint !== true) {
    throw new Error(`${label} was not classified as a point.`);
  }
  if (options.expectControlPoint && metadata.classification.isControlPoint !== true) {
    throw new Error(`${label} was not classified as a control point.`);
  }
  if (options.expectWritable && metadata.classification.isWritablePoint !== true) {
    throw new Error(`${label} was not classified as a writable point.`);
  }
  if (options.expectPointMetadata && metadata.point.recognizedAsPoint !== true) {
    throw new Error(`${label} missing point metadata recognition.`);
  }
  if (options.expectWritable && metadata.point.writable !== true) {
    throw new Error(`${label} point metadata is not writable.`);
  }

  for (const key of ["network", "device"]) {
    const summary = metadata.driver[key];
    if (isObject(summary) && summary.slotPath) {
      assertNodeStatus(summary, `${label} driver.${key}`);
    }
  }
  for (const key of ["pointDeviceExt", "proxyExt"]) {
    const summary = metadata.driver[key];
    if (isObject(summary) && hasOwn(summary, "status")) {
      assertNodeStatus(summary, `${label} driver.${key}`);
    }
  }

  return metadata;
}

function summarizeMetadata(metadata) {
  if (!metadata) {
    return null;
  }
  const classification = metadata.classification || {};
  return {
    isControlPoint: classification.isControlPoint,
    isWritablePoint: classification.isWritablePoint,
    isProxyPoint: classification.isProxyPoint,
    isDriverDevice: classification.isDriverDevice,
    equipmentCertainty: classification.equipmentCertainty,
    parentStatus: metadata.parent?.status || null,
    parentOk: hasOwn(metadata.parent, "ok") ? metadata.parent.ok : null,
    parent: metadata.parent?.slotPath || null,
    ancestorCount: Array.isArray(metadata.ancestors) ? metadata.ancestors.length : null,
    driverBacked: metadata.driver?.isDriverBacked,
    network: metadata.driver?.network?.slotPath || null,
    networkStatus: metadata.driver?.network?.status || null,
    device: metadata.driver?.device?.slotPath || null,
    deviceStatus: metadata.driver?.device?.status || null,
    pointDeviceExt: metadata.driver?.pointDeviceExt?.slotPath || null,
    proxyExt: metadata.driver?.proxyExt?.slotPath || null,
    pointExtensions: Array.isArray(metadata.point?.extensions) ? metadata.point.extensions.length : null,
    tags: Array.isArray(metadata.tags) ? metadata.tags.length : null,
    relations: Array.isArray(metadata.relations) ? metadata.relations.length : null
  };
}

async function readOne(client, point) {
  const response = await client.send("read", { points: [point] });
  return response.points?.[0];
}

async function writeOne(client, point, action, value, extra = {}) {
  const body = { point, action, ...extra };
  if (value !== undefined) body.value = value;
  const response = await client.send("write", body, 16000);
  const result = response.points?.[0];
  if (!result || result.ok === false && result.code) {
    throw new Error(result?.message || `Write ${action} failed for ${point}.`);
  }
  return result;
}

function fallbackOrd(point) {
  return `${point}/fallback`;
}

function activeLevelFromStatus(snapshot) {
  const match = String(snapshot?.status || "").match(/@\s*([^}\s]+)/);
  return match ? match[1] : null;
}

function priorityNumber(level) {
  const parsed = Number.parseInt(String(level || ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readFallback(client, point) {
  try {
    return await readOne(client, fallbackOrd(point));
  }
  catch {
    return null;
  }
}

async function waitForCov(client, point, priorCount, timeoutMillis = 6000) {
  const end = Date.now() + timeoutMillis;
  while (Date.now() < end) {
    for (let i = priorCount; i < client.cov.length; i++) {
      const event = client.cov[i];
      if ((event.points || []).some((item) => item.point === point)) {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function testSetWrite(client, name, point, kind, original) {
  const value = testValueFor(original, kind);
  const originalFallback = await readFallback(client, point);
  const restoreValue = originalFallback?.value ?? original.value;
  const beforeCov = client.cov.length;
  let written;
  let after;
  let afterFallback;
  let cov = false;
  try {
    written = await writeOne(client, point, "set", value);
    after = await readOne(client, point);
    afterFallback = await readFallback(client, point);
    cov = await waitForCov(client, point, beforeCov);
    const outputMatched = equivalent(after.value, value);
    const fallbackMatched = afterFallback && equivalent(afterFallback.value, value);
    if (!outputMatched && !fallbackMatched) {
      throw new Error(`${name} set readback mismatch: expected ${value}, got output ${after.value} and fallback ${afterFallback?.value}.`);
    }
  }
  finally {
    await writeOne(client, point, "set", restoreValue);
  }
  const restored = await readOne(client, point);
  const restoredFallback = await readFallback(client, point);
  if (restoredFallback && !equivalent(restoredFallback.value, restoreValue)) {
    throw new Error(`${name} fallback restore mismatch: expected ${restoreValue}, got ${restoredFallback.value}.`);
  }
  return {
    written: summarizePoint(written),
    after: summarizePoint(after),
    afterFallback: summarizePoint(afterFallback),
    restored: summarizePoint(restored),
    restoredFallback: summarizePoint(restoredFallback),
    cov
  };
}

async function testOverrideAuto(client, name, point, kind, original) {
  const value = testValueFor(original, kind, " override");
  const originalFallback = await readFallback(client, point);
  const restoreValue = originalFallback?.value ?? original.value;
  const activePriority = priorityNumber(activeLevelFromStatus(original));
  const higherPriorityActive = activePriority != null && activePriority < 8;
  let overridden;
  let auto;
  let afterAuto;
  let afterOverride;
  try {
    overridden = await writeOne(client, point, "override", value, { durationSec: 60 });
    afterOverride = await readOne(client, point);
    if (!higherPriorityActive && !equivalent(afterOverride.value, value)) {
      throw new Error(`${name} override readback mismatch: expected ${value}, got ${afterOverride.value}.`);
    }
    auto = await writeOne(client, point, "auto");
    afterAuto = await readOne(client, point);
  }
  finally {
    try {
      await writeOne(client, point, "auto");
    }
    catch {
      // Continue to restore fallback below.
    }
    await writeOne(client, point, "set", restoreValue);
  }
  const restored = await readOne(client, point);
  const restoredFallback = await readFallback(client, point);
  if (restoredFallback && !equivalent(restoredFallback.value, restoreValue)) {
    throw new Error(`${name} fallback restore after auto mismatch: expected ${restoreValue}, got ${restoredFallback.value}.`);
  }
  return {
    override: summarizePoint(overridden),
    afterOverride: summarizePoint(afterOverride),
    auto: summarizePoint(auto),
    afterAuto: summarizePoint(afterAuto),
    restored: summarizePoint(restored),
    restoredFallback: summarizePoint(restoredFallback),
    higherPriorityActive
  };
}

async function discoverEnumAlternate(client, point, original) {
  const candidates = [];
  const current = String(original.value);
  for (const value of [0, 1, 2, 3, "active", "inactive", "on", "off", "true", "false"]) {
    if (String(value) !== current) candidates.push(value);
  }
  for (const candidate of candidates) {
    try {
      const written = await writeOne(client, point, "set", candidate);
      const after = await readOne(client, point);
      if (!equivalent(after.value, original.value)) {
        await writeOne(client, point, "set", original.value);
        return { candidate, written: summarizePoint(written), after: summarizePoint(after) };
      }
    }
    catch {
      try {
        await writeOne(client, point, "set", original.value);
      }
      catch {
        // The final restore in main will report failure if needed.
      }
      // Try the next common enum representation.
    }
  }
  throw new Error("Could not discover a valid alternate enum value from common tags/ordinals.");
}

async function main() {
  const health = await login();
  line("health", health);

  const client = await openClient();
  const results = [];
  const pass = (name, details = {}) => results.push({ name, ok: true, ...details });
  const fail = (name, error) => results.push({ name, ok: false, error: error.message || String(error) });

  try {
    const ping = await client.send("ping");
    pass("ping", { op: ping.op });
  }
  catch (error) {
    fail("ping", error);
  }

  try {
    const capabilities = await client.send("capabilities");
    const ops = capabilities.capabilities?.operations || [];
    for (const op of [
      "search",
      "describe_write",
      "describe_history",
      "ack_alarm",
      "clear_alarm",
      "replace_subscriptions",
      "renew_subscriptions",
      "release_subscriptions",
      "subscription_status",
      "subscribe_model"
    ]) {
      if (!ops.includes(op)) {
        throw new Error(`Capabilities missing ${op}.`);
      }
    }
    const limits = capabilities.capabilities?.limits || {};
    for (const key of ["maxPointSnapshotPoints", "maxBrowseDepth", "defaultSearchDepth", "maxSearchDepth", "maxSearchLimit", "defaultSearchMaxVisited", "defaultSearchTimeoutMillis"]) {
      if (typeof limits[key] !== "number") {
        throw new Error(`Capabilities missing numeric limit ${key}.`);
      }
    }
    const pointSnapshot = capabilities.capabilities?.pointSnapshot || {};
    if (pointSnapshot.operation !== "read" || pointSnapshot.fieldSelection !== true || pointSnapshot.facets !== true) {
      throw new Error("Capabilities missing point snapshot field/facet support.");
    }
    if (!Array.isArray(pointSnapshot.fields) || !pointSnapshot.fields.includes("facets") || !pointSnapshot.fields.includes("type")) {
      throw new Error("Capabilities missing supported point snapshot fields.");
    }
    const graphics = capabilities.capabilities?.graphics || {};
    if (graphics.plainPx !== false) {
      throw new Error("Capabilities should report plainPx=false until plain graphics are implemented.");
    }
    pass("capabilities", {
      apiVersion: capabilities.capabilities?.apiVersion,
      maxPointSnapshotPoints: limits.maxPointSnapshotPoints,
      maxSubscriptions: limits.maxSubscriptionsPerClient,
      defaultSearchDepth: limits.defaultSearchDepth,
      maxSearchLimit: limits.maxSearchLimit,
      pointSnapshotFields: pointSnapshot.fields.length,
      plainPx: graphics.plainPx
    });
  }
  catch (error) {
    fail("capabilities", error);
  }

  try {
    const browse = await client.send("browse", { base: pointBase, depth: 1 });
    const children = Array.isArray(browse.node?.children) ? browse.node.children : [];
    if (browse.metadata !== "none") {
      throw new Error(`Default browse metadata mode was ${browse.metadata}, expected none.`);
    }
    if (hasOwn(browse.node, "metadata")) {
      throw new Error("Default browse unexpectedly included root metadata.");
    }
    if (children.some((child) => hasOwn(child, "metadata"))) {
      throw new Error("Default browse unexpectedly included child metadata.");
    }
    pass("browse points lean", {
      slotPath: browse.node?.slotPath,
      children: children.length,
      metadata: browse.metadata
    });
  }
  catch (error) {
    fail("browse points lean", error);
  }

  try {
    const browse = await client.send("browse", { base: pointBase, depth: 1, metadata: "full" });
    const metadata = assertNodeMetadata(browse.node, "browse points root", {
      expectParent: true,
      expectDistinctParent: true
    });
    const children = Array.isArray(browse.node?.children) ? browse.node.children : [];
    const childrenWithMetadata = children.filter((child) => {
      try {
        assertNodeMetadata(child, `browse child ${child?.ord || child?.name || "unknown"}`);
        return true;
      }
      catch {
        return false;
      }
    }).length;
    if (children.length > 0 && childrenWithMetadata === 0) {
      throw new Error("browse returned children but none included metadata.");
    }
    pass("browse points", {
      slotPath: browse.node?.slotPath,
      children: children.length,
      childrenWithMetadata,
      metadataMode: browse.metadata,
      metadata: summarizeMetadata(metadata)
    });
  }
  catch (error) {
    fail("browse points", error);
  }

  try {
    const search = await client.send("search", {
      base: pointBase,
      features: ["point"],
      operations: ["read"],
      limit: 20
    });
    const nodes = search.result?.nodes || [];
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new Error("Search returned no readable point nodes.");
    }
    pass("search points", { count: search.result?.count, truncated: search.result?.truncated });
  }
  catch (error) {
    fail("search points", error);
  }

  try {
    const search = await client.send("search", {
      base: "slot:/",
      query: "TestPoint",
      features: ["point"],
      operations: ["read"],
      metadata: "none",
      limit: 50
    });
    const nodes = search.result?.nodes || [];
    const numeric = nodes.find((node) => node.slotPath === points.numeric);
    if (!numeric) {
      throw new Error(`Root search did not find ${points.numeric}.`);
    }
    assertNodeStatus(numeric, "search root deep point");
    pass("search root deep point", {
      count: search.result?.count,
      visited: search.result?.visited,
      truncated: search.result?.truncated,
      reasons: search.result?.truncatedReasons
    });
  }
  catch (error) {
    fail("search root deep point", error);
  }

  try {
    const search = await client.send("search", {
      base: "slot:/",
      query: "TestPoint",
      features: ["point"],
      operations: ["write"],
      writable: true,
      limit: 50
    });
    const nodes = search.result?.nodes || [];
    const numeric = nodes.find((node) => node.slotPath === points.numeric);
    if (!numeric) {
      throw new Error(`Writable root search did not find ${points.numeric}.`);
    }
    if (!numeric.features?.includes("point") || !numeric.operations?.includes("write") || numeric.writable !== true) {
      throw new Error("Writable root search returned numeric point without point/write/writable markers.");
    }
    assertNodeStatus(numeric, "search root writable point");
    pass("search root writable point", {
      count: search.result?.count,
      truncated: search.result?.truncated
    });
  }
  catch (error) {
    fail("search root writable point", error);
  }

  try {
    const search = await client.send("search", {
      base: "slot:/",
      features: ["point"],
      limit: 1
    });
    if (search.result?.count !== 1 || search.result?.truncated !== true) {
      throw new Error("Search limit=1 did not report a single truncated result.");
    }
    if (!Array.isArray(search.result?.truncatedReasons) || !search.result.truncatedReasons.includes("limit")) {
      throw new Error("Search truncation did not include limit reason.");
    }
    pass("search truncation", {
      count: search.result.count,
      reasons: search.result.truncatedReasons
    });
  }
  catch (error) {
    fail("search truncation", error);
  }

  const snapshots = {};
  try {
    const describe = await client.send("describe", { ord: points.numeric, metadata: false });
    if (describe.metadata !== "none") {
      throw new Error(`Describe metadata false returned mode ${describe.metadata}, expected none.`);
    }
    if (hasOwn(describe.node, "metadata")) {
      throw new Error("Describe metadata false unexpectedly included node metadata.");
    }
    assertNodeStatus(describe.node, "describe metadata none");
    pass("describe metadata none", {
      slotPath: describe.node?.slotPath,
      metadata: describe.metadata
    });
  }
  catch (error) {
    fail("describe metadata none", error);
  }

  for (const [name, point] of Object.entries(points)) {
    try {
      const describe = await client.send("describe", { ord: point });
      const metadata = assertNodeMetadata(describe.node, `describe ${name}`, {
        expectParent: true,
        expectDistinctParent: true,
        expectPoint: true,
        expectControlPoint: true,
        expectWritable: true,
        expectPointMetadata: true,
        expectStatus: true
      });
      const read = await readOne(client, point);
      if (!isObject(read?.facets)) {
        throw new Error(`Read snapshot for ${name} missing facets object.`);
      }
      const details = {
        slotPath: describe.node?.slotPath,
        type: describe.node?.typeSpec,
        writable: describe.node?.writable,
        metadata: summarizeMetadata(metadata),
        value: summarizePoint(read)
      };
      if (name === "enum") {
        const describedOptions = describe.node?.enum?.options;
        details.enumDescribeOptions = Array.isArray(describedOptions) ? describedOptions.length : null;
        details.enumReadOptions = Array.isArray(read?.enumOptions) ? read.enumOptions.length : null;
        details.enumMetadataOk = details.enumDescribeOptions > 0 && details.enumReadOptions > 0 &&
          read.enumTag != null && read.enumOrdinal != null;
        if (!details.enumMetadataOk) {
          throw new Error(`Enum metadata missing: describe options=${details.enumDescribeOptions}, read options=${details.enumReadOptions}.`);
        }
      }
      snapshots[name] = read;
      pass(`describe/read ${name}`, details);
    }
    catch (error) {
      fail(`describe/read ${name}`, error);
    }
  }

  try {
    const selected = await client.send("read", {
      points: [points.numeric],
      fields: ["value", "displayValue", "status", "facets", "timestamp", "type"]
    });
    const snapshot = selected.points?.[0];
    if (!snapshot || snapshot.code) {
      throw new Error("Field-selected read did not return a valid point snapshot.");
    }
    for (const key of ["point", "ok", "value", "displayValue", "status", "facets", "timestamp", "type"]) {
      if (!hasOwn(snapshot, key)) {
        throw new Error(`Field-selected read missing ${key}.`);
      }
    }
    for (const key of ["display", "valueType", "enumOptions"]) {
      if (hasOwn(snapshot, key)) {
        throw new Error(`Field-selected read unexpectedly included ${key}.`);
      }
    }
    pass("read field selection", { snapshot: summarizePoint(snapshot) });
  }
  catch (error) {
    fail("read field selection", error);
  }

  try {
    const writeDescription = await client.send("describe_write", { points: Object.values(points) });
    const described = Array.isArray(writeDescription.points) ? writeDescription.points : [];
    if (described.length !== Object.values(points).length) {
      throw new Error(`Expected ${Object.values(points).length} write descriptions, got ${described.length}.`);
    }
    if (described.some((entry) => entry.ok === false || entry.writable !== true || !Array.isArray(entry.actions))) {
      throw new Error("At least one write description was not writable or lacked actions.");
    }
    pass("describe write", {
      count: described.length,
      actionCounts: described.map((entry) => entry.actions.length)
    });
  }
  catch (error) {
    fail("describe write", error);
  }

  try {
    const group = `smoke-${Date.now()}`;
    const replaced = await client.send("replace_subscriptions", {
      group,
      points: [points.bool, points.string],
      leaseSec: 60
    });
    const groupPoints = Array.isArray(replaced.points) ? replaced.points : [];
    if (groupPoints.length !== 2 || groupPoints.some((entry) => entry.ok === false)) {
      throw new Error("Grouped replacement did not return current snapshots for both points.");
    }

    const renewed = await client.send("renew_subscriptions", { group, leaseSec: 120 });
    if (renewed.group !== group || renewed.pointCount !== 2) {
      throw new Error("Grouped renewal returned unexpected group status.");
    }

    const status = await client.send("subscription_status", { includePoints: true });
    const groups = status.groups || [];
    const statusGroup = groups.find((entry) => entry.group === group);
    if (!statusGroup || statusGroup.pointCount !== 2 || !Array.isArray(statusGroup.points)) {
      throw new Error("Subscription status did not include the grouped point lease.");
    }

    const released = await client.send("release_subscriptions", { group });
    if (released.group !== group) {
      throw new Error("Grouped release returned the wrong group.");
    }
    pass("subscription groups", {
      replaced: groupPoints.length,
      leaseSec: renewed.leaseSec,
      remainingGroups: released.subscriptionGroups
    });
  }
  catch (error) {
    fail("subscription groups", error);
  }

  let secondClient = null;
  let dualGroup = null;
  try {
    secondClient = await openClient();
    dualGroup = `dual-${Date.now()}`;
    const sharedPoints = [points.bool, points.string];
    const first = await client.send("replace_subscriptions", {
      group: dualGroup,
      points: sharedPoints,
      leaseSec: 60
    });
    const second = await secondClient.send("replace_subscriptions", {
      group: dualGroup,
      points: sharedPoints,
      leaseSec: 60
    });
    if ((first.points || []).length !== sharedPoints.length || (second.points || []).length !== sharedPoints.length) {
      throw new Error("Dual clients did not both receive initial grouped snapshots.");
    }

    secondClient.close();
    secondClient = null;
    await new Promise((resolve) => setTimeout(resolve, 500));

    const status = await client.send("subscription_status", { includePoints: true });
    const group = (status.groups || []).find((entry) => entry.group === dualGroup);
    if (!group || group.pointCount !== sharedPoints.length) {
      throw new Error("Closing second client removed or changed first client's group.");
    }
    const renewed = await client.send("renew_subscriptions", { group: dualGroup, leaseSec: 60 });
    if (renewed.pointCount !== sharedPoints.length) {
      throw new Error("First client's group could not be renewed after second client closed.");
    }
    await client.send("release_subscriptions", { group: dualGroup });
    dualGroup = null;
    pass("dual client subscription isolation", {
      points: sharedPoints.length,
      renewed: renewed.pointCount
    });
  }
  catch (error) {
    fail("dual client subscription isolation", error);
  }
  finally {
    if (dualGroup) {
      try {
        await client.send("release_subscriptions", { group: dualGroup });
      }
      catch {}
    }
    if (secondClient) {
      secondClient.close();
    }
  }

  try {
    await client.send("subscribe", { points: Object.values(points) });
    pass("subscribe writable points");
  }
  catch (error) {
    fail("subscribe writable points", error);
  }

  for (const [name, kind] of [["numeric", "numeric"], ["bool", "bool"], ["string", "string"]]) {
    if (!snapshots[name]) continue;
    try {
      pass(`write set ${name}`, await testSetWrite(client, name, points[name], kind, snapshots[name]));
    }
    catch (error) {
      fail(`write set ${name}`, error);
    }

    try {
      pass(`override/auto ${name}`, await testOverrideAuto(client, name, points[name], kind, snapshots[name]));
    }
    catch (error) {
      fail(`override/auto ${name}`, error);
    }
  }

  if (snapshots.enum) {
    try {
      const alternate = await discoverEnumAlternate(client, points.enum, snapshots.enum);
      pass("write set enum", alternate);
      await writeOne(client, points.enum, "set", snapshots.enum.value);
    }
    catch (error) {
      fail("write set enum", error);
    }
  }

  try {
    const historyDescription = await client.send("describe_history", { ord: historyOrd });
    pass("describe history", {
      histories: historyDescription.history?.histories?.length,
      count: historyDescription.history?.count
    });
  }
  catch (error) {
    fail("describe history", error);
  }

  try {
    const history = await client.send("read_history", {
      ord: historyOrd,
      start: Date.now() - 168 * 3600 * 1000,
      end: Date.now(),
      limit: 20
    });
    pass("read history", { histories: history.history?.histories?.length, count: history.history?.count });
  }
  catch (error) {
    fail("read history", error);
  }

  try {
    const schedule = await client.send("read_schedule", { ord: scheduleOrd, at: Date.now() });
    pass("read schedule", { type: schedule.schedule?.typeSpec, output: schedule.schedule?.output });
  }
  catch (error) {
    fail("read schedule", error);
  }

  try {
    const alarms = await client.send("read_alarms", { scope: "all", limit: 20 });
    pass("read alarms", { count: alarms.alarms?.count });
  }
  catch (error) {
    fail("read alarms", error);
  }

  try {
    const subscribed = await client.send("subscribe_alarms", { source: points.numeric, scope: "all", mode: "event", limit: 20 });
    const end = Date.now() + 10000;
    while (Date.now() < end && client.alarmCov.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const alarmCov = client.alarmCov[0];
    if (!alarmCov) {
      throw new Error("Timed out waiting for alarm_cov.");
    }
    if (alarmCov.mode !== "event") {
      throw new Error(`Expected event-mode alarm_cov, got ${alarmCov.mode}.`);
    }
    if (alarmCov.event == null || !alarmCov.event.uuid) {
      throw new Error("Event-mode alarm_cov did not include an event record.");
    }
    if (typeof alarmCov.inScope !== "boolean") {
      throw new Error("Event-mode alarm_cov did not include boolean inScope.");
    }
    if (Object.prototype.hasOwnProperty.call(alarmCov, "alarms") && !alarmCov.refreshRecommended) {
      throw new Error("Event-mode alarm_cov unexpectedly included full alarms snapshot.");
    }
    pass("subscribe alarms", {
      initialCount: subscribed.alarms?.count,
      alarmCovFrames: client.alarmCov.length,
      mode: alarmCov.mode,
      eventUuid: alarmCov.event.uuid,
      inScope: alarmCov.inScope
    });
  }
  catch (error) {
    fail("subscribe alarms", error);
  }

  try {
    const model = await client.send("subscribe_model", { base: pointBase, depth: 1 });
    if (!model.count || model.count < 1) {
      throw new Error("Model subscription did not include any components.");
    }
    const unsubscribed = await client.send("unsubscribe_model", { base: pointBase });
    pass("subscribe model", {
      count: model.count,
      remaining: unsubscribed.count
    });
  }
  catch (error) {
    fail("subscribe model", error);
  }

  client.fire("unsubscribe", { points: Object.values(points) });
  client.fire("unsubscribe_alarms");
  client.fire("unsubscribe_model");
  client.close();

  const failed = results.filter((item) => !item.ok);
  line("results", results);
  line("summary", {
    ok: failed.length === 0,
    failed: failed.map((item) => item.name),
    seconds: Math.round((Date.now() - started) / 1000)
  });
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  line("fatal", { message: error.message, stack: error.stack });
  process.exitCode = 1;
});
