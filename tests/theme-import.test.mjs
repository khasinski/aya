// Smoke tests for the iTerm2 / Windows Terminal theme parsers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseItermColors,
  parseWindowsTerminalJson,
  parseTheme,
} from "../dist-electron/themes.js";

// --- Windows Terminal JSON (Campbell, shipped with Windows Terminal) --------
const CAMPBELL = JSON.stringify({
  name: "Campbell",
  foreground: "#CCCCCC",
  background: "#0C0C0C",
  cursorColor: "#FFFFFF",
  selectionBackground: "#FFFFFF",
  black: "#0C0C0C",
  red: "#C50F1F",
  green: "#13A10E",
  yellow: "#C19C00",
  blue: "#0037DA",
  purple: "#881798",
  cyan: "#3A96DD",
  white: "#CCCCCC",
  brightBlack: "#767676",
  brightRed: "#E74856",
  brightGreen: "#16C60C",
  brightYellow: "#F9F1A5",
  brightBlue: "#3B78FF",
  brightPurple: "#B4009E",
  brightCyan: "#61D6D6",
  brightWhite: "#F2F2F2",
});

test("Windows Terminal JSON: parses Campbell and maps purple → magenta", () => {
  const t = parseWindowsTerminalJson(CAMPBELL, "fallback");
  assert.equal(t.name, "Campbell");
  assert.equal(t.colors.background, "#0C0C0C");
  assert.equal(t.colors.foreground, "#CCCCCC");
  assert.equal(t.colors.cursor, "#FFFFFF");
  assert.equal(t.colors.magenta, "#881798");
  assert.equal(t.colors.brightMagenta, "#B4009E");
  assert.equal(t.colors.selectionBackground, "#FFFFFF");
});

test("Windows Terminal JSON: missing required field throws", () => {
  const broken = JSON.stringify({ name: "Bad", background: "#000" });
  assert.throws(() => parseWindowsTerminalJson(broken, "fallback"));
});

// --- iTerm2 plist (minimal hand-rolled fixture) ----------------------------
function ansiColor(r, g, b) {
  return `<dict>
      <key>Color Space</key><string>sRGB</string>
      <key>Red Component</key><real>${r}</real>
      <key>Green Component</key><real>${g}</real>
      <key>Blue Component</key><real>${b}</real>
    </dict>`;
}

const ITERM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  ${Array.from({ length: 16 }, (_, i) => {
    // Distinct per-index: r = i/15, g = 0, b = 1 - r
    const r = i / 15;
    return `<key>Ansi ${i} Color</key>${ansiColor(r, 0, 1 - r)}`;
  }).join("\n  ")}
  <key>Background Color</key>${ansiColor(0, 0, 0)}
  <key>Foreground Color</key>${ansiColor(1, 1, 1)}
  <key>Cursor Color</key>${ansiColor(0.5, 0.5, 0.5)}
  <key>Selection Color</key>${ansiColor(0.2, 0.3, 0.4)}
</dict>
</plist>`;

test("iTerm2 .itermcolors: parses ANSI colors + bg/fg/cursor", () => {
  const t = parseItermColors(ITERM_FIXTURE, "Sample");
  assert.equal(t.name, "Sample");
  assert.equal(t.colors.background, "#000000");
  assert.equal(t.colors.foreground, "#ffffff");
  assert.equal(t.colors.cursor, "#808080");
  // Ansi 0 = (0,0,1) → #0000ff (per our fixture formula)
  assert.equal(t.colors.black, "#0000ff");
  // Ansi 1 ≈ (1/15, 0, 14/15) → #1100ee
  assert.equal(t.colors.red, "#1100ee");
  assert.equal(t.colors.selectionBackground, "#334d66");
});

test("iTerm2 .itermcolors: gives stable position to all 16 ANSI slots", () => {
  const t = parseItermColors(ITERM_FIXTURE, "Sample");
  const slots = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
    "brightMagenta", "brightCyan", "brightWhite",
  ];
  for (const s of slots) {
    assert.match(t.colors[s], /^#[0-9a-f]{6}$/, `${s} should be a hex color`);
  }
});

// --- Dispatcher ------------------------------------------------------------
test("parseTheme: dispatches XML to iTerm2 and JSON to Windows Terminal", () => {
  const iterm = parseTheme(ITERM_FIXTURE, "X");
  assert.equal(iterm.colors.background, "#000000");

  const wt = parseTheme(CAMPBELL, "Y");
  assert.equal(wt.name, "Campbell");
});
