// One size standard for all of Aya: electron/units.ts (aya machines) and src/units.ts (the machines popover) are the
// same file, since electron/ never imports from src/. Absolute values too: both copies changed the same wrong way
// would still agree with each other.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as renderer from "../dist-test/units.js";
import * as main from "../dist-electron/units.js";

test("electron/units.ts and src/units.ts are the same file", () => {
  assert.equal(readFileSync("electron/units.ts", "utf8"), readFileSync("src/units.ts", "utf8"));
});

const CASES = [
  // The bytes /api/ps reported for a loaded model; `ollama ps` printed 9.1 GB, Aya says 8.5 GiB.
  ["gib", 9_086_015_897, "8.5"],
  // A 128 GB Mac's hw.memsize.
  ["gib", 137_438_953_472, "128.0"],
  ["gib", 0, "0.0"],
  ["gib", null, "?"],
  // nvidia-smi's total and used MiB on an RTX 4090.
  ["gibFromMiB", 24_564, "24.0"],
  ["gibFromMiB", 9_190, "9.0"],
  ["gibFromMiB", null, "?"],
];

for (const [fn, input, want] of CASES) {
  test(`${fn}(${input}) is "${want}" in both copies`, () => {
    assert.equal(renderer[fn](input), want);
    assert.equal(main[fn](input), want);
  });
}
