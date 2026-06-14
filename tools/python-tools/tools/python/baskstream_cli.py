#!/usr/bin/env python3
"""
baskstream_cli.py

Read-only Niagara baskStream command line helper.

Commands:
  health      login and print /stream/health JSON
  smoke       ping/capabilities/browse sanity check
  tree        compact station/folder tree
  values      discover readable points and print point names + current values
  read        read explicit point ORDs
  schedules   list and optionally read schedules

PowerShell reminder:
  Niagara ORDs often contain "$20" and "$2d". Use SINGLE QUOTES in PowerShell:
    --base 'slot:/Drivers/BacnetNetwork/BENS$20BENCHTEST$20BOX/points'
"""

from __future__ import annotations

import argparse
import csv
import getpass
import json
import os
import sys
import time
from typing import Any, Iterable

from baskstream_client import BaskStreamClient


# -----------------------------------------------------------------------------
# Formatting
# -----------------------------------------------------------------------------

def ellipsize(value: object, width: int) -> str:
    text = "" if value is None else str(value)
    if width <= 1:
        return text[:width]
    if len(text) <= width:
        return text
    return text[: max(0, width - 1)] + "…"


def print_table(rows: list[dict[str, Any]], columns: list[tuple[str, str, int]]) -> None:
    if not rows:
        print("(no rows)")
        return

    widths: list[int] = []
    for key, title, cap in columns:
        width = len(title)
        for row in rows:
            width = max(width, len(str(row.get(key, ""))))
        widths.append(min(width, cap))

    header = "  ".join(title.ljust(widths[i]) for i, (_, title, _) in enumerate(columns))
    print(header)
    print("-" * len(header))

    for row in rows:
        print(
            "  ".join(
                ellipsize(row.get(key, ""), widths[i]).ljust(widths[i])
                for i, (key, _title, _cap) in enumerate(columns)
            )
        )


def print_markdown_table(rows: list[dict[str, Any]], columns: list[tuple[str, str, int]]) -> None:
    titles = [title for _key, title, _cap in columns]
    print("| " + " | ".join(titles) + " |")
    print("| " + " | ".join("---" for _ in titles) + " |")
    for row in rows:
        vals = []
        for key, _title, cap in columns:
            value = ellipsize(row.get(key, ""), cap).replace("|", "\\|")
            vals.append(value)
        print("| " + " | ".join(vals) + " |")


def write_csv(rows: list[dict[str, Any]], columns: list[tuple[str, str, int]], output: str | None) -> None:
    fieldnames = [key for key, _title, _cap in columns]
    if output:
        with open(output, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        print(f"[csv] wrote {output}")
    else:
        writer = csv.DictWriter(sys.stdout, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def print_rows(
    rows: list[dict[str, Any]],
    columns: list[tuple[str, str, int]],
    fmt: str,
    output: str | None = None,
) -> None:
    if fmt == "json":
        text = json.dumps(rows, indent=2, default=str)
        if output:
            with open(output, "w", encoding="utf-8") as f:
                f.write(text + "\n")
            print(f"[json] wrote {output}")
        else:
            print(text)
    elif fmt == "csv":
        write_csv(rows, columns, output)
    elif fmt == "markdown":
        print_markdown_table(rows, columns)
    else:
        print_table(rows, columns)


# -----------------------------------------------------------------------------
# Node helpers
# -----------------------------------------------------------------------------

def node_ord(node: dict[str, Any]) -> str:
    return str(node.get("slotPath") or node.get("ord") or "")


def node_name(node: dict[str, Any]) -> str:
    return str(node.get("display") or node.get("name") or node_ord(node))


def node_type(node: dict[str, Any]) -> str:
    return str(node.get("typeSpec") or node.get("description") or "")


def node_status(node: dict[str, Any]) -> str:
    return str(node.get("status") or "")


def classification(node: dict[str, Any]) -> dict[str, Any]:
    return ((node.get("metadata") or {}).get("classification") or {})


def is_point(node: dict[str, Any]) -> bool:
    c = classification(node)
    if c.get("isPoint") or c.get("isControlPoint") or c.get("isProxyPoint") or c.get("isStatusValue"):
        return True

    t = node_type(node).lower()
    if t.startswith("control:") and (
        "point" in t or "writable" in t or "numeric" in t or "boolean" in t
    ):
        return True

    # kitControl blocks often have readable outputs and are useful for testing,
    # but avoid treating extension/container types as points.
    if t.startswith("kitcontrol:") and "read" in (node.get("operations") or []):
        return True

    return False


def is_schedule(node: dict[str, Any]) -> bool:
    c = classification(node)
    if c.get("isSchedule"):
        return True
    if "read_schedule" in (node.get("operations") or []):
        return True
    return "schedule" in node_type(node).lower()


def children_of(node: dict[str, Any]) -> list[dict[str, Any]]:
    return list(node.get("children") or [])


def should_follow_child(base: str, child_ord: str, follow_external: bool) -> bool:
    if not child_ord:
        return False
    if follow_external:
        return True

    # Niagara can surface station root/config links while browsing a device.
    # Skip those by default so a BACnet device tree does not explode into the
    # whole station.
    if child_ord == "slot:/" and base != "slot:/":
        return False

    normalized_base = base.rstrip("/")
    if normalized_base and not child_ord.startswith(normalized_base):
        # Keep direct children of root.
        if normalized_base == "slot:":
            return True
        return False

    return True


def browse_node(client: BaskStreamClient, ord_value: str, *, metadata: str = "none") -> dict[str, Any]:
    response = client.browse(ord_value, depth=1, metadata=metadata)
    return response.get("node") or {}


def walk_tree(
    client: BaskStreamClient,
    base: str,
    *,
    depth: int,
    metadata: str,
    max_nodes: int,
    follow_external: bool,
) -> list[tuple[int, dict[str, Any]]]:
    rows: list[tuple[int, dict[str, Any]]] = []
    seen: set[str] = set()
    root_base = base.rstrip("/") or base

    def walk(ord_value: str, remaining: int, indent: int) -> None:
        if len(rows) >= max_nodes:
            return

        try:
            node = browse_node(client, ord_value, metadata=metadata)
        except Exception as exc:
            rows.append((indent, {"display": f"! browse failed: {ord_value}", "status": str(exc)}))
            return

        this_ord = node_ord(node) or ord_value
        if this_ord in seen:
            return

        seen.add(this_ord)
        rows.append((indent, node))

        if remaining <= 0:
            return

        for child in children_of(node):
            child_ord = node_ord(child)
            if not should_follow_child(root_base, child_ord, follow_external):
                continue
            walk(child_ord, remaining - 1, indent + 1)

    walk(base, depth, 0)
    return rows


def discover_points(
    client: BaskStreamClient,
    base: str,
    *,
    depth: int,
    query: str,
    max_nodes: int,
    follow_external: bool,
) -> list[dict[str, Any]]:
    matches: dict[str, dict[str, Any]] = {}
    query_l = query.lower().strip()
    walked = walk_tree(
        client,
        base,
        depth=depth,
        metadata="full",
        max_nodes=max_nodes,
        follow_external=follow_external,
    )

    for _indent, node in walked:
        if not is_point(node):
            continue
        ord_value = node_ord(node)
        if not ord_value:
            continue
        haystack = " ".join([node_name(node), ord_value, node_type(node)]).lower()
        if query_l and query_l not in haystack:
            continue
        matches[ord_value] = node

    return [matches[k] for k in sorted(matches)]


def discover_schedules(
    client: BaskStreamClient,
    base: str,
    *,
    depth: int,
    query: str,
    max_nodes: int,
    follow_external: bool,
) -> list[dict[str, Any]]:
    matches: dict[str, dict[str, Any]] = {}
    query_l = query.lower().strip()
    walked = walk_tree(
        client,
        base,
        depth=depth,
        metadata="full",
        max_nodes=max_nodes,
        follow_external=follow_external,
    )

    for _indent, node in walked:
        if not is_schedule(node):
            continue
        ord_value = node_ord(node)
        if not ord_value:
            continue
        haystack = " ".join([node_name(node), ord_value, node_type(node)]).lower()
        if query_l and query_l not in haystack:
            continue
        matches[ord_value] = node

    return [matches[k] for k in sorted(matches)]


def chunks(items: list[str], size: int) -> Iterable[list[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def read_points(client: BaskStreamClient, ords: list[str], *, chunk_size: int = 100) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for batch in chunks(ords, chunk_size):
        response = client.read(batch)
        rows.extend(response.get("points") or [])
    return rows


def normalize_value_row(row: dict[str, Any], meta: dict[str, Any] | None = None) -> dict[str, Any]:
    meta = meta or {}
    value = row.get("displayValue")
    if value in (None, ""):
        value = row.get("value")

    return {
        "name": row.get("displayName") or node_name(meta),
        "value": value,
        "status": row.get("status"),
        "ok": row.get("ok"),
        "type": row.get("valueType") or node_type(meta),
        "timestamp": row.get("timestamp"),
        "ord": row.get("point") or row.get("ord") or node_ord(meta),
    }


# -----------------------------------------------------------------------------
# Commands
# -----------------------------------------------------------------------------

def cmd_health(client: BaskStreamClient, _args: argparse.Namespace) -> None:
    health = client.health()
    if not health:
        raise SystemExit("Not authenticated or /stream/health did not return JSON.")
    print(json.dumps(health, indent=2))


def cmd_smoke(client: BaskStreamClient, args: argparse.Namespace) -> None:
    print("[ping]")
    print(json.dumps(client.ping(), indent=2, default=str))

    print("[capabilities]")
    print(json.dumps(client.capabilities(), indent=2, default=str))

    print(f"[browse] {args.root}")
    node = browse_node(client, args.root, metadata="none")
    children = children_of(node)

    rows = [
        {
            "name": node_name(child),
            "type": node_type(child),
            "status": node_status(child),
            "ord": node_ord(child),
        }
        for child in children
    ]
    print_rows(
        rows,
        [
            ("name", "Name", 34),
            ("type", "Type", 30),
            ("status", "Status", 14),
            ("ord", "ORD", 80),
        ],
        "table",
    )


def cmd_tree(client: BaskStreamClient, args: argparse.Namespace) -> None:
    walked = walk_tree(
        client,
        args.base,
        depth=args.depth,
        metadata=args.metadata,
        max_nodes=args.max_nodes,
        follow_external=args.follow_external,
    )

    for indent, node in walked:
        ord_value = node_ord(node)
        t = node_type(node)
        status = f" {node_status(node)}" if node_status(node) else ""
        if is_point(node):
            marker = "p"
        elif is_schedule(node):
            marker = "s"
        elif node.get("hasChildren"):
            marker = "+"
        else:
            marker = "-"
        print(f"{'  ' * indent}{marker} {node_name(node)}  [{ord_value}]  {t}{status}")


def cmd_values(client: BaskStreamClient, args: argparse.Namespace) -> None:
    points = discover_points(
        client,
        args.base,
        depth=args.depth,
        query=args.query,
        max_nodes=args.max_nodes,
        follow_external=args.follow_external,
    )

    point_ords = [node_ord(p) for p in points if node_ord(p)]
    point_ords = sorted(set(point_ords))[: args.limit]

    print(f"[values] found {len(point_ords)} readable point candidate(s) under {args.base}")

    if args.list_only:
        rows = [
            {
                "name": node_name(p),
                "type": node_type(p),
                "status": node_status(p),
                "ord": node_ord(p),
            }
            for p in points
            if node_ord(p) in point_ords
        ]
        print_rows(
            rows,
            [
                ("name", "Name", 36),
                ("type", "Type", 28),
                ("status", "Status", 16),
                ("ord", "ORD", 90),
            ],
            args.format,
            args.output,
        )
        return

    meta_by_ord = {node_ord(p): p for p in points}
    raw_rows = read_points(client, point_ords, chunk_size=args.chunk_size)
    rows = [normalize_value_row(r, meta_by_ord.get(r.get("point") or "")) for r in raw_rows]

    columns = [
        ("name", "Point", 34),
        ("value", "Value", 18),
        ("status", "Status", 16),
        ("type", "Type", 18),
        ("ord", "ORD", 90),
    ]
    print_rows(rows, columns, args.format, args.output)


def cmd_read(client: BaskStreamClient, args: argparse.Namespace) -> None:
    rows = read_points(client, args.ord, chunk_size=args.chunk_size)
    normalized = [normalize_value_row(r) for r in rows]
    print_rows(
        normalized,
        [
            ("name", "Point", 34),
            ("value", "Value", 18),
            ("status", "Status", 16),
            ("type", "Type", 18),
            ("ord", "ORD", 90),
        ],
        args.format,
        args.output,
    )


def cmd_schedules(client: BaskStreamClient, args: argparse.Namespace) -> None:
    schedules = discover_schedules(
        client,
        args.base,
        depth=args.depth,
        query=args.query,
        max_nodes=args.max_nodes,
        follow_external=args.follow_external,
    )

    rows: list[dict[str, Any]] = []
    now_ms = int(time.time() * 1000)

    for node in schedules[: args.limit]:
        row = {
            "name": node_name(node),
            "type": node_type(node),
            "status": node_status(node),
            "ord": node_ord(node),
        }
        if args.read:
            try:
                sched = client.read_schedule(node_ord(node), at_ms=now_ms)
                row["current"] = json.dumps(sched.get("schedule") or sched, default=str)[:500]
            except Exception as exc:
                row["current"] = f"ERROR: {exc}"
        rows.append(row)

    columns = [
        ("name", "Schedule", 34),
        ("type", "Type", 28),
        ("status", "Status", 16),
        ("ord", "ORD", 90),
    ]
    if args.read:
        columns.append(("current", "Current / Summary", 80))

    print(f"[schedules] found {len(rows)} schedule candidate(s) under {args.base}")
    print_rows(rows, columns, args.format, args.output)


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------

def add_discovery_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--depth", type=int, default=4)
    parser.add_argument("--max-nodes", type=int, default=2000)
    parser.add_argument("--follow-external", action="store_true", help="Follow children that jump outside --base")
    parser.add_argument("--query", default="", help="Case-insensitive name/ORD/type filter")


def add_output_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--format", choices=["table", "markdown", "json", "csv"], default="table")
    parser.add_argument("--output", help="Write json/csv output to a file")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only Niagara baskStream CLI")
    parser.add_argument("--station", default="https://localhost")
    parser.add_argument("--user", default=os.getenv("BASKSTREAM_USER"))
    parser.add_argument("--password", default=os.getenv("BASKSTREAM_PASS"))
    parser.add_argument("--ask-pass", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--verify-tls", action="store_true", help="Verify station TLS certificate")

    sub = parser.add_subparsers(dest="command", required=True)

    health = sub.add_parser("health", help="Login and print /stream/health JSON")
    health.set_defaults(func=cmd_health, needs_ws=False)

    smoke = sub.add_parser("smoke", help="Ping/capabilities/browse smoke test")
    smoke.add_argument("--root", default="slot:/Drivers")
    smoke.set_defaults(func=cmd_smoke, needs_ws=True)

    tree = sub.add_parser("tree", help="Compact station/folder tree")
    tree.add_argument("--base", default="slot:/Drivers")
    tree.add_argument("--depth", type=int, default=3)
    tree.add_argument("--metadata", choices=["none", "full"], default="none")
    tree.add_argument("--max-nodes", type=int, default=1000)
    tree.add_argument("--follow-external", action="store_true")
    tree.set_defaults(func=cmd_tree, needs_ws=True)

    values = sub.add_parser("values", help="Pretty point names and current values")
    values.add_argument("--base", required=True)
    values.add_argument("--limit", type=int, default=1000)
    values.add_argument("--chunk-size", type=int, default=100)
    values.add_argument("--list-only", action="store_true")
    add_discovery_args(values)
    add_output_args(values)
    values.set_defaults(func=cmd_values, needs_ws=True)

    read = sub.add_parser("read", help="Read explicit point ORD(s)")
    read.add_argument("ord", nargs="+")
    read.add_argument("--chunk-size", type=int, default=100)
    add_output_args(read)
    read.set_defaults(func=cmd_read, needs_ws=True)

    schedules = sub.add_parser("schedules", help="List and optionally read schedules")
    schedules.add_argument("--base", default="slot:/")
    schedules.add_argument("--read", action="store_true")
    schedules.add_argument("--limit", type=int, default=1000)
    add_discovery_args(schedules)
    add_output_args(schedules)
    schedules.set_defaults(func=cmd_schedules, needs_ws=True)

    return parser


def main() -> int:
    args = build_parser().parse_args()

    password = args.password
    if args.ask_pass:
        password = getpass.getpass("Niagara password: ")

    if not args.user or not password:
        print("Provide --user/--password, use --ask-pass, or set BASKSTREAM_USER/BASKSTREAM_PASS.")
        return 2

    client = BaskStreamClient(
        args.station,
        verify_tls=args.verify_tls,
        quiet=args.quiet,
    )

    try:
        client.login(args.user, password)

        if getattr(args, "needs_ws", True):
            client.connect()
            client.ping()
            if not args.quiet:
                caps = client.capabilities()
                api_version = (caps.get("capabilities") or {}).get("apiVersion")
                print(f"[capabilities] apiVersion={api_version}")

        args.func(client, args)

    finally:
        client.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
