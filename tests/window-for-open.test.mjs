// Bug 14: two control-socket opens with every window closed made two windows.

import { test } from "node:test";
import assert from "node:assert/strict";

const { createWindowSource } = await import("../dist-electron/window-for-open.js");

test("N opens with no window, plus an activate, create exactly one window", async () => {
  for (const n of [2, 5]) {
    let windows = [];
    let created = 0;
    const source = createWindowSource(
      () => windows[0] ?? null,
      async () => {
        created += 1;
        await new Promise((r) => setTimeout(r, 10));
        windows.push({ id: created });
        return windows[0];
      },
    );
    const got = await Promise.all([...Array.from({ length: n }, () => source.forOpen()), source.createOnce()]);
    assert.equal(created, 1, `${n} opens`);
    assert.ok(got.every((w) => w === got[0]));
  }
});

test("an existing window is reused and nothing is created", async () => {
  const win = { id: 1 };
  const source = createWindowSource(() => win, async () => assert.fail("created"));
  assert.equal(await source.forOpen(), win);
});

// An open that lands while Aya quits would be acked and then lost with the process.
const QUITTING = /quitting/;

// createOnce never reads the open windows, so it needs one cell.
for (const [label, existing, action] of [
  ["a window open, quitting: forOpen", () => ({ id: 1 }), "forOpen"],
  ["every window closed, quitting: forOpen", () => null, "forOpen"],
  ["quitting: createOnce", () => ({ id: 1 }), "createOnce"],
]) {
  test(label, async () => {
    let created = 0;
    const source = createWindowSource(existing, async () => ({ id: ++created }), () => true);
    await assert.rejects(source[action](), QUITTING);
    assert.equal(created, 0, "a window was created while quitting");
  });
}
