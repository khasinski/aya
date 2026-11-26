// "Edit from here" in the Conversation GUI: which messages can be rewound, the Claude restart
// on --resume-session-at, Codex thread/revert, and the Aya-side worktree snapshots.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { editPlan, editableMessageIds, messagesBefore, recordClaudeHead, editSummary } from "../dist-test/gui-edit-from-here.js";

const user = (id, edit, extra = {}) => ({ id, type: "user", text: `prompt ${id}`, delivery: "sent", ...(edit ? { edit } : {}), ...extra });
const reply = id => ({ id, type: "assistant", text: `answer ${id}` });

test("Claude resumes after the previous turn's last assistant message; the first message restarts the session", () => {
  const messages = [user("a", { claudeUser: "ua", claudeHead: "ha", prompt: "first" }), reply("ra"), user("b", { claudeUser: "ub", claudeHead: "hb", snapshot: "f".repeat(40) }), reply("rb")];
  assert.deepEqual(editPlan(messages, 0, "claude"), { messageId: "a", prompt: "first", removed: 4, target: { claudeUser: "ua", resumeAt: null } });
  assert.deepEqual(editPlan(messages, 2, "claude"), { messageId: "b", prompt: "prompt b", removed: 2, target: { claudeUser: "ub", resumeAt: "ha", snapshot: "f".repeat(40) } });
  assert.equal(editPlan(messages, 1, "claude"), null, "only user messages");
  assert.deepEqual([...editableMessageIds(messages, "claude")], ["a", "b"]);
});

test("a message is not editable when its place in the transcript is unknown", () => {
  const noHead = [user("a", { claudeUser: "ua" }), reply("ra"), user("b", { claudeUser: "ub" })];
  assert.equal(editPlan(noHead, 2, "claude"), null, "the previous turn never reported its head");
  assert.deepEqual([...editableMessageIds(noHead, "claude")], ["a"]);
  const legacy = [user("a"), reply("ra"), user("b", { claudeUser: "ub" })];
  assert.equal(editPlan(legacy, 2, "claude"), null, "a turn saved before the feature hides the action after it");
  const steered = [user("a", { claudeUser: "ua", claudeHead: "ha" }), { id: "s", type: "user", text: "↳ also this" }, user("b", { claudeUser: "ub" })];
  assert.equal(editPlan(steered, 2, "claude").target.resumeAt, "ha", "a steer belongs to the turn before it");
  const failed = [user("a", { claudeUser: "ua", claudeHead: "ha" }), user("x", null, { delivery: "failed" }), user("b", { claudeUser: "ub" })];
  assert.equal(editPlan(failed, 2, "claude").target.resumeAt, "ha", "a failed send never reached Claude");
  assert.equal(editPlan([user("a", { claudeUser: "ua" }, { delivery: "sending" })], 0, "claude"), null);
});

test("Codex needs the message's turn id; other agents never offer the action", () => {
  const messages = [user("a", { codexTurn: "t1" }), reply("ra"), user("b", {})];
  assert.deepEqual(editPlan(messages, 0, "codex").target, { codexTurn: "t1" });
  assert.equal(editPlan(messages, 2, "codex"), null);
  for (const agent of ["pi", "antigravity"]) {
    assert.equal(editPlan(messages, 0, agent), null);
    assert.equal(editableMessageIds(messages, agent).size, 0);
  }
});

test("Claude's head lands on the latest turn's message and the view is cut before the edited one", () => {
  const messages = [user("a", { claudeUser: "ua" }), reply("ra"), user("b", null, { delivery: "sending" }), { id: "s", type: "user", text: "↳ steer" }];
  const next = recordClaudeHead(messages, "h2");
  assert.equal(next[2].edit.claudeHead, "h2", "the head arrives before the send result and is merged later");
  assert.equal(next[0].edit.claudeHead, undefined);
  assert.equal(recordClaudeHead(next, "h2"), next, "unchanged heads keep the array");
  assert.deepEqual(messagesBefore(messages, "b").map(m => m.id), ["a", "ra"]);
  assert.equal(messagesBefore(messages, "missing"), messages);
  assert.match(editSummary(3, "Claude"), /removes the 2 after it .* Claude’s history/);
  assert.doesNotMatch(editSummary(1, "Codex"), /after it/);
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });
function worktreeRepo() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "aya-edit-snapshot-")));
  const main = path.join(root, "main"), wt = path.join(root, "wt");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(path.join(main, "tracked.txt"), "one\n");
  writeFileSync(path.join(main, ".gitignore"), "ignored/\n");
  mkdirSync(path.join(main, "sub"));
  writeFileSync(path.join(main, "sub", "inner.txt"), "inner\n");
  git(main, "add", "."); git(main, "commit", "-qm", "init");
  git(main, "worktree", "add", "-q", "-b", "wt", wt);
  return { root, main, wt };
}

test("a worktree snapshot restores changed, deleted and added files under the pane's folder only", async () => {
  const { takeWorkspaceSnapshot, restoreWorkspaceSnapshot, snapshotAvailable } = await import("../dist-electron/gui-edit-from-here.js");
  const { root, main, wt } = worktreeRepo();
  try {
    assert.equal(await takeWorkspaceSnapshot(main), undefined, "the main checkout gets no snapshot");
    writeFileSync(path.join(wt, "untracked.txt"), "before\n");
    const tree = await takeWorkspaceSnapshot(wt);
    assert.match(tree, /^[0-9a-f]{40}$/);
    assert.equal(await snapshotAvailable(wt, tree), true);
    assert.equal(git(wt, "status", "--porcelain"), "?? untracked.txt\n", "the snapshot leaves the index alone");
    writeFileSync(path.join(wt, "tracked.txt"), "changed\n");
    rmSync(path.join(wt, "untracked.txt"));
    mkdirSync(path.join(wt, "new", "deep"), { recursive: true });
    writeFileSync(path.join(wt, "new", "deep", "added.txt"), "added\n");
    mkdirSync(path.join(wt, "ignored"));
    writeFileSync(path.join(wt, "ignored", "cache"), "keep\n");
    const result = await restoreWorkspaceSnapshot(wt, tree);
    assert.deepEqual(result, { restored: 2, removed: 1 });
    assert.equal(readFileSync(path.join(wt, "tracked.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(path.join(wt, "untracked.txt"), "utf8"), "before\n");
    assert.equal(existsSync(path.join(wt, "new")), false, "emptied folders go with the added file");
    assert.equal(readFileSync(path.join(wt, "ignored", "cache"), "utf8"), "keep\n", "ignored files are left alone");
    assert.equal(git(main, "status", "--porcelain"), "", "the main checkout is untouched");

    const sub = path.join(wt, "sub");
    const subTree = await takeWorkspaceSnapshot(sub);
    writeFileSync(path.join(sub, "inner.txt"), "changed\n");
    writeFileSync(path.join(wt, "tracked.txt"), "outside the pane\n");
    assert.deepEqual(await restoreWorkspaceSnapshot(sub, subTree), { restored: 1, removed: 0 });
    assert.equal(readFileSync(path.join(sub, "inner.txt"), "utf8"), "inner\n");
    assert.equal(readFileSync(path.join(wt, "tracked.txt"), "utf8"), "outside the pane\n", "files outside the pane's cwd are never touched");
    await assert.rejects(restoreWorkspaceSnapshot(wt, "0".repeat(40)), /no longer available/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a send's edit checkpoint is the turn's own snapshot, kept only for the pane's worktree", async () => {
  const { workspaceCheckpoint } = await import("../dist-electron/gui-edit-from-here.js");
  const { root, main, wt } = worktreeRepo();
  try {
    let taken = 0;
    const checkpoint = async () => { taken++; return { root: wt, tree: "a".repeat(40) }; };
    assert.equal(await workspaceCheckpoint(wt, checkpoint), "a".repeat(40));
    assert.equal(await workspaceCheckpoint(main, checkpoint), undefined, "the main checkout keeps none");
    assert.equal(taken, 1, "no snapshot is taken outside a worktree");
    assert.equal(await workspaceCheckpoint(wt, async () => ({ root: main, tree: "b".repeat(40) })), undefined, "another checkout's tree is not this pane's");
    assert.equal(await workspaceCheckpoint(wt, async () => null), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the IPC checks the file revert, reverts files before the history, and refuses during a turn", async () => {
  process.env.AYA_HOME = mkdtempSync(path.join(tmpdir(), "aya-edit-home-"));
  const { editFromHere, parseEditTarget, sendWithSnapshot } = await import("../dist-electron/gui-edit-from-here-ipc.js");
  const calls = [];
  const session = {
    running: false,
    previewFileRewind: async target => target.claudeUser === "ok" ? ["/w/a.txt"] : null,
    rewindFiles: async target => { calls.push(["files", target.claudeUser]); },
    editFromHere: async target => { calls.push(["history", target.resumeAt]); return { threadId: "next" }; },
    send: async () => ({ claudeUser: "u1" }),
  };
  const entry = { session, cwd: process.env.AYA_HOME };
  assert.deepEqual(await editFromHere(entry, { phase: "check", target: { claudeUser: "ok" } }), { files: { method: "checkpoint", count: 1 } });
  assert.equal((await editFromHere(entry, { phase: "check", target: { claudeUser: "no" } })).files.method, null);
  const snapshot = { cwd: "/w", threadId: "old" };
  assert.deepEqual(await editFromHere(entry, { phase: "apply", target: { claudeUser: "ok", resumeAt: "h1" }, revertFiles: true }, snapshot), { threadId: "next", filesReverted: true });
  assert.deepEqual(calls, [["files", "ok"], ["history", "h1"]]);
  assert.equal(snapshot.threadId, "next");
  await assert.rejects(editFromHere(entry, { phase: "apply", target: { claudeUser: "no" }, revertFiles: true }, snapshot), /no checkpoint/);
  assert.equal(calls.length, 2, "nothing is rewound when the files cannot be");
  session.running = true;
  await assert.rejects(editFromHere(entry, { phase: "check", target: {} }), /Stop the current turn/);
  assert.deepEqual(parseEditTarget({ claudeUser: "u", resumeAt: null, snapshot: "../x", codexTurn: 5 }), { claudeUser: "u", resumeAt: null });
  assert.deepEqual(await sendWithSnapshot({ session, cwd: process.env.AYA_HOME }, async () => null, session.send), { rewind: { claudeUser: "u1" } });
  await assert.rejects(editFromHere({ session: { running: false }, cwd: "/" }, { phase: "check" }), /cannot rewind/);
});

const claudeFixture = path.resolve("tests/helpers/fake-claude-gui.cjs");
const codexFixture = path.resolve("tests/helpers/fake-codex-gui.cjs");
const waitFor = async (check, what) => { for (let i = 0; i < 200; i++) { const value = check(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } throw Error(`Timed out waiting for ${what}`); };

test("Claude restarts on a fork cut at the previous turn and reverts its checkpointed files", async () => {
  const { ClaudeGuiSession } = await import("../dist-electron/multi-agent-gui-session.js");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "aya-edit-claude-")));
  process.env.AYA_FAKE_CLAUDE_STATE = path.join(root, "state.json");
  const events = [], session = new ClaudeGuiSession(event => events.push(event), claudeFixture);
  const turn = async (prompt) => {
    const count = events.filter(e => e.method === "turn/completed").length;
    const sent = await session.send(prompt);
    const done = await waitFor(() => events.filter(e => e.method === "turn/completed")[count], "turn");
    return { ...sent, head: done.params.turn.ayaHead, text: events.filter(e => e.method === "item/completed").at(-1).params.item.text };
  };
  try {
    const first = await session.connect(root, "");
    assert.equal(events.find(e => e.method === "fixture/config").params.checkpointing, "true", "file checkpoints are on");
    const a = await turn("note alpha"), b = await turn("write beta.txt hello"), c = await turn("note gamma");
    assert.match(a.claudeUser, /^[0-9a-f-]{36}$/);
    assert.ok(a.head && b.head && c.head);
    assert.equal(c.text, "I remember: alpha, beta.txt, gamma");
    assert.deepEqual(await session.previewFileRewind({ claudeUser: b.claudeUser }), [path.join(root, "beta.txt")]);
    await session.rewindFiles({ claudeUser: b.claudeUser });
    assert.equal(existsSync(path.join(root, "beta.txt")), false);
    const before = events.length;
    const result = await session.editFromHere({ claudeUser: b.claudeUser, resumeAt: a.head });
    assert.notEqual(result.threadId, first.threadId);
    const args = events.slice(before).find(e => e.method === "fixture/config").params.args;
    assert.deepEqual(args.slice(args.indexOf("--resume")), ["--resume", first.threadId, "--resume-session-at", a.head, "--fork-session", "--session-id", result.threadId, "--allow-dangerously-skip-permissions"]);
    assert.equal(events.slice(before).some(e => e.method === "aya/disconnected"), false, "the restart is not a disconnect");
    assert.equal(events.slice(before).find(e => e.method === "aya/session").params.threadId, result.threadId);
    assert.equal((await turn("note delta")).text, "I remember: alpha, delta");
    const fresh = await session.editFromHere({ claudeUser: a.claudeUser, resumeAt: null });
    assert.equal((await turn("note epsilon")).text, "I remember: epsilon", "editing the first message starts over");
    assert.notEqual(fresh.threadId, result.threadId);
    await assert.rejects(session.editFromHere({ claudeUser: "x" }), /did not report/);
  } finally { session.close(); delete process.env.AYA_FAKE_CLAUDE_STATE; rmSync(root, { recursive: true, force: true }); }
});

test("Codex reverts the thread to before the message's turn", async () => {
  const { CodexGuiSession } = await import("../dist-electron/codex-gui-session.js");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "aya-edit-codex-")));
  const events = [], session = new CodexGuiSession(event => events.push(event), codexFixture);
  try {
    await session.connect(root, "");
    const sent = [];
    for (const prompt of ["note alpha", "note beta", "note gamma"]) {
      sent.push(await session.send(prompt));
      await waitFor(() => !session.running, "turn end");
    }
    assert.ok(sent.every(s => s.codexTurn) && new Set(sent.map(s => s.codexTurn)).size === 3);
    await session.editFromHere({ codexTurn: sent[1].codexTurn });
    assert.equal(events.find(e => e.method === "fixture/revert").params.beforeTurnId, sent[1].codexTurn);
    await session.send("note delta");
    await waitFor(() => !session.running, "turn end");
    assert.equal(events.filter(e => e.method === "item/completed").at(-1).params.item.text, "I remember: alpha, delta");
    await assert.rejects(session.editFromHere({}), /did not report its turn/);
  } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
});

test("the IPC asks the agent to check the rewind before any file is reverted", async () => {
  const { editFromHere } = await import("../dist-electron/gui-edit-from-here-ipc.js");
  const calls = [];
  let refusal = "A subagent is still working";
  const session = {
    running: false,
    checkEditFromHere: async () => { calls.push("check"); if (refusal) throw Error(refusal); },
    previewFileRewind: async () => ["/w/a.txt"],
    rewindFiles: async () => { calls.push("files"); },
    editFromHere: async () => { calls.push("history"); throw Error("Claude could not restart at the earlier message (gone)."); },
  };
  const entry = { session, cwd: tmpdir() };
  await assert.rejects(editFromHere(entry, { phase: "check", target: { claudeUser: "u", resumeAt: "h" } }), /subagent is still working/);
  await assert.rejects(editFromHere(entry, { phase: "apply", target: { claudeUser: "u", resumeAt: "h" }, revertFiles: true }), /subagent is still working/);
  assert.deepEqual(calls, ["check", "check"], "no file is touched when the agent refuses");
  refusal = "";
  await assert.rejects(editFromHere(entry, { phase: "apply", target: { claudeUser: "u", resumeAt: "h" }, revertFiles: true }), /could not restart.*files were already restored/);
  assert.deepEqual(calls.slice(2), ["check", "files", "history"]);
});

test("Claude reopens the conversation as it was when it cannot start at the earlier message", async () => {
  const { ClaudeGuiSession } = await import("../dist-electron/multi-agent-gui-session.js");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "aya-edit-claude-fail-")));
  process.env.AYA_FAKE_CLAUDE_STATE = path.join(root, "state.json");
  const events = [], session = new ClaudeGuiSession(event => events.push(event), claudeFixture);
  const turn = async (prompt) => {
    const count = events.filter(e => e.method === "turn/completed").length;
    await session.send(prompt);
    await waitFor(() => events.filter(e => e.method === "turn/completed")[count], "turn");
    return events.filter(e => e.method === "item/completed").at(-1).params.item.text;
  };
  try {
    const first = await session.connect(root, "");
    await turn("note alpha"); await turn("note beta");
    const before = events.length;
    await assert.rejects(session.editFromHere({ resumeAt: "not-in-the-transcript" }), /could not restart at the earlier message.*reopened as it was/);
    const launches = events.slice(before).filter(e => e.method === "fixture/config").map(e => e.params.args);
    assert.deepEqual(launches.at(-1).slice(launches.at(-1).indexOf("--resume"), -1), ["--resume", first.threadId]);
    assert.equal(events.slice(before).some(e => e.method === "aya/disconnected"), false, "the pane stays connected");
    assert.equal(events.slice(before).filter(e => e.method === "aya/session").at(-1).params.threadId, first.threadId);
    assert.equal(await turn("note gamma"), "I remember: alpha, beta, gamma");
  } finally { session.close(); delete process.env.AYA_FAKE_CLAUDE_STATE; rmSync(root, { recursive: true, force: true }); }
});

test("Claude refuses Edit from here while a subagent runs, and a late tool answer never reaches the restarted Claude", async () => {
  const { ClaudeGuiSession } = await import("../dist-electron/multi-agent-gui-session.js");
  const tmp = mkdtempSync(path.join(tmpdir(), "aya-edit-claude-tmp-"));
  process.env.CLAUDE_CODE_TMPDIR = tmp;
  const events = [], session = new ClaudeGuiSession(event => events.push(event), process.execPath, [claudeFixture]);
  try {
    await session.connect(process.cwd(), "");
    await session.send("stoppable-agent");
    await waitFor(() => events.some(e => e.method === "turn/completed"), "turn");
    await assert.rejects(session.checkEditFromHere({ resumeAt: null }), /subagent is still working/);
    await assert.rejects(session.editFromHere({ resumeAt: null }), /subagent is still working/);
    assert.equal(events.filter(e => e.method === "fixture/config").length, 1, "Claude was not restarted");
    await session.stopSubagent("toolu_agent2");
    await waitFor(() => !session.running && events.filter(e => e.method === "turn/completed").length === 2, "stop turn");
    // An Aya tool call from this Claude is still running when Edit from here replaces it.
    let finish; session.executeAyaTool = () => new Promise(resolve => { finish = resolve; });
    const late = session.receive({ type: "control_request", request_id: "late-present", request: { subtype: "mcp_message", server_name: "aya", message: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aya_present", arguments: {} } } } });
    await session.editFromHere({ resumeAt: null });
    finish({ success: true, text: "late" }); await late;
    await new Promise(r => setTimeout(r, 100));
    assert.equal(events.some(e => e.method === "fixture/late-answer"), false);
    assert.equal(events.some(e => e.method === "aya/disconnected"), false);
  } finally { session.close(); delete process.env.CLAUDE_CODE_TMPDIR; rmSync(tmp, { recursive: true, force: true }); }
});

test("Codex checks it can rewind, and that no subagent runs, before anything is reverted", async () => {
  const { CodexGuiSession } = await import("../dist-electron/codex-gui-session.js");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "aya-edit-codex-check-")));
  const old = new CodexGuiSession(() => {}, codexFixture);
  const events = [], session = new CodexGuiSession(event => events.push(event), codexFixture);
  try {
    process.env.AYA_FAKE_CODEX_NO_REVERT = "1";
    await old.connect(root, "");
    delete process.env.AYA_FAKE_CODEX_NO_REVERT;
    await assert.rejects(old.checkEditFromHere({ codexTurn: "t1" }), /version of Codex cannot rewind/);
    await session.connect(root, "");
    await session.checkEditFromHere({ codexTurn: "t1" });
    await session.send("subagent-runs");
    await waitFor(() => !session.running, "turn end");
    await assert.rejects(session.checkEditFromHere({ codexTurn: "turn" }), /subagent is still working/);
    await assert.rejects(session.editFromHere({ codexTurn: "turn" }), /subagent is still working/);
    assert.equal(events.some(e => e.method === "fixture/revert"), false);
  } finally { old.close(); session.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Codex drops a next-prompt suggestion sampled from turns Edit from here removed", async () => {
  const { CodexGuiSession } = await import("../dist-electron/codex-gui-session.js");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "aya-edit-codex-sample-")));
  process.env.AYA_FAKE_CODEX_SAMPLE_BUSY = "1";
  const events = [], session = new CodexGuiSession(event => events.push(event), codexFixture);
  try {
    await session.connect(root, "");
    delete process.env.AYA_FAKE_CODEX_SAMPLE_BUSY;
    session.setPromptSuggestions(true);
    const sent = await session.send("note alpha");
    // The suggestion is retried while Codex says the turn is not idle yet; the turn is removed meanwhile.
    await waitFor(() => events.some(e => e.method === "fixture/suggestion-sample"), "first sample");
    await session.editFromHere({ codexTurn: sent.codexTurn });
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(events.filter(e => e.method === "fixture/suggestion-sample").length, 1, "no retry after the turn was removed");
    assert.equal(events.some(e => e.method === "aya/promptSuggestion"), false);
  } finally { delete process.env.AYA_FAKE_CODEX_SAMPLE_BUSY; session.close(); rmSync(root, { recursive: true, force: true }); }
});
