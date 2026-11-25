"""baskstream_client against an in-process fake API 1.14 station (no real station)."""
from __future__ import annotations

import pytest

from baskstream_client import (
    READ_ONLY_OPS,
    BaskStreamClient,
    BaskStreamError,
    BaskStreamSessionClosed,
)
from fake_baskstream_station import FakeBaskStreamStation

AHU = "slot:/Drivers/BacnetNetwork/LabAHU_01"


def connected(st, **kw):
    c = BaskStreamClient(st.url, quiet=True, timeout=kw.pop("timeout", 5), **kw)
    c.login(st.user, st.password)
    c.connect()
    return c


def test_login_verifies_scram_server_signature():
    with FakeBaskStreamStation() as st, connected(st) as c:
        assert c.server_signature_verified
        assert c.health()["authenticatedUser"] == st.user


def test_login_rejects_forged_server_signature():
    with FakeBaskStreamStation(tamper_server_signature=True) as st:
        with BaskStreamClient(st.url, quiet=True, timeout=5) as c:
            with pytest.raises(BaskStreamError, match="server signature"):
                c.login(st.user, st.password)


def test_missing_signature_only_fails_when_required():
    with FakeBaskStreamStation(omit_server_signature=True) as st:
        with BaskStreamClient(st.url, quiet=True, timeout=5) as c:
            c.login(st.user, st.password)
            assert not c.server_signature_verified
        with BaskStreamClient(st.url, quiet=True, timeout=5, require_server_signature=True) as c:
            with pytest.raises(BaskStreamError, match="no server signature"):
                c.login(st.user, st.password)


def test_authorization_header_on_handshake():
    with FakeBaskStreamStation(require_auth_header=True) as st:
        with BaskStreamClient(st.url, quiet=True, timeout=5) as c:
            c.login(st.user, st.password)
            with pytest.raises(Exception, match="403"):
                c.connect()
        with connected(st, auth_header="basic") as c:
            assert c.ping()["op"] == "pong"
        assert any(h.get("Authorization", "").startswith("Basic ") for h in st.state.ws_handshake_headers)


def test_capabilities_and_supports():
    with FakeBaskStreamStation() as st, connected(st) as c:
        assert c.supports("resolve")  # unknown until capabilities is read
        c.capabilities()
        assert c.api_version == "1.14"
        assert c.supports("resolve") and not c.supports("no_such_op")


def test_describe_component_and_read_tags():
    with FakeBaskStreamStation() as st, connected(st) as c:
        node = c.describe(f"{AHU}/points/SA_Temp")["node"]
        assert node["metadata"]["classification"]["isProxyPoint"]
        proxy = c.describe_component(f"{AHU}/points/SA_Temp/proxyExt")["result"]
        assert {s["name"] for s in proxy["slots"]} >= {"objectId", "propertyId"}
        tags = c.read_tags(AHU, dictionary="hs")["targets"][0]
        assert {t["id"] for t in tags["tags"]} == {"hs:equip", "hs:ahu"}
        with pytest.raises(ValueError):
            c.read_tags([])


def test_resolve_suggests_a_point():
    with FakeBaskStreamStation() as st, connected(st) as c:
        res = c.resolve(AHU, role="discharge air temp sensor")
        assert res["inferred"] and res["matches"][0]["name"] == "SA_Temp"
        with pytest.raises(ValueError):
            c.resolve(AHU)


def test_search_discovers_points_in_one_request():
    with FakeBaskStreamStation() as st, connected(st) as c:
        before = len(st.state.received_ops)
        nodes = c.search("slot:/Drivers", features=["point"], metadata="full")["result"]["nodes"]
        assert len(nodes) == 9
        assert st.state.received_ops[before:] == ["search"]


def test_write_ops_refused_before_sending():
    with FakeBaskStreamStation() as st, connected(st) as c:
        for op in ("write", "write_tags", "delete_components", "write_schedule"):
            with pytest.raises(BaskStreamError, match="not a read operation"):
                c.call(op, ord=AHU)
        assert st.state.write_attempts == []
        assert set(st.state.received_ops) <= READ_ONLY_OPS


def test_allow_writes_opt_in_reaches_station_which_refuses():
    with FakeBaskStreamStation() as st, connected(st, allow_writes=True) as c:
        with pytest.raises(BaskStreamError, match="forbidden"):
            c.call("write", point=f"{AHU}/points/SAT_SP", value=50)
        assert len(st.state.write_attempts) == 1


def test_notices_are_kept_and_terminal_ones_raise():
    notices = {"ping": [{"op": "resync_required", "reason": "event_backlog", "droppedEvents": 3}]}
    with FakeBaskStreamStation(notices_before=notices) as st, connected(st) as c:
        c.ping()
        assert [n["op"] for n in c.notices] == ["resync_required"]
    with FakeBaskStreamStation(revoke_on="search") as st, connected(st) as c:
        with pytest.raises(BaskStreamSessionClosed, match="session_revoked"):
            c.search("slot:/Drivers")
    with FakeBaskStreamStation(timeout_on="read") as st, connected(st) as c:
        with pytest.raises(BaskStreamSessionClosed, match="request_timeout"):
            c.read([f"{AHU}/points/SA_Temp"])


def test_unanswered_request_times_out():
    with FakeBaskStreamStation(silent_on="ping") as st, connected(st, timeout=1) as c:
        with pytest.raises(BaskStreamError, match="timed out"):
            c.ping()


def test_close_closes_http_session():
    with FakeBaskStreamStation() as st:
        c = connected(st)
        c.close()
        assert c.ws is None
        c.close()  # idempotent


def test_api_1_12_station_gates_resolve_locally():
    """The signed upstream jar is API 1.12: everything but resolve works; resolve is refused before sending."""
    with FakeBaskStreamStation(api_version="1.12") as st, connected(st) as c:
        caps = c.capabilities()["capabilities"]
        assert caps["apiVersion"] == "1.12" and c.api_version == "1.12"
        for op in ("search", "describe", "describe_component", "read_tags", "read"):
            assert c.supports(op)
        assert not c.supports("resolve")
        sent = len(st.state.received_ops)
        with pytest.raises(BaskStreamError, match=r"needs baskStream API 1\.14\+ \(station reports 1\.12\)"):
            c.resolve(AHU, role="discharge air temp sensor")
        assert len(st.state.received_ops) == sent
        assert c.describe_component(f"{AHU}/config/deviceObject")
