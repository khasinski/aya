import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { SeedOptions } from "./seed";
import { TEAM_REDELIVERY_MS } from "../timeouts";
import { firstTerminalShown } from "./terminal";

export const NODE = process.execPath;
export const AGENT = join(__dirname, "team-agent.cjs");
/** The branch's own CLI: an older installed `aya` may come first on PATH. */
export const AYA = join(__dirname, "..", "..", "bin", "aya");

/** How long team-agent's "ask-briefly" mode keeps its approval prompt up. */
export const ASK_BRIEFLY_MS = 6_000;

/** The team's panes are up and team-agent.cjs has made its first send. */
export const TEAM_AGENT_READY_TIMEOUT_MS = 30_000;

/** A first attempt that is held gets one retry before this runs out. */
export const TEAM_DELIVERY_TIMEOUT_MS = TEAM_REDELIVERY_MS + 5_000;

type Preset = NonNullable<SeedOptions["presetList"]>[number];

/** A pane running team-agent.cjs; `args` picks its mode (see that file). */
export function agentPreset(args = "", agent?: string): Preset {
  const command = `'${NODE}' '${AGENT}' '${AYA}'${args ? ` ${args}` : ""}`;
  return { id: "shell", name: "Agent", icon: "a", color: "", ...(agent ? { agent } : {}), command };
}

/** Where the seeded ux-review team keeps its local state, relative to AYA_HOME. */
export const TEAM_STATE_DIR = "teams/e2e-proj/ux-review";

/** Seeds `team` as ux-review; `assignments` null gives its roles no panes. */
export function teamSeed(
  team: string,
  {
    presetList,
    assignments = { tester: "tab-left", implementer: "tab-right" },
    ayaHomeFiles = {},
  }: { presetList?: Preset[]; assignments?: Record<string, string> | null; ayaHomeFiles?: Record<string, string> } = {},
) {
  return {
    seedOptions: {
      ...(presetList ? { presetList } : {}),
      projectFiles: { ".aya/teams/ux-review.md": team },
      ayaHomeFiles: {
        ...(assignments ? { [`${TEAM_STATE_DIR}/assignments.json`]: JSON.stringify(assignments) } : {}),
        ...ayaHomeFiles,
      },
    },
  };
}

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
