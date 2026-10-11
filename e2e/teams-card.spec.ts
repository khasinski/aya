// The team card as the user reads it: per-role status, Apply only for staged
// picks, the log as a chat with the delivery-test exchange collapsed, and a
// footer that stays on screen however long the card grows.

import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures";
import { openTeams, TEAM_STATE_DIR, teamSeed, SHELL_PRESET, CLAUDE_PRESET } from "./helpers/team";

const TEAM = `# ux-review

## Role: developer
Sends to: ux-reviewer (the commit to check), tester (what changed)
Must not: report a task done without answering every report

## Role: ux-reviewer
Sends to: developer (findings with a screenshot)
Must not: edit code

## Role: tester
Sends to: developer (failing tests with output)
Must not: change the timer code to make a test pass
`;

let id = 0;
const msg = (from: string, to: string, text: string, extra = {}) =>
  JSON.stringify({ id: ++id, time: new Date(Date.now() - (60 - id) * 60_000).toISOString(), from, to, commit: "d95af8a", text, delivered: true, ...extra });
const LOG = [
  msg("aya", "developer", "Delivery test: run aya team whoami, then send one word to ux-reviewer."),
  msg("aya", "ux-reviewer", "Delivery test: run aya team whoami, then send one word to developer."),
  msg("aya", "tester", "Delivery test: run aya team whoami, then send one word to developer."),
  msg("developer", "ux-reviewer", "ok"),
  msg("ux-reviewer", "developer", "ok"),
  msg("tester", "developer", "ok"),
  msg("user", "developer", "Make the timer pausable and keep the remaining time on reload."),
  ...Array.from({ length: 12 }, (_, i) => msg(i % 2 ? "ux-reviewer" : "developer", i % 2 ? "developer" : "ux-reviewer", `Round ${i + 1} notes: the pause button and the reload behaviour.`)),
  msg("tester", "developer", "2 failing: timer.test.ts resumes from 0 after reload.", { delivered: false, held: "shows an approval prompt" }),
].join("\n");

test.use(
  teamSeed(TEAM, {
    presetList: [SHELL_PRESET, CLAUDE_PRESET],
    assignments: { developer: "tab-left", "ux-reviewer": "tab-right" },
    ayaHomeFiles: { [`${TEAM_STATE_DIR}/state.json`]: JSON.stringify({ started: true, paused: false }), [`${TEAM_STATE_DIR}/log.jsonl`]: `${LOG}\n` },
  }),
);

test("each role shows its pane's status", async ({ window }) => {
  const card = (await openTeams(window)).getByTestId("team-ux-review");
  await expect(card.getByLabel("developer status")).toHaveText("runs a shell");
  await expect(card.getByLabel("tester status")).toHaveText("no pane");
});

test("Apply panes appears only while a pick differs from the role's pane", async ({ window }) => {
  const card = (await openTeams(window)).getByTestId("team-ux-review");
  const apply = card.getByRole("button", { name: "Apply panes" });
  await expect(apply).toHaveCount(0);
  await card.getByLabel("Pane for tester").selectOption({ label: "New: Claude Code" });
  await expect(apply).toBeVisible();
  await card.getByLabel("Pane for tester").selectOption({ label: "No pane" });
  await expect(apply).toHaveCount(0);
});

test("the log reads as a chat: oldest first, opened at the newest, the delivery tests on one line that expands, a held message stands out", async ({ window }) => {
  const card = (await openTeams(window)).getByTestId("team-ux-review");
  const chat = card.getByRole("log", { name: "ux-review messages" });
  const entries = chat.locator(".aya-chat-entry");
  await expect(entries.first()).toContainText("Delivery test: 3/3 answered");
  await expect(entries.nth(1)).toContainText("Make the timer pausable");
  await expect(entries.last()).toContainText("2 failing: timer.test.ts resumes from 0 after reload.");
  await expect(entries.last()).toContainText("waiting in inbox: shows an approval prompt");
  await expect(entries.last()).toContainText("tester");
  await expect(entries.last()).toContainText("to developer");
  await expect(entries.last()).toBeInViewport();
  await expect(chat.getByText("Delivery test: run aya team whoami, then send one word to ux-reviewer.")).toHaveCount(0);
  await chat.getByRole("button", { name: /Delivery test: 3\/3 answered/ }).click();
  await expect(chat.getByText("Delivery test: run aya team whoami, then send one word to ux-reviewer.")).toBeVisible();
});

// The panes' launch notes come in seconds after start and push the log down the card: what stays is the log's own scroll.
test("the log opens at its newest message again after the role notes came in and the page reloaded", async ({ window }) => {
  const atNewest = (chat: Locator) => chat.evaluate((el) => el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
  const card = (await openTeams(window)).getByTestId("team-ux-review");
  await expect(card.getByText(/may not reach Aya/)).toHaveCount(2);
  await window.reload();
  const chat = (await openTeams(window)).getByTestId("team-ux-review").getByRole("log", { name: "ux-review messages" });
  await expect(chat.locator(".aya-chat-entry").last()).toContainText("2 failing: timer.test.ts resumes from 0 after reload.");
  await expect.poll(() => atNewest(chat)).toBe(true);
});

test("the footer stays on screen however long the card is", async ({ window }) => {
  await window.setViewportSize({ width: 1100, height: 640 });
  const dialog = await openTeams(window);
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "New team" })).toBeInViewport();
});
