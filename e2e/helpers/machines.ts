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
/** One of each row state: busy and in use, idle, Ollama down, unreachable. */
export const FOUR_MACHINES = JSON.stringify({
  version: 1,
  machines: [
    ...JSON.parse(TWO_MACHINES).machines,
    { id: "spare-box", label: "spare-box", reach: { ssh: "spare-box" }, ollama: { port: 11434 } },
    { id: "old-server", label: "old-server", reach: { ssh: "old-server" }, ollama: { port: 11434 } },
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


// A remote project on gpu-box with two panes, one playing the tester role in a saved team "qa".
export const LIBEVAL_REMOTE = { name: "libeval", directory: "/srv/libeval", hostId: "gpu-box", label: "gpu-box", sshTarget: "gpu-box" };
export const LIBEVAL_FILES = {
  "projects/gpu-box-libeval.json": JSON.stringify({
    name: "libeval",
    directory: "/srv/libeval",
    tabs: [
      { id: "lib-tester", presetId: "shell", name: "tester" },
      { id: "lib-impl", presetId: "shell", name: "implementer" },
    ],
    remote: { hostId: "gpu-box", label: "gpu-box", sshTarget: "gpu-box", directory: "/srv/libeval" },
  }),
  "teams/gpu-box-libeval/qa/saved.md": "# qa\n",
  "teams/gpu-box-libeval/qa/assignments.json": JSON.stringify({ tester: "lib-tester" }),
};
/** A neutral prompt, so no real host name shows in a screenshot. */
export const NEUTRAL_PROMPT = { ".zshrc": "PS1='$ '\n", ".bashrc": "PS1='$ '\n", ".profile": "PS1='$ '\nexport PS1\n" };
