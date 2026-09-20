import { test, expect } from "./fixtures";
import type { ElectronApplication } from "@playwright/test";

async function zoomLevel(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getZoomLevel(),
  );
}

async function key(app: ElectronApplication, keyCode: string, shift = false) {
  // Native input exercises before-input-event as well as menu accelerators.
  await app.evaluate(({ BrowserWindow }, { keyCode, shift }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const modifiers = [process.platform === "darwin" ? "meta" : "control"];
    if (shift) modifiers.push("shift");
    contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  }, { keyCode, shift });
}

test("zoom shortcuts work with terminal focus and reset to the original size", async ({ app, window }) => {
  await window.locator(".xterm-helper-textarea").first().focus();
  await key(app, "0");
  await expect.poll(() => zoomLevel(app)).toBe(0);
  await key(app, "=");
  await expect.poll(() => zoomLevel(app)).toBe(1);
  await key(app, "+", true);
  await expect.poll(() => zoomLevel(app)).toBe(2);
  await key(app, "-");
  await expect.poll(() => zoomLevel(app)).toBe(1);
  await key(app, "0");
  await expect.poll(() => zoomLevel(app)).toBe(0);
});

test("Ctrl+wheel zooms over a terminal while ordinary wheel does not", async ({ app, window }) => {
  await key(app, "0");
  const terminal = window.locator(".xterm-screen").first();
  await terminal.hover();
  await window.mouse.wheel(0, -120);
  await expect.poll(() => zoomLevel(app)).toBe(0);

  // Send real wheel input, rather than emitting zoom-changed directly.
  const box = await terminal.boundingBox();
  if (!box) throw new Error("terminal is not visible");
  const point = { x: Math.round(box.x + 20), y: Math.round(box.y + 20) };
  const wheel = async (deltaY: number) => app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({
      type: "mouseWheel", ...event, deltaX: 0, modifiers: ["control"],
    });
  }, { ...point, deltaY });
  await wheel(120);
  await expect.poll(() => zoomLevel(app)).toBe(1);
  await wheel(-120);
  await expect.poll(() => zoomLevel(app)).toBe(0);
});
