import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { SeededEnv, SeedOptions } from "./seed";
import { E2E_REDELIVERY_MS, TEAM_REDELIVERY_MS } from "../timeouts";
import { firstTerminalShown } from "./terminal";
import { agentBin } from "./agent-bin";

export const NODE = process.execPath;
export const AGENT = join(__dirname, "team-agent.cjs");
/** The branch's own CLI: an older installed `aya` may come first on PATH. */
export const AYA = join(__dirname, "..", "..", "bin", "aya");

/** How long team-agent's "ask-briefly" mode keeps its approval prompt up. */
export const ASK_BRIEFLY_MS = 6_000;

/** The team's panes are up and team-agent.cjs has made its first send. */
export const TEAM_AGENT_READY_TIMEOUT_MS = 30_000;

/** Past the last redelivery pass, for the typed message to reach the pane's log. */
export const DELIVERY_SLACK_MS = 5_000;

/** A first attempt that is held gets one retry before this runs out. */
export const TEAM_DELIVERY_TIMEOUT_MS = TEAM_REDELIVERY_MS + DELIVERY_SLACK_MS;

/** A round or a status line that a spec's shortened team clock brings. */
export const TEAM_CLOCK_TIMEOUT_MS = 15_000;

/** Keys typed in the window reaching a stand-in agent's log. */
export const TYPED_TIMEOUT_MS = 5_000;

/** The Started line, which Start shows once its delivery test has gone out. */
export const START_REPLY_TIMEOUT_MS = 8_000;

type Preset = NonNullable<SeedOptions["presetList"]>[number];

let claudeBin: string | undefined;

/** A pane running team-agent.cjs; `args` picks its mode (see that file). As "claude" its program is named claude,
 *  so Aya gives it Claude's own launch verdict (launch-mode.ts) and session id, as it does a real Claude pane. */
export function agentPreset(args = "", agent?: string): Preset {
  const program = agent === "claude" ? `'${(claudeBin ??= agentBin("claude", AGENT))}'` : `'${NODE}' '${AGENT}'`;
  const command = `${program} '${AYA}'${args ? ` ${args}` : ""}`;
  return { id: "shell", name: "Agent", icon: "a", color: "", ...(agent ? { agent } : {}), command };
}

/** A plain shell preset, and a quiet claude-named agent: the panes most team specs offer. */
export const SHELL_PRESET: Preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" };
export const CLAUDE_PRESET: Preset = { ...agentPreset("quiet", "claude"), id: "claude", name: "Claude Code" };

/** Stands in for Codex under its binary name, sandboxed as the real one is (fake-codex/codex). */
export const CODEX_PRESET: Preset = {
  id: "codex",
  name: "Codex",
  icon: "o",
  color: "",
  command: `AYA_E2E_NODE='${NODE}' AYA_E2E_AYA='${AYA}' ${join(__dirname, "fake-codex", "codex")}`,
};

/** The Codex preset behind `env` with the bypass flag: Aya cannot read it, but its aya calls arrive. */
export const WRAPPED_REACHING_CODEX: Preset = { ...CODEX_PRESET, id: "wrapped-yolo", name: "Wrapped Codex yolo", command: `env ${CODEX_PRESET.command} --dangerously-bypass-approvals-and-sandbox` };

/** The ux-review team of a tester and an implementer, with no cadence. */
export const TWO_ROLE_TEAM = `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code
Plays the build each round.

## Role: implementer
Sends to: tester
Must not: skip a report
Fixes findings.
`;

/** The ux-review team of a tester and an implementer with no notes beyond their limits, no cadence. */
export const BARE_TEAM = `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code

## Role: implementer
Sends to: tester
Must not: skip a report
`;

/** The ux-review team of a tester and an implementer that say what they send, no lead, no cadence. */
export const HANDOFF_TEAM = `# ux-review

## Role: tester
Sends to: implementer (failing tests)
Must not: edit code

## Role: implementer
Sends to: tester (the commit to check)
Must not: skip a report
`;

/** BARE_TEAM with the implementer's section first. */
export const IMPLEMENTER_FIRST_TEAM = `# ux-review

## Role: implementer
Sends to: tester
Must not: skip a report

## Role: tester
Sends to: implementer
Must not: edit code
`;

/** The ux-review team with tester as its lead, and no cadence. */
export const LEAD_TEAM = `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (the commit to check)
Must not: skip a report

## Lead
tester
`;

/** TWO_ROLE_TEAM with the tester's rhythm at one cadence minute. */
export const RELAUNCH_TEAM = `${TWO_ROLE_TEAM}\n## Cadence\ntester every 1 min\n`;

/** A team-log line for a message that was never typed, held as an approval prompt holds it. */
export const heldEntry = (id: number, from: string, to: string, text: string) =>
  `${JSON.stringify({ id, time: "2026-09-28T09:00:00Z", from, to, commit: null, text, delivered: false, held: "shows an approval prompt" })}\n`;

/** `seeded` for a relaunch test: a cadence "minute" lasts `minuteMs`, and the pty host goes down with the app
 *  (`shutdown` "1": the agents start over) or outlives it ("0", as in production). */
export const relaunchEnv = (seeded: SeededEnv, minuteMs: number, shutdown: "0" | "1" = "1", redeliveryMs = E2E_REDELIVERY_MS): SeededEnv => ({
  ...seeded,
  launchEnv: { ...seeded.launchEnv, AYA_E2E_PTY_SHUTDOWN: shutdown, AYA_E2E_TEAM_MINUTE_MS: String(minuteMs), AYA_E2E_TEAM_REDELIVERY_MS: String(redeliveryMs) },
});

/** Relaunch clocks use the existing app overrides. Keep the assertion deadline
 *  independent of those periods, so shortening the clocks does not retune a timeout. */
export const RELAUNCH_MINUTE_MS = 1_000;
export const RELAUNCH_REDELIVERY_MS = 1_000;
export const ROUND_WAIT_MS = 24_000;

/** A quiet-team spec's cadence "minute": the 30 / 10 / 60 min silence and stall limits take 6 / 2 / 12 s. */
export const QUIET_MINUTE_MS = 200;
/** A quiet-team spec waits this long to see that no round comes: past its repeat window (SILENCE_REPEAT_MIN minutes). */
export const QUIET_NO_ROUND_MS = 18 * QUIET_MINUTE_MS;

/** A rhythm spec's cadence "minute": an every-1-min rhythm beats each second, the 60 min stall comes after the test. */
export const RHYTHM_MINUTE_MS = 1_000;

/** The round numbers Aya typed, in the order the pane received them. */
export const roundsIn = (log: string) => [...log.matchAll(/Round (\d+): run your round/g)].map((m) => Number(m[1]));

/** Where the seeded ux-review team keeps its local state, relative to AYA_HOME. */
export const TEAM_STATE_DIR = "teams/e2e-proj/ux-review";

/** `seed` with one cadence "minute" lasting `minuteMs` (AYA_E2E_TEAM_MINUTE_MS), and any `extraEnv` besides. */
export const teamMinute = (seed: ReturnType<typeof teamSeed>, minuteMs: number, extraEnv: Record<string, string> = {}) => ({
  seedOptions: { ...seed.seedOptions, launchEnv: { ...seed.seedOptions.launchEnv, AYA_E2E_TEAM_MINUTE_MS: String(minuteMs), ...extraEnv } },
});

/** A login shell that reads no rc file of the developer's, so a slow one cannot delay a probe. */
export const HERMETIC_SHELL: Pick<SeedOptions, "launchEnv"> = { launchEnv: { SHELL: "/bin/sh" } };

/** Seeds `team` as ux-review; `assignments` null gives its roles no panes. */
export function teamSeed(
  team: string,
  {
    presetList,
    assignments = { tester: "tab-left", implementer: "tab-right" },
    ayaHomeFiles = {},
    seed = {},
  }: { presetList?: Preset[]; assignments?: Record<string, string> | null; ayaHomeFiles?: Record<string, string>; seed?: SeedOptions } = {},
) {
  return {
    seedOptions: {
      ...seed,
      launchEnv: { AYA_E2E_TEAM_REDELIVERY_MS: String(E2E_REDELIVERY_MS), ...seed.launchEnv },
      ...(presetList ? { presetList } : {}),
      projectFiles: { ".aya/teams/ux-review.md": team },
      ayaHomeFiles: {
        // Saved in Aya, as a team made in the Teams window is: a bare repo file does not run.
        [`${TEAM_STATE_DIR}/saved.md`]: team,
        ...(assignments ? { [`${TEAM_STATE_DIR}/assignments.json`]: JSON.stringify(assignments) } : {}),
        ...ayaHomeFiles,
      },
    },
  };
}

/** `team` with no panes, and the right tab running `preset`. */
export const rightTabSeed = (team: string, presetList: Preset[], preset: Preset) =>
  teamSeed(team, { presetList, assignments: null, seed: { rightTab: { presetId: preset.id, name: preset.name } } });

/** `team` already started, both panes running `agent`; `ayaHomeFiles` besides its state. */
export const runningTeam = (team: string, agent: Preset, ayaHomeFiles: Record<string, string> = {}) =>
  teamSeed(team, { presetList: [agent], ayaHomeFiles: { [`${TEAM_STATE_DIR}/state.json`]: JSON.stringify({ paused: false, started: true }), ...ayaHomeFiles } });

/** The lead asked the user five minutes before this run, as agent-waiting.json keeps it. */
export const LEAD_ASKED_FILE = {
  "agent-waiting.json": JSON.stringify({ "tab-left": { text: "need the staging password", since: Date.now() - 5 * 60_000, by: "agent" } }),
};

/** The seeded team's assignments as the app last wrote them. */
export const readAssignments = (ayaHome: string) =>
  JSON.parse(readFileSync(join(ayaHome, TEAM_STATE_DIR, "assignments.json"), "utf8"));

/** The file team-agent.cjs records a pane's input in. */
export const teamLogFile = (projectDir: string, pane: string) => join(projectDir, `team-${pane}.log`);

/** Reads a pane's team log, "" until the agent has created it. */
export function teamLog(projectDir: string) {
  return (pane: string) => {
    const file = teamLogFile(projectDir, pane);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
}

/** How many times `re` (global) matches in a pane's team log. */
export const countMatches = (text: string, re: RegExp) => (text.match(re) ?? []).length;

export async function openTeams(window: Page) {
  await firstTerminalShown(window);
  await window.getByTestId("teams-toggle").click();
  return window.getByRole("dialog", { name: "Teams" });
}

/** The Teams window with a new team's editor open on the template. */
export async function openNewTeam(window: Page) {
  const dialog = await openTeams(window);
  await dialog.getByRole("button", { name: "New team" }).click();
  return dialog;
}
