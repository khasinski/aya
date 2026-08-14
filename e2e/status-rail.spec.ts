import net from "node:net";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// StatusRail — the sidebar counterpart to the AttentionCenter modal. It must
// appear below New Terminal without taking height from the terminal viewport.

function sendControl(ayaHome: string, payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(join(ayaHome, "aya.sock"));
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", () => resolve());
    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
}

const rail = (window: Page) => window.locator(".aya-status-rail");

test("the rail stays hidden until something needs attention, then lists it", async ({
  window,
  seeded,
}) => {
  // Gate on the app being interactive before driving the control socket —
  // a status sent mid-boot lands before the terminal exists and is dropped.
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);
  // Nothing is blocked on a freshly-seeded app, so the rail must not take up
  // any space at all.
  await expect(rail(window)).toHaveCount(0);

  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "waiting",
    text: "Needs approval",
    terminalId: seeded.tabIds.right,
  });

  await expect(rail(window)).toBeVisible();
  await expect(window.locator(".aya-launcher > .aya-status-rail")).toBeVisible();
  await expect(window.locator(".aya-app > .aya-status-rail")).toHaveCount(0);
  const row = rail(window).locator(".aya-status-rail-row", { hasText: "shell 2" });
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/aya-status-rail-row--waiting/);
  await expect(row).toContainText("Needs approval");
  await expect(rail(window).locator(".aya-status-rail-count--waiting")).toContainText(
    "1 waiting",
  );

  // Clearing the agent status returns the terminal to a normal state, and the
  // rail should vanish rather than linger with a stale row.
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "clear",
    terminalId: seeded.tabIds.right,
  });
  await expect(rail(window)).toHaveCount(0);
});

test("clicking a rail row focuses that terminal's pane", async ({ window, seeded }) => {
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);

  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "error",
    text: "boom",
    terminalId: seeded.tabIds.right,
  });

  const row = rail(window).locator(".aya-status-rail-row", { hasText: "shell 2" });
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/aya-status-rail-row--error/);
  await row.click();

  // Same observable as the AttentionCenter focus path: the active split cell
  // moves, and real keyboard focus lands in that pane's xterm textarea.
  await expect(
    window.locator('.aya-pane--active-split[data-terminal-name="shell 2"]'),
  ).toBeVisible();
  await expect
    .poll(() =>
      window.evaluate(() => {
        const ae = document.activeElement;
        if (ae?.tagName !== "TEXTAREA") return null;
        return (
          ae.closest('[data-testid="terminal-pane"]')?.getAttribute("data-terminal-name") ??
          null
        );
      }),
    )
    .toBe("shell 2");
});

test("the rail collapses to just its counts and the choice persists", async ({
  window,
  seeded,
}) => {
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "waiting",
    text: "Needs approval",
    terminalId: seeded.tabIds.right,
  });
  await expect(rail(window).locator(".aya-status-rail-row")).toHaveCount(1);

  await rail(window).locator(".aya-status-rail-toggle").click();

  // Collapsed: the summary counts stay (that's the point of the strip), the
  // per-terminal rows go away.
  await expect(rail(window).locator(".aya-status-rail-row")).toHaveCount(0);
  await expect(rail(window).locator(".aya-status-rail-count--waiting")).toBeVisible();
  await expect(rail(window)).toHaveClass(/aya-status-rail--collapsed/);

  // The preference is stored so a reload doesn't re-expand it in the user's face.
  await expect
    .poll(() => window.evaluate(() => localStorage.getItem("aya:status-rail-collapsed")))
    .toBe("1");
});
