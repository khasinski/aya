import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const program = "process.stdin.setRawMode(true); process.stdin.pause(); console.log('BLOCKED_READY'); setInterval(()=>{},1000)";
const command = `exec ${quote(process.execPath)} -e ${quote(program)}`;
test.use({ seedOptions: { singleTab: { presetId: "blocked", name: "Blocked" }, split: false,
  presetList: [{ id: "blocked", name: "Blocked", icon: "$", color: "", command }] } });

test("a real renderer paste interrupted by owner death reports uncertain input and is never resent", async ({ app, window, seeded }) => {
  const terminal = window.getByTestId("xterm-host").first();
  await expect(terminal).toContainText("BLOCKED_READY");
  const errors: string[] = []; window.on("pageerror", error => errors.push(error.message));
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> };
    const original = handlers._invokeHandlers.get("pty:write")!;
    const state = globalThis as unknown as { pasteCalls: number; pasteSettled: number };
    state.pasteCalls = 0; state.pasteSettled = 0;
    ipcMain.removeHandler("pty:write");
    ipcMain.handle("pty:write", async (...args) => {
      state.pasteCalls++;
      try { return await original(...args); } finally { state.pasteSettled++; }
    });
  });
  await terminal.click();
  await terminal.locator(".xterm-helper-textarea").evaluate(textarea => {
    const transfer = new DataTransfer(); transfer.setData("text/plain", "x".repeat(1024 * 1024));
    textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => app.evaluate(() => {
    const s = globalThis as unknown as { pasteCalls: number; pasteSettled: number }; return [s.pasteCalls, s.pasteSettled];
  })).toEqual([1, 0]);
  const record = JSON.parse(readFileSync(join(seeded.ayaHome, "pty-owner/record.json"), "utf8"));
  process.kill(record.pid, "SIGKILL");
  await expect(terminal).toContainText("Input may have been only partly delivered");
  await expect(terminal).toContainText("Check the pane before retrying. Aya did not resend it.");
  await expect.poll(() => app.evaluate(() => {
    const s = globalThis as unknown as { pasteCalls: number; pasteSettled: number }; return [s.pasteCalls, s.pasteSettled];
  })).toEqual([1, 1]);
  await window.waitForTimeout(250);
  expect(await app.evaluate(() => (globalThis as unknown as { pasteCalls: number }).pasteCalls)).toBe(1);
  expect(errors).toEqual([]);
});
