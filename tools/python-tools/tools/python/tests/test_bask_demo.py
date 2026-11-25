"""Optional: run against `bask demo --serve` (the upstream simulator).

    cd cli && npm ci && npm run build
    node dist/main.js demo --site northgate --port 47911 --serve
    BASK_DEMO_URL=http://127.0.0.1:47911 python -m pytest tests -q
"""
from __future__ import annotations

import os

import pytest

import baskstream_cli
from baskstream_client import BaskStreamClient

URL = os.environ.get("BASK_DEMO_URL")
USER = os.environ.get("BASK_DEMO_USER", "admin")
PASS = os.environ.get("BASK_DEMO_PASS", "demo")

pytestmark = pytest.mark.skipif(not URL, reason="set BASK_DEMO_URL to a running `bask demo --serve`")


def test_demo_session_and_capabilities():
    with BaskStreamClient(URL, quiet=True, timeout=20) as c:
        c.login(USER, PASS)
        c.connect()
        c.capabilities()
        assert c.api_version
        nodes = c.search("slot:/Drivers", features=["point"], metadata="full", limit=50)["result"]["nodes"]
        assert nodes
        first = nodes[0]["slotPath"]
        assert c.describe(first)["node"]["slotPath"] == first
        assert c.describe_component(first)["result"]["slots"]
        assert c.read([first])["points"][0]["ok"]


@pytest.mark.parametrize("argv", [
    ["smoke"],
    ["values", "--base", "slot:/Drivers", "--limit", "5"],
    ["schedules", "--base", "slot:/", "--read"],
    ["bacnet", "--base", "slot:/Drivers", "--limit", "5"],
    ["tags", "slot:/Drivers/BacnetNetwork"],
])
def test_demo_cli_commands(argv, capsys):
    rc = baskstream_cli.main(["--station", URL, "--user", USER, "--password", PASS, "--quiet",
                              "--timeout", "20", *argv])
    assert rc == 0
    assert "Traceback" not in capsys.readouterr().err
