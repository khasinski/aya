import net from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

// The control socket is up before the window's renderer has loaded. `aya open`
// sent in that gap was acked and then lost, so the project never opened.

const SOCKET_POLL_MS = 10;

function openOverControl(ayaHome: string, directory: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(join(ayaHome, "aya.sock"));
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ type: "open", path: directory })}\n`));
    socket.on("data", (chunk) => (reply += chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(reply));
  });
}

test("an open sent as soon as the control socket appears opens the project", async ({
  app,
  seeded,
}) => {
  const dir = join(seeded.root, "open-check");
  mkdirSync(dir);
  const socket = join(seeded.ayaHome, "aya.sock");
  await expect.poll(() => existsSync(socket), { intervals: [SOCKET_POLL_MS] }).toBe(true);

  expect(JSON.parse(await openOverControl(seeded.ayaHome, dir))).toMatchObject({ ok: true });

  const window = await app.firstWindow();
  await expect(window.locator(".aya-tab-name", { hasText: "open-check" })).toBeVisible();
});

test("an open with every window closed opens the project in a new window", async ({
  app,
  window,
  seeded,
}) => {
  test.skip(process.platform !== "darwin", "only macOS keeps running with no window");
  const dir = join(seeded.root, "open-check");
  mkdirSync(dir);
  await expect(window.locator(".aya-tab-name").first()).toBeVisible();
  await window.close();

  const opened = app.waitForEvent("window");
  expect(JSON.parse(await openOverControl(seeded.ayaHome, dir))).toMatchObject({ ok: true });

  await expect((await opened).locator(".aya-tab-name", { hasText: "open-check" })).toBeVisible();
});

test("two opens with every window closed share one new window", async ({
  app,
  window,
  seeded,
}) => {
  test.skip(process.platform !== "darwin", "only macOS keeps running with no window");
  const dirs = ["open-one", "open-two"].map((name) => join(seeded.root, name));
  for (const dir of dirs) mkdirSync(dir);
  await expect(window.locator(".aya-tab-name").first()).toBeVisible();
  await window.close();

  const opened = app.waitForEvent("window");
  const replies = await Promise.all(dirs.map((dir) => openOverControl(seeded.ayaHome, dir)));
  for (const reply of replies) expect(JSON.parse(reply)).toMatchObject({ ok: true });

  const win = await opened;
  for (const name of ["open-one", "open-two"]) {
    await expect(win.locator(".aya-tab-name", { hasText: name })).toBeVisible();
  }
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});
