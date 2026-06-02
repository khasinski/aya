// The cue ↔ side-effect contract behind the play/pause snippet icon: text is
// sent as a bracketed paste (so multi-line snippets arrive as one block and a
// "hold" snippet does NOT submit line by line), and autoRun appends a single
// carriage return to run it. If this drifts, the drawer's visual promise stops
// matching what lands in the terminal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { snippetPtyPayload } from "../dist-test/snippet-payload.js";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const wrap = (text) => `${PASTE_START}${text}${PASTE_END}`;

test("autoRun snippet is a bracketed paste followed by a single CR (runs)", () => {
  assert.equal(snippetPtyPayload({ text: "npm test", autoRun: true }), `${wrap("npm test")}\r`);
});

test("hold (non-autoRun) snippet is a bracketed paste with NO trailing CR", () => {
  const payload = snippetPtyPayload({ text: "review this diff", autoRun: false });
  assert.equal(payload, wrap("review this diff"));
  assert.ok(!payload.endsWith("\r"), "hold snippets must not press Enter for the user");
});

test("multi-line hold snippet keeps newlines INSIDE the paste, no trailing CR", () => {
  // The whole point of bracketed paste: the embedded \n is literal text the
  // program inserts, not a submit. So the payload ends at the paste-end marker.
  const payload = snippetPtyPayload({ text: "step 1\nstep 2\nstep 3", autoRun: false });
  assert.equal(payload, wrap("step 1\nstep 2\nstep 3"));
  assert.ok(!payload.endsWith("\r"), "multi-line hold must not auto-submit");
});

test("multi-line autoRun snippet pastes the block, then one CR submits it", () => {
  assert.equal(
    snippetPtyPayload({ text: "line a\nline b", autoRun: true }),
    `${wrap("line a\nline b")}\r`,
  );
});

test("snippet text is otherwise untouched between the paste markers", () => {
  assert.equal(snippetPtyPayload({ text: "", autoRun: false }), wrap(""));
  assert.equal(snippetPtyPayload({ text: "  spaced  ", autoRun: false }), wrap("  spaced  "));
});
