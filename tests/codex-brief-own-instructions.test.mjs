// Codex gets Aya's brief only as `-c developer_instructions=...`, never over the user's own: the toggle's
// hint says when it is skipped, and the launch skips exactly then.

import { test } from "node:test";
import assert from "node:assert/strict";

const { withRoleNote } = await import("../dist-electron/agent-brief.js");
const { agentBriefHint } = await import("../dist-test/agentPreset.js");

const ctx = (codexConfig) => ({ noteFile: "/tmp/n.json", codexConfig });

// [label, preset command, config.toml, the brief is carried]
const ROWS = [
  ["no developer_instructions anywhere", "codex", 'model = "o3"\n', true],
  ["the user's config.toml sets developer_instructions", "codex", 'developer_instructions = "be terse"\n', false],
  ["the preset's command sets it", "codex -c developer_instructions=x", "", false],
];

for (const [label, command, config, carried] of ROWS) {
  test(`Codex brief toggle | ${label}`, () => {
    const plan = withRoleNote("codex", command, "brief", ctx(config));
    assert.equal("command" in plan, carried);
    if (!carried) assert.match(plan.problem, /developer_instructions/);
  });
}

test("Codex brief toggle | the hint next to the toggle says it is skipped when developer_instructions is already set", () => {
  assert.match(agentBriefHint("codex"), /developer_instructions/);
  assert.match(agentBriefHint("codex"), /not when .*already sets developer_instructions/i);
});
