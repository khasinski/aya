import { test, expect } from "./fixtures";
import { waitForShellReady } from "./helpers/terminal";
import { AGENT_TEST_TIMEOUT_MS } from "./timeouts";

test.use({ seedOptions: {
  singleTab: { presetId: "shell", name: "Shell" }, split: false,
  presetList: [{ id: "shell", name: "Shell", icon: "$", color: "", command: "exec /bin/sh -i" }],
} });

test("a remounted pane restores retained TUI mouse modes after their setup bytes were trimmed", async ({ app, window }) => {
  test.setTimeout(AGENT_TEST_TIMEOUT_MS);
  await waitForShellReady(window);
  await app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get("pty:write");
    (globalThis as any).replayModeWrites = [];
    ipcMain.removeHandler("pty:write");
    ipcMain.handle("pty:write", (event: unknown, id: string, data: string) => {
      if (id === "tab-left") (globalThis as any).replayModeWrites.push(data);
      return original(event, id, data);
    });
  });
  await window.evaluate(() => window.aya.ptyWrite("tab-left", "printf '\\033[?1049h\\033[?1003h\\033[?1006h\\033[?2004h\\033[?1004h\\033[?1h'; printf '\\nMODE_READY\\n'\r"));
  await expect.poll(() => window.evaluate(() => window.aya.ptyBuffer("tab-left")), { timeout: AGENT_TEST_TIMEOUT_MS }).toContain("MODE_READY");
  for (let i = 0; i < 27; i++) {
    await window.evaluate((n) => window.aya.ptyWrite("tab-left", `head -c 40000 /dev/zero | tr '\\000' X; printf '\\nCHUNK_${n}\\n'\r`), i);
    await expect.poll(() => window.evaluate(() => window.aya.ptyBuffer("tab-left")), { timeout: 3_000 }).toContain(`CHUNK_${i}`);
  }
  await window.evaluate(() => window.aya.ptyWrite("tab-left", "cat\r"));
  await expect.poll(() => window.evaluate(() => window.aya.ptyBuffer("tab-left")), { timeout: 3_000 }).toBeTruthy();
  const before = await window.evaluate(() => window.aya.ptyBuffer("tab-left"));
  const retainedSetups = ["\x1b[?1049h", "\x1b[?1003h", "\x1b[?1006h", "\x1b[?2004h", "\x1b[?1004h", "\x1b[?1h"]
    .map(mode => before.indexOf(mode)).filter(index => index >= 0);
  expect({ retainedSetups, length: before.length }).toEqual({ retainedSetups: [], length: expect.any(Number) });

  await window.reload();
  await waitForShellReady(window);
  const screen = window.locator('[data-testid="terminal-pane"][data-terminal-id="tab-left"] .xterm-screen');
  await expect(screen).toBeVisible();
  await expect.poll(() => screen.evaluate(el => el.closest(".xterm")?.classList.contains("enable-mouse-events"))).toBe(true);
  const box = await screen.boundingBox();
  expect(box).toBeTruthy();
  await window.mouse.move(box!.x + 30, box!.y + 30);
  await window.mouse.wheel(0, -120);
  await expect.poll(() => app.evaluate(() => (globalThis as any).replayModeWrites), { timeout: 5_000 })
    .toEqual(expect.arrayContaining([expect.stringMatching(/^\x1b\[<64;\d+;\d+M$/)]));
});
