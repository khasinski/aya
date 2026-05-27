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
