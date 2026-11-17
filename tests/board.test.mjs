import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";
import { FIXED_RULES } from "../shared/board-columns.cjs";

const { startControlServerOn } = await import("../dist-electron/control.js");
const { registerBoardIpc } = await import("../dist-electron/ipc/board-ipc.js");
const { TextPastedError } = await import("../dist-electron/team-control.js");
const { HOLD_NOT_RUNNING } = await import("../dist-electron/pane-holds.js");
const {
  getBoard,
  addBoardCard,
  updateBoardCard,
  moveBoardCard,
  deleteBoardCard,
  archiveBoardCard,
  unarchiveBoardCard,
  clearBoardColumn,
  restoreBoardCards,
  claimBoardCard,
  releaseBoardCard,
  addBoardColumn,
  moveBoardColumn,
  renameBoardColumn,
  deleteBoardColumn,
  exportBoardToRepo,
  formatBoardPrompt,
  releaseBoardClaimsForPane,
  syncBoardPaneName,
  saveBoardImage,
  readBoardImageDataUrl,
  matchesBoardQuery,
  searchBoard,
  handleBoardRequest,
  MAX_BOARD_IMAGE_BYTES,
  MAX_PROJECT_RULES_BYTES,
  PROJECT_RULES_FILE_NAME,
} = await import("../dist-electron/board.js");

const cli = resolve("bin/aya");

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "aya-board-test-"));
  const home = join(dir, "aya-home");
  const repoDir = join(dir, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  const project = {
    name: "Demo",
    slug: "demo",
    directory: repoDir,
    tabs: [
      { id: "pane-1", presetId: "claude", name: "Claude 1" },
      { id: "pane-2", presetId: "codex", name: "Codex 2" },
    ],
  };
  return {
    dir,
    home,
    repoDir,
    project,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeDispatchFixture() {
  const fx = makeFixture();
  const handlers = new Map();
  const sent = [];
  let deliveryError;
  let hold = null;
  let attempts = 0;
  const start = () => registerBoardIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    ayaHome: fx.home,
    listProjects: async () => [fx.project],
    paneHold: async () => hold,
    sendToPane: async (projectSlug, paneId, text) => {
      attempts++;
      if (deliveryError) throw deliveryError;
      sent.push({ projectSlug, paneId, text });
    },
  });
  let notices = start();
  return {
    ...fx, sent,
    failDelivery(error) { deliveryError = error; },
    setHold(value) { hold = value; },
    attempts() { return attempts; },
    flush() { return notices.flush(); },
    restart() { notices.stop(); notices = start(); },
    async call(channel, request) {
      const result = await handlers.get(channel)({}, { projectSlug: fx.project.slug, ...request });
      await notices.flush();
      return result;
    },
    cleanup() { notices.stop(); fx.cleanup(); },
  };
}

test("board defaults to user config and prioritizes .aya/board.json when present in repo", async () => {
  const fx = makeFixture();
  try {
    const initial = await getBoard(fx.home, fx.project);
    assert.equal(initial.source, "user");
    assert.equal(initial.filePath, join(fx.home, "boards", "demo.json"));
    assert.deepEqual(
      initial.columns.map((c) => c.id),
      ["todo", "in-progress", "review", "done"],
    );
    assert.equal(initial.cards.length, 0);

    // Adding a card writes to user config when .aya/board.json does not exist
    const { board: afterAdd } = await addBoardCard(fx.home, fx.project, { title: "User card" });
    assert.equal(afterAdd.source, "user");
    assert.equal(afterAdd.cards.length, 1);
    assert.equal(existsSync(join(fx.home, "boards", "demo.json")), true);
    assert.equal(existsSync(join(fx.repoDir, ".aya", "board.json")), false);

    // If .aya/board.json is created in the repo, it takes priority over user config
    mkdirSync(join(fx.repoDir, ".aya"), { recursive: true });
    writeFileSync(
      join(fx.repoDir, ".aya", "board.json"),
      JSON.stringify({
        version: 1,
        columns: [
          { id: "todo", title: "Todo" },
          { id: "done", title: "Done" },
        ],
        cards: [
          {
            id: "t-99",
            title: "Repo task",
            description: "From repo",
            columnId: "todo",
            createdAt: "2026-11-11T10:00:00.000Z",
            updatedAt: "2026-11-11T10:00:00.000Z",
          },
        ],
      }),
    );

    const fromRepo = await getBoard(fx.home, fx.project);
    assert.equal(fromRepo.source, "repo");
    assert.equal(fromRepo.filePath, join(fx.repoDir, ".aya", "board.json"));
    assert.equal(fromRepo.cards.length, 1);
    assert.equal(fromRepo.cards[0].title, "Repo task");
  } finally {
    fx.cleanup();
  }
});

test("exportBoardToRepo promotes user board into .aya/board.json", async () => {
  const fx = makeFixture();
  try {
    await addBoardCard(fx.home, fx.project, { title: "Promote me" });
    const exported = await exportBoardToRepo(fx.home, fx.project);
    assert.equal(exported.source, "repo");
    assert.equal(exported.filePath, join(fx.repoDir, ".aya", "board.json"));
    assert.equal(exported.cards.length, 1);
    assert.equal(exported.cards[0].title, "Promote me");
    const disk = JSON.parse(readFileSync(join(fx.repoDir, ".aya", "board.json"), "utf8"));
    assert.equal(disk.cards[0].title, "Promote me");
  } finally {
    fx.cleanup();
  }
});

test("card and column CRUD plus terminal claim and release rules", async () => {
  const fx = makeFixture();
  try {
    await addBoardCard(fx.home, fx.project, {
      title: "First task",
      description: "Write tests",
      assignee: "worker-1",
    });
    let snap = await getBoard(fx.home, fx.project);
    assert.equal(snap.cards.length, 1);
    assert.equal(snap.cards[0].id, "t-1");
    assert.equal(snap.cards[0].columnId, "todo");

    // Claiming from todo auto-advances to in-progress (supports numeric shorthand "1" or "t-1")
    ({ board: snap } = await claimBoardCard(fx.home, fx.project, "1", {
      paneId: "pane-1",
      paneName: "Claude 1",
    }));
    assert.equal(snap.cards[0].columnId, "in-progress");
    assert.equal(snap.cards[0].claim?.paneId, "pane-1");
    assert.equal(snap.cards[0].assignee, "Claude 1");

    // Another terminal cannot claim without replace
    await assert.rejects(
      () =>
        claimBoardCard(fx.home, fx.project, "t-1", {
          paneId: "pane-2",
          paneName: "Codex 2",
        }),
      /already claimed by Claude 1/,
    );

    // With replace: true, pane-2 takes over
    ({ board: snap } = await claimBoardCard(fx.home, fx.project, "t-1", {
      paneId: "pane-2",
      paneName: "Codex 2",
      replace: true,
    }));
    assert.equal(snap.cards[0].claim?.paneId, "pane-2");

    // pane-1 cannot release without force
    await assert.rejects(
      () => releaseBoardCard(fx.home, fx.project, "t-1", { paneId: "pane-1" }),
      /claimed by Codex 2/,
    );

    // pane-2 can release its own claim
    ({ board: snap } = await releaseBoardCard(fx.home, fx.project, "t-1", {
      paneId: "pane-2",
    }));
    assert.equal(snap.cards[0].claim, undefined);

    // Update, move, and delete card
    ({ board: snap } = await updateBoardCard(fx.home, fx.project, "t-1", {
      title: "Updated task",
      description: "New desc",
      assignee: null,
    }));
    assert.equal(snap.cards[0].title, "Updated task");
    assert.equal(snap.cards[0].assignee, undefined);

    ({ board: snap } = await moveBoardCard(fx.home, fx.project, "t-1", "Review"));
    assert.equal(snap.cards[0].columnId, "review");

    // Column CRUD
    ({ board: snap } = await addBoardColumn(fx.home, fx.project, "Blocked"));
    assert.ok(snap.columns.some((c) => c.id === "blocked" && c.title === "Blocked"));

    ({ board: snap } = await renameBoardColumn(fx.home, fx.project, "blocked", "QA"));
    assert.ok(snap.columns.some((c) => c.id === "blocked" && c.title === "QA"));

    // Cannot delete column with cards
    await assert.rejects(
      () => deleteBoardColumn(fx.home, fx.project, "review"),
      /still has 1 card/,
    );

    snap = await deleteBoardColumn(fx.home, fx.project, "blocked");
    assert.ok(!snap.columns.some((c) => c.id === "blocked"));

    ({ board: snap } = await deleteBoardCard(fx.home, fx.project, "t-1"));
    assert.equal(snap.cards.length, 0);
  } finally {
    fx.cleanup();
  }
});

test("returning a dispatched card to Todo tells its agent to stop that task", async () => {
  const fx = makeDispatchFixture();
  const { call, sent } = fx;
  try {
    await addBoardCard(fx.home, fx.project, { title: "Existing task" });
    const dispatched = await call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" });
    assert.equal(dispatched.cards[0].columnId, "in-progress");
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Task t-1: Existing task/);
    const returned = await call("board:move-card", { cardId: "t-1", columnId: "todo" });
    assert.equal(returned.cards[0].claim, undefined);
    assert.equal(sent.length, 2, "returning a dispatched task must notify its agent");
    assert.equal(sent[1].paneId, "pane-1");
    assert.match(sent[1].text, /t-1/);
    assert.match(sent[1].text, /stop|withdraw|cancel|wstrzym/i);
  } finally { fx.cleanup(); }
});

// The exact words an agent receives. A change here changes what every agent is told,
// so it has to be deliberate: update these strings in the same commit.
const PINNED_TASK_PROMPT =
  "Task t-1: Existing task\n\n" +
  "Use `aya board` to inspect or update the board (e.g. `aya board move t-1 review` or `aya board move t-1 done` when finished).";
const PINNED_WITHDRAWAL_REASONS = {
  backlog: "returned to Backlog",
  "edit-column": "returned to Todo",
  release: "released from your pane",
  delete: "removed from the board",
  reassign: "reassigned to Codex 2",
};
const pinnedWithdrawal = reason =>
  `Aya Board: task t-1: Existing task was ${reason}. Stop work on this task; do not continue it unless it is assigned to you again. ` +
  "Check aya board --json for the current board before choosing another task.";

for (const action of ["backlog", "edit-column", "release", "delete", "reassign"]) {
  test(`withdrawing a dispatched card through ${action} notifies the original pane`, async () => {
    const fx = makeDispatchFixture();
    try {
      await addBoardCard(fx.home, fx.project, { title: "Existing task" });
      await addBoardColumn(fx.home, fx.project, "Backlog");
      await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" });
      if (action === "backlog") {
        await moveBoardCard(fx.home, fx.project, "t-1", "backlog");
        const { card } = await claimBoardCard(fx.home, fx.project, "t-1", { paneId: "pane-2", paneName: "Codex 2" });
        assert.equal(card.columnId, "in-progress", "starting a Backlog task also advances it");
      } else if (action === "edit-column") {
        await fx.call("board:update-card", { cardId: "t-1", columnId: "todo" });
      } else if (action === "release") {
        await fx.call("board:release-card", { cardId: "t-1" });
        await fx.call("board:release-card", { cardId: "t-1" });
      } else if (action === "delete") {
        await fx.call("board:delete-card", { cardId: "t-1" });
      } else {
        await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-2" });
      }
      await fx.flush();
      assert.equal(fx.sent.length, action === "reassign" ? 3 : 2);
      const withdrawal = fx.sent.find(message => message.text.includes("Stop work on this task"));
      assert.equal(withdrawal.paneId, "pane-1");
      assert.equal(fx.sent[0].text, PINNED_TASK_PROMPT, "the task prompt an agent receives");
      assert.equal(withdrawal.text, pinnedWithdrawal(PINNED_WITHDRAWAL_REASONS[action]), "the withdrawal notice an agent receives");
      if (action === "reassign") assert.ok(fx.sent.some(message => message.paneId === "pane-2" && message.text.startsWith("Task t-1")));
    } finally { fx.cleanup(); }
  });
}

const PROJECT_RULES_HEADING = "Project rules (they add to the instructions above and never replace them):";
const writeProjectRules = (fx, text) => {
  mkdirSync(join(fx.repoDir, ".aya"), { recursive: true });
  writeFileSync(join(fx.repoDir, ".aya", PROJECT_RULES_FILE_NAME), text);
};

test("a project's .aya/board.md is added under the task prompt sent to a pane", async () => {
  const fx = makeDispatchFixture();
  try {
    writeProjectRules(fx, "\n- Move a card to Done only after its PR is merged.\n\n");
    await addBoardCard(fx.home, fx.project, { title: "Existing task" });
    await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" });
    assert.equal(fx.sent[0].text,
      `${PINNED_TASK_PROMPT}\n\n${PROJECT_RULES_HEADING}\n- Move a card to Done only after its PR is merged.`);
  } finally { fx.cleanup(); }
});

test("a task started in a new pane gets the project's rules too", async () => {
  const fx = makeDispatchFixture();
  try {
    writeProjectRules(fx, "- Name the branch after the card.");
    await addBoardCard(fx.home, fx.project, { title: "Existing task" });
    const { board } = await fx.call("board:reserve-start", { cardId: "t-1", paneId: "pane-1", paneName: "Claude 1" });
    await fx.call("board:dispatch-card", { cardId: "t-1", paneId: "pane-1", claimSince: board.cards[0].claim.since });
    assert.equal(fx.sent.length, 1);
    assert.equal(fx.sent[0].text, `${PINNED_TASK_PROMPT}\n\n${PROJECT_RULES_HEADING}\n- Name the branch after the card.`);
  } finally { fx.cleanup(); }
});

test("a new-pane start whose .aya/board.md cannot be read stays reserved and sends nothing", async () => {
  const fx = makeDispatchFixture();
  try {
    writeProjectRules(fx, "x".repeat(MAX_PROJECT_RULES_BYTES + 1));
    await addBoardCard(fx.home, fx.project, { title: "Existing task" });
    const { board } = await fx.call("board:reserve-start", { cardId: "t-1", paneId: "pane-1", paneName: "Claude 1" });
    await assert.rejects(
      fx.call("board:dispatch-card", { cardId: "t-1", paneId: "pane-1", claimSince: board.cards[0].claim.since }),
      /size limit/,
    );
    assert.equal(fx.sent.length, 0);
    assert.equal((await getBoard(fx.home, fx.project)).cards[0].claim.startup, "reserved",
      "the start can be retried once the rules are fixed");
  } finally { fx.cleanup(); }
});

test("an empty .aya/board.md leaves the task prompt exactly as without one", async () => {
  const fx = makeDispatchFixture();
  try {
    writeProjectRules(fx, " \n\t\n");
    await addBoardCard(fx.home, fx.project, { title: "Existing task" });
    await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" });
    assert.equal(fx.sent[0].text, PINNED_TASK_PROMPT);
  } finally { fx.cleanup(); }
});

for (const [name, setup, refusal] of [
  ["a symlink", fx => {
    mkdirSync(join(fx.repoDir, ".aya"), { recursive: true });
    writeFileSync(join(fx.dir, "elsewhere.md"), "- read from outside the project");
    symlinkSync(join(fx.dir, "elsewhere.md"), join(fx.repoDir, ".aya", PROJECT_RULES_FILE_NAME));
  }, /could not open/],
  ["larger than the size limit", fx => writeProjectRules(fx, "x".repeat(MAX_PROJECT_RULES_BYTES + 1)), /size limit/],
]) {
  test(`.aya/board.md that is ${name} stops the send before the card is taken`, async () => {
    const fx = makeDispatchFixture();
    try {
      setup(fx);
      await addBoardCard(fx.home, fx.project, { title: "Existing task" });
      await assert.rejects(fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" }), refusal);
      assert.equal(fx.sent.length, 0, "nothing reaches the pane");
      const board = await getBoard(fx.home, fx.project);
      assert.equal(board.cards[0].claim, undefined, "the card is not left claimed without its prompt");
    } finally { fx.cleanup(); }
  });
}

test("a held recipient does not block withdrawal; its notice survives restart and is retried", async () => {
  const fx = makeDispatchFixture();
  try {
    await addBoardCard(fx.home, fx.project, { title: "Existing task" });
    await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" });
    fx.failDelivery(new Error("pane is waiting for user approval"));
    const after = await fx.call("board:move-card", { cardId: "t-1", columnId: "todo" });
    assert.equal(after.cards[0].columnId, "todo");
    assert.equal(after.cards[0].claim, undefined);
    assert.equal((await getBoard(fx.home, fx.project)).notices[0].state, "pending");
    fx.restart();
    fx.failDelivery(undefined);
    await fx.flush();
    assert.equal((await getBoard(fx.home, fx.project)).notices, undefined);
    assert.equal(fx.sent.length, 2);
  } finally { fx.cleanup(); }
});

test("a stopped pane can release a task while its notice waits for a future attachment", async () => {
  const fx = makeDispatchFixture();
  try {
    await addBoardCard(fx.home, fx.project, { title: "Stopped task" });
    await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" });
    fx.setHold(HOLD_NOT_RUNNING);
    await fx.call("board:release-card", { cardId: "t-1" });
    assert.equal((await getBoard(fx.home, fx.project)).cards[0].claim, undefined);
    assert.equal((await getBoard(fx.home, fx.project)).notices[0].state, "pending");
    assert.equal(fx.attempts(), 1);
  } finally { fx.cleanup(); }
});

test("a partially typed withdrawal is retained for the user and never pasted twice", async () => {
  const fx = makeDispatchFixture();
  try {
    await addBoardCard(fx.home, fx.project, { title: "Partial task" });
    await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" });
    fx.failDelivery(new TextPastedError("text is in the composer"));
    await fx.call("board:move-card", { cardId: "t-1", columnId: "todo" });
    assert.equal((await getBoard(fx.home, fx.project)).notices[0].state, "typed");
    await fx.flush();
    fx.restart();
    await fx.flush();
    assert.equal(fx.attempts(), 2, "only the task and one withdrawal attempt");
  } finally { fx.cleanup(); }
});

test("an agent moving or deleting its own card through CLI is not sent a stop message", async () => {
  const fx = makeDispatchFixture();
  try {
    await addBoardCard(fx.home, fx.project, { title: "Self-owned task" });
    await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" });
    const deps = { ayaHome: fx.home, listProjects: async () => [fx.project] };
    await handleBoardRequest({ argv: ["move", "t-1", "todo"] }, "pane-1", deps);
    await fx.flush();
    await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" });
    await handleBoardRequest({ argv: ["remove", "t-1"] }, "pane-1", deps);
    await fx.flush();
    assert.equal(fx.sent.length, 2);
    assert.ok(fx.sent.every(message => message.text.startsWith("Task")));
  } finally { fx.cleanup(); }
});

test("withdrawal before delayed startup prevents the initial prompt; rollback does not overwrite a newer claim", async () => {
  const fx = makeDispatchFixture();
  try {
    await addBoardCard(fx.home, fx.project, { title: "Delayed startup", assignee: "Planned owner" });
    const { board, previous } = await fx.call("board:reserve-start", { cardId: "t-1", paneId: "pane-1", paneName: "Claude 1" });
    assert.equal(previous.columnId, "todo");
    const since = board.cards[0].claim.since;
    await fx.call("board:cancel-start", { cardId: "t-1", paneId: "pane-1", claimSince: since,
      previousColumn: previous.columnId, previousAssignee: previous.assignee });
    const restored = (await getBoard(fx.home, fx.project)).cards[0];
    assert.equal(restored.columnId, "todo");
    assert.equal(restored.assignee, "Planned owner");
    assert.equal(restored.claim, undefined);
    await fx.call("board:dispatch-card", { cardId: "t-1", paneId: "pane-1", claimSince: since });
    assert.equal(fx.sent.length, 0);
    await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-2" });
    await fx.call("board:cancel-start", { cardId: "t-1", paneId: "pane-1", claimSince: since, previousColumn: "todo" });
    assert.equal((await getBoard(fx.home, fx.project)).cards[0].claim.paneId, "pane-2");
    await assert.rejects(fx.call("board:reserve-start", { cardId: "t-1", paneId: "pane-1", paneName: "Claude 1" }), /already claimed/);
  } finally { fx.cleanup(); }
});

test("remounting a newly started pane cannot submit its task prompt twice", async () => {
  const fx = makeDispatchFixture();
  try {
    await addBoardCard(fx.home, fx.project, { title: "Exactly one startup" });
    const { board } = await fx.call("board:reserve-start", { cardId: "t-1", paneId: "pane-1", paneName: "Claude 1" });
    const request = { cardId: "t-1", paneId: "pane-1", claimSince: board.cards[0].claim.since };
    await fx.call("board:dispatch-card", request);
    await fx.call("board:dispatch-card", request);
    assert.equal(fx.sent.length, 1);
  } finally { fx.cleanup(); }
});

test("withdrawing an unstarted reservation never sends an unrelated Stop prompt", async () => {
  const fx = makeDispatchFixture();
  try {
    await addBoardCard(fx.home, fx.project, { title: "Never started" });
    await fx.call("board:reserve-start", { cardId: "t-1", paneId: "pane-1", paneName: "Claude 1" });
    await fx.call("board:move-card", { cardId: "t-1", columnId: "todo" });
    assert.equal(fx.sent.length, 0);
  } finally { fx.cleanup(); }
});

test("an uncertain startup write is never changed back to a retryable reservation", async () => {
  const fx = makeDispatchFixture();
  try {
    await addBoardCard(fx.home, fx.project, { title: "Uncertain startup" });
    const { board } = await fx.call("board:reserve-start", { cardId: "t-1", paneId: "pane-1", paneName: "Claude 1" });
    const request = { cardId: "t-1", paneId: "pane-1", claimSince: board.cards[0].claim.since };
    fx.failDelivery(Object.assign(new Error("input acknowledgement was lost"), { code: "PTY_HOST_INPUT_UNCERTAIN" }));
    await assert.rejects(fx.call("board:dispatch-card", request), /acknowledgement/);
    assert.equal((await getBoard(fx.home, fx.project)).cards[0].claim.startup, "sending");
    await fx.call("board:dispatch-card", request);
    assert.equal(fx.attempts(), 1);
  } finally { fx.cleanup(); }
});

test("a damaged notification display file does not block reading or editing an unclaimed board", async t => {
  const fx = makeFixture();
  t.mock.method(console, "warn", () => {});
  try {
    writeFileSync(join(fx.home, "board-notices.json"), "broken JSON");
    assert.equal((await getBoard(fx.home, fx.project)).cards.length, 0);
    await addBoardCard(fx.home, fx.project, { title: "Board still works" });
    assert.equal((await getBoard(fx.home, fx.project)).cards[0].title, "Board still works");
  } finally { fx.cleanup(); }
});

test("normal workflow moves, column reordering and an agent releasing its own task do not withdraw it", async () => {
  const fx = makeDispatchFixture();
  try {
    await addBoardCard(fx.home, fx.project, { title: "Existing task" });
    await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" });
    await moveBoardCard(fx.home, fx.project, "t-1", "review");
    await moveBoardCard(fx.home, fx.project, "t-1", "done");
    await addBoardColumn(fx.home, fx.project, "Backlog");
    await moveBoardColumn(fx.home, fx.project, "backlog", { before: "todo" });
    assert.equal((await getBoard(fx.home, fx.project)).cards[0].claim.paneId, "pane-1");
    await releaseBoardCard(fx.home, fx.project, "t-1", { paneId: "pane-1" });
    assert.equal(fx.sent.length, 1);
  } finally { fx.cleanup(); }
});

test("reordering a claimed card within Todo on a board without In Progress does not cancel it", async () => {
  const fx = makeDispatchFixture();
  try {
    await deleteBoardColumn(fx.home, fx.project, "in-progress");
    await addBoardCard(fx.home, fx.project, { title: "Existing task" });
    await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" });
    const moved = await fx.call("board:move-card", { cardId: "t-1", columnId: "todo", index: 0 });
    assert.equal(fx.sent.length, 1);
    assert.equal(moved.cards[0].claim?.paneId, "pane-1");
  } finally { fx.cleanup(); }
});

// Column ids stay literal in these tests: they are the contract that board files
// store and that `aya board` users type.
for (const columnId of ["review", "done"]) {
  test(`moving a claimed card to ${columnId} keeps its claim and sends no stop message`, async () => {
    const fx = makeDispatchFixture();
    try {
      await addBoardCard(fx.home, fx.project, { title: "Existing task" });
      await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" });
      const moved = await fx.call("board:move-card", { cardId: "t-1", columnId });
      await fx.flush();
      assert.equal(moved.cards[0].columnId, columnId);
      assert.equal(moved.cards[0].claim?.paneId, "pane-1");
      assert.equal(fx.sent.length, 1, "only the task prompt reached the pane");
    } finally { fx.cleanup(); }
  });
}

test("starting a card on a board without In Progress leaves it in its column", async () => {
  const fx = makeDispatchFixture();
  try {
    await deleteBoardColumn(fx.home, fx.project, "in-progress");
    await addBoardCard(fx.home, fx.project, { title: "Existing task" });
    const board = await fx.call("board:send-to-pane", { cardId: "t-1", targetId: "pane-1" });
    assert.equal(board.cards[0].columnId, "todo");
    assert.equal(board.cards[0].claim?.paneId, "pane-1");
  } finally { fx.cleanup(); }
});

test("aya board columns gives each column's meaning and the fixed rules, for agents", async () => {
  const fx = makeFixture();
  try {
    await addBoardColumn(fx.home, fx.project, "Backlog");
    await addBoardColumn(fx.home, fx.project, "Blocked");
    await renameBoardColumn(fx.home, fx.project, "review", "Code review");
    const deps = { ayaHome: fx.home, listProjects: async () => [fx.project] };
    // The definitions stay literal here: they are the text agents read.
    assert.equal((await handleBoardRequest({ argv: ["columns"] }, "pane-1", deps)).output, [
      "Columns on demo:",
      "- todo (Todo): Waiting to be started.",
      "- in-progress (In Progress): Being worked on by the pane that claimed it.",
      "- review (Code review): Work is finished and waits for a check.",
      "- done (Done): Finished work; cards here can be archived.",
      "- backlog (Backlog): Waiting to be started, kept for later.",
      "- blocked (Blocked): custom column, no built-in meaning.",
      "",
      "Fixed rules (Aya enforces these; they cannot be changed):",
      ...FIXED_RULES.map((rule) => `- ${rule}`),
      "",
    ].join("\n"));
    const json = JSON.parse((await handleBoardRequest({ argv: ["columns", "--json"] }, "pane-1", deps)).output);
    assert.equal(json.projectSlug, "demo");
    assert.deepEqual(json.columns.find((c) => c.id === "blocked"), { id: "blocked", title: "Blocked", definition: null });
    assert.deepEqual(json.columns.find((c) => c.id === "review"), { id: "review", title: "Code review", definition: "Work is finished and waits for a check." });
    assert.deepEqual(json.fixedRules, [...FIXED_RULES]);
    await assert.rejects(handleBoardRequest({ argv: ["columns", "extra"] }, "pane-1", deps), /usage: aya board/);
  } finally { fx.cleanup(); }
});

test("aya board clear without a column archives the Done column", async () => {
  const fx = makeFixture();
  try {
    await addBoardCard(fx.home, fx.project, { title: "Finished", columnId: "done" });
    await addBoardCard(fx.home, fx.project, { title: "Still to do" });
    const deps = { ayaHome: fx.home, listProjects: async () => [fx.project] };
    await handleBoardRequest({ argv: ["clear"] }, "pane-1", deps);
    const board = await getBoard(fx.home, fx.project);
    assert.deepEqual(board.cards.map((c) => c.title), ["Still to do"]);
    assert.deepEqual(board.archivedCards.map((c) => c.title), ["Finished"]);
  } finally { fx.cleanup(); }
});

for (const repo of [false, true]) {
  test(`column order persists in ${repo ? "repo" : "user"} storage without changing cards or claims`, async () => {
    const fx = makeFixture();
    try {
      if (repo) await exportBoardToRepo(fx.home, fx.project);
      const { card } = await addBoardCard(fx.home, fx.project, { title: "Existing task" });
      await claimBoardCard(fx.home, fx.project, card.id, { paneId: "pane-1", paneName: "Claude 1" });
      await addBoardColumn(fx.home, fx.project, "Backlog");
      const before = await getBoard(fx.home, fx.project);
      const first = await moveBoardColumn(fx.home, fx.project, "Backlog", { before: "Todo" });
      assert.deepEqual(first.board.columns.map(c => c.id), ["backlog", "todo", "in-progress", "review", "done"]);
      assert.deepEqual(first.board.cards, before.cards);
      assert.equal(first.board.source, repo ? "repo" : "user");
      assert.deepEqual((await getBoard(fx.home, fx.project)).columns, first.board.columns);
      const last = await moveBoardColumn(fx.home, fx.project, "backlog", { after: "done" });
      assert.equal(last.board.columns.at(-1).id, "backlog");
      assert.deepEqual(last.board.cards, before.cards);
      const raw = readFileSync(last.board.filePath, "utf8");
      for (const placement of [{}, { before: "todo", after: "done" }, { before: "missing" }, { after: "backlog" }]) {
        await assert.rejects(moveBoardColumn(fx.home, fx.project, "backlog", placement));
        assert.equal(readFileSync(last.board.filePath, "utf8"), raw, "invalid moves cannot change the board");
      }
      await moveBoardColumn(fx.home, fx.project, "backlog", { after: "done" });
      assert.equal(readFileSync(last.board.filePath, "utf8"), raw, "an unchanged order is a no-op");
      await Promise.all([
        addBoardColumn(fx.home, fx.project, "Blocked"),
        moveBoardColumn(fx.home, fx.project, "backlog", { before: "todo" }),
        addBoardCard(fx.home, fx.project, { title: "New task" }),
      ]);
      const current = await getBoard(fx.home, fx.project);
      assert.equal(current.columns[0].id, "backlog");
      assert.ok(current.columns.some(c => c.id === "blocked"));
      assert.equal(current.cards.length, 2);
      assert.deepEqual(current.cards.find(c => c.id === card.id), before.cards.find(c => c.id === card.id));
      assert.equal(current.cards.find(c => c.title === "New task").columnId, "backlog", "new cards default to the reordered first column");
    } finally { fx.cleanup(); }
  });
}

test("aya board CLI end-to-end over control socket", async () => {
  const fx = makeFixture();
  const socket = join(fx.dir, "aya.sock");
  const stop = startControlServerOn(socket, {
    getWindow: () => null,
    openProject: () => {},
    listProjects: async () => [fx.project],
    boardHome: fx.home,
  });

  const runCli = (args, extraEnv = {}) =>
    new Promise((done, fail) => {
      const child = spawn(cli, args, {
        cwd: fx.repoDir,
        env: {
          ...envWithoutAya(),
          AYA_SOCKET: socket,
          AYA_TERMINAL_ID: "pane-1",
          ...extraEnv,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", fail);
      child.on("close", (status) => done({ status, stdout, stderr }));
    });

  try {
    const added = await runCli([
      "board",
      "add",
      "Ship Kanban CLI",
      "--description",
      "Support claim & release",
    ]);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /added t-1 \(todo\): Ship Kanban CLI/);

    const claimed = await runCli(["board", "claim", "t-1"]);
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.match(claimed.stdout, /claimed t-1 \(in-progress\) for Claude 1/);

    const listedJson = await runCli(["board", "list", "--json"]);
    assert.equal(listedJson.status, 0, listedJson.stderr);
    const board = JSON.parse(listedJson.stdout);
    assert.equal(board.source, "user");
    assert.equal(board.cards.length, 1);
    assert.equal(board.cards[0].columnId, "in-progress");
    assert.equal(board.cards[0].claim.paneId, "pane-1");

    const moved = await runCli(["board", "move", "t-1", "done"]);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, /moved t-1 to done/);

    const released = await runCli(["board", "release", "t-1"]);
    assert.equal(released.status, 0, released.stderr);
    assert.match(released.stdout, /released t-1/);

    const addedColumn = await runCli(["board", "column", "add", "Backlog"]);
    assert.equal(addedColumn.status, 0, addedColumn.stderr);
    const beforeColumnsMove = await getBoard(fx.home, fx.project);
    assert.equal(beforeColumnsMove.columns.at(-1).id, "backlog");
    const reordered = await runCli(["board", "column", "move", "Backlog", "--before", "Todo"]);
    assert.equal(reordered.status, 0, reordered.stderr);
    const afterColumnsMove = await getBoard(fx.home, fx.project);
    assert.deepEqual(afterColumnsMove.columns.map(c => c.id), ["backlog", "todo", "in-progress", "review", "done"]);
    assert.deepEqual(afterColumnsMove.cards, beforeColumnsMove.cards, "moving a column preserves cards, claims and timestamps");
    const rawBoard = readFileSync(afterColumnsMove.filePath, "utf8");
    for (const args of [
      ["backlog"],
      ["backlog", "--before", "todo", "--after", "done"],
      ["backlog", "--before", "missing"],
      ["backlog", "--after", "backlog"],
    ]) {
      const invalid = await runCli(["board", "column", "move", ...args]);
      assert.notEqual(invalid.status, 0);
      assert.equal(readFileSync(afterColumnsMove.filePath, "utf8"), rawBoard);
    }

    const exported = await runCli(["board", "export-repo"]);
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(existsSync(join(fx.repoDir, ".aya", "board.json")), true);
  } finally {
    stop();
    fx.cleanup();
  }
});

test("formatBoardPrompt formats multi-line task context and aya board hint", () => {
  const prompt = formatBoardPrompt({
    id: "t-7",
    title: "Fix login redirect",
    description: "Check callback URL\nand query params",
    columnId: "in-progress",
    assignee: "Claude 1",
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z",
  });
  assert.match(prompt, /^Task t-7: Fix login redirect/m);
  assert.match(prompt, /Check callback URL\nand query params/);
  assert.match(prompt, /aya board move t-7 done/);
});

test("card reordering within a column and pane rename/close claim sync", async () => {
  const fx = makeFixture();
  try {
    // Closing a pane when no board file exists should not create a board file
    const noBoard = await releaseBoardClaimsForPane(fx.home, fx.project, "pane-1");
    assert.equal(noBoard, null);
    assert.equal(existsSync(join(fx.home, "boards", "demo.json")), false);

    await addBoardCard(fx.home, fx.project, { title: "First" });
    await addBoardCard(fx.home, fx.project, { title: "Second" });
    await addBoardCard(fx.home, fx.project, { title: "Third" });

    // Move "Third" (t-3) to index 0 of todo
    let { board } = await moveBoardCard(fx.home, fx.project, "t-3", "todo", 0);
    assert.deepEqual(
      board.cards.filter((c) => c.columnId === "todo").map((c) => c.id),
      ["t-3", "t-1", "t-2"],
    );

    // Claim t-3 for pane-1, then rename pane-1 -> "Claude Lead"
    await claimBoardCard(fx.home, fx.project, "t-3", {
      paneId: "pane-1",
      paneName: "Claude 1",
    });
    board = await syncBoardPaneName(fx.home, fx.project, "pane-1", "Claude Lead");
    const claimed = board.cards.find((c) => c.id === "t-3");
    assert.equal(claimed.claim.paneName, "Claude Lead");
    assert.equal(claimed.assignee, "Claude Lead");

    // Closing pane-1 releases its claim automatically
    board = await releaseBoardClaimsForPane(fx.home, fx.project, "pane-1");
    assert.equal(board.cards.find((c) => c.id === "t-3").claim, undefined);
  } finally {
    fx.cleanup();
  }
});

test("saveBoardImage and readBoardImageDataUrl store and load PNG assets", async () => {
  const fx = makeFixture();
  // 1x1 transparent PNG base64
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  try {
    const savedUser = await saveBoardImage(fx.home, fx.project, {
      dataBase64: `data:image/png;base64,${pngBase64}`,
      name: "ui-bug.png",
    });
    assert.match(savedUser.markdown, /^!\[ui-bug\.png\]\(/);
    const dataUrl = await readBoardImageDataUrl(fx.home, fx.project, savedUser.path);
    assert.equal(dataUrl, `data:image/png;base64,${pngBase64}`);

    // Add a card referencing the user-level image, then promote board to repo:
    // exportBoardToRepo copies the image into .aya/board-assets/ and rewrites the markdown path!
    await addBoardCard(fx.home, fx.project, {
      title: "Card with screenshot",
      description: `See ${savedUser.markdown}`,
    });

    // When .aya/board.json exists in repo, images are stored under .aya/board-assets/ with relative path
    const exported = await exportBoardToRepo(fx.home, fx.project);
    assert.match(
      exported.cards[0].description,
      /!\[ui-bug\.png\]\(\.aya\/board-assets\/ui-bug-.*\.png\)/,
    );
    const savedRepo = await saveBoardImage(fx.home, fx.project, {
      dataBase64: pngBase64,
      name: "diagram",
    });
    assert.match(savedRepo.path, /^\.aya\/board-assets\/diagram-.*\.png$/);
    const repoDataUrl = await readBoardImageDataUrl(fx.home, fx.project, savedRepo.path);
    assert.equal(repoDataUrl, `data:image/png;base64,${pngBase64}`);
  } finally {
    fx.cleanup();
  }
});

// The four accepted formats, recognised by their first bytes; the MIME types and
// messages stay literal here as the contract users and agents see.
const MINIMAL_IMAGES = [
  ["image/jpeg", ".jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])],
  ["image/webp", ".webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])],
  ["image/gif", ".gif", Buffer.from("GIF87a\x01\x00\x01\x00", "latin1")],
  ["image/gif", ".gif", Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")],
];
const BMP = Buffer.concat([Buffer.from("BM"), Buffer.alloc(30)]);

test("JPEG, WebP and GIF board images are saved with their own extension and read back", async () => {
  const fx = makeFixture();
  try {
    for (const [mime, ext, bytes] of MINIMAL_IMAGES) {
      const saved = await saveBoardImage(fx.home, fx.project, { dataBase64: bytes.toString("base64"), name: "shot" });
      assert.ok(saved.path.endsWith(ext), `${mime} saved as ${saved.path}`);
      assert.equal(await readBoardImageDataUrl(fx.home, fx.project, saved.path), `data:${mime};base64,${bytes.toString("base64")}`);
    }
  } finally { fx.cleanup(); }
});

test("a board image in another format, empty or too large is refused with its reason", async () => {
  const fx = makeFixture();
  try {
    await assert.rejects(saveBoardImage(fx.home, fx.project, { dataBase64: BMP.toString("base64") }),
      { message: "Only PNG, JPEG, WebP, and GIF images are supported." });
    await assert.rejects(saveBoardImage(fx.home, fx.project, { dataBase64: "data:image/png;base64," }),
      { message: "Image data is empty." });
    await assert.rejects(saveBoardImage(fx.home, fx.project, { dataBase64: Buffer.alloc(MAX_BOARD_IMAGE_BYTES + 1, 1).toString("base64") }),
      { message: "Image must be between 1 byte and 8 MB." });
    writeFileSync(join(fx.repoDir, "picture.bmp"), BMP);
    await assert.rejects(readBoardImageDataUrl(fx.home, fx.project, "picture.bmp"),
      { message: "Unsupported image format (use PNG, JPEG, WebP, or GIF)." });
  } finally { fx.cleanup(); }
});

test("only data URLs of the four image formats are passed through as they are", async () => {
  const fx = makeFixture();
  try {
    for (const url of ["data:image/png;base64,AAAA", "data:image/jpeg;base64,AAAA", "data:image/webp;base64,AAAA",
      "data:image/gif;base64,AAAA", "DATA:IMAGE/PNG;BASE64,AAAA"]) {
      assert.equal(await readBoardImageDataUrl(fx.home, fx.project, url), url);
    }
    await assert.rejects(readBoardImageDataUrl(fx.home, fx.project, "data:image/bmp;base64,AAAA"));
  } finally { fx.cleanup(); }
});

test("the task prompt keeps its exact wording with a description, priority and labels", () => {
  const prompt = formatBoardPrompt({
    id: "t-9", title: "Fix crash", description: "Line one\nLine two", priority: "urgent", labels: ["bug", "ui"],
  });
  assert.equal(
    prompt,
    "Task t-9: Fix crash (priority: urgent · labels: bug, ui)\n\n" +
      "Line one\nLine two\n\n" +
      "Use `aya board` to inspect or update the board (e.g. `aya board move t-9 review` or `aya board move t-9 done` when finished).",
  );
});

test("card priority, labels, clearBoardColumn, and restoreBoardCards (Undo)", async () => {
  const fx = makeFixture();
  try {
    const { card: c1 } = await addBoardCard(fx.home, fx.project, {
      title: "Fix crash",
      priority: "urgent",
      labels: ["bug", "#ui", "BUG"],
      columnId: "done",
    });
    assert.equal(c1.priority, "urgent");
    assert.deepEqual(c1.labels, ["bug", "ui"]);

    const prompt = formatBoardPrompt(c1);
    assert.match(prompt, /priority: urgent/);
    assert.match(prompt, /labels: bug, ui/);

    const { card: updated } = await updateBoardCard(fx.home, fx.project, c1.id, {
      priority: "high",
      labels: ["release"],
    });
    assert.equal(updated.priority, "high");
    assert.deepEqual(updated.labels, ["release"]);

    const { card: c2 } = await addBoardCard(fx.home, fx.project, {
      title: "Second done task",
      columnId: "done",
    });
    await addBoardCard(fx.home, fx.project, {
      title: "Keep in todo",
      columnId: "todo",
    });

    // Clear "done" column archives the cards into archivedCards
    const cleared = await clearBoardColumn(fx.home, fx.project, "done");
    assert.equal(cleared.deleted.length, 2);
    assert.deepEqual(
      cleared.board.cards.map((c) => c.title),
      ["Keep in todo"],
    );
    assert.equal(cleared.board.archivedCards.length, 2);
    assert.deepEqual(
      cleared.board.archivedCards.map((c) => c.id),
      [c1.id, c2.id],
    );
    assert.ok(cleared.board.archivedCards[0].archivedAt);

    // Adding a new card never collides with archived card IDs
    const { card: c4 } = await addBoardCard(fx.home, fx.project, {
      title: "Fourth card after archive",
      columnId: "todo",
    });
    assert.equal(c4.id, "t-4");

    // Undo via restoreBoardCards restores original IDs, columns, and order, and removes them from archivedCards
    const restored = await restoreBoardCards(
      fx.home,
      fx.project,
      cleared.deleted.map((card, index) => ({ card, index })),
    );
    assert.equal(restored.archivedCards.length, 0);
    const doneCards = restored.cards.filter((c) => c.columnId === "done");
    assert.deepEqual(
      doneCards.map((c) => c.id),
      [c1.id, c2.id],
    );
    assert.equal(doneCards[0].priority, "high");
    assert.deepEqual(doneCards[0].labels, ["release"]);

    // Single card archive, unarchive, permanent delete from archive, and empty archive
    const { board: afterSingleArch } = await archiveBoardCard(fx.home, fx.project, c1.id);
    assert.equal(afterSingleArch.archivedCards.length, 1);
    assert.equal(afterSingleArch.archivedCards[0].id, c1.id);

    const { board: afterUnarch } = await unarchiveBoardCard(fx.home, fx.project, c1.id);
    assert.equal(afterUnarch.archivedCards.length, 0);
    assert.ok(afterUnarch.cards.some((c) => c.id === c1.id && c.columnId === "done"));

    await clearBoardColumn(fx.home, fx.project, "done");
    let snap = await getBoard(fx.home, fx.project);
    assert.equal(snap.archivedCards.length, 2);

    // Delete single card from archive
    ({ board: snap } = await deleteBoardCard(fx.home, fx.project, c1.id));
    assert.deepEqual(
      snap.archivedCards.map((c) => c.id),
      [c2.id],
    );

    // Empty entire archive
    ({ board: snap } = await clearBoardColumn(fx.home, fx.project, "__archive__"));
    assert.equal(snap.archivedCards.length, 0);
  } finally {
    fx.cleanup();
  }
});

test("searchBoard, matchesBoardQuery, and aya board search CLI across active and archived cards", async () => {
  const fx = makeFixture();
  try {
    await addBoardCard(fx.home, fx.project, {
      title: "Fix authentication race condition",
      description: "Token refresh collides under concurrent requests",
      priority: "urgent",
      labels: ["bug", "auth"],
      assignee: "Claude 1",
      columnId: "in-progress",
    });
    await addBoardCard(fx.home, fx.project, {
      title: "Add dark mode toggle",
      description: "Settings modal switch",
      priority: "low",
      labels: ["ui", "feat"],
      columnId: "todo",
    });
    const { card: doneCard } = await addBoardCard(fx.home, fx.project, {
      title: "Legacy OAuth migration",
      description: "Replaced v1 token endpoint",
      priority: "high",
      labels: ["auth", "cleanup"],
      columnId: "done",
    });
    await archiveBoardCard(fx.home, fx.project, doneCard.id);

    // Search across both active and archived cards for "token"
    const tokenHits = await searchBoard(fx.home, fx.project, "token");
    assert.deepEqual(
      tokenHits.activeMatches.map((c) => c.id),
      ["t-1"],
    );
    assert.deepEqual(
      tokenHits.archivedMatches.map((c) => c.id),
      ["t-3"],
    );

    // Token filters: #auth p0 @claude
    const urgentAuth = await searchBoard(fx.home, fx.project, "#auth p0 @claude");
    assert.deepEqual(
      urgentAuth.activeMatches.map((c) => c.id),
      ["t-1"],
    );
    assert.equal(urgentAuth.archivedMatches.length, 0);

    // Token filter: is:archived #auth
    const archivedAuth = await searchBoard(fx.home, fx.project, "is:archived #auth");
    assert.equal(archivedAuth.activeMatches.length, 0);
    assert.deepEqual(
      archivedAuth.archivedMatches.map((c) => c.id),
      ["t-3"],
    );

    // CLI handler: `aya board search auth`
    const deps = { ayaHome: fx.home, listProjects: async () => [fx.project] };
    const cliAll = await handleBoardRequest(
      { argv: ["search", "auth"], cwd: fx.repoDir },
      "pane-1",
      deps,
    );
    assert.match(cliAll.output, /Search "auth" on demo — 2 matches:/);
    assert.match(cliAll.output, /## Active \(1\)/);
    assert.match(cliAll.output, /t-1\s+Fix authentication race condition/);
    assert.match(cliAll.output, /## Archive \(1\)/);
    assert.match(cliAll.output, /t-3\s+Legacy OAuth migration/);

    // CLI handler: `aya board search auth --archive --json`
    const cliArchJson = await handleBoardRequest(
      { argv: ["search", "auth", "--archive", "--json"], cwd: fx.repoDir },
      "pane-1",
      deps,
    );
    const parsed = JSON.parse(cliArchJson.output);
    assert.equal(parsed.scope, "archive");
    assert.equal(parsed.active.length, 0);
    assert.equal(parsed.archived.length, 1);
    assert.equal(parsed.archived[0].id, "t-3");

    // CLI handler: `aya board archive search oauth`
    const cliSubArch = await handleBoardRequest(
      { argv: ["archive", "search", "oauth"], cwd: fx.repoDir },
      "pane-1",
      deps,
    );
    assert.match(cliSubArch.output, /## Archive \(1\)/);
    assert.match(cliSubArch.output, /t-3\s+Legacy OAuth migration/);

    // Direct unit check on matchesBoardQuery
    assert.equal(
      matchesBoardQuery(tokenHits.activeMatches[0], "col:progress p:urgent label:bug"),
      true,
    );
    assert.equal(
      matchesBoardQuery(tokenHits.activeMatches[0], "is:unassigned"),
      false,
    );
  } finally {
    fx.cleanup();
  }
});

// Pins the bytes a board without a backlog is saved with today: format, key
// order and fields after archive, unarchive, column rename and column delete.
// The backlog must leave such boards exactly like this.
test("a board without a backlog is saved byte for byte as before", async () => {
  const fx = makeFixture();
  try {
    const at = "2026-11-12T10:00:00.000Z";
    mkdirSync(join(fx.home, "boards"), { recursive: true });
    writeFileSync(join(fx.home, "boards", "demo.json"), JSON.stringify({
      version: 1,
      columns: [{ id: "todo", title: "Todo" }, { id: "in-progress", title: "In Progress" }, { id: "done", title: "Done" }],
      cards: [
        { id: "t-1", columnId: "todo", title: "First", description: "Body", priority: "high", labels: ["bug"], createdAt: at, updatedAt: at },
        { id: "t-2", columnId: "done", title: "Second", assignee: "Ann", createdAt: at, updatedAt: at },
      ],
      archivedCards: [{ id: "t-3", columnId: "done", title: "Third", createdAt: at, updatedAt: at, archivedAt: at }],
    }));
    await archiveBoardCard(fx.home, fx.project, "t-2", new Date("2026-11-16T10:00:00.000Z"));
    await unarchiveBoardCard(fx.home, fx.project, "t-3", undefined, new Date("2026-11-16T11:00:00.000Z"));
    await renameBoardColumn(fx.home, fx.project, "todo", "To do");
    await deleteBoardColumn(fx.home, fx.project, "in-progress");
    const expected = {
      version: 1,
      columns: [{ id: "todo", title: "To do" }, { id: "done", title: "Done" }],
      cards: [
        { id: "t-1", columnId: "todo", title: "First", description: "Body", priority: "high", labels: ["bug"], createdAt: at, updatedAt: at },
        { id: "t-3", columnId: "done", title: "Third", createdAt: at, updatedAt: "2026-11-16T11:00:00.000Z" },
      ],
      archivedCards: [
        { id: "t-2", columnId: "done", title: "Second", assignee: "Ann", archivedAt: "2026-11-16T10:00:00.000Z", createdAt: at, updatedAt: "2026-11-16T10:00:00.000Z" },
      ],
    };
    assert.equal(readFileSync(join(fx.home, "boards", "demo.json"), "utf8"), `${JSON.stringify(expected, null, 2)}\n`);
  } finally { fx.cleanup(); }
});

// The backlog is the Backlog column; only the UI decides where it shows.
const backlogFile = (fx) => join(fx.home, "boards", "demo.json");

test("cards saved with the first version's shelf mark load into the Backlog column", async () => {
  const fx = makeFixture();
  try {
    const at = "2026-11-12T10:00:00.000Z";
    mkdirSync(join(fx.home, "boards"), { recursive: true });
    writeFileSync(backlogFile(fx), JSON.stringify({ version: 1, columns: [{ id: "todo", title: "Todo" }],
      cards: [{ id: "t-1", columnId: "todo", title: "Kept", createdAt: at, updatedAt: at, shelf: "backlog" },
        { id: "t-2", columnId: "todo", title: "Now", createdAt: at, updatedAt: at }] }));
    const board = await getBoard(fx.home, fx.project);
    assert.deepEqual(board.columns.map((c) => c.id), ["todo", "backlog"]);
    assert.deepEqual(board.cards.map((c) => [c.id, c.columnId]), [["t-1", "backlog"], ["t-2", "todo"]]);
    await moveBoardCard(fx.home, fx.project, "t-2", "todo");
    const file = JSON.parse(readFileSync(backlogFile(fx), "utf8"));
    assert.ok(!file.cards.some((c) => "shelf" in c), "the mark is gone after a save");
    writeFileSync(backlogFile(fx), JSON.stringify({ version: 1, columns: [{ id: "todo", title: "Todo" }],
      cards: [{ id: "t-1", columnId: "todo", title: "A", createdAt: at, updatedAt: at, shelf: "attic" }] }));
    await assert.rejects(getBoard(fx.home, fx.project), /invalid card entries/);
  } finally { fx.cleanup(); }
});
