"""In-process fake Niagara station that speaks the baskStream API 1.14 wire protocol.

Used by integration tests (and runnable by hand) to exercise read-only clients
without a real Niagara station:

* Niagara-style SCRAM-SHA-256 web login (``/prelogin``, ``/login``,
  ``/j_security_check/``) with a real server signature (``v=``) and an option to
  tamper with it.
* ``GET /stream/health`` behind the session cookie.
* ``/stream`` WebSocket (RFC 6455, stdlib only) carrying MessagePack frames.
* Niagara-shaped BACnet model: device ``objectId`` under ``config/deviceObject``,
  point ``objectId`` under ``<point>/proxyExt``, facets, Haystack tags.
* Server notices (``resync_required``, ``subscriptions_revoked``,
  ``session_revoked``, ``request_timeout``) on demand.
* ``requireAuthorizationHeader`` behaviour (HTTP 403 without ``Authorization``).
* Every write-class operation is refused and recorded in ``write_attempts`` so
  tests can assert a client never sent one.

Run by hand:  python tests/fake_baskstream_station.py --port 47912
(user ``bask-reader``; password printed to stdout at start, random each run).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote

import msgpack

API_VERSION = "1.14"
# Operations a 1.12 station (the signed upstream jar) does not have.
OPS_ADDED_AFTER_1_12 = {"resolve", "explain_change", "list_changes", "revert_change",
                        "begin_upload", "append_upload", "commit_upload"}
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

READ_OPS = [
    "ping", "capabilities", "browse", "describe", "search", "read", "read_tags",
    "describe_component", "describe_component_types", "read_schedule", "read_history",
    "read_alarms", "resolve", "query",
]
WRITE_OPS = [
    "write", "write_tags", "write_relations", "write_schedule", "ack_alarm", "clear_alarm",
    "apply_model_changes", "create_components", "update_component_properties",
    "rename_component", "move_components", "delete_components", "write_file", "write_px",
    "revert_change", "begin_upload", "append_upload", "commit_upload", "discover", "add_discovered",
]

NET = "slot:/Drivers/BacnetNetwork"
SCHEDULE = "slot:/Schedules/OfficeHours"


def _pt(name, type_spec, obj_id, facets, *, writable=False, tags=(), write_priority=None,
        active_level=None, value=0.0, display_value=None, proxy=True):
    return {
        "name": name, "typeSpec": type_spec, "objectId": obj_id, "facets": facets,
        "writable": writable, "tags": list(tags), "writePriority": write_priority,
        "activeLevel": active_level, "value": value, "displayValue": display_value, "proxy": proxy,
    }


DEFAULT_MODEL: dict[str, Any] = {
    "LabAHU_01": {
        "objectId": "device:10001",
        "tags": ["equip", "ahu"],
        "points": [
            _pt("SA_Temp", "control:NumericPoint", "analogInput:1", "units=u:°F|precision=i:1",
                tags=["discharge", "air", "temp", "sensor", "point"], value=55.2),
            _pt("SAT_SP", "control:NumericWritable", "analogValue:1", "units=u:°F|precision=i:1",
                writable=True, tags=["discharge", "air", "temp", "sp", "point"], write_priority=16, value=55.0),
            _pt("Fan_Cmd", "control:BooleanWritable", "binaryOutput:1", "trueText=s:On|falseText=s:Off",
                writable=True, tags=["discharge", "fan", "cmd", "point"], active_level=10, value=True, display_value="On"),
            _pt("Fan_Status", "control:BooleanPoint", "binaryInput:1", "trueText=s:On|falseText=s:Off",
                tags=["discharge", "fan", "run", "sensor", "point"], value=True, display_value="On"),
            _pt("OA_Damper", "control:NumericWritable", "analogOutput:2", "units=u:%|precision=i:0",
                writable=True, tags=["outside", "damper", "cmd", "point"], active_level=8, value=20.0),
            _pt("Occ_Mode", "control:EnumPoint", "multiStateValue:3", "range=E:{unocc=1,occ=2,standby=3}",
                tags=["occupied", "sensor", "point"], value=2, display_value="occ"),
        ],
    },
    "LabVAV_02": {
        "objectId": "device:10002",
        "tags": ["equip", "vav"],
        "points": [
            _pt("ZN_T", "control:NumericPoint", "analogInput:5", "units=u:°F|precision=i:1",
                tags=["zone", "air", "temp", "sensor", "point"], value=72.4),
            _pt("Airflow", "control:NumericPoint", "analogInput:6", "units=u:cfm|precision=i:0",
                tags=["discharge", "air", "flow", "sensor", "point"], value=410.0),
            # A Niagara-side calculated value with no BACnet proxy: must stay unbound.
            _pt("Calc_Avg", "control:NumericPoint", None, "units=u:°F|precision=i:1",
                tags=["zone", "air", "temp", "point"], value=72.0, proxy=False),
        ],
    },
}


def _enc_val(type_spec: str, encoded: str) -> dict[str, Any]:
    return {"typeSpec": type_spec, "encoded": encoded}


def _slot(name: str, type_spec: str, value: Any, *, writable: bool = False, flags: int = 0) -> dict[str, Any]:
    return {"name": name, "kind": "property", "dynamic": False, "flags": flags, "facets": "",
            "typeSpec": type_spec, "writable": writable, "value": value}


_UNIT_ENCODED = {"°F": "fahrenheit;°F;(K)*1.8+-459.67", "%": "percent;%", "cfm": "cubic feet per minute;cfm;(m3)*0.00047194745/(s)"}


def _facets_wire(encoded: str) -> dict[str, Any]:
    """Facets the way metadata carries them on a real station: a map of display strings."""
    out: dict[str, Any] = {}
    for part in encoded.split("|"):
        k, v = part.split("=", 1)
        prefix, val = v.split(":", 1)
        if prefix == "E":
            out[k] = [{"ordinal": int(x.split("=")[1]), "tag": x.split("=")[0]}
                      for x in val.strip("{}").split(",")]
        else:
            out[k] = val
    return out


def _facets_encoded(encoded: str) -> str:
    """Facets as a describe_component slot encodes them (BUnit in its full encoded form)."""
    parts = []
    for part in encoded.split("|"):
        k, v = part.split("=", 1)
        if v.startswith("u:") and v[2:] in _UNIT_ENCODED:
            v = "u:" + _UNIT_ENCODED[v[2:]]
        parts.append(f"{k}={v}")
    return "|".join(parts)


def _hs_tags(names: list[str]) -> list[dict[str, Any]]:
    return [{"id": f"hs:{n}", "dictionary": "hs", "name": n, "value": None,
             "valueType": "baja:Marker", "marker": True, "source": "direct"} for n in names]


@dataclass
class StationState:
    users: dict[str, str]
    model: dict[str, Any] = field(default_factory=lambda: json.loads(json.dumps(DEFAULT_MODEL)))
    iterations: int = 4096
    api_version: str = API_VERSION
    require_auth_header: bool = False
    tamper_server_signature: bool = False
    omit_server_signature: bool = False
    notices_before: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    revoke_on: str | None = None
    timeout_on: str | None = None
    silent_on: str | None = None
    sessions: dict[str, str] = field(default_factory=dict)
    pending_scram: dict[str, dict[str, Any]] = field(default_factory=dict)
    salts: dict[str, bytes] = field(default_factory=dict)
    received_ops: list[str] = field(default_factory=list)
    write_attempts: list[dict[str, Any]] = field(default_factory=list)
    ws_handshake_headers: list[dict[str, str]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def has_op(self, op: str) -> bool:
        legacy = tuple(int(x) for x in self.api_version.split(".")[:2]) <= (1, 12)
        return not (legacy and op in OPS_ADDED_AFTER_1_12)

    # ------------------------------------------------------------------ model
    def device_ord(self, dev: str) -> str:
        return f"{NET}/{dev}"

    def point_ord(self, dev: str, pt: dict[str, Any]) -> str:
        return f"{NET}/{dev}/points/{pt['name']}"

    def iter_points(self):
        for dev, d in self.model.items():
            for pt in d["points"]:
                yield dev, d, pt

    def node(self, ord_value: str, *, metadata: bool) -> dict[str, Any] | None:
        ord_value = ord_value.rstrip("/") or "slot:/"
        if ord_value in ("slot:/", "slot:", "slot:/Drivers"):
            name = "Drivers" if ord_value.endswith("Drivers") else "station"
            n = {"ord": ord_value, "slotPath": ord_value, "name": name, "display": name,
                 "typeSpec": "driver:DriverContainer" if name == "Drivers" else "baja:Station",
                 "kind": "folder", "hasChildren": True, "features": [], "operations": ["browse"]}
            if metadata:
                n["metadata"] = {"classification": {"isComponent": True}}
            return n
        if ord_value == "slot:/Schedules":
            return {"ord": ord_value, "slotPath": ord_value, "name": "Schedules", "display": "Schedules",
                    "typeSpec": "baja:Folder", "kind": "folder", "hasChildren": True,
                    "features": [], "operations": ["browse"]}
        if ord_value == SCHEDULE:
            n = {"ord": SCHEDULE, "slotPath": SCHEDULE, "name": "OfficeHours", "display": "OfficeHours",
                 "typeSpec": "schedule:BooleanSchedule", "kind": "schedule", "hasChildren": False,
                 "status": "{ok}", "features": ["schedule"], "operations": ["read_schedule"]}
            if metadata:
                n["metadata"] = {"classification": {"isComponent": True, "isSchedule": True}}
            return n
        if ord_value == NET:
            n = {"ord": NET, "slotPath": NET, "name": "BacnetNetwork", "display": "BacnetNetwork",
                 "typeSpec": "bacnet:BacnetNetwork", "kind": "network", "hasChildren": True,
                 "features": [], "operations": ["browse"]}
            if metadata:
                n["metadata"] = {"classification": {"isComponent": True, "isDriverNetwork": True}}
            return n
        for dev, d in self.model.items():
            dord = self.device_ord(dev)
            if ord_value == dord:
                n = {"ord": dord, "slotPath": dord, "name": dev, "display": dev,
                     "typeSpec": "bacnet:BacnetDevice", "kind": "device", "hasChildren": True,
                     "status": "{ok}", "features": [], "operations": ["browse", "read_tags"]}
                if metadata:
                    n["metadata"] = {
                        "classification": {"isComponent": True, "isDriverDevice": True},
                        "driver": {"network": NET, "device": dord},
                        "tags": _hs_tags(d["tags"]),
                    }
                return n
            if ord_value == f"{dord}/points":
                return {"ord": ord_value, "slotPath": ord_value, "name": "points", "display": "Points",
                        "typeSpec": "bacnet:BacnetPointDeviceExt", "kind": "folder", "hasChildren": True,
                        "features": [], "operations": ["browse"]}
            for pt in d["points"]:
                pord = self.point_ord(dev, pt)
                if ord_value == pord:
                    n = {"ord": pord, "slotPath": pord, "name": pt["name"], "display": pt["name"],
                         "typeSpec": pt["typeSpec"], "kind": "point", "hasChildren": False,
                         "status": "{ok}", "writable": pt["writable"],
                         "features": ["point", "history"],
                         "operations": ["read", "subscribe"] + (["write"] if pt["writable"] else [])}
                    if metadata:
                        kind = ("boolean" if "Boolean" in pt["typeSpec"] else
                                "enum" if "Enum" in pt["typeSpec"] else "numeric")
                        pmeta: dict[str, Any] = {"facets": _facets_wire(pt["facets"]), "hasProxyExt": pt["proxy"]}
                        if pt["activeLevel"]:
                            pmeta["activeLevelOrdinal"] = pt["activeLevel"]
                        n["metadata"] = {
                            "classification": {"isComponent": True, "isControlPoint": True,
                                               "isWritablePoint": pt["writable"], "isProxyPoint": pt["proxy"]},
                            "driver": {"network": NET, "device": dord,
                                       "proxyExtType": "bacnet:BacnetNumericProxyExt" if pt["proxy"] else None,
                                       "readWriteMode": "readWrite" if pt["writable"] else "readOnly"},
                            "point": pmeta,
                            "write": {"valueKind": kind, "writable": pt["writable"]},
                            "facets": _facets_wire(pt["facets"]),
                            "tags": _hs_tags(pt["tags"]),
                        }
                    return n
        return None

    def children(self, ord_value: str) -> list[str]:
        ord_value = ord_value.rstrip("/") or "slot:/"
        if ord_value in ("slot:/", "slot:"):
            return ["slot:/Drivers", "slot:/Schedules"]
        if ord_value == "slot:/Schedules":
            return [SCHEDULE]
        if ord_value == "slot:/Drivers":
            return [NET]
        if ord_value == NET:
            return [self.device_ord(d) for d in self.model]
        for dev, d in self.model.items():
            if ord_value == self.device_ord(dev):
                return [f"{self.device_ord(dev)}/points"]
            if ord_value == f"{self.device_ord(dev)}/points":
                return [self.point_ord(dev, p) for p in d["points"]]
        return []

    def describe_component(self, ord_value: str) -> dict[str, Any] | None:
        for dev, d in self.model.items():
            dord = self.device_ord(dev)
            if ord_value == dord:
                slots = [_slot("displayName", "baja:String", _enc_val("baja:String", dev), writable=True),
                         _slot("enabled", "baja:Boolean", _enc_val("baja:Boolean", "true"), writable=True),
                         _slot("config", "bacnet:BacnetConfigDeviceExt", {"typeSpec": "bacnet:BacnetConfigDeviceExt", "expand": True})]
                return {"ord": dord, "typeSpec": "bacnet:BacnetDevice", "name": dev, "slots": slots}
            if ord_value == f"{dord}/config/deviceObject":
                return {"ord": ord_value, "typeSpec": "bacnet:BacnetDeviceObject", "name": "deviceObject",
                        "slots": [_slot("objectId", "bacnet:BacnetObjectIdentifier",
                                        _enc_val("bacnet:BacnetObjectIdentifier", d["objectId"])),
                                  _slot("objectName", "baja:String", _enc_val("baja:String", dev))]}
            for pt in d["points"]:
                pord = self.point_ord(dev, pt)
                if ord_value == pord:
                    slots = [_slot("facets", "baja:Facets", _enc_val("baja:Facets", _facets_encoded(pt["facets"])), writable=True),
                             _slot("out", "baja:StatusValue", {"typeSpec": "baja:StatusValue", "properties": {
                                 "status": _enc_val("baja:Status", "{ok}"),
                                 "value": _enc_val("baja:String", str(pt["value"]))}}, flags=11)]
                    if pt["proxy"]:
                        slots.insert(1, _slot("proxyExt", "control:AbstractProxyExt",
                                              {"typeSpec": "bacnet:BacnetNumericProxyExt", "expand": True}, flags=1))
                    return {"ord": pord, "typeSpec": pt["typeSpec"], "name": pt["name"], "slots": slots}
                if ord_value == f"{pord}/proxyExt" and pt["proxy"]:
                    slots = [_slot("objectId", "bacnet:BacnetObjectIdentifier",
                                   _enc_val("bacnet:BacnetObjectIdentifier", pt["objectId"])),
                             _slot("propertyId", "bacnet:BacnetPropertyIdentifier",
                                   _enc_val("baja:String", "presentValue")),
                             _slot("propertyArrayIndex", "baja:Integer", _enc_val("baja:Integer", "-1"))]
                    if pt["writePriority"]:
                        slots.append(_slot("writePriority", "baja:Integer",
                                           _enc_val("baja:Integer", str(pt["writePriority"]))))
                    return {"ord": ord_value, "typeSpec": "bacnet:BacnetNumericProxyExt", "name": "proxyExt", "slots": slots}
        return None

    # ------------------------------------------------------------------ auth
    def salt_for(self, user: str) -> bytes:
        with self.lock:
            if user not in self.salts:
                self.salts[user] = os.urandom(16)
            return self.salts[user]


def _ws_frame(payload: bytes, opcode: int = 0x2) -> bytes:
    head = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        head += bytes([n])
    elif n < 65536:
        head += bytes([126]) + struct.pack(">H", n)
    else:
        head += bytes([127]) + struct.pack(">Q", n)
    return head + payload


def _read_exact(rfile, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = rfile.read(n - len(buf))
        if not chunk:
            raise ConnectionError("socket closed")
        buf += chunk
    return buf


def _ws_read(rfile) -> tuple[int, bytes]:
    b1, b2 = _read_exact(rfile, 2)
    opcode = b1 & 0x0F
    masked = b2 & 0x80
    n = b2 & 0x7F
    if n == 126:
        n = struct.unpack(">H", _read_exact(rfile, 2))[0]
    elif n == 127:
        n = struct.unpack(">Q", _read_exact(rfile, 8))[0]
    mask = _read_exact(rfile, 4) if masked else b"\0\0\0\0"
    data = bytearray(_read_exact(rfile, n))
    for i in range(n):
        data[i] ^= mask[i % 4]
    return opcode, bytes(data)


def _make_handler(state: StationState):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args: Any) -> None:  # keep test output quiet
            return

        # ---------------------------------------------------------- helpers
        def _cookies(self) -> dict[str, str]:
            out: dict[str, str] = {}
            for part in (self.headers.get("Cookie") or "").split(";"):
                if "=" in part:
                    k, v = part.strip().split("=", 1)
                    out[k] = v
            return out

        def _session_user(self) -> str | None:
            sid = self._cookies().get("JSESSIONID")
            return state.sessions.get(sid or "")

        def _send(self, code: int, body: bytes = b"", ctype: str = "text/plain",
                  headers: dict[str, str] | None = None) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _body(self) -> str:
            n = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(n).decode("utf-8") if n else ""

        # ---------------------------------------------------------- HTTP
        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path == "/prelogin":
                self._send(200, b"<html>login</html>", "text/html",
                           {"Set-Cookie": "niagara_userid=; Path=/"})
            elif path == "/j_security_check/":
                pre = self._cookies().get("preauth")
                user = state.pending_scram.get(pre or "", {}).get("verified_user")
                if not user:
                    self._send(403, b"not authenticated")
                    return
                sid = secrets.token_hex(16)
                state.sessions[sid] = user
                self._send(302, b"", headers={"Location": "/", "Set-Cookie": f"JSESSIONID={sid}; Path=/; HttpOnly"})
            elif path == "/stream/health":
                user = self._session_user()
                if not user:
                    self._send(302, b"", headers={"Location": "/prelogin"})
                    return
                body = json.dumps({"ok": True, "apiVersion": API_VERSION, "authenticatedUser": user}).encode()
                self._send(200, body, "application/json")
            elif path == "/stream":
                self._websocket()
            else:
                self._send(404, b"not found")

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            body = self._body()
            if path == "/login":
                user = unquote(parse_qs(body).get("j_username", [""])[0])
                pre = secrets.token_hex(12)
                state.pending_scram[pre] = {"user": user}
                self._send(200, b"<form action='j_security_check'></form>", "text/html",
                           {"Set-Cookie": f"preauth={pre}; Path=/"})
                return
            if path == "/j_security_check/":
                pre = self._cookies().get("preauth") or ""
                pending = state.pending_scram.get(pre)
                if pending is None:
                    self._send(403, b"no login in progress")
                    return
                if "action=sendClientFirstMessage" in body:
                    first = body.split("clientFirstMessage=", 1)[1]
                    bare = first.split(",,", 1)[1] if first.startswith("n,,") else first
                    attrs = dict(p.split("=", 1) for p in bare.split(",") if "=" in p)
                    user = pending["user"]
                    if attrs.get("n", "").replace("=2C", ",").replace("=3D", "=") != user or user not in state.users:
                        self._send(403, b"unknown user")
                        return
                    snonce = attrs["r"] + base64.b64encode(os.urandom(18)).decode()
                    salt = state.salt_for(user)
                    server_first = f"r={snonce},s={base64.b64encode(salt).decode()},i={state.iterations}"
                    pending.update(client_first_bare=bare, server_first=server_first, nonce=snonce)
                    self._send(200, server_first.encode())
                    return
                if "action=sendClientFinalMessage" in body:
                    final = body.split("clientFinalMessage=", 1)[1]
                    without_proof, proof_b64 = final.rsplit(",p=", 1)
                    user = pending["user"]
                    salted = hashlib.pbkdf2_hmac(
                        "sha256", unicodedata.normalize("NFKC", state.users[user]).encode(),
                        state.salt_for(user), state.iterations, dklen=32)
                    auth_msg = f"{pending['client_first_bare']},{pending['server_first']},{without_proof}".encode()
                    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
                    stored_key = hashlib.sha256(client_key).digest()
                    client_sig = hmac.new(stored_key, auth_msg, hashlib.sha256).digest()
                    expected_proof = bytes(a ^ b for a, b in zip(client_key, client_sig))
                    if f"r={pending['nonce']}" not in without_proof or not hmac.compare_digest(
                            base64.b64decode(proof_b64), expected_proof):
                        self._send(403, b"bad proof")
                        return
                    pending["verified_user"] = user
                    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
                    sig = hmac.new(server_key, auth_msg, hashlib.sha256).digest()
                    if state.tamper_server_signature:
                        sig = bytes(reversed(sig))
                    out = b"" if state.omit_server_signature else f"v={base64.b64encode(sig).decode()}".encode()
                    self._send(200, out)
                    return
            self._send(404, b"not found")

        # ---------------------------------------------------------- WebSocket
        def _websocket(self) -> None:
            user = self._session_user()
            state.ws_handshake_headers.append({k: v for k, v in self.headers.items()})
            if not user:
                self._send(403, b"Not authenticated")
                return
            if state.require_auth_header and not (self.headers.get("Authorization") or "").strip():
                self._send(403, b"Authorization header is required for this endpoint.")
                return
            key = self.headers.get("Sec-WebSocket-Key", "")
            accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            self.wfile.flush()
            self.close_connection = True
            try:
                self._ws_loop(user)
            except (ConnectionError, OSError):
                pass

        def _push(self, msg: dict[str, Any]) -> None:
            self.wfile.write(_ws_frame(msgpack.packb(msg, use_bin_type=True)))
            self.wfile.flush()

        def _close(self, code: int, reason: str) -> None:
            self.wfile.write(_ws_frame(struct.pack(">H", code) + reason.encode(), opcode=0x8))
            self.wfile.flush()

        def _ws_loop(self, user: str) -> None:
            while True:
                opcode, data = _ws_read(self.rfile)
                if opcode == 0x8:
                    self._close(1000, "bye")
                    return
                if opcode == 0x9:
                    self.wfile.write(_ws_frame(data, opcode=0xA))
                    continue
                if opcode not in (0x1, 0x2):
                    continue
                req = msgpack.unpackb(data, raw=False)
                op = str(req.get("op") or "")
                rid = req.get("id")
                state.received_ops.append(op)
                for notice in state.notices_before.get(op, []):
                    self._push(notice)
                if state.revoke_on == op:
                    self._push({"op": "session_revoked", "reason": "user disabled"})
                    self._close(1008, "session revoked")
                    return
                if state.timeout_on == op:
                    self._push({"op": "request_timeout", "requestOp": op, "elapsedMillis": 600000})
                    self._close(1011, "request timeout")
                    return
                if state.silent_on == op:
                    continue
                self._push(self._dispatch(op, rid, req, user))

        def _error(self, rid: Any, code: str, message: str) -> dict[str, Any]:
            return {"op": "error", "id": rid, "code": code, "message": message}

        def _dispatch(self, op: str, rid: Any, req: dict[str, Any], user: str) -> dict[str, Any]:
            if op in WRITE_OPS:
                state.write_attempts.append(req)
                return self._error(rid, "forbidden", f"{op} refused: writes are disabled for {user}")
            if op == "ping":
                return {"op": "pong", "id": rid, "serverTime": int(time.time() * 1000)}
            if op == "capabilities":
                return {"op": "capabilities_result", "id": rid, "capabilities": {
                    "apiVersion": state.api_version, "module": "baskStream",
                    "operations": [o for o in READ_OPS + WRITE_OPS if state.has_op(o)],
                    "writesEnabled": False, "modelEditsEnabled": False,
                    "agents": {"pointWrites": "refuse", "kinds": {k: "refuse" for k in (
                        "files", "discovery", "modelEdits", "tags", "schedules", "alarms")}},
                    "limits": {"maxSearchLimit": 5000, "maxVisited": 100000, "maxTimeoutMillis": 15000},
                }}
            if op in ("browse", "describe"):
                base = str(req.get("base") or req.get("ord") or "")
                meta = req.get("metadata", "full" if op == "describe" else "none") not in (None, "none", False)
                n = state.node(base, metadata=meta)
                if n is None:
                    return self._error(rid, "invalid_point", f"{base} not found")
                if op == "browse":
                    n = dict(n, children=[state.node(c, metadata=meta) for c in state.children(base)])
                return {"op": f"{op}_result", "id": rid, "metadata": "full" if meta else "none", "node": n}
            if op == "search":
                base = str(req.get("base") or "slot:/").rstrip("/") or "slot:/"
                meta = req.get("metadata") not in (None, "none", False)
                feats = set(req.get("features") or [])
                q = str(req.get("query") or "").casefold()
                limit = int(req.get("limit") or 1000)
                out, stack, visited = [], [base], 0
                while stack:
                    cur = stack.pop(0)
                    visited += 1
                    for c in state.children(cur):
                        stack.append(c)
                        n = state.node(c, metadata=meta)
                        if not n:
                            continue
                        if feats and not feats.intersection(n.get("features") or []):
                            continue
                        if q and q not in (n["name"] + " " + n["ord"]).casefold():
                            continue
                        out.append(n)
                truncated = len(out) > limit
                return {"op": "search_result", "id": rid, "result": {
                    "base": base, "visited": visited, "count": min(len(out), limit),
                    "truncated": truncated, "truncatedReasons": ["limit"] if truncated else [],
                    "nodes": out[:limit]}}
            if op == "describe_component":
                comp = state.describe_component(str(req.get("ord") or ""))
                if comp is None:
                    return self._error(rid, "invalid_point", "component not found")
                comp = dict(comp, writesEnabled=False, modelEditsEnabled=False)
                return {"op": "model_result", "id": rid, "operation": "describe_component", "result": comp}
            if op == "read":
                pts = []
                index = {state.point_ord(d, p): p for d, _dd, p in state.iter_points()}
                for o in req.get("points") or []:
                    p = index.get(o)
                    if p is None:
                        pts.append({"point": o, "ok": False, "error": "invalid_point"})
                    else:
                        pts.append({"point": o, "ok": True, "value": p["value"],
                                    "displayValue": p["displayValue"] or str(p["value"]),
                                    "status": "{ok}", "valueType": p["typeSpec"],
                                    "timestamp": int(time.time() * 1000)})
                return {"op": "read_result", "id": rid, "points": pts}
            if op == "read_tags":
                ords = req.get("ords") or ([req["ord"]] if req.get("ord") else [])
                targets = []
                for o in ords:
                    n = state.node(o, metadata=True)
                    if n is None:
                        targets.append({"ord": o, "ok": False, "error": "invalid_point"})
                        continue
                    targets.append({"ord": o, "ok": True, "slotPath": o, "display": n["display"],
                                    "typeSpec": n["typeSpec"], "tags": (n.get("metadata") or {}).get("tags") or [],
                                    "relations": []})
                return {"op": "tags_result", "id": rid, "targets": targets}
            if not state.has_op(op):
                return self._error(rid, "unsupported_op", f"Unsupported op: {op}")
            if op == "resolve":
                equip = str(req.get("equip") or req.get("ord") or "")
                role = str(req.get("role") or "")
                want = set((role.replace("_", " ").casefold().split()) or
                           [str(t).split(":")[-1].casefold() for t in req.get("tags") or []])
                if not want:
                    return self._error(rid, "bad_request", "Give a 'role' or 'tags'.")
                dev = equip.rsplit("/", 1)[-1]
                if dev not in state.model:
                    return self._error(rid, "invalid_point", f"Equipment {equip} is missing.")
                matches = []
                for pt in state.model[dev]["points"]:
                    have = set(pt["tags"]) | set(pt["name"].casefold().replace("_", " ").split())
                    score = len(want & have) / max(len(want), 1)
                    if score > 0:
                        matches.append({"ord": state.point_ord(dev, pt), "name": pt["name"],
                                        "typeSpec": pt["typeSpec"], "score": round(score, 2),
                                        "why": sorted(want & have)})
                matches.sort(key=lambda m: -m["score"])
                sure = bool(matches) and matches[0]["score"] >= 0.75 and (
                    len(matches) == 1 or matches[1]["score"] < matches[0]["score"])
                return {"op": "resolve_result", "id": rid, "equip": equip, "role": role or None,
                        "point": matches[0]["ord"] if sure else None,
                        "ambiguous": bool(matches) and not sure, "matches": matches[:5], "inferred": True}
            if op == "read_schedule":
                day = [{"start": "6:30 AM", "finish": "6:00 PM", "startTime": "06:30", "finishTime": "18:00",
                        "effectiveValue": {"ok": True, "value": True, "displayValue": "Occupied"}}]
                week = {d: {"name": d, "day": day if d not in ("saturday", "sunday") else []}
                        for d in ("sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday")}
                return {"op": "schedule_result", "id": rid, "schedule": {
                    "ord": req.get("ord"), "name": "OfficeHours", "typeSpec": "schedule:BooleanSchedule",
                    "status": "{ok}", "effectiveNow": True,
                    "currentOutput": {"ok": True, "value": True, "displayValue": "Occupied", "status": "{ok}"},
                    "nextEvent": int(time.time() * 1000) + 3600_000, "tree": {"week": week}}}
            return self._error(rid, "unsupported_op", f"Unsupported op: {op}")

    return Handler


class FakeBaskStreamStation:
    """Context manager that runs the fake station on 127.0.0.1 in a thread."""

    def __init__(self, **state_kwargs: Any) -> None:
        self.user = state_kwargs.pop("user", "bask-reader")
        self.password = state_kwargs.pop("password", None) or secrets.token_urlsafe(18)
        self.state = StationState(users={self.user: self.password}, **state_kwargs)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _make_handler(self.state))
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> "FakeBaskStreamStation":
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def _main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Run a fake baskStream 1.14 station on 127.0.0.1")
    ap.add_argument("--port", type=int, default=47912)
    ap.add_argument("--require-auth-header", action="store_true")
    args = ap.parse_args()
    st = FakeBaskStreamStation(require_auth_header=args.require_auth_header)
    st.httpd.server_close()
    st.httpd = ThreadingHTTPServer(("127.0.0.1", args.port), _make_handler(st.state))
    print(f"fake baskStream {API_VERSION} station at {st.url} user={st.user} password={st.password}")
    try:
        st.httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    _main()
