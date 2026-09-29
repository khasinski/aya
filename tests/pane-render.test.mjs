// `aya pane read` hands another agent what the pane SHOWS, not the raw bytes:
// a TUI that repaints (Grok's animated logo) left 64 KB of escape codes and
// braille frames with no readable text in the raw tail.

import { test } from "node:test";
import assert from "node:assert/strict";
import xterm from "@xterm/headless";
import {
  PANE_RENDER_SCROLLBACK_LINES,
  paneReadText,
  renderPaneText,
} from "../dist-electron/pane-render.js";

test("colors and cursor moves render to the text they paint", async () => {
  const raw = "\x1b[31mred\x1b[0m plain\r\nline2\x1b[1A\x1b[5Gxx";
  assert.equal(await renderPaneText(raw, 80, 24), "red xxain\nline2");
});

test("an alt-screen TUI returns only its current frame", async () => {
  const raw =
    "shell$ grok\r\n\x1b[?1049h" +
    "\x1b[H\x1b[2Jframe 1\r\n\x1b[1mstale\x1b[0m" +
    "\x1b[H\x1b[2Jframe 2\r\n\r\n> prompt";
  assert.equal(await renderPaneText(raw, 40, 10), "frame 2\n\n> prompt");
});

test("leaving the alt screen returns the normal buffer again", async () => {
  const raw = "before\r\n\x1b[?1049h\x1b[H\x1b[2Jtui\x1b[?1049lafter";
  assert.equal(await renderPaneText(raw, 40, 10), "before\nafter");
});

// The host's replay buffer is capped: a long-running TUI's alt-screen enter is
// evicted, so the replay alone would print its frames into the normal buffer.
const altEnterCutOff =
  Array.from({ length: 20 }, (_, i) => `log ${i}`).join("\r\n") + "\x1b[1;1Hcurrent";

test("a TUI whose alt-screen enter was cut off still reads as its screen", async () => {
  assert.equal(
    await renderPaneText(altEnterCutOff, 40, 5, true),
    "current\nlog 16\nlog 17\nlog 18\nlog 19",
  );
});

test("without the host's word the cut-off TUI reads as a normal buffer", async () => {
  const lines = (await renderPaneText(altEnterCutOff, 40, 5)).split("\n");
  assert.equal(lines.length, 20);
  assert.equal(lines[0], "log 0");
});

test("an alt screen the replay enters itself is unchanged by the host's word", async () => {
  const raw = "shell$\r\n\x1b[?1049h\x1b[H\x1b[2Jframe";
  assert.equal(await renderPaneText(raw, 40, 5, true), "frame");
});

test("an animation that overwrites itself leaves one frame and the text", async () => {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let raw = "\x1b[?1049h\x1b[H\x1b[2J\x1b[3;1HHello from grok";
  for (let i = 0; i < 5_000; i += 1) {
    raw += `\x1b[1;1H\x1b[36m${frames[i % frames.length].repeat(8)}\x1b[0m`;
  }
  const text = await renderPaneText(raw, 40, 6);
  assert.equal(text, `${frames[4_999 % frames.length].repeat(8)}\n\nHello from grok`);
});

test("a spinner redrawn with carriage returns keeps only its last state", async () => {
  let raw = "";
  for (const f of "⠋⠙⠹⠸") raw += `\rWorking ${f}`;
  raw += "\r\x1b[KDone.\r\n";
  assert.equal(await renderPaneText(raw, 40, 10), "Done.");
});

test("wide characters take two cells but read back once", async () => {
  assert.equal(await renderPaneText("日本語 ok\r\n", 20, 5), "日本語 ok");
});

test("a wide character pushed to the next row leaves no gap", async () => {
  assert.equal(await renderPaneText("abc日本", 4, 5), "abc日本");
});

test("a line the terminal wrapped reads back as one line", async () => {
  assert.equal(await renderPaneText("abcdefghijKLM\r\nnext", 10, 5), "abcdefghijKLM\nnext");
});

test("a space that fell on the wrap boundary survives the rejoin", async () => {
  assert.equal(await renderPaneText("abcde fghij", 6, 5), "abcde fghij");
});

test("a real newline at the exact width is not joined to the next line", async () => {
  assert.equal(await renderPaneText("abcdefghij\r\nnext", 10, 5), "abcdefghij\nnext");
});

test("the normal buffer includes scrollback above the screen", async () => {
  const raw = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n");
  const lines = (await renderPaneText(raw, 40, 5)).split("\n");
  assert.equal(lines.length, 100);
  assert.equal(lines[0], "line 0");
  assert.equal(lines[99], "line 99");
});

test("trailing blank lines and trailing spaces are trimmed, leading ones kept", async () => {
  assert.equal(await renderPaneText("\r\n  a   \r\n\r\n\r\n", 40, 10), "\n  a");
});

test("padding a TUI wrote after a line's text is trimmed", async () => {
  assert.equal(await renderPaneText("a   \r\nb\x1b[20C", 40, 10), "a\nb");
});

test("a wrapped line whose start scrolled off still reads back", async () => {
  // At 2 columns (xterm's minimum) the first rows kept are all continuations.
  const keptRows = PANE_RENDER_SCROLLBACK_LINES + 1;
  const text = await renderPaneText("x".repeat(keptRows * 4), 2, 1);
  assert.equal(text.length, keptRows * 2);
});

test("an empty buffer renders to an empty string", async () => {
  assert.equal(await renderPaneText("", 80, 24), "");
});

test("each read releases its terminal", async (t) => {
  // A 1 MB render is not free; left to the GC, 40 reads held 4 MB more heap.
  const dispose = t.mock.method(xterm.Terminal.prototype, "dispose");
  await renderPaneText("hi", 80, 24);
  assert.equal(dispose.mock.callCount(), 1);
});

test("without a known size the raw buffer is returned unchanged", async () => {
  const raw = "\x1b[31mred\x1b[0m";
  assert.equal(await paneReadText(raw, null), raw);
});

test("the host's alt-screen word reaches the render", async () => {
  const size = { cols: 40, rows: 5, alt: true };
  assert.equal((await paneReadText(altEnterCutOff, size)).split("\n").length, 5);
});

test("with a size the buffer is rendered at that size", async () => {
  const bottomRight = "\x1b[99;99HZ";
  assert.equal(await paneReadText(bottomRight, { cols: 3, rows: 5 }), "\n\n\n\n  Z");
});
