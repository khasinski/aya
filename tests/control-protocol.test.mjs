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
// The first gate on a request that can type into someone else's agent.

test("pane-read requires a target or targetId", () => {
  assert.throws(() => parseControlRequest({ type: "pane-read" }), /target/);
});

test("pane-list needs no target and carries the caller's scope + self id", () => {
  const req = parseControlRequest({
    type: "pane-list",
    projectSlug: "demo",
    selfTerminalId: "t9",
  });
  assert.equal(req.type, "pane-list");
  assert.equal(req.projectSlug, "demo");
  assert.equal(req.selfTerminalId, "t9");
});

test("pane-list is valid with no fields at all (list everything)", () => {
  // The SHAPE is the contract: listPanes skips its project filter only when
  // projectSlug is undefined, so any substituted default scopes the listing.
  assert.deepEqual(parseControlRequest({ type: "pane-list" }), {
    type: "pane-list",
    projectSlug: undefined,
    selfTerminalId: undefined,
  });
});

test("pane-list normalizes blank scope fields to undefined", () => {
  // What bin/aya sends when AYA_PROJECT_SLUG / AYA_TERMINAL_ID are unset.
  assert.deepEqual(
    parseControlRequest({
      type: "pane-list",
      projectSlug: "  ",
      selfTerminalId: "",
    }),
    { type: "pane-list", projectSlug: undefined, selfTerminalId: undefined },
  );
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
  // A stray Enter accepts whatever prompt is on screen in an agent pane.
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
  // Whole-object: `target === undefined` is true because the INPUT omitted it,
  // so alone it would pass even if the parser stopped emitting the key.
  assert.deepEqual(
    parseControlRequest({ type: "pane-send", targetId: "t9", text: "hi" }),
    {
      type: "pane-send",
      target: undefined,
      targetId: "t9",
      projectSlug: undefined,
      text: "hi",
      submit: false,
    },
  );
});
