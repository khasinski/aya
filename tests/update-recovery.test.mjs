// A macOS auto-update can fail in a separate ShipIt process AFTER the app
// quits, silently rolling back to the old version (#78). We can't catch it
// where it happens, only diagnose it on the next launch by comparing the
// version we asked ShipIt to install against the one we came back as. This
// pins that pure decision.

import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseRelaunch } from "../dist-electron/update-recovery.js";

test("no marker is a normal launch, not a rollback", () => {
  assert.equal(diagnoseRelaunch(null, "0.8.0"), "none");
});

test("same version means the update applied", () => {
  assert.equal(
    diagnoseRelaunch({ targetVersion: "0.8.1", requestedAt: "" }, "0.8.1"),
    "applied",
  );
});

test("still on the old version means ShipIt silently rolled back", () => {
  assert.equal(
    diagnoseRelaunch({ targetVersion: "0.8.1", requestedAt: "" }, "0.8.0"),
    "rolled-back",
  );
});

test("a marker with no targetVersion is treated as none, not a rollback", () => {
  assert.equal(
    diagnoseRelaunch({ targetVersion: "", requestedAt: "" }, "0.8.0"),
    "none",
  );
});
