// Terminal ⇄ Conversation: the per-pane mode, the resume commands both ways, the transcript a switched Conversation
// opens with, and the migration that merges "Claude" + "Claude GUI" preset twins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aya-pane-mode-test-"));
process.env.AYA_HOME = home;
const { mergeInterfaceTwins, remapProjectTabs, migrateInterfaceTwinPresets } = await import("../dist-electron/preset-mode-migration.js");
const { claudeTranscriptMessages, codexRolloutMessages, adoptTerminalSession, findClaudeTranscript, findCodexRollout, withTerminalArtifacts } = await import("../dist-electron/gui-mode-switch.js");
const { claudeProjectDirName } = await import("../dist-electron/claude-session.js");
const { modeSwitchCommand, resumeSpawn } = await import("../dist-test/agentPreset.js");
const { paneMode, initialPaneMode, terminalSwitchRefusal, conversationSwitchRefusal } = await import("../dist-test/pane-mode.js");

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
  assert.match(terminalSwitchRefusal({ ...live, working: true }), /turn to finish/);
  assert.match(terminalSwitchRefusal({ ...live, status: "waiting" }), /prompt/);
  assert.match(terminalSwitchRefusal({ ...live, externalStatus: { level: "active", text: "", updatedAt: 0 } }), /turn/);
  assert.equal(terminalSwitchRefusal({ ...live, working: true, exitCode: 0 }), null, "an exited agent has nothing to wait for");
  assert.match(terminalSwitchRefusal({ ...live, remoteHost: "box" }), /remote/);
  assert.equal(conversationSwitchRefusal({ busy: false, requests: 0, switching: false, connecting: false }), null);
  assert.match(conversationSwitchRefusal({ busy: true, requests: 0, switching: false, connecting: false }), /turn/);
  assert.match(conversationSwitchRefusal({ busy: true, requests: 1, switching: false, connecting: false }), /approval/);
  assert.match(conversationSwitchRefusal({ busy: false, requests: 0, switching: false, connecting: true }), /connecting/);
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
  assert.deepEqual(JSON.parse(readFileSync(presetsFile, "utf8")), { presets: [claude, extra], other: 1 });
  assert.deepEqual(JSON.parse(readFileSync(join(projects, "a.json"), "utf8")).tabs, [{ id: "1", presetId: "claude", name: "G", interfaceMode: "gui" }]);
  assert.equal(readFileSync(join(projects, "bad.json"), "utf8"), "{");
  const presetsAfter = readFileSync(presetsFile, "utf8");
  const projectAfter = readFileSync(join(projects, "a.json"), "utf8");
  const second = await migrateInterfaceTwinPresets(presetsFile, projects);
  assert.deepEqual(second.remap, {});
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
