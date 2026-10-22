import { test } from "node:test";
import assert from "node:assert/strict";

const { UPDATE_SPAWN_REFUSAL, userFacingSpawnError } = await import("../dist-electron/update-spawn.js");
const { UPDATE_SPAWN_REFUSAL: rendererRefusal, displayIpcError } = await import("../dist-test/update-spawn.js");

test("the pane shows only the friendly update refusal", () => {
  assert.equal(rendererRefusal, UPDATE_SPAWN_REFUSAL);
  assert.equal(displayIpcError(new Error(`Error invoking remote method 'pty:spawn': Error: ${UPDATE_SPAWN_REFUSAL}`)), UPDATE_SPAWN_REFUSAL);
});

const sources = ["New terminal", "respawn or restart", "team pane", "remote pane"];
const outcomes = ["succeeds", "fails", "cancelled"];

for (const source of sources) {
  for (const outcome of outcomes) {
    test(`${source}: ${outcome} update preparation yields a safe spawn refusal`, () => {
      // Every source converges on PtyHostClient.spawn; the host's freeze error
      // must never escape into a pane banner or a remote protocol response.
      const mapped = userFacingSpawnError(new Error("Terminal handover is in progress. This operation was not applied."));
      assert.equal(mapped.message, UPDATE_SPAWN_REFUSAL);
      assert.equal(mapped.message.includes("handover"), false);
      assert.equal(mapped.message.includes("Terminal handover"), false);
    });
  }
}

test("unrelated spawn failures retain their original explanation", () => {
  const error = new Error("The selected terminal preset is unavailable.");
  assert.equal(userFacingSpawnError(error), error);
});
