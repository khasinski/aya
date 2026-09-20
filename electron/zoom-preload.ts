/// <reference lib="dom" />
import { webFrame } from "electron";
import { nextZoomLevel } from "./zoom";

export function installWheelZoom(): void {
  // Capture before xterm handles scrolling, including mouse-reporting apps.
  window.addEventListener("wheel", (event) => {
    if (!event.ctrlKey || event.altKey || event.metaKey || event.deltaY === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    webFrame.setZoomLevel(nextZoomLevel(
      webFrame.getZoomLevel(), event.deltaY < 0 ? 1 : -1,
    ));
  }, { capture: true, passive: false });
}
