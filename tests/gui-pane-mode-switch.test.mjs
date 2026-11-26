// Terminal ⇄ Conversation: the per-pane mode, the resume commands both ways, the transcript a switched Conversation
// opens with, and the migration that merges "Claude" + "Claude GUI" preset twins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aya-pane-mode-test-"));
process.env.AYA_HOME = home;
const { mergeInterfaceTwins, remapProjectTabs, migrateInterfaceTwinPresets, startupPresetMerges } = await import("../dist-electron/preset-mode-migration.js");
const { claudeTranscriptMessages, codexRolloutMessages, codexThreadMessages, adoptTerminalSession, findClaudeTranscript, findCodexRollout, findCodexRolloutSegments, terminalSessionMessages, withTerminalArtifacts } = await import("../dist-electron/gui-mode-switch.js");
const { claudeProjectDirName } = await import("../dist-electron/claude-session.js");
const { modeSwitchCommand, resumeSpawn } = await import("../dist-test/agentPreset.js");
const { paneMode, initialPaneMode, terminalSwitchRefusal, terminalSwitchWarning, conversationSwitchRefusal, switchSessionId } = await import("../dist-test/pane-mode.js");
const { applyPtyEvent, restartResumes, SWITCH_RESUME_FAILED_MS } = await import("../dist-test/pty-event-reducer.js");
const { extractAyaOsc, parseAyaOscStatus } = await import("../dist-electron/osc-extractor.js");

const preset = (over) => ({ id: "p", name: "P", icon: "", color: "", command: "claude", ...over });

test.after(() => rmSync(home, { recursive: true, force: true }));

// --- pane mode ---

test("a pane's own mode wins over the preset's Opens as, and a pane without a GUI is always a terminal", () => {
  assert.equal(paneMode(preset({}), {}, false), "terminal");
  assert.equal(paneMode(preset({ interfaceMode: "gui" }), {}, false), "gui");
  assert.equal(paneMode(preset({ interfaceMode: "gui" }), { interfaceMode: "terminal" }, false), "terminal");
  assert.equal(paneMode(preset({}), { interfaceMode: "gui" }, false), "gui");
  assert.equal(paneMode(preset({ interfaceMode: "gui" }), { interfaceMode: "gui" }, true), "terminal", "remote panes stay terminals");
  assert.equal(paneMode(preset({ command: "aider" }), { interfaceMode: "gui" }, false), "terminal");
  assert.equal(initialPaneMode(preset({ interfaceMode: "gui" }), false), "gui");
  assert.equal(initialPaneMode(preset({ command: "$SHELL" }), false), undefined);
});

test("a switch waits for the turn and for any approval or question", () => {
  const live = { status: "running", exitCode: null };
  assert.equal(terminalSwitchRefusal(live), null);
  // What the agent reported, or the screen's activity, can outlive the turn: a warning a second request overrides.
  assert.equal(terminalSwitchRefusal({ ...live, working: true }), null);
  assert.match(terminalSwitchWarning({ ...live, working: true }), /still be working/);
  assert.match(terminalSwitchWarning({ ...live, status: "waiting" }), /waiting/);
  assert.match(terminalSwitchWarning({ ...live, externalStatus: { level: "active", text: "", updatedAt: 0 } }), /working/);
  assert.equal(terminalSwitchWarning(live), null);
  assert.equal(terminalSwitchWarning({ ...live, working: true, exitCode: 0 }), null, "an exited agent has nothing to wait for");
  // A CLI dialog on screen would be lost: that one blocks.
  assert.match(terminalSwitchRefusal({ ...live, status: "waiting", screenDialog: "permission" }), /prompt/);
  assert.equal(terminalSwitchRefusal({ ...live, working: true, exitCode: 0 }), null, "an exited agent has nothing to wait for");
  assert.match(terminalSwitchRefusal({ ...live, remoteHost: "box" }), /remote/);
  assert.equal(conversationSwitchRefusal({ busy: false, requests: 0, switching: false, connecting: false }), null);
  assert.match(conversationSwitchRefusal({ busy: true, requests: 0, switching: false, connecting: false }), /turn/);
  assert.match(conversationSwitchRefusal({ busy: true, requests: 1, switching: false, connecting: false }), /approval/);
  assert.match(conversationSwitchRefusal({ busy: false, requests: 0, switching: false, connecting: true }), /connecting/);
});

test("an idle Claude or Codex terminal switches on the first request, whatever program status the CLI sent", () => {
  // The pane as pty-core sees it: OSC 7501 out of the output, as osc-status events into the renderer's state.
  const afterOutput = (chunks) => chunks.reduce((state, chunk) => {
    for (const event of extractAyaOsc(chunk, "").events) {
      const status = parseAyaOscStatus(event);
      if (status) state = applyPtyEvent(state, { type: "osc-status", ptyId: "t1", level: status.level, text: status.text, updatedAt: 1 });
    }
    return state;
  }, { t1: { id: "t1", projectSlug: "p", presetId: "p", name: "t1", cwd: "/w", status: "running", bell: false, exitCode: null } }).t1;
  // Claude Code 2.1.332 asks `7501;?` at start and, with no reply, sends nothing more.
  assert.equal(terminalSwitchWarning(afterOutput(["\x1b]7501;?\x07"])), null);
  // Codex 0.172.0 ends a turn with state=done (later idle).
  const codexTurn = ["\x1b]7501;state=idle:app=codex\x07", "\x1b]7501;state=working:app=codex\x07"];
  assert.match(terminalSwitchWarning(afterOutput(codexTurn)), /still be working/, "a turn that runs still warns");
  assert.equal(terminalSwitchWarning(afterOutput([...codexTurn, "\x1b]7501;state=done:app=codex\x07"])), null);
  assert.equal(terminalSwitchWarning(afterOutput([...codexTurn, "\x1b]7501;state=idle:app=codex\x07"])), null);
});

test("a Conversation with queued messages does not switch, since the terminal would drop them", () => {
  const idle = { busy: false, requests: 0, switching: false, connecting: false };
  assert.equal(conversationSwitchRefusal({ ...idle, queued: 0 }), null);
  assert.match(conversationSwitchRefusal({ ...idle, queued: 2 }), /queued/);
});

test("the exit a switch to the Conversation causes is not the pane's: no error, no done", () => {
  const pane = { id: "t1", projectSlug: "p", presetId: "p", name: "t1", cwd: "/w", status: "running", bell: false, exitCode: null, interfaceMode: "terminal" };
  const exit = { type: "exit", ptyId: "t1", exitCode: 143 };
  const state = { t1: { ...pane, modeSwitching: true } };
  assert.equal(applyPtyEvent(state, exit), state);
  assert.equal(applyPtyEvent({ t1: pane }, exit).t1.status, "error", "any other exit still shows");
});

// --- resume arguments ---

test("switching to the terminal resumes the Conversation's session by id, whatever auto-resume says", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.equal(modeSwitchCommand(preset({}), id), `claude --resume ${id}`);
  assert.equal(modeSwitchCommand(preset({ autoResume: false }), id), `claude --resume ${id}`);
  assert.equal(modeSwitchCommand(preset({ command: "codex", agent: "codex" }), id), `codex resume ${id}`);
  assert.equal(modeSwitchCommand(preset({ command: "pi", agent: "pi" }), "s1"), "pi --session s1");
  assert.equal(modeSwitchCommand(preset({ command: "agy", agent: "antigravity" }), "c1"), "agy --conversation c1");
  assert.equal(modeSwitchCommand(preset({ command: "CLAUDE_CONFIG_DIR=~/.claude2 claude" }), id), `CLAUDE_CONFIG_DIR=~/.claude2 claude --resume ${id}`);
  // No id: a fresh session, never "continue latest" (another pane's).
  assert.equal(modeSwitchCommand(preset({}), undefined), "claude");
  // A command that already resumes is left alone.
  assert.equal(modeSwitchCommand(preset({ command: "claude --continue" }), id), "claude --continue");
  const spawn = resumeSpawn(preset({ autoResume: false }), { id: "a", cwd: "/w", sessionId: id, resumeOnSwitch: true }, [{ id: "b", preset: preset({}), cwd: "/w" }]);
  assert.deepEqual(spawn, { command: `claude --resume ${id}` }, "no shared-folder fallback to --continue");
});

test("only the spawn right after a switch resumes past the preset, and a resume that fails at once is dropped", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const switchedAt = 1_000_000;
  const pane = { id: "t1", projectSlug: "p", presetId: "p", name: "t1", cwd: "/w", status: "running", bell: false, exitCode: null, interfaceMode: "terminal", sessionId: id, resumeOnSwitch: switchedAt };
  // The agent ran and exited later: the next Restart follows the preset (auto-resume off: a new session).
  const ran = applyPtyEvent({ t1: pane }, { type: "exit", ptyId: "t1", exitCode: 0 }, switchedAt + 60_000).t1;
  assert.equal(ran.resumeOnSwitch, undefined);
  assert.equal(ran.sessionId, id);
  const off = preset({ autoResume: false });
  assert.deepEqual(resumeSpawn(off, { id: "t1", cwd: "/w", restored: restartResumes(ran, true), sessionId: ran.sessionId, resumeOnSwitch: ran.resumeOnSwitch !== undefined }, []), { command: "claude" });
  assert.deepEqual(resumeSpawn(preset({}), { id: "t1", cwd: "/w", restored: restartResumes(ran, true), sessionId: ran.sessionId, resumeOnSwitch: false }, []), { command: `claude --resume ${id}` });
  // `codex resume <id>` of a thread with no turn yet exits at once: Restart starts fresh, not the same failure again.
  const codex = preset({ command: "codex", agent: "codex" });
  const failed = applyPtyEvent({ t1: pane }, { type: "exit", ptyId: "t1", exitCode: 1 }, switchedAt + SWITCH_RESUME_FAILED_MS - 1).t1;
  assert.equal(failed.sessionId, undefined);
  assert.equal(failed.resumeOnSwitch, undefined);
  assert.equal(restartResumes(failed, true), false, "a restart of it does not continue latest either");
  assert.deepEqual(resumeSpawn(codex, { id: "t1", cwd: "/w", restored: restartResumes(failed, true), sessionId: failed.sessionId }, []), { command: "codex" });
});

test("a session id handed between modes never names a path for the agents whose files Aya reads", () => {
  assert.equal(switchSessionId("claude", "0f8fad5b-d9cb-469f-a165-70867728950e"), "0f8fad5b-d9cb-469f-a165-70867728950e");
  assert.equal(switchSessionId("claude", "../../x"), undefined);
  assert.equal(switchSessionId("codex", "a/b"), undefined);
  assert.equal(switchSessionId("pi", "/home/u/.pi/sessions/s.jsonl"), "/home/u/.pi/sessions/s.jsonl", "Pi resumes a session file");
  assert.equal(switchSessionId("pi", "bad id; rm"), undefined);
});

// --- transcripts ---

test("a Claude transcript gives the typed prompts and replies, without tool traffic, meta lines or command wrappers", () => {
  const lines = [
    { type: "user", uuid: "u1", message: { role: "user", content: "Remember the word PELICAN." } },
    { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "" }] } },
    { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Noted." }] } },
    { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } },
    { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Done." }] } },
    { type: "user", isMeta: true, message: { role: "user", content: "Caveat" } },
    { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
    { type: "user", isSidechain: true, message: { role: "user", content: "subagent prompt" } },
    "not json",
    { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "text", text: "What was it?" }] } },
  ].map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  const messages = claudeTranscriptMessages(lines);
  assert.deepEqual(messages.map((m) => [m.type, m.text]), [
    ["user", "Remember the word PELICAN."],
    ["assistant", "Noted.\n\nDone."],
    ["user", "What was it?"],
  ]);
  assert.equal(new Set(messages.map((m) => m.id)).size, messages.length);
});

test("a Claude transcript rewound in the terminal (Esc Esc) shows only the branch it went on from", () => {
  const lines = [
    { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "first" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "reply one" }] } },
    { type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: "abandoned prompt" } },
    { type: "assistant", uuid: "a2", parentUuid: "u2", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "abandoned reply" }] } },
    { type: "summary", summary: "a title" },
    // The rewind went back to a1 and on from there.
    { type: "user", uuid: "u3", parentUuid: "a1", message: { role: "user", content: "second" } },
    { type: "assistant", uuid: "a3", parentUuid: "u3", message: { id: "m3", role: "assistant", content: [{ type: "text", text: "reply two" }] } },
    // A compaction starts a new chain that points at the one before it.
    { type: "system", uuid: "c1", parentUuid: null, logicalParentUuid: "a3", subtype: "compact_boundary" },
    { type: "user", uuid: "u4", parentUuid: "c1", message: { role: "user", content: "third" } },
  ].map((l) => JSON.stringify(l)).join("\n");
  assert.deepEqual(claudeTranscriptMessages(lines).map((m) => m.text), ["first", "reply one", "second", "reply two", "third"]);
});

test("a Codex rollout gives the messages in both shapes Codex has written", () => {
  const lines = [
    { type: "session_meta", payload: { id: "t" } },
    { type: "event_msg", payload: { type: "user_message", message: "old prompt" } },
    { type: "event_msg", payload: { type: "agent_message", message: "old reply" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>" }] } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "u", content: [{ type: "text", text: "new prompt" }] } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "Reasoning", id: "r" } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "a", content: [{ type: "Text", text: "new reply" }] } } },
  ].map((l) => JSON.stringify(l)).join("\n");
  assert.deepEqual(codexRolloutMessages(lines).map((m) => [m.type, m.text]), [
    ["user", "old prompt"], ["assistant", "old reply"], ["user", "new prompt"], ["assistant", "new reply"],
  ]);
});

test("transcripts are found by the cwd's folder, a symlink-free spelling, or any folder; rollouts by day", async () => {
  const config = join(home, "claude-config");
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(config, "projects", claudeProjectDirName(cwd)), { recursive: true });
  writeFileSync(join(config, "projects", claudeProjectDirName(cwd), "s1.jsonl"), "");
  mkdirSync(join(config, "projects", "-elsewhere"), { recursive: true });
  writeFileSync(join(config, "projects", "-elsewhere", "s2.jsonl"), "");
  assert.equal(await findClaudeTranscript(config, cwd, "s1"), join(config, "projects", claudeProjectDirName(cwd), "s1.jsonl"));
  assert.equal(await findClaudeTranscript(config, cwd, "s2"), join(config, "projects", "-elsewhere", "s2.jsonl"));
  assert.equal(await findClaudeTranscript(config, cwd, "nope"), null);
  const codex = join(home, "codex-home");
  mkdirSync(join(codex, "sessions", "2026", "11", "25"), { recursive: true });
  writeFileSync(join(codex, "sessions", "2026", "11", "25", "rollout-2026-11-25T10-00-00-abc-1.jsonl"), "");
  assert.equal(await findCodexRollout(codex, "abc-1"), join(codex, "sessions", "2026", "11", "25", "rollout-2026-11-25T10-00-00-abc-1.jsonl"));
  assert.equal(await findCodexRollout(codex, "zzz"), null);
});

test("a Codex thread rolled back by Edit from here reads on from its newer segment, without the dropped turns", async () => {
  // Codex 0.172: thread/revert starts rollout-<time>-<id>_<segment>.jsonl, whose ordinals go on from where it cut.
  const codex = join(home, "codex-segments");
  const day = (d) => join(codex, "sessions", "2026", "11", d);
  mkdirSync(day("25"), { recursive: true }); mkdirSync(day("26"), { recursive: true });
  const line = (ordinal, type, text) => JSON.stringify({ timestamp: "t", ordinal, type: "event_msg", payload: { type: "item_completed", item: { type, id: `i${ordinal}`, content: [{ type: "text", text }] } } });
  const meta = (ordinal) => JSON.stringify({ timestamp: "t", ordinal, type: "session_meta", payload: { id: "t-1" } });
  writeFileSync(join(day("25"), "rollout-2026-11-25T10-00-00-t-1.jsonl"), [meta(0), line(1, "UserMessage", "one"), line(2, "AgentMessage", "did one"), line(3, "UserMessage", "two"), line(4, "AgentMessage", "did two")].join("\n"));
  writeFileSync(join(day("26"), "rollout-2026-11-26T09-00-00-t-1_seg-a.jsonl"), [meta(3), line(3, "UserMessage", "three"), line(4, "AgentMessage", "did three")].join("\n"));
  writeFileSync(join(day("26"), "rollout-2026-11-26T09-00-00-other.jsonl"), line(0, "UserMessage", "not this thread"));
  const files = await findCodexRolloutSegments(codex, "t-1");
  assert.deepEqual(files.map((f) => f.split("/").at(-1)), ["rollout-2026-11-25T10-00-00-t-1.jsonl", "rollout-2026-11-26T09-00-00-t-1_seg-a.jsonl"]);
  assert.equal(await findCodexRollout(codex, "t-1"), files[0]);
  const messages = await codexThreadMessages(files);
  assert.deepEqual(messages.map((m) => m.text), ["one", "did one", "three", "did three"]);
  assert.equal(new Set(messages.map((m) => m.id)).size, 4);
});

test("a Codex thread rolled back twice keeps out what either rollback dropped", async () => {
  const codex = join(home, "codex-two-rollbacks");
  const day = join(codex, "sessions", "2026", "11", "26");
  mkdirSync(day, { recursive: true });
  const line = (ordinal, type, text) => JSON.stringify({ timestamp: "t", ordinal, type: "event_msg", payload: { type: "item_completed", item: { type, id: `i${ordinal}`, content: [{ type: "text", text }] } } });
  const meta = (ordinal) => JSON.stringify({ timestamp: "t", ordinal, type: "session_meta", payload: { id: "t-2" } });
  writeFileSync(join(day, "rollout-2026-11-26T10-00-00-t-2.jsonl"), [meta(0), line(1, "UserMessage", "one"), line(2, "AgentMessage", "did one"), line(3, "UserMessage", "two"), line(4, "AgentMessage", "did two"), line(5, "UserMessage", "three"), line(6, "AgentMessage", "did three")].join("\n"));
  // The first rollback went back to "three"; the second further, to "two".
  writeFileSync(join(day, "rollout-2026-11-26T11-00-00-t-2_seg-a.jsonl"), [meta(5), line(5, "UserMessage", "three again"), line(6, "AgentMessage", "did three again")].join("\n"));
  writeFileSync(join(day, "rollout-2026-11-26T12-00-00-t-2_seg-b.jsonl"), [meta(3), line(3, "UserMessage", "two again"), line(4, "AgentMessage", "did two again")].join("\n"));
  const messages = await codexThreadMessages(await findCodexRolloutSegments(codex, "t-2"));
  assert.deepEqual(messages.map((m) => m.text), ["one", "did one", "two again", "did two again"]);
});

test("the terminal's session is read where its command's CODEX_HOME or CLAUDE_CONFIG_DIR put it", async () => {
  const codex = join(home, "inline-codex-home");
  const day = join(codex, "sessions", "2026", "11", "26");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-2026-11-26T10-00-00-t-3.jsonl"), JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "from the inline home" } }));
  const codexMessages = await terminalSessionMessages("codex", "/w", undefined, "t-3", `CODEX_HOME=${codex} codex`);
  assert.deepEqual(codexMessages?.map((m) => m.text), ["from the inline home"]);
  const config = join(home, "inline-claude-config");
  const cwd = join(home, "inline-work");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(config, "projects", claudeProjectDirName(cwd)), { recursive: true });
  writeFileSync(join(config, "projects", claudeProjectDirName(cwd), "s-9.jsonl"), JSON.stringify({ type: "user", uuid: "u", message: { role: "user", content: "from the inline config" } }));
  const claudeMessages = await terminalSessionMessages("claude", cwd, undefined, "s-9", `CLAUDE_CONFIG_DIR="${config}" claude`);
  assert.deepEqual(claudeMessages?.map((m) => m.text), ["from the inline config"]);
});

test("a Conversation opened from a terminal resumes the session it found and keeps the pane's choices", async () => {
  const read = async () => [{ id: "u", type: "user", text: "hi" }];
  const saved = { cwd: "/w", agent: "claude", threadId: "old", view: { permissionMode: "plan", messages: [{ id: "x", type: "user", text: "older" }], artifacts: [{ id: "a" }] } };
  const snapshot = await adoptTerminalSession({ cwd: "/w", agent: "claude", sessionId: "s1" }, saved, read);
  assert.equal(snapshot.threadId, "s1");
  assert.deepEqual(snapshot.view.messages, [{ id: "u", type: "user", text: "hi" }]);
  assert.equal(snapshot.view.permissionMode, "plan");
  assert.equal(snapshot.view.artifacts, undefined, "another conversation's artifacts do not carry over");
  assert.match(snapshot.view.importNotice, /Continued the terminal session/);
  const same = await adoptTerminalSession({ cwd: "/w", agent: "claude", sessionId: "old" }, saved, read);
  assert.deepEqual(same.view.artifacts, [{ id: "a" }], "the same conversation keeps what it showed");
  // Not on disk (no message yet), or no id at all: a new conversation, said plainly.
  const fresh = await adoptTerminalSession({ cwd: "/w", agent: "claude", sessionId: "s1" }, saved, async () => null);
  assert.equal(fresh.threadId, undefined);
  assert.match(fresh.view.importNotice, /new Claude conversation/);
  assert.equal((await adoptTerminalSession({ cwd: "/w", agent: "codex" }, null, read)).threadId, undefined);
  // Pi and Antigravity resume the id the pane's Conversation had, which Aya cannot read back.
  assert.equal((await adoptTerminalSession({ cwd: "/w", agent: "pi", sessionId: "p1" }, null, async () => null)).threadId, "p1");
  assert.equal((await adoptTerminalSession({ cwd: "/w", agent: "claude", sessionId: "bad id; rm" }, null, read)).threadId, undefined);
  // An id a pane reported over OSC 9001 never names a file outside the transcripts.
  let asked = 0;
  const counted = async () => { asked++; return [{ id: "u", type: "user", text: "hi" }]; };
  assert.equal((await adoptTerminalSession({ cwd: "/w", agent: "claude", sessionId: "../../etc/x" }, null, counted)).threadId, undefined);
  assert.equal((await adoptTerminalSession({ cwd: "/w", agent: "codex", sessionId: "a/b" }, null, counted)).threadId, undefined);
  assert.equal(asked, 0);
  assert.equal(await findClaudeTranscript(join(home, "claude-config"), "/w", "../../x"), null);
  // The same conversation keeps what the user queued in it; another one does not.
  const queued = { ...saved, view: { ...saved.view, queue: [{ id: "q", text: "later" }] } };
  assert.deepEqual((await adoptTerminalSession({ cwd: "/w", agent: "claude", sessionId: "old" }, queued, read)).view.queue, [{ id: "q", text: "later" }]);
  assert.deepEqual((await adoptTerminalSession({ cwd: "/w", agent: "claude", sessionId: "s1" }, queued, read)).view.queue, []);
});

// --- migration ---

const claude = { id: "claude", name: "Claude", icon: "✻", color: "#d97757", command: "claude" };
const claudeGui = { id: "claude-gui", name: "Claude GUI", icon: "✦", color: "", command: "claude", agent: "claude", interfaceMode: "gui" };

test("a Conversation preset that only differs by its interface merges into the terminal one", () => {
  // The seeded "Claude" has no agent field; a Settings-made "Claude GUI" has one: the same agent.
  const second = { id: "c2", name: "Claude 2", icon: "", color: "", command: "CLAUDE_CONFIG_DIR=~/.claude2 claude", configDir: "~/.claude2" };
  const second2 = { ...second, id: "c2-gui", name: "Claude 2 GUI", agent: "claude", interfaceMode: "gui" };
  const { presets, remap } = mergeInterfaceTwins([claude, claudeGui, second, second2]);
  assert.deepEqual(remap, { "claude-gui": "claude", "c2-gui": "c2" });
  assert.deepEqual(presets.map((p) => p.id), ["claude", "c2"]);
  assert.equal(presets[0].interfaceMode, undefined, "the kept preset still opens as a terminal");
});

test("presets that are not exact launch twins stay", () => {
  const cases = [
    [claude, { ...claudeGui, command: "claude --model haiku" }],
    [claude, { ...claudeGui, configDir: "~/.claude2" }],
    [claude, { ...claudeGui, unsafeMode: true }],
    [claude, { ...claudeGui, agent: "codex", command: "claude" }],
    [{ ...claude, id: "a" }, { ...claude, id: "b" }],
    [{ id: "s", name: "S", icon: "", color: "", command: "$SHELL" }, { id: "s2", name: "S2", icon: "", color: "", command: "$SHELL", interfaceMode: "gui" }],
    [claudeGui],
  ];
  for (const list of cases) {
    const { presets, remap } = mergeInterfaceTwins(list);
    assert.deepEqual(remap, {}, JSON.stringify(list));
    assert.deepEqual(presets, list);
  }
});

test("tabs of a merged preset point at the kept one and keep opening as a Conversation", () => {
  const project = { name: "p", directory: "/w", tabs: [
    { id: "1", presetId: "claude-gui", name: "Claude GUI", sessionId: "s" },
    { id: "2", presetId: "claude", name: "Claude" },
    { id: "3", presetId: "claude-gui", name: "Switched", interfaceMode: "terminal" },
  ], splitTree: { k: 1 } };
  const next = remapProjectTabs(project, { "claude-gui": "claude" });
  assert.deepEqual(next.tabs, [
    { id: "1", presetId: "claude", name: "Claude GUI", sessionId: "s", interfaceMode: "gui" },
    { id: "2", presetId: "claude", name: "Claude" },
    { id: "3", presetId: "claude", name: "Switched", interfaceMode: "terminal" },
  ]);
  assert.deepEqual(next.splitTree, { k: 1 });
  assert.equal(remapProjectTabs(project, { other: "claude" }), null);
});

test("the startup migration rewrites presets and projects once, and a second run changes nothing", async () => {
  const dir = mkdtempSync(join(home, "migrate-"));
  const presetsFile = join(dir, "presets.json");
  const projects = join(dir, "projects");
  mkdirSync(projects);
  const extra = { id: "x", name: "Broken" }; // not a preset: kept as is
  writeFileSync(presetsFile, JSON.stringify({ presets: [claude, claudeGui, extra], other: 1 }));
  writeFileSync(join(projects, "a.json"), JSON.stringify({ name: "a", directory: "/w", tabs: [{ id: "1", presetId: "claude-gui", name: "G" }] }));
  writeFileSync(join(projects, "b.json"), JSON.stringify({ name: "b", directory: "/v", tabs: [{ id: "2", presetId: "claude", name: "T" }] }));
  writeFileSync(join(projects, "bad.json"), "{");
  const first = await migrateInterfaceTwinPresets(presetsFile, projects);
  assert.deepEqual(first.remap, { "claude-gui": "claude" });
  // The renderer asks for it (presets:merged) to move the removed preset's chime exception.
  assert.deepEqual(startupPresetMerges(), { "claude-gui": "claude" });
  assert.deepEqual(JSON.parse(readFileSync(presetsFile, "utf8")), { presets: [claude, extra], other: 1 });
  assert.deepEqual(JSON.parse(readFileSync(join(projects, "a.json"), "utf8")).tabs, [{ id: "1", presetId: "claude", name: "G", interfaceMode: "gui" }]);
  assert.equal(readFileSync(join(projects, "bad.json"), "utf8"), "{");
  const presetsAfter = readFileSync(presetsFile, "utf8");
  const projectAfter = readFileSync(join(projects, "a.json"), "utf8");
  const second = await migrateInterfaceTwinPresets(presetsFile, projects);
  assert.deepEqual(second.remap, {});
  assert.deepEqual(startupPresetMerges(), { "claude-gui": "claude" }, "a run that merges nothing keeps this start's merge");
  assert.equal(readFileSync(presetsFile, "utf8"), presetsAfter);
  assert.equal(readFileSync(join(projects, "a.json"), "utf8"), projectAfter);
  // No presets file (first launch): nothing to do, and the harness scan is left to listPresets.
  assert.deepEqual((await migrateInterfaceTwinPresets(join(dir, "missing.json"), projects)).remap, {});
});

test("a terminal pane's aya present artifacts join the Conversation it switches to, oldest first, without duplicates", () => {
  const snapshot = { cwd: "/w", view: { artifacts: [{ id: "a", kind: "metric", title: "Kept", value: "1", description: "" }] } };
  const terminal = [
    { id: "c", kind: "metric", title: "Newest", value: "3", description: "" },
    { id: "b", kind: "metric", title: "Older", value: "2", description: "" },
    { id: "a", kind: "metric", title: "Terminal copy", value: "0", description: "" },
  ];
  const merged = withTerminalArtifacts(snapshot, terminal);
  assert.deepEqual(merged.view.artifacts.map(a => a.id), ["a", "b", "c"]);
  assert.equal(merged.view.artifacts[0].title, "Kept");
  assert.equal(withTerminalArtifacts(snapshot, []), snapshot);
  assert.deepEqual(withTerminalArtifacts({ cwd: "/w" }, terminal.slice(0, 1)).view.artifacts.map(a => a.id), ["c"]);
});
