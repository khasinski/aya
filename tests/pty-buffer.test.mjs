// PTY rolling output buffer — used to repaint xterm.js after HMR /
// re-mount. We can't actually spawn a PTY from tests (would consume
// subscription credits etc.), but the buffer trim logic is pure and worth
// testing directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __testAppendToOutputBuffer,
  __testClearOutputBuffers,
  OUTPUT_BUFFER_MAX,
  getBufferedOutput,
  getBufferedReplayOutput,
  searchPtyOutputs,
} from "../dist-electron/pty.js";
import xterm from "@xterm/headless";
import { focusReportingState } from "../dist-test/focus-reporting.js";
import { consumeReplayModes, initialReplayModeTracker, replayModePrefix } from "../dist-electron/pty-replay-modes.js";

// Per-chunk size (bytes) used to overflow the rolling buffer in the trim test.
const BUFFER_TEST_CHUNK_SIZE_BYTES = 30000;

// The buffer is private to pty.ts. To exercise it we expose getBufferedOutput
// and rely on the public spawnPty path elsewhere. For unit testing the trim,
// we drive a stub via a local reimplementation matching the production code.

function makeBuffer() {
  const chunks = [];
  return {
    append(chunk) {
      chunks.push(chunk);
      let total = 0;
      for (const c of chunks) total += c.length;
      while (total > OUTPUT_BUFFER_MAX && chunks.length > 1) {
        const removed = chunks.shift();
        if (removed) total -= removed.length;
      }
    },
    read() {
      return chunks.join("");
    },
  };
}

test("empty buffer reads as empty", () => {
  const b = makeBuffer();
  assert.equal(b.read(), "");
});

test("getBufferedOutput returns empty for unknown ptyId", () => {
  assert.equal(getBufferedOutput("nonexistent-pty"), "");
});

test("replay boundary tracks DEC modes while evicted and preserves split CSI", () => {
  __testClearOutputBuffers();
  __testAppendToOutputBuffer("mode-tail", "\x1b[?1049h\x1b[?1003");
  const ending = "h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?1h";
  __testAppendToOutputBuffer("mode-tail", ending + "A".repeat(40_000));
  for (let i = 0; i < 26; i++) __testAppendToOutputBuffer("mode-tail", "A".repeat(40_000));
  const replay = getBufferedReplayOutput("mode-tail");
  assert.ok(replay.startsWith("\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?1h"));
  assert.equal(replay.includes("A".repeat(100)), true);
  __testClearOutputBuffers();
});

test("replay prefix plus retained toggles matches the live VT mirror modes", async () => {
  __testClearOutputBuffers();
  const { Terminal } = xterm;
  const mirror = new Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true });
  const renderer = new Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true });
  const initial = "\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?1h";
  const trim = "x".repeat(OUTPUT_BUFFER_MAX + 4);
  const retained = "\x1b[?1003l\x1b[?1000h\x1b[?1006l\x1b[?1006h\x1b[?2004l\x1b[?2004hTAIL";
  const write = (term, data) => new Promise(resolve => term.write(data, resolve));
  try {
    await write(mirror, initial + trim + retained);
    __testAppendToOutputBuffer("mode-compare", initial);
    __testAppendToOutputBuffer("mode-compare", trim);
    __testAppendToOutputBuffer("mode-compare", retained);
    const replay = getBufferedReplayOutput("mode-compare");
    await write(renderer, replay);
    assert.equal(focusReportingState(replay, false), true, "the replay prefix must also seed TerminalView's focus-reporting gate");
    const view = term => ({ buffer: term.buffer.active.type, modes: term.modes });
    assert.deepEqual(view(renderer), view(mirror));
    assert.equal(renderer.modes.mouseTrackingMode, "vt200");
    assert.equal(renderer.modes.sendFocusMode, true);
    assert.equal(renderer.modes.bracketedPasteMode, true);
    assert.equal(renderer.modes.applicationCursorKeysMode, true);
    assert.match(replay, /^\x1b\[\?1049h/);
    assert.ok(replay.endsWith("TAIL"));
  } finally { mirror.dispose(); renderer.dispose(); __testClearOutputBuffers(); }
});

test("mode-like text inside OSC/DCS/SOS/PM/APC payloads does not become replay state after trimming", async () => {
  __testClearOutputBuffers();
  const { Terminal } = xterm;
  const mirror = new Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true });
  const renderer = new Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true });
  const payload = [
    "\x1b]0;title ?1049h BEL\x07",
    "\x1b]0;title ?1003h ST\x1b\\",
    "\x1bPqpayload ?1006h ST\x1b\\",
    "\x1bXpayload ?2004h ST\x1b\\",
    "\x1b^payload ?1004h ST\x1b\\",
    "\x1b_payload ?1h ST\x1b\\",
  ].join("");
  const filler = "VISIBLE-ROW".padEnd(40_000, "x");
  const write = (term, data) => new Promise(resolve => term.write(data, resolve));
  try {
    await write(mirror, payload + filler.repeat(28));
    __testAppendToOutputBuffer("control-string-tail", payload);
    for (let i = 0; i < 28; i++) __testAppendToOutputBuffer("control-string-tail", filler);
    const replay = getBufferedReplayOutput("control-string-tail");
    await write(renderer, replay);
    assert.equal(mirror.buffer.active.type, "normal");
    assert.equal(mirror.modes.mouseTrackingMode, "none");
    assert.equal(replay.startsWith("\x1b[?1049h"), false, "string payload must not synthesize an alternate-screen prefix");
    assert.deepEqual({ buffer: renderer.buffer.active.type, modes: renderer.modes }, { buffer: mirror.buffer.active.type, modes: mirror.modes });
    assert.ok(replay.includes("VISIBLE-ROW"));
  } finally { mirror.dispose(); renderer.dispose(); __testClearOutputBuffers(); }
});

test("a trimmed open DCS string keeps the retained replay inside the string", async () => {
  __testClearOutputBuffers();
  const { Terminal } = xterm;
  const mirror = new Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true });
  const renderer = new Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true });
  const write = (term, data) => new Promise(resolve => term.write(data, resolve));
  const opener = "\x1bPq?1049h" + "discarded".padEnd(40_000, "d");
  const tail = "retained ?1003h" + "visible-bytes".padEnd(40_000, "r");
  try {
    await write(mirror, opener + tail + "\x1b\\");
    __testAppendToOutputBuffer("open-string-tail", opener);
    __testAppendToOutputBuffer("open-string-tail", tail);
    for (let i = 0; i < 25; i++) __testAppendToOutputBuffer("open-string-tail", "filler".padEnd(40_000, "f"));
    const replay = getBufferedReplayOutput("open-string-tail");
    assert.ok(replay.startsWith("\x1bP"), "the boundary prefix should reopen the DCS string");
    assert.equal(replay.startsWith("\x1b[?1049h"), false, "plain mode-like text must not synthesize an alternate-screen prefix");
    await write(renderer, replay);
    assert.equal(mirror.buffer.active.type, "normal");
    assert.equal(renderer.buffer.active.type, mirror.buffer.active.type);
    assert.equal(mirror.modes.mouseTrackingMode, "none");
    assert.equal(renderer.modes.mouseTrackingMode, mirror.modes.mouseTrackingMode);
  } finally { mirror.dispose(); renderer.dispose(); __testClearOutputBuffers(); }
});

test("replay scanner matches xterm escape handling inside control strings", async () => {
  const { Terminal } = xterm;
  const mirror = new Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true });
  const tracker = initialReplayModeTracker();
  const write = data => new Promise(resolve => mirror.write(data, resolve));
  try {
    const strings = [
      "\x1b]0;title \x1b[?1049h\x07",
      "\x1bPpayload \x1b[?1003h\x1b\\",
      "\x1bXpayload \x1b[?2004h\x1b\\",
      "\x1b^payload \x1b[?1004h\x1b\\",
      "\x1b_payload \x1b[?1h\x1b\\",
      "\x1bPpayload\x9b?1006h\x1b\\",
    ];
    for (const part of strings) {
      consumeReplayModes(tracker, part);
      await write(part);
    }
    assert.equal(tracker.state.alternate, mirror.buffer.active.type === "alternate");
    assert.equal(tracker.state.mouse, mirror.modes.mouseTrackingMode);
    assert.equal(tracker.state.focus, mirror.modes.sendFocusMode);
    assert.equal(tracker.state.bracketedPaste, mirror.modes.bracketedPasteMode);
    assert.equal(tracker.state.applicationCursor, mirror.modes.applicationCursorKeysMode);
    assert.ok(replayModePrefix(tracker).startsWith("\x1b[?1049h"));
  } finally { mirror.dispose(); }
});

test("replay scanner matches xterm mode resets from RIS and DECSTR, including RIS inside DCS", async () => {
  const { Terminal } = xterm;
  const makeTerminal = () => new Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true });
  const stateOf = terminal => ({
    alternate: terminal.buffer.active.type === "alternate",
    mouse: terminal.modes.mouseTrackingMode,
    sgrMouse: terminal._core.coreMouseService._activeEncoding === "SGR",
    focus: terminal.modes.sendFocusMode,
    bracketedPaste: terminal.modes.bracketedPasteMode,
    applicationCursor: terminal.modes.applicationCursorKeysMode,
  });
  const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));
  const modes = "\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?1h";
  for (const reset of ["\x1bc", "\x1b[!p", "\x1bPq\x1bc"]) {
    const mirror = makeTerminal();
    const replay = makeTerminal();
    const tracker = initialReplayModeTracker();
    try {
      consumeReplayModes(tracker, modes);
      await write(mirror, modes);
      consumeReplayModes(tracker, reset);
      await write(mirror, reset);
      assert.deepEqual(tracker.state, stateOf(mirror), JSON.stringify(reset));
      await write(replay, replayModePrefix(tracker));
      assert.deepEqual(stateOf(replay), stateOf(mirror), `replay prefix after ${JSON.stringify(reset)}`);
    } finally { mirror.dispose(); replay.dispose(); }
  }
});

test("replay scanner tracks split ESC and C1 control-string boundaries", () => {
  const cases = [
    ["\x1b]", "\x07", "\x1b]"], ["\x1b]", "\x1b\\", "\x1b]"], ["\x1bP", "\x1b\\", "\x1bP"],
    ["\x1bX", "\x1b\\", "\x1bX"], ["\x1b^", "\x1b\\", "\x1b^"], ["\x1b_", "\x1b\\", "\x1b_"],
    ["\x9d", "\x9c", "\x1b]"], ["\x90", "\x9c", "\x1bP"], ["\x98", "\x9c", "\x1bX"], ["\x9e", "\x9c", "\x1b^"], ["\x9f", "\x9c", "\x1b_"],
  ];
  for (const [start, end, expectedPrefix] of cases) {
    const tracker = initialReplayModeTracker();
    const text = `payload${end}`;
    consumeReplayModes(tracker, start);
    assert.equal(tracker.scanner.state, "string", `split introducer ${JSON.stringify(start)}`);
    assert.ok(replayModePrefix(tracker).endsWith(expectedPrefix), `open string prefix for ${JSON.stringify(start)}`);
    for (const ch of text) consumeReplayModes(tracker, ch);
    assert.equal(replayModePrefix(tracker), "", `closed string leaves no replay prefix from ${JSON.stringify(start)}`);
  }
});

test("searchPtyOutputs finds tokens across ANSI-decorated PTY output", () => {
  __testClearOutputBuffers();
  __testAppendToOutputBuffer(
    "pty-1",
    "\x1b[32mClaude\x1b[0m finished the ruby migration\nNeed approval",
  );
  __testAppendToOutputBuffer("pty-2", "codex is working on docs");

  const hits = searchPtyOutputs("ruby approval");

  assert.equal(hits.length, 1);
  assert.equal(hits[0].ptyId, "pty-1");
  assert.match(hits[0].snippet, /ruby migration Need approval/);
  assert.equal(hits[0].matchLength, "ruby".length);

  __testClearOutputBuffers();
});

test("searchPtyOutputs uses AND semantics across query tokens", () => {
  __testClearOutputBuffers();
  __testAppendToOutputBuffer("pty-1", "ruby migration complete");
  __testAppendToOutputBuffer("pty-2", "ruby tests running");

  assert.deepEqual(
    searchPtyOutputs("ruby complete").map((hit) => hit.ptyId),
    ["pty-1"],
  );
  assert.deepEqual(searchPtyOutputs("ruby missing"), []);

  __testClearOutputBuffers();
});

test("buffer keeps small writes intact", () => {
  const b = makeBuffer();
  b.append("hello ");
  b.append("world");
  assert.equal(b.read(), "hello world");
});

test("buffer trims oldest chunks once total exceeds limit", () => {
  const b = makeBuffer();
  // Push enough chunks to exceed the production rolling-buffer limit.
  // Expect the oldest chunks to be dropped.
  for (let i = 0; i < 40; i++) {
    const tag = String.fromCharCode(97 + i); // "a", "b", "c", ...
    b.append(tag.repeat(BUFFER_TEST_CHUNK_SIZE_BYTES));
  }
  const result = b.read();
  assert.ok(result.length <= OUTPUT_BUFFER_MAX);
  // The first chunk(s) should be gone. "a" is definitely gone.
  assert.equal(result.includes("a"), false);
  // The last chunk must be present in full.
  assert.ok(
    result.includes(
      String.fromCharCode(97 + 39).repeat(BUFFER_TEST_CHUNK_SIZE_BYTES),
    ),
  );
});

test("buffer keeps at least one chunk even if it exceeds the limit", () => {
  // Edge case: a single chunk larger than OUTPUT_BUFFER_MAX. The trim loop
  // bails when only one chunk remains, so the buffer reads as that chunk in
  // full (better than silently emptying).
  const b = makeBuffer();
  const giant = "x".repeat(OUTPUT_BUFFER_MAX * 2);
  b.append(giant);
  assert.equal(b.read(), giant);
});

test("search cache: appended output is found by the next query (invalidation)", () => {
  // searchPtyOutputs caches the cleaned+lowercased buffer per PTY between
  // keystrokes; an append must invalidate it or new output becomes unsearchable.
  __testClearOutputBuffers();
  __testAppendToOutputBuffer("pty-c", "first \x1b[1mchunk\x1b[0m of output");
  const before = searchPtyOutputs("chunk");
  assert.equal(before.length, 1);
  // Warm the cache, then append and search again.
  assert.equal(searchPtyOutputs("zebra-token").length, 0);
  __testAppendToOutputBuffer("pty-c", " and a zebra-token arrives");
  const after = searchPtyOutputs("zebra-token");
  assert.equal(after.length, 1);
  assert.ok(after[0].snippet.includes("zebra-token"));
  // Repeated identical queries (pure cache hits) stay stable.
  assert.deepEqual(searchPtyOutputs("zebra-token"), after);
});
