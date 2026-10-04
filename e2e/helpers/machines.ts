import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { fireShortcut } from "./shortcut";

// Seed for Settings > Machines: a temp ~/.ssh/config, one remote project and the fake ssh (fake-ssh-machines.cjs).
export const SSH_CONFIG = "Host gpu-box\n  HostName 192.0.2.10\nHost mini-lab old-server\nHost *.lan\n";
export const REMOTE_PROJECT = JSON.stringify({
  name: "web",
  directory: "/home/me/web",
  tabs: [],
  remote: { hostId: "devbox", label: "devbox", sshTarget: "me@devbox", directory: "/home/me/web" },
});
const SINCE = new Date(Date.now() - 25 * 60_000).toISOString();
export const TWO_MACHINES = JSON.stringify({
  version: 1,
  machines: [
    {
      id: "gpu-box",
      label: "gpu-box",
      reach: { ssh: "gpu-box" },
      ollama: { port: 11434 },
      occupancy: { by: "justi", purpose: "run5 timed collection", since: SINCE },
    },
    { id: "mini-lab", label: "mini-lab", reach: { ssh: "mini-lab" }, ollama: { port: 11434 } },
  ],
});
export const seedBase = {
  fakeSshMachines: true,
  homeFiles: { ".ssh/config": SSH_CONFIG },
  ayaHomeFiles: { "projects/web.json": REMOTE_PROJECT },
};

export async function openMachines(window: Page, app: ElectronApplication) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings.getByRole("tab", { name: /Machines/ }).click();
  const panel = settings.getByRole("tabpanel", { name: /Machines/ });
  await expect(panel.getByRole("heading", { level: 2, name: "Machines" })).toBeVisible();
  return panel;
}

