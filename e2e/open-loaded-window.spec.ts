import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { sendControl } from "./helpers/control";
import { waitForShellReady } from "./helpers/terminal";

// Several `aya open` requests into a window that has already loaded must all become projects.

const tabNames = (window: Page) => window.locator(".aya-topbar .aya-tab .aya-tab-name");

function makeDirs(root: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const dir = join(root, `burst-${i}`);
    mkdirSync(dir);
    return dir;
  });
}

for (const count of [2, 3, 5]) {
  test(`${count} back-to-back opens into a loaded window keep every project and its shell`, async ({
    window,
    seeded,
  }) => {
    const dirs = makeDirs(seeded.root, count);
    await expect(tabNames(window)).toHaveText(["e2e"]);

    await Promise.all(dirs.map((path) => sendControl(seeded.ayaHome, { type: "open", path })));

    const names = dirs.map((_, i) => `burst-${i}`);
    await expect(tabNames(window)).toHaveText(["e2e", ...names]);
    for (const name of names) {
      await window.locator(".aya-topbar .aya-tab", { hasText: name }).click();
      await waitForShellReady(window);
    }
  });
}

test("opens sent one after another keep every project", async ({ window, seeded }) => {
  const dirs = makeDirs(seeded.root, 3);
  await expect(tabNames(window)).toHaveText(["e2e"]);
  for (const path of dirs) await sendControl(seeded.ayaHome, { type: "open", path });
  await expect(tabNames(window)).toHaveText(["e2e", "burst-0", "burst-1", "burst-2"]);
});

test("opening the same directory twice at once yields one project", async ({ window, seeded }) => {
  const [dir] = makeDirs(seeded.root, 1);
  await expect(tabNames(window)).toHaveText(["e2e"]);
  await Promise.all([1, 2, 3].map(() => sendControl(seeded.ayaHome, { type: "open", path: dir })));
  await expect(tabNames(window)).toHaveText(["e2e", "burst-0"]);
  await window.waitForTimeout(500);
  await expect(tabNames(window)).toHaveText(["e2e", "burst-0"]);
});

test("opens racing the removal of a project keep the new ones and drop only the removed", async ({
  window,
  seeded,
}) => {
  const dirs = makeDirs(seeded.root, 3);
  await expect(tabNames(window)).toHaveText(["e2e"]);
  await sendControl(seeded.ayaHome, { type: "open", path: dirs[0] });
  await expect(tabNames(window)).toHaveText(["e2e", "burst-0"]);

  const doomed = window.locator(".aya-topbar .aya-tab", { hasText: "burst-0" });
  await doomed.hover();
  const opens = Promise.all(
    dirs.slice(1).map((path) => sendControl(seeded.ayaHome, { type: "open", path })),
  );
  await doomed.locator(".aya-tab-close").click();
  await opens;

  await expect(tabNames(window)).toHaveText(["e2e", "burst-1", "burst-2"]);
});

test("opens sent while the window is still loading all land once it is ready", async ({
  app,
  seeded,
}) => {
  const dirs = makeDirs(seeded.root, 3);
  const socket = join(seeded.ayaHome, "aya.sock");
  await expect.poll(() => existsSync(socket), { intervals: [10] }).toBe(true);
  await Promise.all(dirs.map((path) => sendControl(seeded.ayaHome, { type: "open", path })));

  const window = await app.firstWindow();
  await expect(tabNames(window)).toHaveText(["e2e", "burst-0", "burst-1", "burst-2"]);
});

for (const reloadAfterMs of [0, 150]) {
  test(`acked opens survive the window reloading ${reloadAfterMs} ms after they were sent`, async ({ window, seeded }) => {
    const dirs = makeDirs(seeded.root, 4);
    await expect(tabNames(window)).toHaveText(["e2e"]);

    const replies = Promise.all(dirs.map((path) => sendControl(seeded.ayaHome, { type: "open", path })));
    await window.waitForTimeout(reloadAfterMs);
    await window.reload();
    await replies;

    // Order is not asserted: a project the old page was still creating when it reloaded
    // is finished by the replayed open, after the ones the new page created at once.
    await expect
      .poll(async () => (await tabNames(window).allTextContents()).sort())
      .toEqual(["burst-0", "burst-1", "burst-2", "burst-3", "e2e"]);
  });
}

/** Time for the page to save a project change and confirm it to main. */
const SAVE_SETTLE_MS = 1_000;

test("a project opened, then closed by the user, is not opened again by a reload", async ({ window, seeded }) => {
  const [dir] = makeDirs(seeded.root, 1);
  await expect(tabNames(window)).toHaveText(["e2e"]);
  await sendControl(seeded.ayaHome, { type: "open", path: dir });
  await expect(tabNames(window)).toHaveText(["e2e", "burst-0"]);
  await window.waitForTimeout(SAVE_SETTLE_MS);

  const opened = window.locator(".aya-topbar .aya-tab", { hasText: "burst-0" });
  await opened.hover();
  await opened.locator(".aya-tab-close").click();
  await expect(tabNames(window)).toHaveText(["e2e"]);
  await window.waitForTimeout(SAVE_SETTLE_MS);

  await window.reload();
  await expect(tabNames(window)).toHaveText(["e2e"]);
  await window.waitForTimeout(SAVE_SETTLE_MS);
  await expect(tabNames(window)).toHaveText(["e2e"]);
});
