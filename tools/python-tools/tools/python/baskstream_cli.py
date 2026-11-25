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
  schedules   list and optionally read schedules (now / next event / today)
  describe    one node with full metadata
  component   describe_component: slots, facets, links of one component
  tags        read_tags for one or more ORDs
  resolve     API 1.14: the station's guess at the point for a role on an equipment
  bacnet      BACnet device / object identifiers of points (config/deviceObject, proxyExt)

Discovery uses the station-side `search` operation by default (one request per
base). Pass --walk to fall back to the older recursive `browse` walk.

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

from baskstream_client import BaskStreamClient, BaskStreamError, BaskStreamSessionClosed


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


def write_json(data: Any, output: str | None) -> None:
    text = json.dumps(data, indent=2, default=str)
    if output:
        with open(output, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print(f"[json] wrote {output}")
    else:
        print(text)


def print_rows(
    rows: list[dict[str, Any]],
    columns: list[tuple[str, str, int]],
    fmt: str,
    output: str | None = None,
) -> None:
    if fmt == "json":
        write_json(rows, output)
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


def search_nodes(
    client: BaskStreamClient,
    base: str,
    *,
    feature: str,
    depth: int,
    query: str,
    max_nodes: int,
) -> list[dict[str, Any]]:
    """Station-side discovery with ``search`` (features filter, full metadata)."""
    response = client.search(
        base,
        query=query,
        features=[feature],
        metadata="full",
        depth=max(depth, 1),
        limit=max_nodes,
    )
    result = response.get("result") or {}
    if result.get("truncated") and not client.quiet:
        reasons = ",".join(result.get("truncatedReasons") or []) or "unknown"
        print(
            f"[search] results truncated ({reasons}); raise --max-nodes/--depth or narrow --base",
            file=sys.stderr,
        )
    return list(result.get("nodes") or [])


def _filter_sorted(nodes: Iterable[dict[str, Any]], query: str, keep) -> list[dict[str, Any]]:
    matches: dict[str, dict[str, Any]] = {}
    query_l = query.lower().strip()
    for node in nodes:
        if not keep(node):
            continue
        ord_value = node_ord(node)
        if not ord_value:
            continue
        haystack = " ".join([node_name(node), ord_value, node_type(node)]).lower()
        if query_l and query_l not in haystack:
            continue
        matches[ord_value] = node
    return [matches[k] for k in sorted(matches)]


def discover_points(
    client: BaskStreamClient,
    base: str,
    *,
    depth: int,
    query: str,
    max_nodes: int,
    follow_external: bool,
    walk: bool = False,
) -> list[dict[str, Any]]:
    if walk:
        walked = walk_tree(client, base, depth=depth, metadata="full",
                           max_nodes=max_nodes, follow_external=follow_external)
        return _filter_sorted((n for _i, n in walked), query, is_point)
    nodes = search_nodes(client, base, feature="point", depth=depth, query="", max_nodes=max_nodes)
    return _filter_sorted(nodes, query, lambda _n: True)


def discover_schedules(
    client: BaskStreamClient,
    base: str,
    *,
    depth: int,
    query: str,
    max_nodes: int,
    follow_external: bool,
    walk: bool = False,
) -> list[dict[str, Any]]:
    if walk:
        walked = walk_tree(client, base, depth=depth, metadata="full",
                           max_nodes=max_nodes, follow_external=follow_external)
        return _filter_sorted((n for _i, n in walked), query, is_schedule)
    nodes = search_nodes(client, base, feature="schedule", depth=depth, query="", max_nodes=max_nodes)
    return _filter_sorted(nodes, query, lambda _n: True)


def chunks(items: list[str], size: int) -> Iterable[list[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


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



DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _output_text(output: Any) -> str:
    if not isinstance(output, dict):
        return "" if output is None else str(output)
    text = output.get("displayValue")
    if text in (None, ""):
        text = output.get("value")
    return "" if text is None else str(text)


def schedule_summary(schedule: dict[str, Any], now_ms: int) -> dict[str, str]:
    """Flatten a read_schedule result into Now / Next change / Today columns.

    API 1.14 adds 24-hour ``startTime``/``finishTime``; older stations only send the
    display-format ``start``/``finish``. Both are handled.
    """
    now = _output_text(schedule.get("currentOutput"))
    next_ms = schedule.get("nextEvent")
    next_text = ""
    if isinstance(next_ms, (int, float)) and next_ms > 0:
        next_text = time.strftime("%a %H:%M", time.localtime(next_ms / 1000))
    week = ((schedule.get("tree") or {}).get("week") or {})
    today_name = DAY_NAMES[time.localtime(now_ms / 1000).tm_wday]
    entries = ((week.get(today_name) or {}).get("day") or [])
    spans = []
    for entry in entries:
        start = entry.get("startTime") or entry.get("start") or "?"
        finish = entry.get("finishTime") or entry.get("finish") or "?"
        value = _output_text(entry.get("effectiveValue"))
        spans.append(f"{start}-{finish} {value}".strip())
    return {"now": now, "next": next_text, "today": "; ".join(spans) or "(no entries)"}


def slot_map(component: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result = component.get("result") if "result" in component else component
    return {str(s.get("name")): s for s in (result or {}).get("slots") or [] if s.get("name")}


def slot_text(slot: dict[str, Any] | None) -> str:
    if not slot:
        return ""
    value = slot.get("value")
    if isinstance(value, dict):
        for key in ("encoded", "value"):
            if key in value:
                return str(value[key])
        return ""
    return "" if value is None else str(value)


def bacnet_ids(client: BaskStreamClient, point_ord: str) -> dict[str, str]:
    """objectId / propertyId of a BACnet proxy point, read-only via describe_component."""
    out: dict[str, str] = {}
    for target in (f"{point_ord}/proxyExt", point_ord):
        try:
            slots = slot_map(client.describe_component(target))
        except BaskStreamSessionClosed:
            raise
        except BaskStreamError:
            continue
        for name in ("objectId", "propertyId", "propertyArrayIndex", "writePriority"):
            if name in slots and name not in out:
                out[name] = slot_text(slots[name])
    return out


def device_object_id(client: BaskStreamClient, device_ord: str) -> str:
    for target in (device_ord, f"{device_ord}/config/deviceObject"):
        try:
            slots = slot_map(client.describe_component(target))
        except BaskStreamSessionClosed:
            raise
        except BaskStreamError:
            continue
        if "objectId" in slots:
            return slot_text(slots["objectId"])
    return ""

# -----------------------------------------------------------------------------
# Commands
# -----------------------------------------------------------------------------

def status(args: argparse.Namespace, message: str) -> None:
    """Progress lines go to stderr when stdout carries JSON/CSV, so the output stays parseable."""
    machine = getattr(args, "format", "table") in ("json", "csv") and not getattr(args, "output", None)
    print(message, file=sys.stderr if machine else sys.stdout)


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
        walk=args.walk,
    )

    point_ords = [node_ord(p) for p in points if node_ord(p)]
    point_ords = sorted(set(point_ords))[: args.limit]

    status(args, f"[values] found {len(point_ords)} readable point candidate(s) under {args.base}")

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
        walk=args.walk,
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
                row.update(schedule_summary(sched.get("schedule") or {}, now_ms))
                if args.format == "json":
                    row["schedule"] = sched.get("schedule")
            except BaskStreamSessionClosed:
                raise
            except BaskStreamError as exc:
                row["now"] = f"ERROR: {exc}"
        rows.append(row)

    columns = [
        ("name", "Schedule", 34),
        ("type", "Type", 28),
        ("status", "Status", 16),
    ]
    if args.read:
        columns += [("now", "Now", 16), ("next", "Next change", 20), ("today", "Today", 40)]
    columns.append(("ord", "ORD", 90))

    status(args, f"[schedules] found {len(rows)} schedule candidate(s) under {args.base}")
    print_rows(rows, columns, args.format, args.output)


def cmd_describe(client: BaskStreamClient, args: argparse.Namespace) -> None:
    print(json.dumps(client.describe(args.ord), indent=2, default=str))


def cmd_component(client: BaskStreamClient, args: argparse.Namespace) -> None:
    response = client.describe_component(args.ord)
    if args.format == "json":
        write_json(response, args.output)
        return
    rows = [
        {"slot": name, "type": s.get("typeSpec"), "value": slot_text(s), "writable": s.get("writable")}
        for name, s in slot_map(response).items()
    ]
    print_rows(rows, [("slot", "Slot", 28), ("type", "Type", 36), ("value", "Value", 50),
                      ("writable", "Writable", 8)], args.format, args.output)


def cmd_tags(client: BaskStreamClient, args: argparse.Namespace) -> None:
    response = client.read_tags(args.ord, dictionary=args.dictionary)
    rows = []
    for target in response.get("targets") or []:
        for tag in target.get("tags") or []:
            rows.append({"ord": target.get("ord"), "tag": tag.get("id"),
                         "value": "" if tag.get("marker") else tag.get("value"), "source": tag.get("source")})
        if not target.get("ok"):
            rows.append({"ord": target.get("ord"), "tag": "!", "value": target.get("error"), "source": ""})
    print_rows(rows, [("tag", "Tag", 28), ("value", "Value", 30), ("source", "Source", 8),
                      ("ord", "ORD", 90)], args.format, args.output)


def cmd_resolve(client: BaskStreamClient, args: argparse.Namespace) -> None:
    if client.server_operations is None and client.api_version is None:
        client.capabilities()
    if not client.supports("resolve"):
        raise SystemExit(f"This station (apiVersion {client.api_version}) does not offer resolve; it needs API 1.14.")
    try:
        response = client.resolve(args.equip, role=args.role, tags=args.tag or None)
    except BaskStreamError as exc:
        if "unsupported_op" in str(exc):
            raise BaskStreamError(f"this station (apiVersion {client.api_version}) has no resolve; it needs API 1.14") from exc
        raise
    status(args, f"[resolve] point={response.get('point')} ambiguous={response.get('ambiguous')} (inferred, review before use)")
    rows = [{"score": m.get("score"), "name": m.get("name"), "why": ", ".join(map(str, m.get("why") or [])),
             "ord": m.get("ord")} for m in response.get("matches") or []]
    print_rows(rows, [("score", "Score", 6), ("name", "Name", 30), ("why", "Why", 40),
                      ("ord", "ORD", 90)], args.format, args.output)


def cmd_bacnet(client: BaskStreamClient, args: argparse.Namespace) -> None:
    points = discover_points(client, args.base, depth=args.depth, query=args.query,
                             max_nodes=args.max_nodes, follow_external=args.follow_external, walk=args.walk)
    device_ids: dict[str, str] = {}
    rows = []
    for node in points[: args.limit]:
        ord_value = node_ord(node)
        driver = ((node.get("metadata") or {}).get("driver") or {})
        device_ord = str(driver.get("device") or ord_value.split("/points/")[0])
        if device_ord not in device_ids:
            device_ids[device_ord] = device_object_id(client, device_ord)
        ids = bacnet_ids(client, ord_value)
        rows.append({"name": node_name(node), "device": device_ids[device_ord], "object": ids.get("objectId", ""),
                     "property": ids.get("propertyId", ""), "ord": ord_value})
    status(args, f"[bacnet] {sum(1 for r in rows if r['object'])} of {len(rows)} point(s) carry a BACnet objectId")
    print_rows(rows, [("name", "Point", 30), ("device", "Device", 14), ("object", "Object", 22),
                      ("property", "Property", 14), ("ord", "ORD", 90)], args.format, args.output)


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------

def add_discovery_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--depth", type=int, default=4)
    parser.add_argument("--max-nodes", type=int, default=2000)
    parser.add_argument("--follow-external", action="store_true", help="Follow children that jump outside --base")
    parser.add_argument("--query", default="", help="Case-insensitive name/ORD/type filter")
    parser.add_argument("--walk", action="store_true", help="Use the recursive browse walk instead of search")


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
    parser.add_argument("--timeout", type=positive_int, default=45, help="Seconds to wait for each reply")
    parser.add_argument("--ws-auth", choices=["none", "basic"], default="none",
                        help="Send Authorization on the WebSocket handshake (service requireAuthorizationHeader=true)")
    parser.add_argument("--require-server-signature", action="store_true",
                        help="Fail login unless the station proves itself with a SCRAM server signature")
    parser.add_argument(
        "--allow-insecure-transport",
        action="store_true",
        help="Allow sending WebSocket Authorization credentials over ws:// to a non-loopback host",
    )

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
    values.add_argument("--chunk-size", type=positive_int, default=100)
    values.add_argument("--list-only", action="store_true")
    add_discovery_args(values)
    add_output_args(values)
    values.set_defaults(func=cmd_values, needs_ws=True)

    read = sub.add_parser("read", help="Read explicit point ORD(s)")
    read.add_argument("ord", nargs="+")
    read.add_argument("--chunk-size", type=positive_int, default=100)
    add_output_args(read)
    read.set_defaults(func=cmd_read, needs_ws=True)

    schedules = sub.add_parser("schedules", help="List and optionally read schedules")
    schedules.add_argument("--base", default="slot:/")
    schedules.add_argument("--read", action="store_true")
    schedules.add_argument("--limit", type=int, default=1000)
    add_discovery_args(schedules)
    add_output_args(schedules)
    schedules.set_defaults(func=cmd_schedules, needs_ws=True)

    describe = sub.add_parser("describe", help="One node with full metadata")
    describe.add_argument("ord")
    describe.set_defaults(func=cmd_describe, needs_ws=True)

    component = sub.add_parser("component", help="describe_component: slots of one component")
    component.add_argument("ord")
    add_output_args(component)
    component.set_defaults(func=cmd_component, needs_ws=True)

    tags = sub.add_parser("tags", help="read_tags for one or more ORDs")
    tags.add_argument("ord", nargs="+")
    tags.add_argument("--dictionary", help="only this tag dictionary, e.g. hs")
    add_output_args(tags)
    tags.set_defaults(func=cmd_tags, needs_ws=True)

    resolve = sub.add_parser("resolve", help="API 1.14: guess the point for a role on an equipment")
    resolve.add_argument("equip")
    resolve.add_argument("--role", help='words, e.g. "discharge air temp"')
    resolve.add_argument("--tag", action="append", help="tag name (repeatable)")
    add_output_args(resolve)
    resolve.set_defaults(func=cmd_resolve, needs_ws=True)

    bacnet = sub.add_parser("bacnet", help="BACnet device/object identifiers of discovered points")
    bacnet.add_argument("--base", default="slot:/Drivers")
    bacnet.add_argument("--limit", type=positive_int, default=1000)
    add_discovery_args(bacnet)
    add_output_args(bacnet)
    bacnet.set_defaults(func=cmd_bacnet, needs_ws=True)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

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
        timeout=args.timeout,
        auth_header="basic" if args.ws_auth == "basic" else None,
        require_server_signature=args.require_server_signature,
        allow_insecure_transport=args.allow_insecure_transport,
    )

    try:
        client.login(args.user, password)

        if getattr(args, "needs_ws", True):
            client.connect()
            client.ping()
            client.capabilities()
            if not args.quiet:
                status(args, f"[capabilities] apiVersion={client.api_version}")

        args.func(client, args)

    except BaskStreamError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        client.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
