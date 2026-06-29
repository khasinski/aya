import net from "node:net";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// AttentionCenter (opened from the StatusBar). Attention items are injected via
// the control socket (same mechanism as status-clear.spec.ts). Focus/Close are
// asserted at the real observable (active pane / removed terminal).

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

const dot = (window: Page, name: string) =>
  window.locator(".aya-sidebar-row", { hasText: name }).locator(".aya-sidebar-statusdot");

async function openAttention(window: Page) {
  await window.getByTitle("Open attention center").click();
  const modal = window.locator(".aya-attention-modal");
  await expect(modal).toBeVisible();
  return modal;
}

// ADVERSARIAL: Focus from AttentionCenter must move the active split CELL (and
// keyboard focus) to the target - exactly like the search-jump fix. focusTerminal
// only sets activeProjectId+activeTab, so this is expected to expose the same
// focus-divergence bug in a split.
test("AttentionCenter Focus activates the target's pane in a split", async ({
  window,
  app,
  seeded,
}) => {
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);
  await expect(
    window.locator('.aya-pane--active-split[data-terminal-name="shell 1"]'),
  ).toBeVisible();

  // Inject an error on the NON-active shell 2 so it appears as a Failed row.
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "error",
    text: "boom",
    terminalId: seeded.tabIds.right,
  });
  await expect(dot(window, "shell 2")).toHaveClass(/aya-sidebar-statusdot--error/);

  const modal = await openAttention(window);
  const row = modal.locator(".aya-attention-row", { hasText: "shell 2" });
  await expect(row).toBeVisible();
  await row.locator("button", { hasText: "Focus" }).click();

  await expect(modal).toBeHidden();
  // shell 2 must now be the active pane - and real keyboard focus must land there.
  await expect(
    window.locator('.aya-pane--active-split[data-terminal-name="shell 2"]'),
  ).toBeVisible();
  await expect
    .poll(() =>
      window.evaluate(
        () =>
          document.activeElement
            ?.closest('[data-testid="terminal-pane"]')
            ?.getAttribute("data-terminal-name") ?? null,
      ),
    )
    .toBe("shell 2");
});

test("AttentionCenter Close removes the terminal", async ({ window, app, seeded }) => {
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "error",
    text: "boom",
    terminalId: seeded.tabIds.right,
  });
  await expect(dot(window, "shell 2")).toHaveClass(/aya-sidebar-statusdot--error/);

  const modal = await openAttention(window);
  const row = modal.locator(".aya-attention-row", { hasText: "shell 2" });
  await expect(row).toBeVisible();
  await row.locator("button", { hasText: "Close" }).click();

  // shell 2 is gone: its row leaves the modal and the sidebar.
  await expect(modal.locator(".aya-attention-row", { hasText: "shell 2" })).toHaveCount(0);
  await expect(window.locator(".aya-sidebar-row", { hasText: "shell 2" })).toHaveCount(0);
  await expect(window.getByTestId("sidebar-terminal")).toHaveCount(1);
});
