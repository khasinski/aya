import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { test } from "./fixtures";
import { openMachinesSettings, seedBase, THREE_MACHINES } from "./helpers/machines";

// Machines: the status bar item and its popover, and Settings > Machines for setup.
// ssh is e2e/helpers/fake-ssh-machines.cjs (fixed answers, every call logged); no real host, no model touched.

const SHOTS = process.env.AYA_MACHINES_SHOTS;

async function shoot(app: ElectronApplication, window: Page, name: string) {
  if (!SHOTS) return;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900));
  await window.waitForTimeout(300);
  await window.screenshot({ path: join(SHOTS, name), scale: "css" });
}

const sshCalls = (root: string) => {
  const log = join(root, "ssh-calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
};

test.describe("none added", () => {
  test.use({ seedOptions: seedBase });

  test("no status bar item; Settings suggests hosts without connecting, Add saves with no dialog, Remove takes it out", async ({ app, window, seeded }) => {
    await expect(window.getByTestId("machines-toggle")).toHaveCount(0);
    const panel = await openMachinesSettings(window, app);
    await expect(panel).toContainText("No machines yet.");
    const suggested = panel.locator(".aya-settings-suggested-btn");
    await expect(suggested).toHaveText(["Add this machine", "Add gpu-box", "Add mini-lab", "Add old-server", "Add me@devbox"]);
    expect(sshCalls(seeded.root), "listing suggestions connects to nothing").toEqual([]);
    await shoot(app, window, "settings-empty.png");

    // A click in Aya is the user's own yes: no native dialog.
    await app.evaluate(({ dialog }) => {
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => {
        throw new Error("no dialog for a click in Aya");
      };
    });
    await panel.getByRole("button", { name: "Add gpu-box" }).click();
    await expect(panel.getByRole("status")).toHaveText("Added gpu-box.");
    await expect(panel.getByRole("list", { name: "Added machines" })).toContainText("gpu-box");
    await expect(panel).toContainText("ssh gpu-box · Ollama port 11434");
    const registry = join(seeded.ayaHome, "machines.json");
    expect(JSON.parse(readFileSync(registry, "utf8")).machines.map((m: { id: string }) => m.id)).toEqual(["gpu-box"]);
    await expect(suggested).toHaveText(["Add this machine", "Add mini-lab", "Add old-server", "Add me@devbox"]);
    const calls = sshCalls(seeded.root);
    expect(calls[0]).toContain("-o BatchMode=yes");
    expect(calls[0]).toContain("-o ClearAllForwardings=yes");
    expect(calls[0]).toMatch(/ -- gpu-box sh -s$/);

    // The typed form takes the same sentence as `aya machines add`, a port included.
    await panel.getByLabel("Machine to add").fill("mini-lab port 11435, and the laptop");
    await panel.getByRole("button", { name: "Add", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText('Added mini-lab. Did you mean this machine by "laptop"? Say local to add it, or name its ssh alias.');
    await expect(panel).toContainText("ssh mini-lab · Ollama port 11435");

    await window.keyboard.press("Escape");
    await expect(window.getByTestId("machines-toggle")).toContainText("gpu-box 97%");

    const again = await openMachinesSettings(window, app);
    await again.getByRole("listitem").filter({ hasText: "mini-lab" }).getByRole("button", { name: "Remove" }).click();
    await expect(again.getByRole("list", { name: "Added machines" })).not.toContainText("mini-lab");
    expect(JSON.parse(readFileSync(registry, "utf8")).machines.map((m: { id: string }) => m.id)).toEqual(["gpu-box"]);
  });
});

test.describe("three added", () => {
  test.use({ seedOptions: { ...seedBase, ayaHomeFiles: { ...seedBase.ayaHomeFiles, "machines.json": THREE_MACHINES } } });

  test("the status bar names each state in words; the popover says what is loaded and who claimed it; Release clears the claim", async ({ app, window, seeded }) => {
    const bar = window.getByTestId("machines-toggle");
    await expect(bar).toHaveAccessibleName("Machines: gpu-box ready, claimed; mini-lab ollama down; old-server unreachable");
    await expect(bar).toContainText("gpu-box 97% claimed");
    await expect(bar.locator(".aya-machine-dot--warn")).toHaveCount(1);
    await expect(bar.locator(".aya-machine-dot--down")).toHaveCount(1);

    await bar.click();
    const popover = window.getByRole("dialog", { name: "Machines" });
    const entries = popover.getByTestId("machine-entry");
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0)).toContainText("gpu-boxRTX 4090Ready");
    await expect(entries.nth(0)).toContainText("GPU 97% · VRAM 21.0/24.0 GB · ssh gpu-box");
    await expect(entries.nth(0)).toContainText(/qwen3:32b · 19\.6 GB · until \d\d:\d\d \(1[34] min\)/);
    await expect(entries.nth(0)).toContainText("Claimed: run5 timed collection · justi (pane lead) · since");
    await expect(entries.nth(1)).toContainText("mini-labApple M2 ProOllama down");
    await expect(entries.nth(1)).toContainText("CPU 0.8/10 · RAM 12.0/32.0 GB · ssh mini-lab");
    await expect(entries.nth(1)).toContainText("Ollama not answering on port 11434");
    await expect(entries.nth(2)).toContainText("old-serverUnreachable");
    await expect(entries.nth(2)).toContainText("ssh old-server: ssh: old-server: Permission denied (publickey).");
    await shoot(app, window, "status-popover.png");

    await entries.nth(0).getByRole("button", { name: "Release" }).click();
    await expect(entries.nth(0)).not.toContainText("Claimed");
    await expect(bar).toContainText("gpu-box 97%");
    await expect(bar).not.toContainText("claimed");
    expect(JSON.parse(readFileSync(join(seeded.ayaHome, "machines.json"), "utf8")).machines[0].claim).toBeUndefined();

    await window.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await bar.click();
    await window.getByRole("dialog", { name: "Machines" }).getByRole("button", { name: "Manage" }).click();
    await expect(window.locator(".aya-machines-settings")).toBeVisible();
    await expect(window.locator(".aya-settings-actions-note")).toHaveText("Machines are saved as you change them.");
    await shoot(app, window, "settings-added.png");
  });
});
