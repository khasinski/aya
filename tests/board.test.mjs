import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";

const { startControlServerOn } = await import("../dist-electron/control.js");
const {
  getBoard,
  addBoardCard,
  updateBoardCard,
  moveBoardCard,
  deleteBoardCard,
  claimBoardCard,
  releaseBoardCard,
  addBoardColumn,
  renameBoardColumn,
  deleteBoardColumn,
  exportBoardToRepo,
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

    const exported = await runCli(["board", "export-repo"]);
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(existsSync(join(fx.repoDir, ".aya", "board.json")), true);
  } finally {
    stop();
    fx.cleanup();
  }
});
