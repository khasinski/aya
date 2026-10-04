import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { test } from "./fixtures";
import { LIBEVAL_FILES, LIBEVAL_REMOTE, NEUTRAL_PROMPT, openMachines, seedBase, SSH_CONFIG, TWO_MACHINES } from "./helpers/machines";

// Settings > Machines and Open project > Remote host over one store of known ssh hosts.
// ssh is e2e/helpers/fake-ssh-machines.cjs (fixed answers, every call logged); no real host, no model touched.

const SHOTS = process.env.AYA_MACHINES_SHOTS;

async function shoot(app: ElectronApplication, window: Page, name: string) {
  if (!SHOTS) return;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900));
  await window.waitForTimeout(300);
  await window.screenshot({ path: join(SHOTS, name), scale: "css" });
}

/** Stubs Aya's native Add / Cancel dialog in main; records what it was asked. */
async function answerAddDialog(app: ElectronApplication, button: "Add" | "Cancel") {
  await app.evaluate(({ dialog }, response) => {
    const g = globalThis as unknown as { __asks: string[] };
    g.__asks = [];
    (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (...args: unknown[]) => {
      const opts = (args.length > 1 ? args[1] : args[0]) as { message: string; detail: string };
      g.__asks.push(`${opts.message}\n${opts.detail}`);
      return { response, checkboxChecked: false };
    };
  }, button === "Add" ? 0 : 1);
}
const asks = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __asks: string[] }).__asks);

const sshCalls = (root: string) => {
  const log = join(root, "ssh-calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
};

test.describe("empty", () => {
  test.use({ seedOptions: seedBase });

  test("empty state: the line, the sentence field, suggestions from all sources, nothing probed until Check", async ({ app, window, seeded }) => {
    const panel = await openMachines(window, app);
    await expect(panel.getByText("Your own machines with Ollama. Aya reads their state over ssh; it never loads or unloads a model.")).toBeVisible();
    await expect(panel.getByLabel("Add machines in one sentence")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Find" })).toBeVisible();
    await expect(panel.getByTestId("machine-card")).toHaveCount(0);

    const rows = panel.getByTestId("machine-suggestion");
    await expect(rows).toHaveCount(5);
    await expect(rows.locator(".aya-machine-target")).toHaveText(["gpu-box", "mini-lab", "old-server", "me@devbox", "This machine"]);
    await expect(rows.nth(3)).toContainText("remote project web");
    await expect(rows.nth(0)).toContainText("ssh config");
    expect(sshCalls(seeded.root), "listing suggestions connects to nothing").toEqual([]);

    await panel.getByRole("button", { name: "Check gpu-box" }).click();
    const found = rows.nth(0).getByTestId("machine-found");
    await expect(found).toContainText("Reachable · GPU NVIDIA GeForce RTX 4090");
    await expect(found).toContainText("Ollama 0.12.3 · qwen3:32b · hot until");
    await shoot(app, window, "1-machines-empty-checked.png");

    await panel.getByRole("button", { name: "Check old-server" }).click();
    await expect(rows.nth(2)).toContainText("Not reachable: ssh: old-server: Permission denied (publickey).");
    const calls = sshCalls(seeded.root);
    expect(calls.map((c) => c.split(" -- ")[1])).toEqual(["gpu-box sh -s", "old-server sh -s"]);
    expect(calls[0]).toContain("-o BatchMode=yes");
    expect(calls[0]).toContain("-o ClearAllForwardings=yes");
  });

  test("Add opens Aya's own dialog: Cancel saves nothing, Add saves and shows the card", async ({ app, window, seeded }) => {
    const panel = await openMachines(window, app);
    const registry = join(seeded.ayaHome, "machines.json");

    await answerAddDialog(app, "Cancel");
    await panel.getByRole("button", { name: "Add gpu-box" }).click();
    await expect(panel.getByTestId("machines-answer")).toHaveText("Not added: cancelled in Aya.");
    expect(await asks(app)).toHaveLength(1);
    expect(existsSync(registry)).toBe(false);
    await expect(panel.getByTestId("machine-card")).toHaveCount(0);

    await answerAddDialog(app, "Add");
    await panel.getByRole("button", { name: "Add gpu-box" }).click();
    await expect(panel.getByTestId("machines-answer")).toContainText("added gpu-box  ssh:gpu-box  ollama port 11434");
    const [ask] = await asks(app);
    expect(ask).toContain("Add gpu-box to Aya's machines?");
    expect(ask).toContain("NVIDIA GeForce RTX 4090");
    const card = panel.getByTestId("machine-card");
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("machine-state")).toContainText("Connected · ssh gpu-box · checked");
    await expect(card.getByRole("heading", { level: 4, name: "gpu-box" })).toBeFocused();
    expect(JSON.parse(readFileSync(registry, "utf8")).machines.map((m: { id: string }) => m.id)).toEqual(["gpu-box"]);
    await expect(panel.getByTestId("machine-suggestion").locator(".aya-machine-target")).toHaveText(["mini-lab", "old-server", "me@devbox", "This machine"]);
  });

  test("the sentence goes through the same add: drafted, asked in Aya, unclear words named", async ({ app, window, seeded }) => {
    const panel = await openMachines(window, app);
    await answerAddDialog(app, "Add");
    await panel.getByRole("button", { name: "Find" }).click();
    await expect(panel.getByRole("alert")).toContainText("Write which machines to add");
    await expect(panel.getByLabel("Add machines in one sentence")).toHaveAttribute("aria-invalid", "true");

    await panel.getByLabel("Add machines in one sentence").fill("mini-lab is the small box, and the laptop");
    await panel.getByRole("button", { name: "Find" }).click();
    await expect(panel.getByTestId("machines-answer")).toContainText("added mini-lab");
    await expect(panel.getByTestId("machines-answer")).toContainText('Did you mean this machine by "laptop"?');
    await expect(panel.getByTestId("machine-card")).toContainText("Ollama not answering on port 11434");
    expect(sshCalls(seeded.root).filter((c) => c.endsWith("mini-lab sh -s")).length).toBeGreaterThan(0);
  });
});

test.describe("added", () => {
  test.use({ seedOptions: { ...seedBase, ayaHomeFiles: { ...seedBase.ayaHomeFiles, "machines.json": TWO_MACHINES } } });

  test("added machines: a card each with state, GPU, models, occupancy; Free and Mark in use; suggestions below", async ({ app, window, seeded }) => {
    const panel = await openMachines(window, app);
    const cards = panel.getByTestId("machine-card");
    await expect(cards).toHaveCount(2);
    const gpu = cards.nth(0);
    await expect(gpu.getByTestId("machine-state")).toContainText("Connected · ssh gpu-box · checked");
    await expect(gpu).toContainText("NVIDIA GeForce RTX 4090 · 97% · 21.0/24.0 GB VRAM");
    await expect(gpu).toContainText("load 3.2 on 32 cores");
    await expect(gpu).toContainText(/qwen3:32b · hot until \d\d:\d\d \(1[34] min\)/);
    await expect(gpu.getByTestId("machine-occupancy")).toHaveText(/^In use: run5 timed collection · justi · since \d\d:\d\d$/);
    const mini = cards.nth(1);
    await expect(mini.getByTestId("machine-state")).toContainText("Connected · ssh mini-lab");
    await expect(mini).toContainText("Ollama not answering on port 11434");
    await expect(panel.getByTestId("machine-suggestion").locator(".aya-machine-target")).toHaveText(["old-server", "me@devbox", "This machine"]);
    await shoot(app, window, "2-machines-added.png");

    await gpu.getByRole("button", { name: "Free gpu-box" }).click();
    await expect(gpu.getByTestId("machine-occupancy")).toHaveCount(0);
    await gpu.getByRole("button", { name: "Mark in use, gpu-box" }).click();
    const purpose = gpu.getByLabel("What is gpu-box in use for?");
    await expect(purpose).toBeFocused();
    await purpose.fill("eval sweep");
    await gpu.getByRole("button", { name: "Save" }).click();
    await expect(gpu.getByTestId("machine-occupancy")).toContainText("In use: eval sweep ·");
    const saved = JSON.parse(readFileSync(join(seeded.ayaHome, "machines.json"), "utf8"));
    expect(saved.machines[0].occupancy.purpose).toBe("eval sweep");

    await gpu.getByRole("button", { name: "Check now, gpu-box" }).click();
    await expect(gpu.getByTestId("machine-state")).toContainText("Connected");

    window.once("dialog", (d) => void d.accept());
    await mini.getByRole("button", { name: "Remove mini-lab" }).click();
    await expect(cards).toHaveCount(1);
    await expect(panel.getByRole("heading", { level: 2, name: "Machines" })).toBeFocused();
  });

  test("Open project > Remote host offers the same known hosts with their sources", async ({ app, window }) => {
    await window.locator(".aya-tab-new").click();
    await window.getByRole("button", { name: "Remote" }).click();
    const list = window.getByTestId("remote-host-suggestions");
    const items = list.getByRole("button");
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toHaveText(/^gpu-box\s*ssh config · machine$/);
    await expect(items.nth(3)).toHaveText(/^me@devbox\s*remote project web$/);
    await shoot(app, window, "3-remote-host-suggestions.png");
    await items.nth(3).click();
    await expect(window.getByLabel("Remote host")).toHaveValue("me@devbox");
    await expect(items).toHaveCount(1);
    await expect(items.nth(0)).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("usage and history", () => {
  test.use({
    seedOptions: {
      ...seedBase,
      homeFiles: { ".ssh/config": SSH_CONFIG, ...NEUTRAL_PROMPT },
      launchEnv: { PS1: "$ " },
      ayaHomeFiles: { ...seedBase.ayaHomeFiles, ...LIBEVAL_FILES, "machines.json": TWO_MACHINES },
    },
  });

  test("a remote project open and a Check are saved; a row expands to its usage and history; removal keeps the line", async ({ app, window, seeded }) => {
    const savedFile = join(seeded.ayaHome, "ssh-hosts.json");
    expect(existsSync(savedFile), "nothing is saved before a host is used").toBe(false);
    // Open project > Remote host's own call: re-opening libeval on gpu-box is a use of gpu-box.
    await window.evaluate((req) => window.aya.createRemoteProject(req), LIBEVAL_REMOTE);
    const afterOpen = JSON.parse(readFileSync(savedFile, "utf8"));
    expect(afterOpen.hosts).toEqual([expect.objectContaining({ target: "gpu-box", addedFrom: "open-project", lastUsedFor: "project" })]);

    const panel = await openMachines(window, app);
    const gpu = panel.getByTestId("machine-card").nth(0);
    const toggle = gpu.getByRole("button", { name: "Usage and history, gpu-box" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const details = panel.locator(`#${await toggle.getAttribute("aria-controls")}`);
    await expect(details).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(details).toBeVisible();
    await expect(details).toContainText("Used by: machine gpu-box (in use: run5 timed collection, by justi); project libeval; panes tester (tester in team qa), implementer");
    await expect(details).toContainText(/Added \d\d:\d\d from Open project; last used \d\d:\d\d \(remote project\)/);
    await expect(details.getByRole("listitem")).toHaveText([/\d\d:\d\d added from Open project/, /\d\d:\d\d connected \(remote project libeval\)/]);

    // A Check updates the open row in place; a failed one says why in text.
    await panel.getByRole("button", { name: "Check old-server" }).click();
    await expect(panel.getByTestId("machine-suggestion").filter({ hasText: "old-server" })).toContainText("Not reachable");
    await gpu.getByRole("button", { name: "Check now, gpu-box" }).click();
    await expect(details).toContainText(/Last Check \d\d:\d\d: reachable/);
    await expect(details.getByRole("listitem").last()).toHaveText(/connected \(Check\)$/);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await shoot(app, window, "4-machines-host-expanded.png");
    if (SHOTS) await details.screenshot({ path: join(SHOTS, "4b-host-details.png") });

    // Removing mini-lab leaves it a suggestion that still carries its history.
    await panel.getByRole("button", { name: "Check now, mini-lab" }).click();
    window.once("dialog", (d) => void d.accept());
    await panel.getByRole("button", { name: "Remove mini-lab" }).click();
    await expect(panel.getByTestId("machine-card")).toHaveCount(1);
    const mini = panel.getByTestId("machine-suggestion").filter({ hasText: "mini-lab" });
    await mini.getByRole("button", { name: "Usage and history, mini-lab" }).click();
    await expect(mini.getByTestId("host-details").getByRole("listitem").last()).toHaveText(/removed machine mini-lab from Settings > Machines$/);
    const history = readFileSync(join(seeded.ayaHome, "ssh-hosts-history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(history.map((e: { target: string; event: string }) => `${e.target} ${e.event}`)).toEqual([
      "gpu-box added",
      "gpu-box connected",
      "old-server added",
      "old-server check-failed",
      "gpu-box connected",
      "mini-lab added",
      "mini-lab connected",
      "mini-lab removed",
    ]);
    expect(history.find((e: { event: string }) => e.event === "check-failed").why).toBe("ssh: old-server: Permission denied (publickey).");
    await window.keyboard.press("Escape");

    // Open project > Remote host: the most recently used first, with when.
    await window.locator(".aya-tab-new").click();
    await window.getByRole("button", { name: "Remote" }).click();
    const items = window.getByTestId("remote-host-suggestions").getByRole("button");
    await expect(items.nth(0)).toHaveText(/^mini-lab\s*ssh config · last used \d\d:\d\d$/);
    await expect(items.nth(1)).toHaveText(/^gpu-box\s*ssh config · remote project libeval · machine · last used \d\d:\d\d$/);
    await expect(items.nth(2)).toHaveText(/^old-server\s*ssh config · last used \d\d:\d\d$/);
    await shoot(app, window, "5-remote-host-recent-first.png");
  });
});
