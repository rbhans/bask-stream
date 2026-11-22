// Values at a moment (src/past.ts): a time as a person types it, the last record of each point's
// history at or before it, and the evenly spaced series a chart is made from. A point with no
// history, or one that was not recording then, is said to have no value rather than given one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAt, parseMoment, pastDisplay, seriesFor, valuesAt } from "../dist/past.js";
import { startStation } from "./harness.mjs";

const NET = "slot:/Drivers/BacnetNetwork";
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STEP = 5 * MIN;
const P = (path) => `${NET}/${path.replace("/", "/points/")}`;

test("a time as typed: a length of time ago, a day and a time, a time of day, a date", () => {
  // A Saturday afternoon, in whatever zone the tests run in.
  const now = new Date(2026, 10, 21, 15, 30, 20).getTime();
  const at = (...parts) => new Date(...parts).getTime();
  assert.deepEqual(parseAt("slot:/Drivers/N/AHU_2", now), { ord: "slot:/Drivers/N/AHU_2" }, "no @ is now: no time at all");
  assert.deepEqual(parseAt("slot:/Drivers/N/AHU_2@3h", now), { ord: "slot:/Drivers/N/AHU_2", at: now - 3 * HOUR });
  assert.deepEqual(parseAt("AHU_2 @ 90m", now), { ord: "AHU_2", at: now - 90 * MIN });
  assert.deepEqual(parseAt("@yesterday", now), { ord: "", at: at(2026, 10, 20, 15, 30, 20) }, "this time of day, the day before");
  assert.equal(parseAt("x@2026-11-17T14:10", now).at, at(2026, 10, 17, 14, 10));
  assert.equal(parseAt("x@2026-11-17 14:10:30", now).at, at(2026, 10, 17, 14, 10, 30));
  assert.equal(parseAt("x@2026-11-17", now).at, at(2026, 10, 17), "a date alone is the start of that day, here");
  assert.equal(parseAt("x@2026-11-17T21:10:00Z", now).at, Date.UTC(2026, 10, 17, 21, 10), "a date that names its zone is read as written");
  assert.equal(parseAt("x@tue-2pm", now).at, at(2026, 10, 17, 14, 0));
  assert.equal(parseAt("x@Tuesday 2:30pm", now).at, at(2026, 10, 17, 14, 30));
  assert.equal(parseAt("x@mon", now).at, at(2026, 10, 16, 15, 30, 20), "a day alone is this time of day then");
  // Today is Saturday: "sat" is a week ago, 9 this morning has been, 6 this evening has not.
  assert.equal(parseAt("x@sat", now).at, at(2026, 10, 14, 15, 30, 20));
  assert.equal(parseAt("x@sat-9am", now).at, at(2026, 10, 21, 9, 0));
  assert.equal(parseAt("x@sat-6pm", now).at, at(2026, 10, 14, 18, 0));
  assert.equal(parseAt("x@9am", now).at, at(2026, 10, 21, 9, 0));
  assert.equal(parseAt("x@23:15", now).at, at(2026, 10, 20, 23, 15), "the last time it was 23:15");
  assert.equal(parseAt("x@yesterday-14:10", now).at, at(2026, 10, 20, 14, 10));
  assert.equal(parseAt("x@today-noon", now).at, at(2026, 10, 21, 12, 0));
  assert.equal(parseAt("x@12am", now).at, at(2026, 10, 21, 0, 0));
  assert.equal(parseAt("x@now", now).at, now);
  assert.equal(parseAt(`x@${now - 5000}`, now).at, now - 5000);
  assert.equal(parseMoment("2d", now), now - 2 * DAY);
  // A slot ORD has no @ in it (Niagara writes one as $40), so the last @ starts the time.
  assert.deepEqual(parseAt("slot:/A$40B/C@1h", now), { ord: "slot:/A$40B/C", at: now - HOUR });

  assert.throws(() => parseAt("x@", now), /ends in @ with no time after it/);
  for (const bad of ["soon", "25:00", "tue-2", "13pm", "2026-13-01", "2026-02-30", "14"]) assert.throws(() => parseAt(`x@${bad}`, now), new RegExp(`^Error: Bad time "${bad}"\\. Use a length of time ago`), bad);
  assert.throws(() => parseAt("x@2027-01-01", now), /has not come yet/);
  assert.throws(() => parseAt("x@today-6pm", now), /has not come yet/);
});

test("values at a moment come from each point's history: the last record at or before it", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    const now = Date.now();
    const zone = P("VAV_105/ZoneTemp");
    const live = (await client.read([zone, P("VAV_105/Airflow")])).map((snap) => snap.value);

    // Now: the newest record, a few minutes old at most, shown as the point shows its value.
    const recent = await valuesAt(client, [zone, P("VAV_105/Airflow")], now);
    const [temp, flow] = [recent.get(zone), recent.get(P("VAV_105/Airflow"))];
    assert.ok(temp.ok && flow.ok);
    assert.ok(temp.at <= now && temp.at % STEP === 0 && temp.ageMs === now - temp.at && temp.ageMs < STEP);
    assert.ok(Math.abs(temp.value - live[0]) < 1 && Math.abs(flow.value - live[1]) < 20, "what the history holds now is what the point reads now");
    assert.match(temp.display, /^7[89]\.\d °F$/);
    assert.match(flow.display, /^\d+ cfm$/, "no decimals, as the point's facets say");

    // Five days ago, before VAV_105 was starved of air: a different building.
    const then = now - 5 * DAY;
    const before = await valuesAt(client, [zone, P("VAV_105/Airflow"), P("VAV_106/Airflow")], then);
    assert.ok(before.get(zone).ok && before.get(zone).value < 74.5 && before.get(zone).at <= then && then - before.get(zone).at < STEP);
    assert.ok(before.get(P("VAV_105/Airflow")).value > 400);
    assert.ok(before.get(P("VAV_106/Airflow")).ok, "it was still recording then");

    // A history that stopped three days ago has no value for now, and says since when.
    const stopped = (await valuesAt(client, [P("VAV_106/Airflow")], now)).get(P("VAV_106/Airflow"));
    assert.equal(stopped.ok, false);
    assert.match(stopped.why, /^Its nearest record is from \d+ \w{3} \d\d:\d\d, 3 days before the time asked for\. It records every 5 min, so it was not recording then\.$/);

    // No history, no such point, and a time before the history starts.
    const none = await valuesAt(client, [P("VAV_105/MaxAirflow"), `${NET}/Nope`, P("AHU_01/OccupiedCmd")], now);
    assert.deepEqual(none.get(P("VAV_105/MaxAirflow")), { ok: false, why: "It keeps no history." });
    assert.deepEqual(none.get(`${NET}/Nope`), { ok: false, why: "There is no such point." });
    assert.deepEqual(none.get(P("AHU_01/OccupiedCmd")), { ok: false, why: "It keeps no history." });
    const early = (await valuesAt(client, [zone], now - 30 * DAY)).get(zone);
    assert.equal(early.ok, false);
    assert.match(early.why, /^Its history starts \d+ \w{3} \d\d:\d\d, after the time asked for\.$/);

    // Every numeric point of the building at once: each is answered, keyed as it was given, in a bounded number of requests.
    const all = [...station.state.nodes.values()].filter((n) => n.kind === "point" && n.vt === "numeric" && !n.logic).map((n) => n.ord);
    const asked = station.state.counters.requests;
    const answers = await valuesAt(client, [...all, all[0], "Drivers/BacnetNetwork/AHU_01/points/SupplyAirTemp"], then);
    assert.equal(answers.size, all.length + 1);
    assert.ok(all.every((ord) => answers.has(ord)));
    assert.ok(answers.get("Drivers/BacnetNetwork/AHU_01/points/SupplyAirTemp").ok, "an ORD is answered under the spelling it was asked in");
    assert.ok(station.state.counters.requests - asked <= 2 * (all.length + 1) + 1, "one read for the facets, then at most two requests a point");
    assert.equal([...answers.values()].filter((v) => !v.ok).length, 1, "only the point with no history has no value");
  } finally {
    await close();
  }
});

test("a history that records on change, a reply cut at its limit, and a bad record, on a station's own shapes", async () => {
  // A stand-in for the client with one point: 12,000 records a minute apart, recorded on change of
  // value (no interval), then one marked down. The replies are the ones the module sends.
  const ord = "slot:/Drivers/N/Dev/points/Status";
  const first = Date.UTC(2026, 10, 1);
  const record = (i) => ({ timestamp: first + i * MIN, recordType: "history:NumericTrendRecord", value: i, valueType: "numeric", status: i === 12000 ? "{down,stale}" : "{ok}", trendFlags: "{ }" });
  const calls = [];
  const client = {
    capabilities: { limits: {} },
    read: async (points) => points.map((point) => ({ point, ok: true, facets: { units: "kW", precision: 1 } })),
    call: async (op) => {
      calls.push(op);
      return { history: { requestOrd: ord, count: 1, histories: [{ historyId: "/S/Status", recordType: "history:NumericTrendRecord", config: { interval: "irregular" }, totalCount: 12001, firstTimestamp: first, lastTimestamp: first + 12000 * MIN, lastRecord: record(12000) }] } };
    },
    historyRollup: async (_ord, { start, end, interval, includeEmpty }) => {
      calls.push("read_history_rollup");
      assert.equal(includeEmpty, false);
      const buckets = [];
      for (let t = start; t < end; t += interval) {
        const count = Array.from({ length: 12001 }, (_v, i) => first + i * MIN).filter((at) => at >= t && at < t + interval && at <= end).length;
        if (count) buckets.push({ start: t, count });
      }
      return { interval, histories: [{ historyId: "/S/Status", buckets }] };
    },
    history: async (_ord, { start, end, limit }) => {
      calls.push("read_history");
      assert.ok(limit <= 5000, "a station gives at most 5000 records in one reply");
      const all = Array.from({ length: 12001 }, (_v, i) => record(i)).filter((r) => r.timestamp >= start && r.timestamp <= end);
      // Oldest first, cut at the limit.
      return { histories: [{ historyId: "/S/Status", records: all.slice(0, limit), truncated: all.length > limit, count: Math.min(all.length, limit) }] };
    }
  };
  // Half a minute after record 9000: that record, however long ago the one before it was.
  const mid = (await valuesAt(client, [ord], first + 9000 * MIN + 30000)).get(ord);
  assert.deepEqual(mid, { ok: true, value: 9000, display: "9000.0 kW", at: first + 9000 * MIN, ageMs: 30000 });
  // A week after its last record: a point that records on change still holds that value, but this one is marked down.
  const late = (await valuesAt(client, [ord], first + 12000 * MIN + 7 * DAY)).get(ord);
  assert.deepEqual(late, { ok: false, why: `Its record at ${new Date(first + 12000 * MIN).getDate()} Nov ${String(new Date(first + 12000 * MIN).getHours()).padStart(2, "0")}:${String(new Date(first + 12000 * MIN).getMinutes()).padStart(2, "0")} is marked {down,stale}, so there is no good value for that time.` });
  // Before it began.
  assert.match((await valuesAt(client, [ord], first - HOUR)).get(ord).why, /^Its history starts .*, after the time asked for\.$/);
  assert.ok(calls.includes("read_history_rollup") && calls.includes("read_history"));

  // A station too old for rollups: the records are read forward, a full reply at a time.
  calls.length = 0;
  const old = { ...client, historyRollup: async () => { throw Object.assign(new (await import("@basidekick/baskstream")).BaskStreamError("unsupported_op", "Unsupported op: read_history_rollup", "read_history_rollup")); } };
  assert.equal((await valuesAt(old, [ord], first + 11000 * MIN + 30000)).get(ord).value, 11000);
  assert.equal(calls.filter((op) => op === "read_history").length, 3, "three replies of 5000 to reach record 11000");

  assert.deepEqual([pastDisplay(72.456, { units: "°F", precision: "1" }), pastDisplay(3, {}), pastDisplay(3.14159, undefined), pastDisplay(true, { trueText: "On", falseText: "Off" }), pastDisplay(false, undefined), pastDisplay("occupied", {})], ["72.5 °F", "3", "3.14", "On", "false", "occupied"]);
});

test("a series for a chart: evenly spaced, a gap where the history has none, undefined with no history", async () => {
  const { client, close } = await startStation({ site: "northgate" });
  try {
    const until = Math.floor(Date.now() / HOUR) * HOUR;
    const since = until - DAY;
    const day = await seriesFor(client, P("AHU_01/SupplyAirTemp"), since, until, 24);
    assert.equal(day.length, 24);
    assert.deepEqual(day.map((p) => p.at), Array.from({ length: 24 }, (_v, i) => since + i * HOUR + HOUR / 2), "each value sits in the middle of its hour");
    assert.ok(day.every((p) => p.value > 50 && p.value < 60));
    // An ORD without its scheme is the same point.
    assert.deepEqual(await seriesFor(client, "Drivers/BacnetNetwork/AHU_01/points/SupplyAirTemp", since, until, 24), day);

    // A history that stopped three days ago: the hours after that are left out, not made up.
    const week = await seriesFor(client, P("VAV_106/Airflow"), until - 6 * DAY, until, 144);
    assert.ok(week.length > 60 && week.length < 80, `${week.length} of 144 hours hold records`);
    assert.ok(week.every((p) => p.at < Date.now() - 71 * HOUR));
    // The station sends those hours as empty buckets, as a station does, and they are not values.
    const raw = (await client.historyRollup(P("VAV_106/Airflow"), { start: until - 6 * DAY, end: until, interval: HOUR })).histories[0];
    assert.equal(raw.buckets.length, 144);
    assert.ok(raw.buckets.filter((b) => b.count === 0).every((b) => b.avg === undefined));
    assert.equal(raw.emptyBuckets, 144 - week.length);

    // No history is not an empty series. A station refuses the read, and so does this one now.
    assert.equal(await seriesFor(client, P("VAV_105/MaxAirflow"), since, until, 24), undefined);
    await assert.rejects(client.historyRollup(P("VAV_105/MaxAirflow"), { start: since, end: until, interval: HOUR }), (error) => error.code === "history_failed");
    await assert.rejects(client.history(P("VAV_105/MaxAirflow"), { start: since, end: until }), (error) => error.code === "history_failed");
    assert.deepEqual(await seriesFor(client, P("AHU_01/SupplyAirTemp"), until, until, 24), [], "no time at all holds nothing");
    // More buckets than a reply may hold are not asked for.
    assert.ok((await seriesFor(client, P("AHU_01/SupplyAirTemp"), since, until, 100000)).length <= 4000);
    // A history read is oldest first and says when it was cut short.
    const cut = (await client.history(P("AHU_01/SupplyAirTemp"), { start: since, end: until, limit: 10 })).histories[0];
    assert.deepEqual([cut.records.length, cut.truncated, cut.records[0].timestamp], [10, true, since]);
  } finally {
    await close();
  }
});
