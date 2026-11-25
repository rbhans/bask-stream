"""baskstream_cli end to end against the fake API 1.14 station."""
from __future__ import annotations

import json

import pytest

import baskstream_cli
from fake_baskstream_station import FakeBaskStreamStation

AHU = "slot:/Drivers/BacnetNetwork/LabAHU_01"


def run(st, *argv, capsys):
    rc = baskstream_cli.main(["--station", st.url, "--user", st.user, "--password", st.password,
                              "--quiet", "--timeout", "5", *argv])
    out = capsys.readouterr()
    return rc, out.out, out.err


def test_values_uses_search_and_reads(capsys):
    with FakeBaskStreamStation() as st:
        rc, out, _ = run(st, "values", "--base", "slot:/Drivers", "--format", "json", capsys=capsys)
        assert "browse" not in st.state.received_ops
    assert rc == 0
    rows = json.loads(out)
    assert {r["name"] for r in rows} >= {"SA_Temp", "Fan_Cmd", "ZN_T"}
    assert next(r for r in rows if r["name"] == "SA_Temp")["value"] == "55.2"


def test_values_walk_fallback(capsys):
    with FakeBaskStreamStation() as st:
        rc, out, _ = run(st, "values", "--base", "slot:/Drivers", "--walk", "--list-only", capsys=capsys)
        assert "browse" in st.state.received_ops
    assert rc == 0 and "SA_Temp" in out


def test_schedules_read_prints_table_not_dict(capsys):
    with FakeBaskStreamStation() as st:
        rc, out, _ = run(st, "schedules", "--base", "slot:/", "--read", capsys=capsys)
    assert rc == 0
    assert "OfficeHours" in out and "Occupied" in out
    assert "{'" not in out and '{"' not in out  # no raw dict dumps in the table


@pytest.mark.parametrize("today,expected", [
    ({"startTime": "06:30", "finishTime": "18:00", "start": "6:30 AM", "finish": "6:00 PM"}, "06:30-18:00"),
    ({"start": "6:30 AM", "finish": "6:00 PM"}, "6:30 AM-6:00 PM"),  # pre-1.14 station
])
def test_schedule_summary_handles_old_and_new_times(today, expected):
    import time
    now = int(time.time() * 1000)
    day = baskstream_cli.DAY_NAMES[time.localtime(now / 1000).tm_wday]
    sched = {"currentOutput": {"displayValue": "Occupied"}, "nextEvent": now + 3600_000,
             "tree": {"week": {day: {"day": [dict(today, effectiveValue={"displayValue": "Occupied"})]}}}}
    summary = baskstream_cli.schedule_summary(sched, now)
    assert summary["now"] == "Occupied"
    assert summary["today"].startswith(expected)


def test_bacnet_command_lists_object_ids(capsys):
    with FakeBaskStreamStation() as st:
        rc, out, _ = run(st, "bacnet", "--base", "slot:/Drivers", "--format", "json", capsys=capsys)
        assert st.state.write_attempts == []
    rows = json.loads(out)
    by = {r["name"]: r for r in rows}
    assert by["SA_Temp"]["device"] == "device:10001"
    assert by["SA_Temp"]["object"] == "analogInput:1"
    assert by["Calc_Avg"]["object"] == ""


def test_describe_component_tags_resolve(capsys):
    with FakeBaskStreamStation() as st:
        rc, out, _ = run(st, "component", f"{AHU}/config/deviceObject", capsys=capsys)
        assert rc == 0 and "device:10001" in out
        rc, out, _ = run(st, "tags", AHU, "--dictionary", "hs", capsys=capsys)
        assert rc == 0 and "hs:ahu" in out
        rc, out, _ = run(st, "resolve", AHU, "--role", "discharge air temp sensor", capsys=capsys)
        assert rc == 0 and "SA_Temp" in out


def test_bad_chunk_size_rejected():
    with pytest.raises(SystemExit):
        baskstream_cli.build_parser().parse_args(["read", "slot:/x", "--chunk-size", "0"])


def test_session_revoked_is_a_clean_error(capsys):
    with FakeBaskStreamStation(revoke_on="search") as st:
        rc, _out, err = run(st, "values", "--base", "slot:/Drivers", capsys=capsys)
    assert rc == 1 and "session_revoked" in err


def test_password_never_printed(capsys):
    with FakeBaskStreamStation() as st:
        baskstream_cli.main(["--station", st.url, "--user", st.user, "--password", st.password,
                             "--timeout", "5", "smoke"])
        out = capsys.readouterr()
    assert st.password not in out.out and st.password not in out.err


def test_api_1_12_station_cli(capsys):
    with FakeBaskStreamStation(api_version="1.12") as st:
        rc, out, _ = run(st, "bacnet", "--base", "slot:/Drivers", "--format", "json", capsys=capsys)
        assert rc == 0
        by = {r["name"]: r for r in json.loads(out)}
        assert by["SA_Temp"]["object"] == "analogInput:1"
        with pytest.raises(SystemExit) as err:
            run(st, "resolve", AHU, "--role", "discharge air temp sensor", capsys=capsys)
        assert "1.14" in str(err.value) and "1.12" in str(err.value)
