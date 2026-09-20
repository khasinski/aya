import type { WebContents } from "electron";

// Keep keyboard and wheel zoom within Chromium's usual 50–300% range.
const MIN_ZOOM = Math.log(0.5) / Math.log(1.2);
const MAX_ZOOM = Math.log(3) / Math.log(1.2);

export function nextZoomLevel(current: number, direction: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current + direction));
}

export function installWindowZoom(contents: WebContents): void {
  const step = (direction: number) => {
    contents.setZoomLevel(nextZoomLevel(contents.getZoomLevel(), direction));
  };

  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.alt) return;
    const modifier = process.platform === "darwin"
      ? input.meta && !input.control
      : input.control && !input.meta;
    if (!modifier) return;

    // '+' commonly requires Shift; '=' is the unshifted browser shortcut.
    // Match logical keys so this also works with non-US keyboard layouts.
    if (input.key === "+" || input.key === "=") {
      event.preventDefault();
      step(1);
    } else if (input.key === "-" && !input.shift) {
      event.preventDefault();
      step(-1);
    } else if (input.key === "0" && !input.shift) {
      event.preventDefault();
      contents.setZoomLevel(0);
    }
  });
}
