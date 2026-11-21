// A real station (seen on N4.15) sends some browse nodes with a null name. walkTree used to stop
// with "Cannot read properties of null (reading 'replace')"; it now takes the last part of the
// node's path. Check, export and model infer all walk the tree, so each is run on such a station.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCheck, walkTree } from "../dist/check.js";
import { loadRules } from "../dist/check-rules.js";
import { exportBranch } from "../dist/export.js";
import { inferModel, readEvidence } from "../dist/model.js";
import { startStation } from "./harness.mjs";

const NET = "slot:/Drivers/BacnetNetwork";
const NAMELESS = [`${NET}/AHU_01`, `${NET}/AHU_01/points/SupplyAirTemp`, "slot:/Schedules/OfficeHours", "slot:/Logic/AHU_01"];

/** A station whose browse replies have no name on some nodes: null on most, the field missing on one. */
async function namelessStation() {
  const started = await startStation({ site: "northgate" });
  const browse = started.client.browse.bind(started.client);
  const strip = (node) => {
    if (NAMELESS.includes(node.ord)) {
      if (node.ord === "slot:/Logic/AHU_01") delete node.name;
      else node.name = null;
      delete node.display;
    }
    for (const child of node.children ?? []) strip(child);
    return node;
  };
  started.client.browse = async (...args) => strip(await browse(...args));
  return started;
}

test("a browse node with no name is named by the last part of its path", async () => {
  const { client, close } = await namelessStation();
  try {
    const { nodes } = await walkTree(client, "slot:/");
    assert.deepEqual(NAMELESS.map((ord) => [nodes.get(ord).name, nodes.get(ord).display]), [["AHU_01", "AHU_01"], ["SupplyAirTemp", "SupplyAirTemp"], ["OfficeHours", "OfficeHours"], ["AHU_01", "AHU_01"]]);
    // Its points are still counted under it by name.
    assert.ok(nodes.get(`${NET}/AHU_01`).pointNames.includes("SupplyAirTemp"));
  } finally {
    await close();
  }
});

test("check, export and model infer run on a station that sends null names, and give what they give with names", async () => {
  const plain = await startStation({ site: "northgate" });
  const { station, client, close } = await namelessStation();
  try {
    const key = (result) => result.findings.map((f) => `${f.rule} ${f.where} ${f.message}`);
    const [checked, expected] = [await runCheck(client, loadRules()), await runCheck(plain.client, loadRules())];
    assert.deepEqual(key(checked), key(expected));
    assert.ok(checked.findings.length >= 8);

    const [exported, same] = [await exportBranch(client, "slot:/"), await exportBranch(plain.client, "slot:/")];
    assert.deepEqual(exported, same);
    assert.ok(exported.components.some((c) => c.path === "Drivers/BacnetNetwork/AHU_01/points/SupplyAirTemp"));

    const strip = (station) => void [...station.state.nodes.values()].forEach((node) => void (node.tags = []));
    // With the tags taken away, so the kinds and roles come from the names.
    strip(plain.station);
    strip(station);
    const [nameless, named] = [inferModel((await readEvidence(client, "slot:/")).evidence), inferModel((await readEvidence(plain.client, "slot:/")).evidence)];
    assert.equal(nameless.length, named.length);
    const ahu = nameless.find((e) => e.ord === `${NET}/AHU_01`);
    assert.deepEqual([ahu.name, ahu.kind], ["AHU_01", "ahu"]);
    assert.equal(ahu.points.find((p) => p.ord === `${NET}/AHU_01/points/SupplyAirTemp`).name, "SupplyAirTemp");
    assert.equal(ahu.points.find((p) => p.ord === `${NET}/AHU_01/points/SupplyAirTemp`).role, named.find((e) => e.ord === `${NET}/AHU_01`).points.find((p) => p.name === "SupplyAirTemp").role);
  } finally {
    await close();
    await plain.close();
  }
});
