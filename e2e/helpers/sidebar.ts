import type { Page } from "@playwright/test";

/** The sidebar row whose name is exactly `name`. */
export function sidebarRow(window: Page, name: string) {
  return window.locator(".aya-sidebar-row", {
    has: window.locator(".aya-sidebar-name", { hasText: new RegExp(`^${name}$`) }),
  });
}
