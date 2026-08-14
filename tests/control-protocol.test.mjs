import { test } from "node:test";
import assert from "node:assert/strict";
import { parseControlRequest } from "../dist-electron/control-protocol.js";

test("control protocol accepts open and focus requests", () => {
  assert.deepEqual(parseControlRequest({ type: "focus" }), { type: "focus" });
  assert.deepEqual(parseControlRequest({ type: "open", path: "/tmp/aya" }), {
    type: "open",
    path: "/tmp/aya",
  });
});

test("control protocol accepts notify with terminal context", () => {
  assert.deepEqual(
    parseControlRequest({
      type: "notify",
      title: "Aya",
      body: "Needs approval",
      terminalId: "term-1",
      projectSlug: "aya",
    }),
    {
      type: "notify",
      title: "Aya",
      body: "Needs approval",
      terminalId: "term-1",
      projectSlug: "aya",
    },
  );
});

test("control protocol accepts status levels and trims optional blanks away", () => {
  assert.deepEqual(
    parseControlRequest({
      type: "status",
      level: "waiting",
      text: "Review diff",
      terminalId: "term-1",
      projectSlug: "aya",
      cwd: "/tmp/aya",
    }),
    {
      type: "status",
      level: "waiting",
      text: "Review diff",
      terminalId: "term-1",
      projectSlug: "aya",
      cwd: "/tmp/aya",
    },
  );
  assert.deepEqual(
    parseControlRequest({
      type: "status",
      level: "clear",
      text: " ",
      terminalId: "",
      projectSlug: "",
    }),
    {
      type: "status",
      level: "clear",
      text: undefined,
      terminalId: undefined,
      projectSlug: undefined,
      cwd: undefined,
    },
  );
});

test("control protocol rejects malformed agent-facing requests", () => {
  assert.throws(() => parseControlRequest(null), /request must be an object/);
  assert.throws(() => parseControlRequest({ type: "open" }), /open\.path/);
  assert.throws(() => parseControlRequest({ type: "notify" }), /notify\.body/);
  assert.throws(
    () => parseControlRequest({ type: "status", level: "paused" }),
    /status\.level/,
  );
  assert.throws(() => parseControlRequest({ type: "unknown" }), /unknown/);
});

// --- pane-read / pane-send -------------------------------------------------
// These let one terminal drive another, so the parser is the first gate on a
// request that can type into someone else's agent.

test("pane-read requires a target or targetId", () => {
  assert.throws(() => parseControlRequest({ type: "pane-read" }), /target/);
});

test("pane-read accepts a name and carries the caller's project scope", () => {
  const req = parseControlRequest({
    type: "pane-read",
    target: "reviewer",
    projectSlug: "demo",
  });
  assert.equal(req.type, "pane-read");
  assert.equal(req.target, "reviewer");
  assert.equal(req.projectSlug, "demo");
});

test("pane-send requires non-empty text", () => {
  assert.throws(
    () => parseControlRequest({ type: "pane-send", target: "x" }),
    /text is required/,
  );
  assert.throws(
    () => parseControlRequest({ type: "pane-send", target: "x", text: "" }),
    /text is required/,
  );
});

test("pane-send defaults to NOT pressing Enter", () => {
  // A stray Enter can accept whatever prompt is on screen in an agent pane,
  // so submitting has to be opt-in.
  const req = parseControlRequest({ type: "pane-send", target: "x", text: "hi" });
  assert.equal(req.submit, false);
});

test("pane-send submit is honored only for a literal true", () => {
  assert.equal(
    parseControlRequest({ type: "pane-send", target: "x", text: "hi", submit: true })
      .submit,
    true,
  );
  assert.equal(
    parseControlRequest({ type: "pane-send", target: "x", text: "hi", submit: "yes" })
      .submit,
    false,
  );
});

test("pane-send accepts a target id instead of a name", () => {
  const req = parseControlRequest({
    type: "pane-send",
    targetId: "t9",
    text: "hi",
  });
  assert.equal(req.targetId, "t9");
  assert.equal(req.target, undefined);
});
