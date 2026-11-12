import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";

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
  claimBoardCard,
  releaseBoardCard,
  addBoardColumn,
  moveBoardColumn,
  renameBoardColumn,
  deleteBoardColumn,
  exportBoardToRepo,
  handleBoardRequest,
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
      if (action === "reassign") assert.ok(fx.sent.some(message => message.paneId === "pane-2" && message.text.startsWith("Task t-1")));
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
