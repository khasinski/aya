import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAC_OPTION_KEY_MODE,
  isMacOptionKeyMode,
  leftOptionMetaSequence,
  optionSideFromCode,
  shouldUseXtermOptionAsMeta,
} from "../dist-test/terminal-option-key.js";

test("right-option-compose is the default macOS Option mode", () => {
  assert.equal(DEFAULT_MAC_OPTION_KEY_MODE, "right-option-compose");
  assert.equal(shouldUseXtermOptionAsMeta("right-option-compose"), false);
  assert.equal(shouldUseXtermOptionAsMeta("option-as-meta"), true);
});

test("Option side is derived from physical Alt key codes", () => {
  assert.equal(optionSideFromCode("AltLeft"), "left");
  assert.equal(optionSideFromCode("AltRight"), "right");
  assert.equal(optionSideFromCode(""), "unknown");
});

test("left Option sends Meta letters only in iTerm-style mode", () => {
  assert.equal(
    leftOptionMetaSequence("∫", "KeyB", false, "left", "right-option-compose"),
    "\x1bb",
  );
  assert.equal(
    leftOptionMetaSequence("ƒ", "KeyF", false, "right", "right-option-compose"),
    null,
  );
  assert.equal(
    leftOptionMetaSequence("ƒ", "KeyF", false, "left", "option-as-meta"),
    null,
  );
  assert.equal(
    leftOptionMetaSequence("ArrowLeft", "ArrowLeft", false, "left", "right-option-compose"),
    null,
  );
  assert.equal(
    leftOptionMetaSequence("∫", "KeyB", true, "left", "right-option-compose"),
    "\x1bB",
  );
});

test("stored Option key mode values are validated", () => {
  assert.equal(isMacOptionKeyMode("right-option-compose"), true);
  assert.equal(isMacOptionKeyMode("option-as-meta"), true);
  assert.equal(isMacOptionKeyMode("left-option-meta"), false);
  assert.equal(isMacOptionKeyMode(null), false);
});
