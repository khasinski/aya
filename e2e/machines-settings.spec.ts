import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures";
import { FOUR_MACHINES, LIBEVAL_FILES, LIBEVAL_REMOTE, NEUTRAL_PROMPT, openMachines, seedBase, SSH_CONFIG, TWO_MACHINES } from "./helpers/machines";

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

/** Runs one of a row's actions through its More disclosure, as a user does. */
async function rowAction(panel: Locator, machine: string, action: string) {
  const more = panel.getByRole("button", { name: `More, ${machine}` });
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
  await panel.getByRole("button", { name: action }).click();
}

const sshCalls = (root: string) => {
  const log = join(root, "ssh-calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
};

test.describe("empty", () => {
  test.use({ seedOptions: seedBase });

  test("empty state: the line, the sentence field, suggestions from all sources, nothing probed until Check", async ({ app, window, seeded }) => {
    const panel = await openMachines(window, app);
    await expect(panel.getByText("Your own machines with Ollama, read over ssh. Aya asks before it adds one and never loads or unloads a model.")).toBeVisible();
    await expect(panel.getByLabel("Add machines in one sentence")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Find" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Check all" })).toBeVisible();
    await expect(panel.getByTestId("machine-row")).toHaveCount(0);
    await expect(panel.getByTestId("machines-empty")).toHaveText("No machines yet. Add one from the suggestions below, or name them in one sentence above.");
    await expect(panel.getByRole("button", { name: "Suggested (5)" })).toHaveAttribute("aria-expanded", "true");

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
    await shoot(app, window, "after-empty.png");

    await panel.getByRole("button", { name: "Check old-server" }).click();
    await expect(rows.nth(2)).toContainText("Not reachable: ssh: old-server: Permission denied (publickey).");
    const calls = sshCalls(seeded.root);
    expect(calls.map((c) => c.split(" -- ")[1])).toEqual(["gpu-box sh -s", "old-server sh -s"]);
    expect(calls[0]).toContain("-o BatchMode=yes");
    expect(calls[0]).toContain("-o ClearAllForwardings=yes");
  });

  test("Add opens Aya's own dialog: Cancel saves nothing, Add saves and shows the row", async ({ app, window, seeded }) => {
    const panel = await openMachines(window, app);
    const registry = join(seeded.ayaHome, "machines.json");

    await answerAddDialog(app, "Cancel");
    await panel.getByRole("button", { name: "Add gpu-box" }).click();
    await expect(panel.getByTestId("machines-answer")).toHaveText("Not added: cancelled in Aya.");
    expect(await asks(app)).toHaveLength(1);
    expect(existsSync(registry)).toBe(false);
    await expect(panel.getByTestId("machine-row")).toHaveCount(0);

    await answerAddDialog(app, "Add");
    await panel.getByRole("button", { name: "Add gpu-box" }).click();
    await expect(panel.getByTestId("machines-answer")).toContainText("added gpu-box  ssh:gpu-box  ollama port 11434");
    const [ask] = await asks(app);
    expect(ask).toContain("Add gpu-box to Aya's machines?");
    expect(ask).toContain("NVIDIA GeForce RTX 4090");
    const row = panel.getByTestId("machine-row");
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("machine-state")).toHaveText("Ready");
    await expect(row.getByTestId("machine-reach")).toContainText("Connected · ssh gpu-box · checked");
    await expect(panel.getByRole("button", { name: "gpu-box details" })).toBeFocused();
    await expect(panel.getByTestId("machines-empty")).toHaveCount(0);
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
    await expect(panel.getByTestId("machine-state")).toHaveText("Ollama down");
    await expect(panel.getByTestId("machine-details")).toContainText("Ollama not answering on port 11434");
    expect(sshCalls(seeded.root).filter((c) => c.endsWith("mini-lab sh -s")).length).toBeGreaterThan(0);
  });
});

test.describe("added", () => {
  test.use({ seedOptions: { ...seedBase, ayaHomeFiles: { ...seedBase.ayaHomeFiles, "machines.json": TWO_MACHINES } } });

  test("added machines: a row each with state, GPU, model, occupancy; Mark free and Mark in use through More; suggestions below", async ({ app, window, seeded }) => {
    const panel = await openMachines(window, app);
    const rows = panel.getByTestId("machine-row");
    await expect(rows).toHaveCount(2);
    const gpu = rows.nth(0);
    await expect(gpu.getByTestId("machine-state")).toHaveText("Ready");
    await expect(gpu.getByTestId("machine-gpu")).toHaveText("97%");
    await expect(gpu.getByTestId("machine-vram")).toHaveText("21.0/24.0");
    await expect(gpu.getByTestId("machine-load")).toHaveText("3.2/32");
    await expect(gpu.getByTestId("machine-model")).toHaveText(/^qwen3:32bhot 1[34]m$/);
    // The pill ellipsizes in its column; its text (the accessible name) and its tooltip are the whole line.
    const pill = gpu.getByTestId("machine-occupancy");
    await expect(pill).toHaveText(/^run5 timed collection · justi · since \d\d:\d\d$/);
    await expect(pill).toHaveAccessibleName(/^run5 timed collection · justi · since \d\d:\d\d$/);
    expect(await pill.getAttribute("title")).toBe(await pill.textContent());
    await expect(gpu.getByTestId("machine-details")).toContainText(/run5 timed collection · justi · since \d\d:\d\d/);
    await expect(gpu.getByTestId("machine-details")).toContainText("NVIDIA GeForce RTX 4090 · 97% · 21.0/24.0 GB VRAM");
    const mini = rows.nth(1);
    await expect(mini.getByTestId("machine-state")).toHaveText("Ollama down");
    await expect(mini.getByTestId("machine-gpu")).toHaveText("none");
    await expect(mini.getByTestId("machine-model")).toHaveText("-");
    await expect(panel.getByTestId("machine-suggestion").locator(".aya-machine-target")).toHaveText(["old-server", "me@devbox", "This machine"]);
    await shoot(app, window, "2-machines-added.png");

    await rowAction(panel, "gpu-box", "Mark free, gpu-box");
    await expect(gpu.getByTestId("machine-occupancy")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "More, gpu-box" })).toBeFocused();
    await rowAction(panel, "gpu-box", "Mark in use, gpu-box");
    const purpose = gpu.getByLabel("What is gpu-box in use for?");
    await expect(purpose).toBeFocused();
    await purpose.fill("eval sweep");
    await gpu.getByRole("button", { name: "Save" }).click();
    await expect(gpu.getByTestId("machine-occupancy")).toContainText("eval sweep ·");
    const saved = JSON.parse(readFileSync(join(seeded.ayaHome, "machines.json"), "utf8"));
    expect(saved.machines[0].occupancy.purpose).toBe("eval sweep");

    await rowAction(panel, "gpu-box", "Check now, gpu-box");
    await expect(gpu.getByTestId("machine-state")).toHaveText("Ready");

    window.once("dialog", (d) => void d.accept());
    await rowAction(panel, "mini-lab", "Remove mini-lab");
    await expect(rows).toHaveCount(1);
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
    const gpu = panel.getByTestId("machine-row").nth(0);
    const toggle = gpu.getByRole("button", { name: "gpu-box details" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const details = panel.locator(`#${await toggle.getAttribute("aria-controls")}`);
    await expect(details).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(details).toBeVisible();
    await expect(details).toContainText("Used by: machine gpu-box (in use: run5 timed collection, by justi); project libeval; panes tester (tester in team qa), implementer");
    await expect(details).toContainText(/Added \d\d:\d\d from Open project; last used \d\d:\d\d \(remote project\)/);
    await expect(details.locator(".aya-host-history").getByRole("listitem")).toHaveText([/\d\d:\d\d added from Open project/, /\d\d:\d\d connected \(remote project libeval\)/]);

    // A Check updates the open row in place; a failed one says why in text.
    await panel.getByRole("button", { name: "Check old-server" }).click();
    await expect(panel.getByTestId("machine-suggestion").filter({ hasText: "old-server" })).toContainText("Not reachable");
    await rowAction(panel, "gpu-box", "Check now, gpu-box");
    await expect(details).toContainText(/Last Check \d\d:\d\d: reachable/);
    await expect(details.locator(".aya-host-history").getByRole("listitem").last()).toHaveText(/connected \(Check\)$/);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await shoot(app, window, "4-machines-host-expanded.png");
    if (SHOTS) await details.screenshot({ path: join(SHOTS, "4b-host-details.png") });

    // Removing mini-lab leaves it a suggestion that still carries its history.
    await rowAction(panel, "mini-lab", "Check now, mini-lab");
    window.once("dialog", (d) => void d.accept());
    await rowAction(panel, "mini-lab", "Remove mini-lab");
    await expect(panel.getByTestId("machine-row")).toHaveCount(1);
    const mini = panel.getByTestId("machine-suggestion").filter({ hasText: "mini-lab" });
    await mini.getByRole("button", { name: "mini-lab usage and history" }).click();
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

test.describe("four machines", () => {
  test.use({
    seedOptions: {
      ...seedBase,
      homeFiles: { ".ssh/config": SSH_CONFIG, ...NEUTRAL_PROMPT },
      launchEnv: { PS1: "$ " },
      ayaHomeFiles: { ...seedBase.ayaHomeFiles, ...LIBEVAL_FILES, "machines.json": FOUR_MACHINES },
    },
  });

  test("one compact row per state: busy and in use, Ollama down, idle, unreachable with its reason; suggestions stay on screen", async ({ app, window }) => {
    await window.evaluate((req) => window.aya.createRemoteProject(req), LIBEVAL_REMOTE);
    const panel = await openMachines(window, app);
    const rows = panel.getByTestId("machine-row");
    await expect(rows).toHaveCount(4);
    await expect(rows.getByTestId("machine-state")).toHaveText(["Ready", "Ollama down", "Ready", "Unreachable"]);
    const spare = rows.nth(2);
    await expect(spare.getByTestId("machine-gpu")).toHaveText("0%");
    await expect(spare.getByTestId("machine-model")).toHaveText("none loaded");
    await expect(spare.getByTestId("machine-occupancy")).toHaveCount(0);
    await expect(spare).toContainText("free");
    await expect(rows.nth(3)).toContainText("Why: ssh: old-server: Permission denied (publickey).");
    // The point of the layout: a machine is one line, not a card.
    for (const row of await rows.all()) {
      const box = await row.locator("tr.aya-machine-row").boundingBox();
      expect(box?.height, "a machine row is one line").toBeLessThanOrEqual(48);
    }
    await expect(panel.getByTestId("machine-suggestion")).toHaveCount(2);
    for (const s of await panel.getByTestId("machine-suggestion").all()) expect((await s.boundingBox())?.height).toBeLessThanOrEqual(36);
    await shoot(app, window, "after-added.png");

    await panel.getByRole("button", { name: "gpu-box details" }).click();
    await expect(rows.nth(0).getByTestId("machine-details")).toContainText("Used by: machine gpu-box");
    const details = rows.nth(0).getByTestId("machine-details");
    // Every details line wraps inside the row; nothing is cut off at the Settings width.
    const clipped = await details.locator("p, li, dd").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
    expect(clipped).toEqual([]);
    await panel.getByRole("button", { name: "More, gpu-box" }).click();
    const actions = panel.getByRole("group", { name: "Actions for gpu-box" });
    await expect(actions).toBeVisible();
    // The actions push the details down; they never cover them.
    const a = await actions.boundingBox();
    const d = await details.boundingBox();
    expect(a && d && a.y + a.height <= d.y, "the actions sit above the details, not over them").toBe(true);
    await shoot(app, window, "after-expanded.png");
  });
});
