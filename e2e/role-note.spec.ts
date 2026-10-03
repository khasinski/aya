// A team pane's role note reaches its CLI through the CLI's own channel, or the Teams window says it
// cannot. The pane is a stand-in that records its argv/env (helpers/argv-dump.cjs) on the real launch path.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { ARGV_DUMP_COMMAND } from "./helpers/agent-bin";
import { AGENT_START_TIMEOUT_MS, AGENT_TEST_TIMEOUT_MS } from "./timeouts";
import { HERMETIC_SHELL, openTeams, teamSeed, IMPLEMENTER_FIRST_TEAM } from "./helpers/team";

test.describe.configure({ timeout: AGENT_TEST_TIMEOUT_MS });

const SHAPES = {
  simple: ARGV_DUMP_COMMAND,
  "env-prefixed": `FOO=1 ${ARGV_DUMP_COMMAND}`,
  compound: `cd "$AYA_PROJECT_DIR" && ${ARGV_DUMP_COMMAND}`,
} as const;
type Shape = keyof typeof SHAPES;

/** Whether the shape leaves the appended argument on the CLI (not on `cd`). */
const carriesAppended = (shape: Shape) => shape !== "compound";

// One cell per branch of withRoleNote/brief (agent-brief.ts, pane-brief.ts): each channel once with the brief on;
// the brief off, the assignment prefix and a compound command (refused before the channel) once each.
const CELLS: [agent: string, optedIn: boolean, shape: Shape][] = [
  ["claude", true, "simple"],
  ["grok", true, "simple"],
  ["opencode", true, "simple"],
  ["codex", true, "simple"],
  ["claude", false, "env-prefixed"],
  ["codex", true, "compound"],
];

const seed = (agent: string, optedIn: boolean, shape: Shape) =>
  teamSeed(IMPLEMENTER_FIRST_TEAM, {
    presetList: [
      { id: "shell", name: `Fake ${agent}`, icon: "$", color: "", agent, ...(optedIn ? { agentBrief: true } : {}), command: SHAPES[shape] },
    ],
    assignments: { tester: "tab-right" },
    seed: HERMETIC_SHELL,
  });

/** Where the role note of a launched pane is to be found, per channel. */
function roleNoteText(agent: string, dump: { args: string[]; opencodeConfig: string | null }): string {
  if (agent !== "opencode") return dump.args.join("\n");
  if (!dump.opencodeConfig) return "";
  return (JSON.parse(readFileSync(dump.opencodeConfig, "utf8")).instructions as string[])
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

for (const [agent, optedIn, shape] of CELLS) {
  test.describe(`${agent}, brief ${optedIn ? "on" : "off"}, ${shape} command`, () => {
    test.use(seed(agent, optedIn, shape));

    test("the tester pane carries its role note, or the Teams window says it cannot", async ({ window, seeded }) => {
      const dumpFile = join(seeded.projectDir, `argv-${seeded.tabIds.right}.json`);
      await expect
        .poll(() => existsSync(dumpFile), { message: "the pane never started", timeout: AGENT_START_TIMEOUT_MS })
        .toBe(true);
      const dump = JSON.parse(readFileSync(dumpFile, "utf8"));
      const carried = /tester in the Aya team ux-review/.test(roleNoteText(agent, dump));
      const card = (await openTeams(window)).getByTestId("team-ux-review");
      const status = card.getByLabel("tester role note");
      if (carriesAppended(shape)) {
        expect(carried, "the role note did not reach the CLI").toBe(true);
        if (optedIn) expect(roleNoteText(agent, dump), "the brief goes with the note, Codex included").toContain("aya capabilities");
        else expect(roleNoteText(agent, dump), "no brief without the opt-in").not.toContain("aya capabilities");
        // A tab with no saved session starts fresh, Codex too, so its note is carried and nothing is unknown.
        await expect(status).toHaveCount(0);
      } else {
        expect(carried).toBe(false);
        await expect(status).toContainText("cannot tell this CLI its role: its command is not a single simple command");
        await expect(status).toContainText("aya team whoami");
      }
    });
  });
}

test.describe("a CLI with no channel for a role note", () => {
  test.use(seed("cursor", true, "simple"));

  test("the Teams window says so", async ({ window }) => {
    const card = (await openTeams(window)).getByTestId("team-ux-review");
    await expect(card.getByLabel("tester role note")).toContainText("cannot tell this CLI its role: cursor takes no per-session instruction");
    await expect(card.getByLabel("implementer role note")).toHaveCount(0);
  });
});
