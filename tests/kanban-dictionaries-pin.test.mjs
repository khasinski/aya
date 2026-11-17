// Pins what the board's limits and priorities look like to users today: the
// numbers electron/board.ts enforces, the priority names the CLI accepts and
// prints, and the size limit of the board notices file. The values are written
// out here on purpose, so a change in the module that defines them shows up as
// a failure and not as a silent change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const board = await import("../dist-electron/board.js");
const { pendingBoardNotices } = await import("../dist-electron/board-notices.js");
const { AYA_CAPABILITIES } = await import("../dist-electron/capabilities.js");

const KIB = 1024;
const MIB = KIB * KIB;

test("the board limits main enforces", () => {
  assert.deepEqual(
    {
      MAX_BOARD_COLUMNS: board.MAX_BOARD_COLUMNS,
      MAX_BOARD_CARDS: board.MAX_BOARD_CARDS,
      MAX_CARD_TITLE_CHARS: board.MAX_CARD_TITLE_CHARS,
      MAX_COLUMN_TITLE_CHARS: board.MAX_COLUMN_TITLE_CHARS,
      MAX_CARD_DESCRIPTION_CHARS: board.MAX_CARD_DESCRIPTION_CHARS,
      MAX_CARD_LABELS: board.MAX_CARD_LABELS,
      MAX_CARD_LABEL_CHARS: board.MAX_CARD_LABEL_CHARS,
      MAX_ASSIGNEE_CHARS: board.MAX_ASSIGNEE_CHARS,
      MAX_BOARD_IMAGE_BYTES: board.MAX_BOARD_IMAGE_BYTES,
      MAX_BOARD_FILE_BYTES: board.MAX_BOARD_FILE_BYTES,
      MAX_PROJECT_RULES_BYTES: board.MAX_PROJECT_RULES_BYTES,
    },
    {
      MAX_BOARD_COLUMNS: 24,
      MAX_BOARD_CARDS: 500,
      MAX_CARD_TITLE_CHARS: 200,
      MAX_COLUMN_TITLE_CHARS: 80,
      MAX_CARD_DESCRIPTION_CHARS: 16_000,
      MAX_CARD_LABELS: 12,
      MAX_CARD_LABEL_CHARS: 32,
      MAX_ASSIGNEE_CHARS: 120,
      MAX_BOARD_IMAGE_BYTES: 8 * MIB,
      MAX_BOARD_FILE_BYTES: 2 * MIB,
      MAX_PROJECT_RULES_BYTES: 16 * KIB,
    },
  );
});

test("the priorities a card accepts, lowest first", () => {
  assert.deepEqual([...board.VALID_KANBAN_PRIORITIES], ["low", "medium", "high", "urgent"]);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "aya-kanban-pin-"));
  const project = { name: "Demo", slug: "demo", directory: join(dir, "repo"), tabs: [] };
  return { dir, home: join(dir, "home"), project, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("an unknown priority is refused with the list of priorities", async () => {
  const fx = fixture();
  try {
    await assert.rejects(board.addBoardCard(fx.home, fx.project, { title: "Task", priority: "p9" }),
      { message: 'Invalid priority "p9"; choose one of: low, medium, high, urgent.' });
  } finally { fx.cleanup(); }
});

test("aya board prints its usage with the priorities, byte for byte", async () => {
  const fx = fixture();
  try {
    const deps = { ayaHome: fx.home, listProjects: async () => [fx.project] };
    await assert.rejects(board.handleBoardRequest({ argv: ["columns", "extra"], projectSlug: "demo" }, undefined, deps), {
      message:
        "usage: aya board [--json] [--project slug] | search <query> [--archive|--active] [--json] [--project slug] | columns [--json] [--project slug] | add <title> [--column <col>] [--description <text>] [--assignee <name>] [--priority <low|medium|high|urgent>] [--labels <a,b>] [--project slug] | move <id> <column> [--project slug] | edit <id> [--title <title>] [--description <text>] [--assignee <name|none>] [--priority <low|medium|high|urgent|none>] [--labels <a,b|none>] [--project slug] | remove <id> [--project slug] | clear <column> [--project slug] | archive [list|<id>|restore <id> [column]|clear|search <query>] [--project slug] | claim <id> [--replace] [--project slug] | release <id> [--force] [--project slug] | column add|rename|remove ... [--project slug] | column move <column> --before|--after <other-column> [--project slug] | export-repo [--project slug]",
    });
  } finally { fx.cleanup(); }
});

test("aya capabilities lists the priorities for board add and board edit", () => {
  const usage = (command) => AYA_CAPABILITIES.find((c) => c.command === command)?.usage;
  assert.equal(usage("board add"),
    "aya board add title [--column col] [--description text] [--assignee name] [--priority low|medium|high|urgent] [--labels a,b] [--project slug]");
  assert.equal(usage("board edit"),
    "aya board edit id [--title title] [--description text] [--assignee name] [--priority low|medium|high|urgent|none] [--labels a,b|none] [--project slug]");
});

test("the board notices file is read up to 2 MiB and refused above", async () => {
  const fx = fixture();
  try {
    const file = join(fx.dir, "board-notices.json");
    const emptyList = (bytes) => `[${" ".repeat(bytes - 2)}]`;
    writeFileSync(file, emptyList(2 * MIB));
    assert.deepEqual(await pendingBoardNotices(fx.dir, "demo"), []);
    writeFileSync(file, emptyList(2 * MIB + 1));
    await assert.rejects(pendingBoardNotices(fx.dir, "demo"), { message: "Invalid board notification file." });
  } finally { fx.cleanup(); }
});
