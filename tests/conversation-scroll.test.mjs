import { test } from "node:test";
import assert from "node:assert/strict";
import { movedUpFromFollowedPosition } from "../dist-test/conversation-scroll.js";

test("small and fractional upward movements leave the followed position", () => {
  for (const distance of [0.25, 1, 12, 40, 120]) {
    assert.equal(movedUpFromFollowedPosition(1000 - distance, 1000, 1000), true, `${distance}px`);
  }
});

test("stream growth alone, downward movement and initial layout are not user scrolls", () => {
  assert.equal(movedUpFromFollowedPosition(1000, 1200, 1000), false);
  assert.equal(movedUpFromFollowedPosition(1100, 1200, 1000), false);
  assert.equal(movedUpFromFollowedPosition(0, 1200, null), false);
});

test("browser clamping after content or viewport resizing keeps follow active", () => {
  assert.equal(movedUpFromFollowedPosition(900, 900, 1000), false);
  assert.equal(movedUpFromFollowedPosition(0, 0, 1000), false);
  assert.equal(movedUpFromFollowedPosition(999.995, 1000, 1000), false, "ignore subpixel rounding noise");
});
