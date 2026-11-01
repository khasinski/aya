import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THEME_CODEC,
  MAC_OPTION_CODEC,
  LAYOUT_CODEC,
  HARNESS_NAME_CODEC,
  GITHUB_LINK_CODEC,
  HARNESS_SEARCH_CODEC,
  TERMINAL_SOUNDS_CODEC,
  STATUS_RAIL_COLLAPSED_CODEC,
  SOUND_OVERRIDES_CODEC,
  SOUND_PATH_CODEC,
  readTerminalFontFamily,
} from "../dist-test/app-preferences.js";
import { TERMINAL_FONT_FAMILY_STORAGE_KEY } from "../dist-test/storage-keys.js";

function useStorage(t, storage) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  });
}

function checkEnum(codec, values, fallback) {
  assert.equal(codec.fallback, fallback);
  for (const value of values) {
    assert.equal(codec.parse(value), value);
    assert.equal(codec.serialize(value), value);
    assert.equal(codec.parse(codec.serialize(value)), value);
  }
  for (const raw of ["", "invalid", ` ${values[0]}`, values[0].toUpperCase()]) {
    assert.equal(codec.parse(raw), fallback);
  }
}

test("theme codec preserves every theme and falls back to system", () => {
  checkEnum(THEME_CODEC, ["system", "light", "dark", "omarchy", "violet"], "system");
});

test("Mac option codec preserves both modes and defaults to right-option-compose", () => {
  checkEnum(MAC_OPTION_CODEC, ["right-option-compose", "option-as-meta"], "right-option-compose");
});

test("layout codec preserves both layouts and defaults to classic", () => {
  checkEnum(LAYOUT_CODEC, ["classic", "projects-left"], "classic");
});

for (const [name, codec, fallback] of [
  ["harness name", HARNESS_NAME_CODEC, true],
  ["GitHub link", GITHUB_LINK_CODEC, false],
  ["harness search", HARNESS_SEARCH_CODEC, false],
  ["terminal sounds", TERMINAL_SOUNDS_CODEC, true],
  ["status rail collapsed", STATUS_RAIL_COLLAPSED_CODEC, false],
]) {
  test(`${name} codec keeps its default and legacy flag semantics`, () => {
    assert.equal(codec.fallback, fallback);
    assert.equal(codec.parse("1"), true);
    assert.equal(codec.parse("0"), false);
    for (const raw of ["", "true", "false", "garbage", " 0", " 1"]) {
      assert.equal(codec.parse(raw), fallback);
    }
    for (const value of [true, false]) {
      assert.equal(codec.serialize(value), value ? "1" : "0");
      assert.equal(codec.parse(codec.serialize(value)), value);
    }
  });
}

test("sound overrides codec keeps only boolean map entries", () => {
  assert.deepEqual(SOUND_OVERRIDES_CODEC.fallback, {});
  assert.deepEqual(
    SOUND_OVERRIDES_CODEC.parse('{"claude":false,"codex":true,"shell":0,"other":"false","nested":{},"empty":null}'),
    { claude: false, codex: true },
  );
  const value = { claude: false, codex: true };
  assert.equal(SOUND_OVERRIDES_CODEC.serialize(value), '{"claude":false,"codex":true}');
  assert.deepEqual(SOUND_OVERRIDES_CODEC.parse(SOUND_OVERRIDES_CODEC.serialize(value)), value);
});

test("sound overrides codec rejects malformed JSON and non-map values", () => {
  for (const raw of ["", "{", "null", "false", "42", '"sound"', "[]", '[true,false]']) {
    assert.deepEqual(SOUND_OVERRIDES_CODEC.parse(raw), {});
  }
});

test("sound path codec treats blank paths as null and preserves nonblank whitespace", () => {
  assert.equal(SOUND_PATH_CODEC.fallback, null);
  for (const raw of ["", " ", "\t\n"]) assert.equal(SOUND_PATH_CODEC.parse(raw), null);
  for (const value of ["/tmp/chime.wav", " /tmp/chime.wav ", null]) {
    assert.equal(SOUND_PATH_CODEC.serialize(value), value ?? "");
    assert.equal(SOUND_PATH_CODEC.parse(SOUND_PATH_CODEC.serialize(value)), value);
  }
});

test("terminal font reader uses the original key and preserves stored text", (t) => {
  let stored = null;
  useStorage(t, {
    getItem(key) {
      assert.equal(key, TERMINAL_FONT_FAMILY_STORAGE_KEY);
      return stored;
    },
  });
  assert.equal(readTerminalFontFamily(), "");
  for (const value of ["", "  ", "JetBrains Mono", " JetBrains Mono "]) {
    stored = value;
    assert.equal(readTerminalFontFamily(), value);
  }
});

test("terminal font reader still propagates storage failures", (t) => {
  const error = new Error("storage unavailable");
  useStorage(t, { getItem() { throw error; } });
  assert.throws(() => readTerminalFontFamily(), (caught) => caught === error);
});
