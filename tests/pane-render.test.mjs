// `aya pane read` hands another agent what the pane SHOWS, not the raw bytes:
// a TUI that repaints (Grok's animated logo) left 64 KB of escape codes and
// braille frames with no readable text in the raw tail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { paneReadText, renderPaneText } from "../dist-electron/pane-render.js";

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

test("an empty buffer renders to an empty string", async () => {
  assert.equal(await renderPaneText("", 80, 24), "");
});

test("a zero size is clamped rather than thrown on", async () => {
  assert.equal(await renderPaneText("hi", 0, 0), "hi");
});

test("without a known size the raw buffer is returned unchanged", async () => {
  const raw = "\x1b[31mred\x1b[0m";
  assert.equal(await paneReadText(raw, null), raw);
});

test("with a size the buffer is rendered at that size", async () => {
  assert.equal(await paneReadText("abcdef\x1b[31m!", { cols: 3, rows: 4 }), "abcdef!");
});
