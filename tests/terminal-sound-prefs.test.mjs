// Precedence rules for the waiting/done chimes: a master switch, per-preset
// exceptions, and optional user-supplied audio files. Worth direct coverage
// because "why is my terminal silent" is exactly the kind of bug that hides
// in a boolean fallback chain.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TERMINAL_SOUND_PREFS,
  isWatchingTerminal,
  normalizeSoundOverrides,
  shouldPlayTerminalSound,
  terminalSoundUrl,
} from "../dist-test/terminal-sound-prefs.js";

const BUNDLED = { waiting: "/bundled/waiting.wav", done: "/bundled/done.wav" };

function prefs(overrides = {}) {
  return { ...DEFAULT_TERMINAL_SOUND_PREFS, ...overrides };
}

// --- shouldPlayTerminalSound ----------------------------------------------

test("defaults play for any preset", () => {
  assert.equal(shouldPlayTerminalSound(prefs(), "claude"), true);
});

test("the master switch silences every preset, overrides included", () => {
  const p = prefs({ enabled: false, overrides: { claude: true } });
  assert.equal(shouldPlayTerminalSound(p, "claude"), false);
});

test("a per-preset exception silences only that preset", () => {
  const p = prefs({ overrides: { codex: false } });
  assert.equal(shouldPlayTerminalSound(p, "codex"), false);
  assert.equal(shouldPlayTerminalSound(p, "claude"), true);
});

test("the focused active terminal is being watched and needs no chime", () => {
  assert.equal(isWatchingTerminal("term-1", "term-1", true), true);
  assert.equal(isWatchingTerminal("term-2", "term-1", true), false);
});

test("an active tab still chimes while Aya is in the background", () => {
  assert.equal(isWatchingTerminal("term-1", "term-1", false), false);
});

// --- terminalSoundUrl ------------------------------------------------------

test("falls back to the bundled chime when no custom file is set", () => {
  assert.equal(terminalSoundUrl(prefs(), "waiting", BUNDLED), BUNDLED.waiting);
  assert.equal(terminalSoundUrl(prefs(), "done", BUNDLED), BUNDLED.done);
});

test("a custom absolute path gains the file:// scheme the renderer needs", () => {
  const p = prefs({ customWaitingPath: "/Users/me/chime.wav" });
  assert.equal(
    terminalSoundUrl(p, "waiting", BUNDLED),
    "file:///Users/me/chime.wav",
  );
});

test("an already-file:// path is not double-prefixed", () => {
  const p = prefs({ customDonePath: "file:///Users/me/done.wav" });
  assert.equal(terminalSoundUrl(p, "done", BUNDLED), "file:///Users/me/done.wav");
});

test("each cue resolves independently — one custom file doesn't hijack the other", () => {
  const p = prefs({ customWaitingPath: "/tmp/w.wav" });
  assert.equal(terminalSoundUrl(p, "waiting", BUNDLED), "file:///tmp/w.wav");
  assert.equal(terminalSoundUrl(p, "done", BUNDLED), BUNDLED.done);
});

// --- normalizeSoundOverrides ----------------------------------------------
// Only real exceptions are stored, so toggling a preset off and back on
// leaves no residue in localStorage.

test("re-enabling a preset drops its entry instead of storing a redundant true", () => {
  assert.deepEqual(normalizeSoundOverrides({ claude: true, codex: false }), {
    codex: false,
  });
});

test("an all-default map normalizes to empty", () => {
  assert.deepEqual(normalizeSoundOverrides({ a: true, b: true }), {});
});
