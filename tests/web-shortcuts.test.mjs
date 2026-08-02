// Aya Web browser shortcuts: the keydown->action table must mirror the
// desktop mapping in electron/main.ts (before-input-event), including the
// extra-modifier guard (Cmd+Shift+T must NOT fire new-shell) and pane combos.

import { test } from "node:test";
import assert from "node:assert/strict";

const { shortcutForKey } = await import("../dist-test/web/shortcuts.js");
const { parseServerFrame, encodeInvokeFrame } = await import(
  "../dist-test/web/protocol.js"
);

const key = (over) => ({
  key: "",
  code: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

test("mod key matches the client platform", () => {
  assert.equal(shortcutForKey(key({ key: "k", metaKey: true }), true), "search");
  assert.equal(shortcutForKey(key({ key: "k", metaKey: true }), false), null);
  assert.equal(shortcutForKey(key({ key: "k", ctrlKey: true }), false), "search");
  assert.equal(shortcutForKey(key({ key: "k" }), true), null);
});

test("primary shortcuts map like the desktop table", () => {
  const mac = (k) => shortcutForKey(key({ key: k, metaKey: true }), true);
  assert.equal(mac("t"), "new-shell");
  assert.equal(mac("w"), "close-tab");
  assert.equal(mac(","), "open-settings");
  assert.equal(mac("["), "prev-tab");
  assert.equal(mac("]"), "next-tab");
  assert.equal(mac("f"), "find-in-pane");
  assert.equal(mac("3"), "project-3");
  assert.equal(mac("9"), "project-9");
  assert.equal(mac("0"), null);
  // Cmd+R is left to the browser (reload doubles as reconnect).
  assert.equal(mac("r"), null);
});

test("extra modifiers do not trigger our actions", () => {
  assert.equal(
    shortcutForKey(key({ key: "t", metaKey: true, shiftKey: true }), true),
    null,
  );
});

test("pane shortcuts use mod+alt", () => {
  const macAlt = (k, code = "") =>
    shortcutForKey(key({ key: k, code, metaKey: true, altKey: true }), true);
  assert.equal(macAlt("ArrowLeft"), "focus-pane-left");
  assert.equal(macAlt("ArrowDown"), "focus-pane-down");
  assert.equal(macAlt("\\"), "split-pane-right");
  assert.equal(macAlt("x", "Backslash"), "split-pane-right");
  assert.equal(macAlt("-"), "split-pane-below");
  assert.equal(macAlt("z"), null);
  assert.equal(
    shortcutForKey(
      key({ key: "ArrowLeft", metaKey: true, altKey: true, shiftKey: true }),
      true,
    ),
    null,
  );
});

test("parseServerFrame accepts only well-formed frames", () => {
  assert.equal(parseServerFrame("not json"), null);
  assert.equal(parseServerFrame('"a string"'), null);
  assert.equal(parseServerFrame('{"t":"result","id":"1","ok":true}'), null);
  assert.deepEqual(parseServerFrame('{"t":"result","id":1,"ok":true,"value":5}'), {
    t: "result",
    id: 1,
    ok: true,
    value: 5,
    error: undefined,
  });
  assert.deepEqual(
    parseServerFrame('{"t":"event","channel":"pty:event","payload":{"a":1}}'),
    { t: "event", channel: "pty:event", payload: { a: 1 } },
  );
  const hello = parseServerFrame(
    '{"t":"hello","user":"u","platform":"darwin","version":"1.0.0","isDev":false}',
  );
  assert.equal(hello.t, "hello");
  assert.equal(hello.platform, "darwin");
});

test("encodeInvokeFrame round-trips through JSON", () => {
  assert.deepEqual(JSON.parse(encodeInvokeFrame(7, "pty:write", ["id", "x"])), {
    t: "invoke",
    id: 7,
    channel: "pty:write",
    args: ["id", "x"],
  });
});
