// Aya's OSC 9001 signal channel (integrations.md): a cooperating TUI or
// wrapper script can emit `ESC ]9001;aya.<key>=<value> BEL` inline in its own
// output. pty.ts strips these before the chunk reaches xterm.js and forwards
// the parsed events as structured PtyEvents — this is the parser at the heart
// of that pipeline, so it needs to be exactly right about what it consumes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractAyaOsc,
  parseAyaOscSession,
  parseAyaOscStatus,
} from "../dist-electron/osc-extractor.js";

const AYA_OSC_INTRODUCER = "\x1b]9001;aya.";

function seq(key, value, terminator = "\x07") {
  return `${AYA_OSC_INTRODUCER}${key}=${value}${terminator}`;
}

test("a complete sequence is stripped and parsed", () => {
  const result = extractAyaOsc(`before ${seq("status", "waiting : Approval needed")} after`, "");
  assert.equal(result.cleaned, "before  after");
  assert.deepEqual(result.events, [
    { key: "status", value: "waiting : Approval needed" },
  ]);
  assert.equal(result.carry, "");
});

test("ST (ESC \\\\) terminator works same as BEL", () => {
  const result = extractAyaOsc(seq("context", "Implementing search", "\x1b\\"), "");
  assert.deepEqual(result.events, [{ key: "context", value: "Implementing search" }]);
  assert.equal(result.cleaned, "");
});

test("multiple sequences in one chunk are all parsed, in order", () => {
  const chunk = `${seq("tool", "Read : src/foo.ts")}x${seq("cost", "0.05 : 1.23")}`;
  const result = extractAyaOsc(chunk, "");
  assert.deepEqual(result.events, [
    { key: "tool", value: "Read : src/foo.ts" },
    { key: "cost", value: "0.05 : 1.23" },
  ]);
  assert.equal(result.cleaned, "x");
});

test("plain output with no Aya OSC is passed through unchanged", () => {
  const result = extractAyaOsc("just some\nregular output\x1b[31m colored\x1b[0m", "");
  assert.equal(result.cleaned, "just some\nregular output\x1b[31m colored\x1b[0m");
  assert.deepEqual(result.events, []);
  assert.equal(result.carry, "");
});

test("a sequence split across chunk boundaries is held back then completed", () => {
  const whole = seq("status", "done : Build passed");
  const splitAt = whole.indexOf(":") + 1; // mid-sequence, inside the introducer+key=value
  const first = extractAyaOsc(`before${whole.slice(0, splitAt)}`, "");
  assert.equal(first.cleaned, "before");
  assert.deepEqual(first.events, []);
  assert.ok(first.carry.length > 0);

  const second = extractAyaOsc(`${whole.slice(splitAt)}after`, first.carry);
  assert.deepEqual(second.events, [{ key: "status", value: "done : Build passed" }]);
  assert.equal(second.cleaned, "after");
  assert.equal(second.carry, "");
});

test("a chunk ending mid-introducer (before 'aya.') is held back byte-for-byte", () => {
  const first = extractAyaOsc("hi\x1b]90", "");
  assert.equal(first.cleaned, "hi");
  assert.equal(first.carry, "\x1b]90");

  const second = extractAyaOsc(`01;aya.status=active : Running\x07bye`, first.carry);
  assert.deepEqual(second.events, [{ key: "status", value: "active : Running" }]);
  assert.equal(second.cleaned, "bye");
});

test("an unrelated OSC 9001 sequence (no aya. namespace) is left completely alone", () => {
  const result = extractAyaOsc("\x1b]9001;something-else\x07after", "");
  assert.equal(result.cleaned, "\x1b]9001;something-else\x07after");
  assert.deepEqual(result.events, []);
  assert.equal(result.carry, "");
});

test("other OSC sequences (title, hyperlinks) are never touched", () => {
  const osc0 = "\x1b]0;my title\x07";
  const osc8 = "\x1b]8;;https://example.com\x07link text\x1b]8;;\x07";
  const result = extractAyaOsc(`${osc0}${osc8}`, "");
  assert.equal(result.cleaned, `${osc0}${osc8}`);
  assert.deepEqual(result.events, []);
});

test("a carry that never terminates is capped, not held forever", () => {
  const runaway = AYA_OSC_INTRODUCER + "x".repeat(5000);
  const result = extractAyaOsc(runaway, "");
  // Past the cap, the held-back text is flushed as plain output instead of
  // silently swallowing real terminal content forever.
  assert.equal(result.cleaned, runaway);
  assert.equal(result.carry, "");
});

test("parseAyaOscStatus: valid status events parse level + trimmed text", () => {
  assert.deepEqual(parseAyaOscStatus({ key: "status", value: "waiting : Approval needed" }), {
    level: "waiting",
    text: "Approval needed",
  });
});

test("parseAyaOscStatus: non-status keys are ignored", () => {
  assert.equal(parseAyaOscStatus({ key: "context", value: "waiting : x" }), null);
});

test("parseAyaOscStatus: unrecognized level is ignored", () => {
  assert.equal(parseAyaOscStatus({ key: "status", value: "blocked : x" }), null);
});

test("parseAyaOscStatus: missing colon or empty text is ignored", () => {
  assert.equal(parseAyaOscStatus({ key: "status", value: "waiting" }), null);
  assert.equal(parseAyaOscStatus({ key: "status", value: "waiting :   " }), null);
});

// --- aya.session ------------------------------------------------------------
// A session id is substituted into a spawn command on restore, so the parser
// is a security boundary, not just a format check: anything that could change
// the shape of that command line must be rejected outright.

test("parseAyaOscSession returns a well-formed id", () => {
  assert.equal(
    parseAyaOscSession({ key: "session", value: "claude-abc123" }),
    "claude-abc123",
  );
  assert.equal(
    parseAyaOscSession({ key: "session", value: "  01J8Z.9/a:b_c-d  " }),
    "01J8Z.9/a:b_c-d",
  );
});

test("parseAyaOscSession ignores non-session keys", () => {
  assert.equal(parseAyaOscSession({ key: "status", value: "abc" }), null);
});

test("parseAyaOscSession rejects shell metacharacters outright", () => {
  for (const value of [
    "abc; rm -rf /",
    "abc && evil",
    "abc$(whoami)",
    "abc`id`",
    "abc|tee x",
    "a b",
    "abc'q",
    'abc"q',
    "",
  ]) {
    assert.equal(
      parseAyaOscSession({ key: "session", value }),
      null,
      `should reject: ${JSON.stringify(value)}`,
    );
  }
});

test("parseAyaOscSession rejects an absurdly long id", () => {
  assert.equal(
    parseAyaOscSession({ key: "session", value: "a".repeat(201) }),
    null,
  );
});
