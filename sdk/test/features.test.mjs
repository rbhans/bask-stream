// The engines are part of the SDK: another program gets them from the package, with no CLI.
import assert from "node:assert/strict";
import test from "node:test";
import * as sdk from "../dist/index.js";

test("the engines are exported from the package", () => {
  for (const name of ["explain", "whyText", "readLog", "logText", "valuesAt", "parseAt", "parseCheckout", "rehearseCheckout", "runCheckout", "checkoutReport",
    "readEvidence", "inferModel", "inferServes", "buildReview", "readSite", "buildSite", "loadSheet", "traceOf", "namedLinks", "fmtPoint", "shortOrd"]) {
    assert.equal(typeof sdk[name], "function", `${name} is exported`);
  }
});

test("a checkout document parses without a station", () => {
  assert.throws(() => sdk.parseCheckout("nothing a checkout could be", "x.md"), sdk.CheckoutParseError);
});
