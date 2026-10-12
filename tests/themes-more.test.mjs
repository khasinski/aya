// Pins how themes.json in AYA_HOME is read and written: a missing file is seeded with the
// built-in themes, a hand-edited file keeps only the themes whose colors validate, a file
// with no usable theme is reset to the defaults, a broken file is never overwritten, and
// a save drops what does not validate. Also the iTerm2 importer's failures on hostile
// color dicts. The file is user-editable, so wrong types and odd values are the main cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "aya-themes-more-"));
process.env.AYA_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));

// paths.ts resolves THEMES_FILE at load, so the module is imported after AYA_HOME is set.
const {
  AYA_DARK,
  TOKYO_NIGHT,
  DEFAULT_THEMES,
  loadThemes,
  saveThemes,
  parseItermColors,
} = await import("../dist-electron/themes.js");
const { THEMES_FILE } = await import("../dist-electron/paths.js");

const DEFAULT_IDS = DEFAULT_THEMES.map((t) => t.id);

/** A valid custom theme with one color slot overridden. */
const custom = (id, colors = {}, extra = {}) => ({
  id,
  name: `Theme ${id}`,
  colors: { ...TOKYO_NIGHT.colors, ...colors },
  ...extra,
});

async function writeThemes(content) {
  await rm(THEMES_FILE, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  await writeFile(THEMES_FILE, typeof content === "string" ? content : JSON.stringify(content));
}

const readDisk = () => readFile(THEMES_FILE, "utf-8");

test("THEMES_FILE lives in the temp AYA_HOME, not the real config", () => {
  assert.equal(THEMES_FILE, join(home, "themes.json"));
});

test("a missing themes.json is seeded with the five built-in themes and Aya Dark active", async () => {
  await rm(THEMES_FILE, { force: true });
  const file = await loadThemes();
  assert.deepEqual(file.themes.map((t) => t.id), DEFAULT_IDS);
  assert.equal(file.activeId, AYA_DARK.id);
  const disk = JSON.parse(await readDisk());
  assert.deepEqual(disk, { themes: [...DEFAULT_THEMES], activeId: AYA_DARK.id });
});

test("a valid file is returned as written, with its active theme, and not rewritten", async () => {
  const content = JSON.stringify({ themes: [custom("a"), custom("b")], activeId: "b" });
  await writeThemes(content);
  const file = await loadThemes();
  assert.deepEqual(file.themes.map((t) => t.id), ["a", "b"]);
  assert.equal(file.activeId, "b");
  assert.equal(await readDisk(), content);
});

test("unknown top-level keys are not returned", async () => {
  await writeThemes({ themes: [custom("a")], activeId: "a", extra: { huge: "x".repeat(1000) }, version: 99 });
  const file = await loadThemes();
  assert.deepEqual(Object.keys(file).sort(), ["activeId", "themes"]);
});

test("a __proto__ key in the file does not pollute Object.prototype", async () => {
  await writeThemes(
    '{"__proto__":{"polluted":true},"themes":[{"__proto__":{"polluted":true},"id":"a","name":"A","colors":' +
      JSON.stringify(TOKYO_NIGHT.colors) +
      "}],\"activeId\":\"a\"}",
  );
  const file = await loadThemes();
  assert.deepEqual(file.themes.map((t) => t.id), ["a"]);
  assert.equal({}.polluted, undefined);
});

// [label, theme entry that must be dropped]
const INVALID_THEMES = [
  ["null entry", null],
  ["string entry", "aya-dark"],
  ["number entry", 42],
  ["array entry", [custom("arr")]],
  ["numeric id", { ...custom("x"), id: 7 }],
  ["empty id", custom("")],
  ["missing name", { id: "noname", colors: TOKYO_NIGHT.colors }],
  ["object name", { ...custom("objname"), name: { text: "x" } }],
  ["colors null", { ...custom("cnull"), colors: null }],
  ["colors a string", { ...custom("cstr"), colors: "#ffffff" }],
  ["colors missing", { id: "nocolors", name: "No colors" }],
  ["a required slot missing", { ...custom("noslot"), colors: { ...TOKYO_NIGHT.colors, brightWhite: undefined } }],
  ["a color as a number", custom("num", { red: 0xff0000 })],
  ["a short #rgb hex", custom("short", { background: "#fff" })],
  ["a named color", custom("named", { foreground: "red" })],
  ["a non-hex digit", custom("nonhex", { cursor: "#12345g" })],
  ["a 7-digit hex", custom("seven", { black: "#1234567" })],
  ["a leading space", custom("lead", { blue: " #ffffff" })],
  ["a trailing newline", custom("trail", { cyan: "#ffffff\n" })],
  ["a megabyte-long hex", custom("huge", { white: "#" + "f".repeat(1_000_000) })],
  ["hsl(", custom("hsl", { green: "hsl(0, 0%, 0%)" })],
];

for (const [label, bad] of INVALID_THEMES) {
  test(`a theme with ${label} is dropped while the valid ones load, and the file is left alone`, async () => {
    const content = JSON.stringify({ themes: [custom("good"), bad], activeId: "good" });
    await writeThemes(content);
    const file = await loadThemes();
    assert.deepEqual(file.themes.map((t) => t.id), ["good"]);
    assert.equal(file.activeId, "good");
    assert.equal(await readDisk(), content);
  });
}

test("accepted color forms: #rrggbb in either case, #rrggbbaa, rgb( and rgba(", async () => {
  const theme = custom("forms", {
    background: "#ABCDEF",
    foreground: "#abcdef",
    cursor: "#11223344",
    red: "rgb(1,2,3)",
    green: "rgba(1,2,3,0.5)",
  });
  await writeThemes({ themes: [theme], activeId: "forms" });
  const file = await loadThemes();
  assert.deepEqual(file.themes, [theme]);
});

// [label, activeId in the file]
const STRAY_ACTIVE = [
  ["missing", undefined],
  ["an unknown id", "nope"],
  ["the id of a dropped theme", "bad"],
  ["a number", 1],
  ["an object", { id: "b" }],
  ["an array", ["b"]],
  ["null", null],
];

for (const [label, activeId] of STRAY_ACTIVE) {
  test(`an activeId that is ${label} falls back to the first valid theme`, async () => {
    await writeThemes({ themes: [{ ...custom("bad"), colors: {} }, custom("a"), custom("b")], activeId });
    const file = await loadThemes();
    assert.equal(file.activeId, "a");
  });
}

// [label, whole file content with no usable theme]
const NO_USABLE_THEME = [
  ["JSON null", "null"],
  ["a JSON number", "12"],
  ["a JSON string", '"themes"'],
  ["a JSON array", JSON.stringify([custom("a")])],
  ["an empty object", "{}"],
  ["themes as an object", JSON.stringify({ themes: { a: custom("a") }, activeId: "a" })],
  ["themes as a string", JSON.stringify({ themes: "aya-dark", activeId: "aya-dark" })],
  ["an empty themes list", JSON.stringify({ themes: [], activeId: "a" })],
  ["only invalid themes", JSON.stringify({ themes: [custom("a", { red: "#f00" }), null], activeId: "a" })],
];

for (const [label, content] of NO_USABLE_THEME) {
  test(`a file with ${label} is reset to the built-in themes on disk`, async () => {
    await writeThemes(content);
    const file = await loadThemes();
    assert.deepEqual(file.themes.map((t) => t.id), DEFAULT_IDS);
    assert.equal(file.activeId, AYA_DARK.id);
    assert.deepEqual(JSON.parse(await readDisk()), { themes: [...DEFAULT_THEMES], activeId: AYA_DARK.id });
  });
}

test("a file that is not JSON rejects and is left byte for byte, so a half-edit is not lost", async () => {
  const content = '{"themes":[' + JSON.stringify(custom("a")) + ",], // trailing comma\n";
  await writeThemes(content);
  await assert.rejects(loadThemes(), SyntaxError);
  assert.equal(await readDisk(), content);
});

test("an empty file rejects instead of being reset", async () => {
  await writeThemes("");
  await assert.rejects(loadThemes(), SyntaxError);
  assert.equal(await readDisk(), "");
});

test("a read error other than a missing file (themes.json is a directory) rejects and seeds nothing", async () => {
  await rm(THEMES_FILE, { recursive: true, force: true });
  await mkdir(THEMES_FILE);
  try {
    await assert.rejects(loadThemes(), (err) => err.code === "EISDIR");
  } finally {
    await rm(THEMES_FILE, { recursive: true, force: true });
  }
});

test("saveThemes drops themes that do not validate and keeps activeId as given", async () => {
  await rm(THEMES_FILE, { force: true });
  await saveThemes({
    themes: [custom("a"), custom("bad", { red: "red" }), { id: "x" }, null, custom("b")],
    activeId: "b",
  });
  const raw = await readDisk();
  assert.ok(raw.endsWith("}\n"), "pretty JSON with a trailing newline");
  assert.equal(raw, JSON.stringify({ themes: [custom("a"), custom("b")], activeId: "b" }, null, 2) + "\n");
});

test("saveThemes then loadThemes round-trips the themes and the active id", async () => {
  const themes = [custom("one"), AYA_DARK, custom("two", { selectionBackground: "rgba(0,0,0,0.5)" })];
  await saveThemes({ themes, activeId: "two" });
  const file = await loadThemes();
  assert.deepEqual(file, { themes, activeId: "two" });
});

test("saveThemes creates AYA_HOME when it is missing", async () => {
  await rm(home, { recursive: true, force: true });
  await saveThemes({ themes: [custom("a")], activeId: "a" });
  assert.deepEqual(JSON.parse(await readDisk()).themes.map((t) => t.id), ["a"]);
});

// --- iTerm2 importer: hostile color dicts --------------------------------

function colorDict(r, g, b) {
  return `<dict><key>Red Component</key><real>${r}</real><key>Green Component</key><real>${g}</real><key>Blue Component</key><real>${b}</real></dict>`;
}

/** An .itermcolors plist; `overrides` replaces (string) or removes (null) a key's value. */
function itermPlist(overrides = {}) {
  const entries = {};
  for (let i = 0; i < 16; i++) entries[`Ansi ${i} Color`] = colorDict(i / 15, 0, 0);
  entries["Background Color"] = colorDict(0, 0, 0);
  entries["Foreground Color"] = colorDict(1, 1, 1);
  Object.assign(entries, overrides);
  const body = Object.entries(entries)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `<key>${k}</key>${v}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${body}</dict></plist>`;
}

test("iTerm2: an ANSI color that is a string, not a dict, is reported by its index", () => {
  assert.throws(
    () => parseItermColors(itermPlist({ "Ansi 4 Color": "<string>#0000ff</string>" }), "X"),
    /no usable "Ansi 4 Color"/,
  );
});

test("iTerm2: an ANSI color with any component that is not a number is reported", () => {
  for (const channel of ["Red", "Green", "Blue"]) {
    const dict =
      "<dict>" +
      ["Red", "Green", "Blue"]
        .map((c) => `<key>${c} Component</key>${c === channel ? "<string>1</string>" : "<real>0</real>"}`)
        .join("") +
      "</dict>";
    assert.throws(
      () => parseItermColors(itermPlist({ "Ansi 9 Color": dict }), "X"),
      /no usable "Ansi 9 Color"/,
      `${channel} as a string`,
    );
  }
});

test("iTerm2: a missing last ANSI slot (15) is reported", () => {
  assert.throws(() => parseItermColors(itermPlist({ "Ansi 15 Color": null }), "X"), /no usable "Ansi 15 Color"/);
});

test("iTerm2: a missing or malformed background or foreground is reported", () => {
  for (const key of ["Background Color", "Foreground Color"]) {
    assert.throws(() => parseItermColors(itermPlist({ [key]: null }), "X"), /no usable Background or Foreground/);
    assert.throws(
      () => parseItermColors(itermPlist({ [key]: "<dict><key>Red Component</key><real>1</real></dict>" }), "X"),
      /no usable Background or Foreground/,
    );
  }
});

test("iTerm2: finite components outside 0..1, however large, are clamped to 00..ff; an infinite one is refused", () => {
  const t = parseItermColors(
    itermPlist({
      "Background Color": colorDict(-5, 2, 1e308),
      "Foreground Color": colorDict(1e308, -1e308, 0.5),
    }),
    "Clamp",
  );
  assert.equal(t.colors.background, "#00ffff");
  assert.equal(t.colors.foreground, "#ff0080");
  // 1e400 parses as Infinity: not a component, like nan (#192).
  assert.throws(() => parseItermColors(itermPlist({ "Background Color": colorDict(-5, 2, 1e400) }), "X"), /no usable Background or Foreground/);
});

test("iTerm2: no cursor or selection color falls back to the foreground and leaves selection unset", () => {
  const t = parseItermColors(itermPlist({ "Cursor Color": null, "Selection Color": "<string>x</string>" }), "Bare");
  assert.equal(t.colors.cursor, "#ffffff");
  assert.equal(t.colors.selectionBackground, undefined);
  assert.equal(t.colors.cursorAccent, "#000000");
});
