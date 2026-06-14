#!/usr/bin/env python3
"""
baskstream_client.py

Small read-only Python client for Niagara baskStream:
- Niagara SCRAM web login
- authenticated /stream/health check
- MessagePack WebSocket calls to /stream

This is intentionally dependency-light for field testing and Open-FDD-style
connector experiments. It is not a full Niagara SDK.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import ssl
import unicodedata
import uuid
from http.cookies import SimpleCookie
from typing import Any
from urllib.parse import quote, urlparse

import msgpack
import requests
import urllib3
import websocket

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class BaskStreamError(RuntimeError):
    """Raised for Niagara login, HTTP, or baskStream protocol errors."""


class SimpleCookieJar:
    """Tiny cookie jar that mirrors the baskStream Node helper behavior."""

    def __init__(self) -> None:
        self._cookies: dict[str, str] = {}

    def store(self, response: requests.Response) -> None:
        raw_values: list[str] = []
        try:
            raw_values.extend(response.raw.headers.getlist("Set-Cookie"))
        except Exception:
            pass

        fallback = response.headers.get("Set-Cookie")
        if fallback and fallback not in raw_values:
            raw_values.append(fallback)

        for raw in raw_values:
            try:
                parsed = SimpleCookie()
                parsed.load(raw)
                for name, morsel in parsed.items():
                    self._cookies[name] = morsel.value
            except Exception:
                first = raw.split(";", 1)[0]
                if "=" in first:
                    name, value = first.split("=", 1)
                    self._cookies[name.strip()] = value.strip()

    def header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self._cookies.items())

    def names(self) -> list[str]:
        return list(self._cookies.keys())


def prep_username(value: str) -> str:
    """SCRAM username prep used by Niagara's web login flow."""
    return unicodedata.normalize("NFKC", str(value)).replace("=", "=3D").replace(",", "=2C")


def parse_scram(value: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in value.split(","):
        if "=" in part:
            key, val = part.split("=", 1)
            out[key] = val
    return out


def xor_bytes(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


class BaskStreamClient:
    """
    Read-only baskStream client.

    Typical use:
        client = BaskStreamClient("https://localhost")
        client.login("admin", password)
        client.connect()
        print(client.call("capabilities"))
        print(client.browse("slot:/Drivers", depth=1))
        client.close()
    """

    def __init__(
        self,
        station: str,
        *,
        verify_tls: bool = False,
        quiet: bool = False,
        timeout: int = 45,
    ) -> None:
        self.station = station.rstrip("/")
        self.verify_tls = verify_tls
        self.quiet = quiet
        self.timeout = timeout
        self.session = requests.Session()
        self.cookies = SimpleCookieJar()
        self.ws: websocket.WebSocket | None = None

    def log(self, message: str) -> None:
        if not self.quiet:
            print(message)

    def url(self, path: str) -> str:
        return self.station + path

    def http(
        self,
        method: str,
        path: str,
        *,
        body: str | bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> requests.Response:
        req_headers: dict[str, str] = {
            "User-Agent": "baskstream-python-tools/0.3",
            "Accept": "*/*",
        }

        cookie_header = self.cookies.header()
        if cookie_header:
            req_headers["Cookie"] = cookie_header

        if headers:
            req_headers.update(headers)

        response = self.session.request(
            method=method,
            url=self.url(path),
            data=body or b"",
            headers=req_headers,
            verify=self.verify_tls,
            allow_redirects=False,
            timeout=self.timeout,
        )
        self.cookies.store(response)

        self.log(f"[http] {method} {path} -> {response.status_code}")
        if response.headers.get("Location"):
            self.log(f"[http] location: {response.headers.get('Location')}")
        if response.status_code >= 400:
            self.log("[http] response body:")
            self.log(response.text[:2000])

        return response

    def health(self) -> dict[str, Any] | None:
        response = self.http("GET", "/stream/health")
        if response.status_code == 200:
            try:
                return response.json()
            except Exception as exc:
                raise BaskStreamError(f"/stream/health returned non-JSON body: {exc}") from exc
        return None

    def login(self, username: str, password: str) -> dict[str, Any]:
        """
        Perform Niagara SCRAM web login and confirm /stream/health.

        The final GET /j_security_check/ intentionally does not follow the 302.
        This matches the included baskStream Node companion helper and avoids
        session problems on some Niagara/JENEsys builds.
        """
        already = self.health()
        if already:
            self.log(f"[login] already authenticatedUser={already.get('authenticatedUser')}")
            return already

        self.log("[login] GET /prelogin")
        self.http("GET", "/prelogin")

        self.log("[login] POST /login username")
        user_step = self.http(
            "POST",
            "/login",
            body=f"j_username={quote(username)}",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if user_step.status_code != 200 or "j_security_check" not in user_step.text:
            raise BaskStreamError(
                "Niagara username step failed. Verify the user can log into station web."
            )

        nonce = base64.b64encode(os.urandom(16)).decode("ascii")
        client_first_bare = f"n={prep_username(username)},r={nonce}"
        client_first_message = f"n,,{client_first_bare}"

        self.log("[login] SCRAM first")
        first = self.http(
            "POST",
            "/j_security_check/",
            body=f"action=sendClientFirstMessage&clientFirstMessage={client_first_message}",
            headers={"Content-Type": "application/x-niagara-login-support"},
        )
        if first.status_code != 200:
            raise BaskStreamError(f"SCRAM first message failed: HTTP {first.status_code}")

        server_first = first.text.strip()
        parsed = parse_scram(server_first)
        if not parsed.get("r", "").startswith(nonce) or not parsed.get("s") or not parsed.get("i"):
            raise BaskStreamError(f"Bad SCRAM server response: {server_first}")

        salted_password = hashlib.pbkdf2_hmac(
            "sha256",
            unicodedata.normalize("NFKC", password).encode("utf-8"),
            base64.b64decode(parsed["s"]),
            int(parsed["i"]),
            dklen=32,
        )

        client_final_no_proof = f"c=biws,r={parsed['r']}"
        auth_message = f"{client_first_bare},{server_first},{client_final_no_proof}"
        client_key = hmac.new(salted_password, b"Client Key", hashlib.sha256).digest()
        stored_key = hashlib.sha256(client_key).digest()
        client_signature = hmac.new(stored_key, auth_message.encode("utf-8"), hashlib.sha256).digest()
        proof_b64 = base64.b64encode(xor_bytes(client_key, client_signature)).decode("ascii")

        self.log("[login] SCRAM final")
        final = self.http(
            "POST",
            "/j_security_check/",
            body=f"action=sendClientFinalMessage&clientFinalMessage={client_final_no_proof},p={proof_b64}",
            headers={"Content-Type": "application/x-niagara-login-support"},
        )
        if final.status_code != 200:
            raise BaskStreamError(f"SCRAM final message failed: HTTP {final.status_code}")

        self.log("[login] finalize")
        self.http("GET", "/j_security_check/")

        health = self.health()
        if not health:
            raise BaskStreamError("/stream/health was not 200 after Niagara login.")

        self.log(f"[login] authenticatedUser={health.get('authenticatedUser')}")
        return health

    def ws_url(self) -> str:
        parsed = urlparse(self.station)
        if parsed.scheme == "https":
            return f"wss://{parsed.netloc}/stream"
        if parsed.scheme == "http":
            return f"ws://{parsed.netloc}/stream"
        raise ValueError("Station URL must start with http:// or https://")

    def origin(self) -> str:
        parsed = urlparse(self.station)
        return f"{parsed.scheme}://{parsed.netloc}"

    def connect(self) -> None:
        cookie_header = self.cookies.header()
        if not cookie_header:
            raise BaskStreamError("No Niagara cookies are available. Call login() first.")

        self.log(f"[ws] connecting {self.ws_url()}")
        self.ws = websocket.create_connection(
            self.ws_url(),
            header=[f"Cookie: {cookie_header}"],
            origin=self.origin(),
            sslopt={"cert_reqs": ssl.CERT_REQUIRED if self.verify_tls else ssl.CERT_NONE,
                    "check_hostname": self.verify_tls},
            timeout=self.timeout,
        )

    def close(self) -> None:
        if self.ws is not None:
            self.ws.close()
            self.ws = None

    def __enter__(self) -> "BaskStreamClient":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def call(self, op: str, **fields: Any) -> dict[str, Any]:
        if self.ws is None:
            raise BaskStreamError("WebSocket is not connected.")

        req_id = fields.pop("id", f"{op}-{uuid.uuid4().hex[:8]}")
        frame: dict[str, Any] = {"op": op, "id": req_id}
        frame.update(fields)

        self.ws.send(msgpack.packb(frame, use_bin_type=True), opcode=websocket.ABNF.OPCODE_BINARY)

        while True:
            raw = self.ws.recv()
            if isinstance(raw, str):
                continue

            msg = msgpack.unpackb(raw, raw=False)
            if msg.get("id") != req_id:
                continue

            if msg.get("error") or msg.get("op") == "error":
                raise BaskStreamError(json.dumps(msg, indent=2, default=str))
            return msg

    def ping(self) -> dict[str, Any]:
        return self.call("ping")

    def capabilities(self) -> dict[str, Any]:
        return self.call("capabilities")

    def browse(self, base: str, *, depth: int = 1, metadata: str = "none") -> dict[str, Any]:
        return self.call("browse", base=base, depth=depth, metadata=metadata)

    def search(
        self,
        base: str,
        *,
        query: str = "",
        features: list[str] | None = None,
        operations: list[str] | None = None,
        metadata: str = "none",
        depth: int = 32,
        limit: int = 5000,
        max_visited: int = 100000,
        timeout_ms: int = 15000,
    ) -> dict[str, Any]:
        frame: dict[str, Any] = {
            "base": base,
            "query": query,
            "depth": depth,
            "metadata": metadata,
            "limit": limit,
            "maxVisited": max_visited,
            "timeoutMillis": timeout_ms,
        }
        if features:
            frame["features"] = features
        if operations:
            frame["operations"] = operations
        return self.call("search", **frame)

    def read(self, points: list[str]) -> dict[str, Any]:
        return self.call("read", points=points)

    def read_schedule(self, ord_value: str, *, at_ms: int | None = None) -> dict[str, Any]:
        frame: dict[str, Any] = {"ord": ord_value}
        if at_ms is not None:
            frame["at"] = at_ms
        return self.call("read_schedule", **frame)
