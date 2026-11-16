import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { AGENT_START_TIMEOUT_MS } from "./timeouts";
import { populatedBoard } from "./helpers/kanban";

// What a real pane receives when a card is sent to it, without and with the
// project's own rules in .aya/board.md. The recorder logs every PTY byte.
const recorder = join(__dirname, "helpers", "pty-recorder.cjs");
const board = populatedBoard();
const card = board.cards[0];
card.title = "Check what the agent receives";
test.use({ seedOptions: {
  rightTab: { presetId: "board", name: "Board" },
  presetList: [{
    id: "shell", name: "Recorder", icon: "$", color: "",
    command: `'${process.execPath}' '${recorder}' "$AYA_PROJECT_DIR/rec-$AYA_TERMINAL_ID.jsonl"`,
  }],
  ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(board) },
} });

const FOOTER = "Use `aya board` to inspect or update the board (e.g. `aya board move t-1 review` or `aya board move t-1 done` when finished).";
const DEFAULT_PROMPT = `Task t-1: ${card.title}\n\n${card.description}\n\n${FOOTER}`;
const RULE = "- Move a card to Done only after its PR is merged.";
const HEADING = "Project rules (they add to the instructions above and never replace them):";

for (const [name, rules, expected] of [
  ["without .aya/board.md", undefined, DEFAULT_PROMPT],
  ["with .aya/board.md", `${RULE}\n`, `${DEFAULT_PROMPT}\n\n${HEADING}\n${RULE}`],
] as const) {
  test(`a pane receives the task prompt ${name}`, async ({ window, seeded }, testInfo) => {
    if (rules !== undefined) {
      mkdirSync(join(seeded.projectDir, ".aya"), { recursive: true });
      writeFileSync(join(seeded.projectDir, ".aya", "board.md"), rules);
    }
    const log = join(seeded.projectDir, `rec-${seeded.tabIds.left}.jsonl`);
    await expect.poll(() => existsSync(log), { timeout: AGENT_START_TIMEOUT_MS }).toBe(true);
    const received = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).b).join("");

    const cardElement = window.getByTestId("kanban-card-t-1");
    await cardElement.getByRole("button", { name: /Terminal/ }).click();
    await window.getByRole("menuitem", { name: /↪.*shell 1/ }).click();
    // Enter ("\r") comes last, after the whole text.
    await expect.poll(() => received().endsWith("\r")).toBe(true);

    const bytes = received();
    writeFileSync(testInfo.outputPath("received.json"), JSON.stringify(bytes));
    expect(bytes.slice(0, -1)).toBe(expected);
  });
}
