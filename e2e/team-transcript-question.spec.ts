// A last answer ending in "Do you want me to ...?" above an empty composer is no prompt: the status bar
// must not say the pane "is waiting for your approval".

import { test, expect } from "./fixtures";
import { agentPreset, teamSeed } from "./helpers/team";
import { firstTerminalShown } from "./helpers/terminal";

const SEED = teamSeed(
  `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code

## Role: implementer
Sends to: tester
Must not: skip a report
`,
  { presetList: [agentPreset("transcript-question", "claude")] },
);

test.use(SEED);

test("a question in the transcript, at an empty composer, does not leave 'waiting for your approval'", async ({ window }) => {
  await firstTerminalShown(window);
  await window.waitForTimeout(5_000);
  await expect(window.locator("footer.aya-statusbar")).not.toContainText("is waiting for your approval");
  await window.waitForTimeout(2_000);
  await expect(window.locator("footer.aya-statusbar")).not.toContainText("is waiting for your approval");
});
