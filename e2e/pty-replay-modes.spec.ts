import { test, expect } from "./fixtures";
import { agentBin } from "./helpers/agent-bin";
import { join } from "node:path";
import { AGENT_TEST_TIMEOUT_MS } from "./timeouts";

const FAKE_CODEX = agentBin("codex", join(__dirname, "helpers", "fake-codex-mouse.cjs"));

test.use({ seedOptions: {
  singleTab: { presetId: "codex", name: "Codex" }, split: false,
  presetList: [{ id: "codex", name: "Codex", icon: "◆", color: "#10a37f", command: FAKE_CODEX }],
} });

test("a remounted Codex pane restores mouse tracking after its setup bytes were trimmed", async ({ app, window }) => {
  test.setTimeout(AGENT_TEST_TIMEOUT_MS);
  await expect.poll(() => window.evaluate(() => window.aya.ptyBuffer("tab-left")), { timeout: AGENT_TEST_TIMEOUT_MS })
    .toContain("FAKE_CODEX_MOUSE_READY");
  await app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get("pty:write");
    (globalThis as any).replayModeWrites = [];
    ipcMain.removeHandler("pty:write");
    ipcMain.handle("pty:write", (event: unknown, id: string, data: string) => {
      if (id === "tab-left") (globalThis as any).replayModeWrites.push(data);
      return original(event, id, data);
    });
  });
  const before = await window.evaluate(() => window.aya.ptyBuffer("tab-left"));
  const retainedSetups = ["\x1b[?1049h", "\x1b[?1003h", "\x1b[?1006h", "\x1b[?2004h", "\x1b[?1004h", "\x1b[?1h"]
    .map(mode => before.indexOf(mode)).filter(index => index >= 0);
  expect({ retainedSetups, length: before.length }).toEqual({ retainedSetups: [], length: expect.any(Number) });

  await window.reload();
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
