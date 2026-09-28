import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import type { SeedOptions } from "./seed";
import { TEAM_REDELIVERY_MS } from "../timeouts";

export const NODE = process.execPath;
export const AGENT = join(__dirname, "team-agent.cjs");
/** The branch's own CLI: an older installed `aya` may come first on PATH. */
export const AYA = join(__dirname, "..", "..", "bin", "aya");

/** How long team-agent's "ask-briefly" mode keeps its approval prompt up. */
export const ASK_BRIEFLY_MS = 6_000;

/** A first attempt that is held gets one retry before this runs out. */
export const TEAM_DELIVERY_TIMEOUT_MS = TEAM_REDELIVERY_MS + 5_000;

type Preset = NonNullable<SeedOptions["presetList"]>[number];

/** A pane running team-agent.cjs; `args` picks its mode (see that file). */
export function agentPreset(args = "", agent?: string): Preset {
  const command = `'${NODE}' '${AGENT}' '${AYA}'${args ? ` ${args}` : ""}`;
  return { id: "shell", name: "Agent", icon: "a", color: "", ...(agent ? { agent } : {}), command };
}

/** Seeds `team` as ux-review with tester on tab-left and implementer on tab-right. */
export function teamSeed(team: string, presetList: Preset[], ayaHomeFiles: Record<string, string> = {}) {
  return {
    seedOptions: {
      presetList,
      projectFiles: { ".aya/teams/ux-review.md": team },
      ayaHomeFiles: {
        "teams/e2e-proj/ux-review/assignments.json": JSON.stringify({ tester: "tab-left", implementer: "tab-right" }),
        ...ayaHomeFiles,
      },
    },
  };
}

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
  await expect(window.getByTestId("xterm-host").first()).toBeVisible();
  await window.getByTestId("teams-toggle").click();
  return window.getByRole("dialog", { name: "Teams" });
}
