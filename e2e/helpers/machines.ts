import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { fireShortcut } from "./shortcut";

// Seed for machines: a temp ~/.ssh/config, one remote project and the fake ssh (fake-ssh-machines.cjs).
export const SSH_CONFIG = "Host gpu-box\n  HostName 192.0.2.10\nHost mini-lab old-server\nHost *.lan\n";
export const REMOTE_PROJECT = JSON.stringify({
  name: "web",
  directory: "/home/me/web",
  tabs: [],
  remote: { hostId: "devbox", label: "devbox", sshTarget: "me@devbox", directory: "/home/me/web" },
});
const SINCE = new Date(Date.now() - 25 * 60_000).toISOString();
/** One of each state: busy and claimed, Ollama down, unreachable. */
export const THREE_MACHINES = JSON.stringify({
  version: 1,
  machines: [
    { id: "gpu-box", reach: { ssh: "gpu-box" }, ollama: { port: 11434 }, claim: { by: "justi", pane: "lead", purpose: "run5 timed collection", since: SINCE } },
    { id: "mini-lab", reach: { ssh: "mini-lab" }, ollama: { port: 11434 } },
    { id: "old-server", reach: { ssh: "old-server" }, ollama: { port: 11434 } },
  ],
});
export const seedBase = {
  fakeSshMachines: true,
  homeFiles: { ".ssh/config": SSH_CONFIG },
  ayaHomeFiles: { "projects/web.json": REMOTE_PROJECT },
};

export async function openMachinesSettings(window: Page, app: ElectronApplication) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings.getByRole("tab", { name: /Machines/ }).click();
  const panel = settings.locator(".aya-machines-settings");
  await expect(panel).toBeVisible();
  return panel;
}
