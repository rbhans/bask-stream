#!/usr/bin/env python3
"""
baskstream_smoke.py

Minimal read-only smoke test for Niagara baskStream.

Install:
  py -m pip install -r requirements.txt

Run:
  $env:BASKSTREAM_USER="admin"
  $env:BASKSTREAM_PASS="<station-password>"
  py .\baskstream_smoke.py --station https://localhost --root 'slot:/Drivers'
"""

from __future__ import annotations

import argparse
import getpass
import json
import os

from baskstream_client import BaskStreamClient


def main() -> int:
    parser = argparse.ArgumentParser(description="Minimal baskStream smoke test")
    parser.add_argument("--station", default="https://localhost")
    parser.add_argument("--user", default=os.getenv("BASKSTREAM_USER"))
    parser.add_argument("--password", default=os.getenv("BASKSTREAM_PASS"))
    parser.add_argument("--ask-pass", action="store_true")
    parser.add_argument("--root", default="slot:/Drivers")
    parser.add_argument("--verify-tls", action="store_true")
    args = parser.parse_args()

    password = args.password
    if args.ask_pass:
        password = getpass.getpass("Niagara password: ")

    if not args.user or not password:
        print("Provide --user/--password, use --ask-pass, or set BASKSTREAM_USER/BASKSTREAM_PASS.")
        return 2

    with BaskStreamClient(args.station, verify_tls=args.verify_tls) as client:
        health = client.login(args.user, password)
        print("[health]")
        print(json.dumps(health, indent=2))

        client.connect()

        print("[ping]")
        print(json.dumps(client.ping(), indent=2, default=str))

        print("[capabilities]")
        print(json.dumps(client.capabilities(), indent=2, default=str))

        print(f"[browse] {args.root}")
        response = client.browse(args.root, depth=1, metadata="none")
        node = response.get("node") or {}
        for child in node.get("children") or []:
            name = child.get("display") or child.get("name")
            ord_value = child.get("slotPath") or child.get("ord")
            type_spec = child.get("typeSpec") or child.get("description")
            status = child.get("status") or ""
            print(f"- {name} | {ord_value} | {type_spec} {status}")

    print("\nOK: baskStream smoke test completed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
