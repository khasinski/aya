// A saved team gets its panes: aya team open from a pane, and the Teams
// window's Apply panes, give each role a new session of a preset, the calling
// pane or an open pane, through the same main-process path. Start stays the user's.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { envWithoutAya } from "./helpers/env";
import {
  AYA,
  TEAM_AGENT_READY_TIMEOUT_MS,
  TEAM_DELIVERY_TIMEOUT_MS,
  TEAM_STATE_DIR,
  agentPreset,
  openTeams,
  readAssignments,
  teamLog,
  teamSeed,
} from "./helpers/team";
import { firstTerminalShown } from "./helpers/terminal";
import { TEAMS_REFRESH_MS } from "../src/hooks/useTeams";
import { AGENT_TEST_TIMEOUT_MS } from "./timeouts";

const TEAM = `# ux-review

## Role: tester
Sends to: implementer (failing tests)
Must not: edit code

## Role: implementer
Sends to: tester (the commit to check)
Must not: skip a report
`;

const SHELL = { id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" };
// Stands in for Claude Code: draws its composer, so Aya holds it only while it starts.
const CLAUDE = { ...agentPreset("quiet", "claude"), id: "claude", name: "Claude Code" };
const MISSING = { id: "missing", name: "Missing CLI", icon: "m", color: "", command: "aya-no-such-cli-e2e" };
const PRESETS = [SHELL, CLAUDE, MISSING];

function cli(ayaHome: string) {
  const env = { ...envWithoutAya(), AYA_SOCKET: join(ayaHome, "aya.sock"), AYA_TERMINAL_ID: "tab-left" };
  return (args: string[], input?: string) => spawnSync(AYA, args, { env, input, encoding: "utf8" });
}

/** role -> pane id, from aya team open's output. */
const paneIds = (stdout: string) => Object.fromEntries([...stdout.matchAll(/^ {2}(\S+) -> (?:new )?pane "[^"]+" \(id (\S+)\)/gm)].map((m) => [m[1], m[2]]));
const teamState = (ayaHome: string, dir = TEAM_STATE_DIR) => {
  const file = join(ayaHome, dir, "state.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
};
const started = (projectDir: string, pane: string) => existsSync(join(projectDir, `team-${pane}.log`));

test.describe("one Claude Code pane, where the user asks for a team", () => {
  test.use({ seedOptions: { presetList: PRESETS, singleTab: { presetId: "claude", name: "Claude Code" } } });

  test("aya team new, save, open three new Claude Code sessions for three roles; the asking pane keeps no role; Start reaches all three", async ({ window, seeded }) => {
    test.setTimeout(AGENT_TEST_TIMEOUT_MS);
    await firstTerminalShown(window);
    const aya = cli(seeded.ayaHome);

    const guide = aya(["team", "new", "three roles, all on Claude Code"]);
    expect(guide.stdout).toMatch(/aya team open <team> <role>=<target>/);
    const file = guide.stdout.split(/^----- .* -----$/m)[1];
    expect(aya(["team", "save", "-"], file).stdout).toMatch(/^saved team ux-fix: 3 roles \(reviewer, fixer, tester\)/);
    expect(aya(["presets"]).stdout).toMatch(/^claude +Claude Code +claude +yes$/m);
    // The agent proposes the panes now: the window's own assign prompt would compete with it.
    await window.waitForTimeout(TEAMS_REFRESH_MS + 1_000);
    await expect(window.getByRole("dialog", { name: "Assign team roles" })).toHaveCount(0);

    const opened = aya(["team", "open", "ux-fix", "reviewer=claude", "fixer=claude", "tester=claude"]);
    expect(opened.stderr).toBe("");
    expect(opened.stdout).toMatch(
      /^team ux-fix: gave 3 roles a pane, 3 new:\n  reviewer -> new pane "Claude Code - reviewer" \(id \S+\)\n  fixer -> new pane "Claude Code - fixer" \(id \S+\)\n  tester -> new pane "Claude Code - tester" \(id \S+\)\nStart it in the Teams window, or ask me to\.\n$/,
    );
    const ids = paneIds(opened.stdout);
    expect(Object.keys(ids)).toEqual(["reviewer", "fixer", "tester"]);
    expect(new Set(Object.values(ids)).size).toBe(3);
    expect(Object.values(ids)).not.toContain("tab-left");
    const assigned = JSON.parse(readFileSync(join(seeded.ayaHome, "teams/e2e-proj/ux-fix/assignments.json"), "utf8"));
    expect(assigned).toEqual(ids);

    const rows = window.locator(".aya-sidebar-row");
    await expect(rows).toHaveCount(4);
    await expect(rows.filter({ hasText: "Claude Code - fixer" })).toContainText("fixer · ux-fix");
    await expect(window.locator('.aya-sidebar-row[data-terminal-name="Claude Code"]')).not.toContainText("ux-fix");

    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-fix");
    for (const role of ["reviewer", "fixer", "tester"]) {
      await expect(card.getByLabel(`Pane for ${role}`).locator("option:checked")).toHaveText(`Claude Code - ${role}`);
    }
    // Marked the agent's by aya team save, cleared once a role got a pane.
    expect(teamState(seeded.ayaHome, "teams/e2e-proj/ux-fix")).toEqual({});
    await expect.poll(() => Object.values(ids).every((id) => started(seeded.projectDir, id)), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toBe(true);

    const start = aya(["team", "start", "ux-fix", "make the timer pausable"]);
    expect(start.stderr).toBe("");
    // The example team's cadence role leads the rounds, so it takes the task.
    expect(start.stdout).toBe("started team ux-fix; delivery test written to reviewer, fixer, tester; task sent to reviewer\n");
    await expect(card.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    const log = teamLog(seeded.projectDir);
    for (const id of Object.values(ids)) {
      await expect.poll(() => log(id), { timeout: TEAM_DELIVERY_TIMEOUT_MS }).toMatch(/Delivery test: run aya team whoami/);
    }
    await expect.poll(() => log(ids.reviewer)).toMatch(/Delivery test[\s\S]*\[team ux-fix \| from user \| \d\d:\d\d\] make the timer pausable/);
    expect(log(ids.fixer)).not.toMatch(/make the timer pausable/);
    expect(log("tab-left")).not.toMatch(/Delivery test/);
    await expect(rows).toHaveCount(4);
  });
});

test.describe("a team saved with no panes", () => {
  test.use(teamSeed(TEAM, { presetList: PRESETS, assignments: null }));

  test("aya team open refuses an uninstalled preset and opens nothing, then gives the calling pane one role and a new session the other", async ({ window, seeded }) => {
    test.setTimeout(AGENT_TEST_TIMEOUT_MS);
    await firstTerminalShown(window);
    const aya = cli(seeded.ayaHome);

    const presets = aya(["presets"]);
    expect(presets.stdout).toMatch(/^missing +Missing CLI +custom +no$/m);
    const refused = aya(["team", "open", "ux-review", "tester=missing", "implementer=this"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toBe('aya: preset "missing" (Missing CLI) is not installed; nothing was opened\n');
    await expect(window.locator(".aya-sidebar-row")).toHaveCount(2);
    expect(existsSync(join(seeded.ayaHome, TEAM_STATE_DIR, "assignments.json"))).toBe(false);

    const opened = aya(["team", "open", "ux-review", "tester=claude", "implementer=this"]);
    expect(opened.stderr).toBe("");
    expect(opened.stdout).toMatch(
      /^team ux-review: gave 2 roles a pane, 1 new:\n  tester -> new pane "Claude Code - tester" \(id \S+\)\n  implementer -> pane "shell 1" \(id tab-left\)\nStart it in the Teams window, or ask me to\.\n$/,
    );
    const ids = paneIds(opened.stdout);
    expect(readAssignments(seeded.ayaHome)).toEqual({ tester: ids.tester, implementer: "tab-left" });
    await expect.poll(() => started(seeded.projectDir, ids.tester), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toBe(true);
    const rows = window.locator(".aya-sidebar-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "Claude Code - tester" })).toContainText("tester · ux-review");
    await expect(rows.filter({ hasText: "shell 1" })).toContainText("implementer · ux-review");
    expect(teamState(seeded.ayaHome)).toBeNull();
    const start = aya(["team", "start", "ux-review"]);
    expect(start.status).toBe(1);
    expect(start.stderr).toBe("aya: team ux-review was not started, nothing was sent; implementer: runs a shell\n");
  });

  test("a window that cannot save the project keeps no phantom tab, and nothing is assigned", async ({ window, seeded }) => {
    test.setTimeout(AGENT_TEST_TIMEOUT_MS);
    await firstTerminalShown(window);
    const projects = join(seeded.ayaHome, "projects");
    chmodSync(projects, 0o555);
    try {
      const opened = cli(seeded.ayaHome)(["team", "open", "ux-review", "tester=claude"]);
      expect(opened.status).toBe(1);
      expect(opened.stderr).toMatch(/^aya: .*(EACCES|permission denied)/i);
      await expect(window.locator(".aya-sidebar-row")).toHaveCount(2);
      await window.waitForTimeout(1_000);
      await expect(window.locator(".aya-sidebar-row")).toHaveCount(2);
      expect(existsSync(join(seeded.ayaHome, TEAM_STATE_DIR, "assignments.json"))).toBe(false);
    } finally {
      chmodSync(projects, 0o755);
    }
  });

  test("Apply panes in the Teams window: a new session per role from installed presets only", async ({ window, seeded }) => {
    test.setTimeout(AGENT_TEST_TIMEOUT_MS);
    await firstTerminalShown(window);
    // A team with no panes brings its own prompt; it leads to the Teams window.
    await window.getByRole("dialog", { name: "Assign team roles" }).getByRole("button", { name: "Open teams" }).click();
    const dialog = window.getByRole("dialog", { name: "Teams" });
    const tester = dialog.getByLabel("Pane for tester");
    await expect(tester.locator("option")).toHaveText(["No pane", "shell 1", "shell 2", "New: Shell", "New: Claude Code"]);
    await tester.selectOption({ label: "New: Claude Code" });
    await dialog.getByLabel("Pane for implementer").selectOption({ label: "New: Claude Code" });
    expect(existsSync(join(seeded.ayaHome, TEAM_STATE_DIR, "assignments.json"))).toBe(false);
    await dialog.getByRole("button", { name: "Apply panes" }).click();

    await expect(dialog.getByText("tester: new Claude Code pane, implementer: new Claude Code pane. Start the team when you are ready.")).toBeVisible();
    await expect.poll(() => Object.keys(readAssignments(seeded.ayaHome)).sort()).toEqual(["implementer", "tester"]);
    const assigned = readAssignments(seeded.ayaHome);
    expect(assigned.tester).not.toBe(assigned.implementer);
    await expect(tester.locator("option:checked")).toHaveText("Claude Code - tester");
    await expect(dialog.getByRole("button", { name: "Apply panes" })).toHaveCount(0);
    await expect.poll(() => started(seeded.projectDir, assigned.implementer), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toBe(true);
    await expect.poll(() => started(seeded.projectDir, assigned.tester), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toBe(true);
    await expect(window.locator(".aya-sidebar-row")).toHaveCount(4);
    expect(teamState(seeded.ayaHome)).toBeNull();

    // Start with a task: the team has no cadence, so its first role takes it.
    await dialog.getByLabel("Task for ux-review").fill("retest the login");
    await dialog.getByRole("button", { name: "Start", exact: true }).click();
    await expect(dialog.getByText("Started; task sent to tester.")).toBeVisible();
    await expect.poll(() => teamLog(seeded.projectDir)(assigned.tester), { timeout: TEAM_DELIVERY_TIMEOUT_MS }).toMatch(/from user \| \d\d:\d\d\] retest the login/);
  });
});

test.describe("a running team whose tester has a live pane", () => {
  test.use(
    teamSeed(TEAM, {
      presetList: PRESETS,
      assignments: { tester: "tab-left" },
      ayaHomeFiles: { [`${TEAM_STATE_DIR}/state.json`]: JSON.stringify({ started: true, paused: false }) },
    }),
  );

  test("needs --replace; then the new session is told its role once it starts, and the old pane keeps running", async ({ window, seeded }) => {
    test.setTimeout(AGENT_TEST_TIMEOUT_MS);
    await firstTerminalShown(window);
    const aya = cli(seeded.ayaHome);

    const refused = aya(["team", "open", "ux-review", "tester=claude"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/role "tester" already has a live pane \(tab-left\); add --replace .*; nothing was opened\n$/);

    const opened = aya(["team", "open", "--replace", "ux-review", "tester=claude"]);
    expect(opened.stderr).toBe("");
    expect(opened.stdout).toMatch(/^team ux-review: gave 1 role a pane, 1 new:\n  tester -> new pane "Claude Code - tester" \(id \S+\); told its role\n$/);
    const { tester } = paneIds(opened.stdout);
    expect(readAssignments(seeded.ayaHome)).toEqual({ tester });
    await expect.poll(() => teamLog(seeded.projectDir)(tester)).toMatch(/\[team ux-review \| from aya \| \d\d:\d\d\] Delivery test: run aya team whoami/);

    const old = window.locator('.aya-sidebar-row[data-terminal-name="shell 1"]');
    await expect(old).toBeVisible();
    await expect(old).not.toContainText("ux-review");
  });
});

test.describe("one pane and two roles", () => {
  test.use(teamSeed(TEAM, { presetList: PRESETS, assignments: { tester: "tab-left" } }));

  test("a pane another role plays is labelled with it, Apply spells out the move, and the emptied role can take a new session", async ({ window, seeded }) => {
    test.setTimeout(AGENT_TEST_TIMEOUT_MS);
    const dialog = await openTeams(window);
    const implementer = dialog.getByLabel("Pane for implementer");
    await expect(implementer.locator("option")).toHaveText(["No pane", "shell 1 (plays tester)", "shell 2", "New: Shell", "New: Claude Code"]);
    await expect(dialog.getByLabel("Pane for tester").locator("option")).toHaveText(["No pane", "shell 1", "shell 2", "New: Shell", "New: Claude Code"]);

    await implementer.selectOption({ label: "shell 1 (plays tester)" });
    await expect(dialog.getByText("shell 1 moves from tester to implementer; tester is left without a pane.")).toBeVisible();
    expect(readAssignments(seeded.ayaHome)).toEqual({ tester: "tab-left" });
    await window.screenshot({ path: test.info().outputPath("pane-move-pending.png") });
    await dialog.getByRole("button", { name: "Apply panes" }).click();
    await expect(dialog.getByText("implementer: shell 1. Left without a pane: tester. Start the team when you are ready.")).toBeVisible();
    await expect.poll(() => readAssignments(seeded.ayaHome)).toEqual({ implementer: "tab-left" });
    await expect(dialog.getByLabel("Pane for tester")).toHaveValue("");

    await dialog.getByLabel("Pane for tester").selectOption({ label: "New: Claude Code" });
    await expect(dialog.getByText(/moves from/)).toHaveCount(0);
    await dialog.getByRole("button", { name: "Apply panes" }).click();
    await expect.poll(() => Object.keys(readAssignments(seeded.ayaHome)).sort()).toEqual(["implementer", "tester"]);
    await expect(dialog.getByLabel("Pane for tester").locator("option:checked")).toHaveText("Claude Code - tester");
    await window.screenshot({ path: test.info().outputPath("pane-move-applied.png") });
  });
});
