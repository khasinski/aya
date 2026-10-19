// A restart Aya makes on purpose stops what a CLI runs in the background (finding 16: "1 monitor couldn't be moved and
// was stopped"): it asks first when a pane's screen shows such work, and tells the resumed team agent afterwards.
// It also cuts off an agent's turn and a shell's running command (#217): asked about too, with nothing to tell after.

import { literal } from "./helpers/regex.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { renderPaneText } = await import("../dist-electron/pane-render.js");
const { backgroundWorkShown, confirmPaneRestart, confirmRestart, deliverRelaunchNotes, RELAUNCH_NOTE, RELAUNCH_NOTE_TTL_MS } = await import("../dist-electron/relaunch-notes.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");

/** A recorded screen as main reads it for the check (paneReadText). */
async function recorded(name) {
  const dir = new URL("./fixtures/own-screens/", import.meta.url);
  const meta = JSON.parse(readFileSync(new URL(`${name}.meta.json`, dir), "utf8"));
  return renderPaneText(readFileSync(new URL(`${name}.raw`, dir), "utf8"), meta.cols, meta.rows);
}

// The recorded Claude 2.1.x idle screen, its footer given the task pill Claude Code 2.1.289 draws (bundle function RAe);
// no screen with a running monitor is recorded.
const CLAUDE_IDLE = await recorded("claude-idle");
const CLAUDE_FOOTER = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
assert.ok(CLAUDE_IDLE.endsWith(CLAUDE_FOOTER), "the recording still ends in the footer these screens edit");
const claudeWith = (pill) => CLAUDE_IDLE.replace(CLAUDE_FOOTER, `  ⏵⏵ bypass permissions on (shift+tab to cycle) · ${pill} · ← for agents`);
const CLAUDE_PROSE = CLAUDE_IDLE.replace("────", "⏺ I started 1 monitor and 2 shells for run4.\n────");
const CLAUDE_DIALOG = "⏺ Running the suite.\n⏺ 1 monitor is watching run4\n╭───╮\n│ Do you want to proceed? │\n│ ❯ 1. Yes │\n╰───╯";
// codex-cli 0.160.0's bottom pane line, built from its binary's strings; the recorded 0.158 busy screen around it.
const CODEX_BUSY = readFileSync(new URL("./fixtures/busy-codex.screen.txt", import.meta.url), "utf8").trimEnd();
const CODEX_TERMINAL = CODEX_BUSY.replace("› \x1b[2mAsk", "  1 background terminal running · /ps to view · /stop to close\n› \x1b[2mAsk");

// [screen, claude, codex, opencode]: what each CLI's rule reads off the same screen.
const SCREENS = [
  ["Claude's idle composer, nothing in the background", CLAUDE_IDLE, null, null, null],
  ["Claude's footer with one monitor", claudeWith("1 monitor"), "1 monitor", null, null],
  ["Claude's footer with shells and a monitor", claudeWith("2 shells, 1 monitor"), "2 shells, 1 monitor", null, null],
  ["Claude's footer with mixed kinds", claudeWith("3 background tasks"), "3 background tasks", null, null],
  ["Claude's footer with a local agent", claudeWith("1 local agent"), "1 local agent", null, null],
  ["the agent's own prose about monitors above the composer", CLAUDE_PROSE, null, null, null],
  ["a dialog up, no composer drawn: the transcript's words are not the footer", CLAUDE_DIALOG, null, null, null],
  ["Codex's bottom pane with a background terminal", CODEX_TERMINAL, null, "1 background terminal", null],
  ["Codex busy, no background terminal", CODEX_BUSY, null, null, null],
];

describe("what a screen shows running in the background", () => {
  for (const [name, screen, ...expected] of SCREENS) {
    for (const [i, agent] of ["claude", "codex", "opencode"].entries()) {
      test(`${name} (${agent})`, () => assert.equal(backgroundWorkShown(screen, agent), expected[i]));
    }
  }
});

const TEAM = `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester
Must not: skip a report
`;

const NOW = Date.parse("2026-10-03T21:20:00Z");

/** pane-t plays tester (Claude), pane-x plays no role (Claude); pane-c plays implementer (Codex); pane-s is a shell.
 *  `busy` and `foreground` stand for the host's mid-turn answer and the shell's foreground command, by pane. */
function setup({ screens = {}, holds = {}, commands = {}, busy = {}, foreground = {} } = {}) {
  const tabs = [{ id: "pane-t", name: "tester pane" }, { id: "pane-c", name: "impl pane" }, { id: "pane-x", name: "loose" }, { id: "pane-s", name: "dev shell" }];
  const t = teamProject("aya-relaunch-", { teamFile: TEAM, tabs });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  const pids = { "pane-t": 100, "pane-c": 200, "pane-x": 300, "pane-s": 400 };
  const agents = { "pane-t": "claude", "pane-c": "codex", "pane-x": "claude", "pane-s": "custom" };
  const typed = [];
  const asked = [];
  const clock = { now: NOW };
  const relaunch = {
    file: join(t.root, "aya", "relaunch-notes.json"),
    panes: async (ids) => t.project.tabs.filter((tab) => !ids || ids.includes(tab.id)),
    agentOf: async (id) => agents[id],
    screen: async (id) => screens[id] ?? null,
    pid: async (id) => pids[id],
    command: async (id) => commands[id] ?? null,
    busy: async (id) => (asked.push(["busy", id]), busy[id] ?? false),
    foreground: async (id) => (asked.push(["foreground", id]), foreground[id] ?? null),
    now: () => clock.now,
  };
  const team = {
    teamHome: t.teamHome,
    listProjects: async () => [t.project],
    deliver: async (pane, text, _c, entered) => {
      typed.push({ pane, text });
      await entered?.();
    },
    holdReason: async (pane) => holds[pane] ?? null,
    headCommit: async () => null,
  };
  return { ...t, store, pids, typed, asked, clock, relaunch, team, holds };
}

const notes = (t) => {
  try {
    return JSON.parse(readFileSync(t.relaunch.file, "utf8"));
  } catch {
    return {};
  }
};

// [case, screens shown, user's answer, asked?, restart goes ahead?, panes noted]
const CONFIRMS = [
  ["no pane shows background work: no question, the restart goes", {}, false, false, true, []],
  ["a monitor shown, the user restarts", { "pane-t": claudeWith("1 monitor") }, true, true, true, ["pane-t"]],
  ["a monitor shown, the user keeps the pane", { "pane-t": claudeWith("1 monitor") }, false, true, false, []],
  ["a Codex background terminal shown, the user restarts", { "pane-c": CODEX_TERMINAL }, true, true, true, ["pane-c"]],
  ["only prose about a monitor: no question", { "pane-t": CLAUDE_PROSE }, false, false, true, []],
];

describe("asking before a restart", () => {
  for (const [name, screens, answer, asked, goes, noted] of CONFIRMS) {
    test(name, async () => {
      const t = setup({ screens });
      try {
        const questions = [];
        const ok = await confirmRestart(t.relaunch, "Restarting the PTY host", async (text) => (questions.push(text), answer));
        assert.equal(questions.length > 0, asked);
        assert.equal(ok, goes);
        assert.deepEqual(Object.keys(notes(t)).sort(), noted);
        if (asked) assert.match(questions[0], /^Restarting the PTY host stops what these panes are doing \((tester pane: 1 monitor|impl pane: 1 background terminal)\)\. An agent cannot carry its background tasks/);
      } finally {
        t.cleanup();
      }
    });
  }

  test("a pane restart asks only about that pane", async () => {
    const t = setup({ screens: { "pane-t": claudeWith("1 monitor"), "pane-x": claudeWith("1 shell") } });
    try {
      const questions = [];
      assert.equal(await confirmRestart(t.relaunch, "Restarting loose", async (q) => (questions.push(q), true), ["pane-x"]), true);
      assert.match(questions[0], /\(loose: 1 shell\)/);
      assert.deepEqual(Object.keys(notes(t)), ["pane-x"]);
    } finally {
      t.cleanup();
    }
  });
});

const CLAUDE_RESUMED = "claude --dangerously-skip-permissions --continue";
const CODEX_RESUMED = "codex -s danger-full-access -a never resume --last";

// [case, pane, relaunched process (pid change), its command, hold, paused, expected typed into it, note kept after]
const DELIVERIES = [
  ["the old process still runs: nothing yet", "pane-t", false, CLAUDE_RESUMED, null, false, false, true],
  ["relaunched with --continue and free: told once", "pane-t", true, CLAUDE_RESUMED, null, false, true, false],
  ["relaunched without a resume: a new conversation, dropped", "pane-t", true, "claude --dangerously-skip-permissions --session-id 5f0c", null, false, false, false],
  ["relaunched, still starting: held for the next pass", "pane-t", true, CLAUDE_RESUMED, "is still starting up", false, false, true],
  ["relaunched, the team paused: held", "pane-t", true, CLAUDE_RESUMED, null, true, false, true],
  ["a pane outside any team: no inbox to hold it, dropped", "pane-x", true, CLAUDE_RESUMED, null, false, false, false],
  ["Codex relaunched with resume --last: told once", "pane-c", true, CODEX_RESUMED, null, false, true, false],
];

describe("telling the resumed agent", () => {
  for (const [name, pane, relaunched, command, hold, paused, told, kept] of DELIVERIES) {
    test(name, async () => {
      const t = setup({ screens: { "pane-t": claudeWith("1 monitor"), "pane-c": CODEX_TERMINAL, "pane-x": claudeWith("1 monitor") }, holds: { [pane]: hold }, commands: { [pane]: command } });
      try {
        await t.store.assign("tester", "pane-t");
        await t.store.assign("implementer", "pane-c");
        if (paused) await t.store.setPaused(true);
        assert.equal(await confirmRestart(t.relaunch, "Restarting", async () => true, [pane]), true);
        if (relaunched) t.pids[pane] += 1;
        const typed = await deliverRelaunchNotes(t.team, t.relaunch);
        assert.equal(typed, told ? 1 : 0);
        assert.deepEqual(t.typed.map((x) => x.pane), told ? [pane] : []);
        if (told) {
          assert.match(t.typed[0].text, new RegExp(`^\\[team ux-review \\| from aya \\| \\d\\d:\\d\\d\\] ${literal(RELAUNCH_NOTE)}$`));
          assert.ok((await t.store.log()).some((m) => m.from === "aya" && m.text === RELAUNCH_NOTE), "logged as Aya's message");
        }
        assert.equal(pane in notes(t), kept);
        // A second pass never types it again.
        await deliverRelaunchNotes(t.team, t.relaunch);
        assert.equal(t.typed.length, told ? 1 : 0);
      } finally {
        t.cleanup();
      }
    });
  }

  test("a held note goes once the pane is free, and a stale one is dropped", async () => {
    const t = setup({ screens: { "pane-t": claudeWith("1 monitor"), "pane-x": claudeWith("1 shell") }, holds: { "pane-t": "is still starting up" }, commands: { "pane-t": CLAUDE_RESUMED } });
    try {
      await t.store.assign("tester", "pane-t");
      await confirmRestart(t.relaunch, "Restarting", async () => true);
      t.pids["pane-t"] += 1;
      assert.equal(await deliverRelaunchNotes(t.team, t.relaunch), 0);
      t.holds["pane-t"] = null;
      assert.equal(await deliverRelaunchNotes(t.team, t.relaunch), 1);
      // pane-x never came back: after the TTL its note goes untyped.
      assert.ok("pane-x" in notes(t));
      t.clock.now += RELAUNCH_NOTE_TTL_MS + 1;
      assert.equal(await deliverRelaunchNotes(t.team, t.relaunch), 0);
      assert.deepEqual(notes(t), {});
    } finally {
      t.cleanup();
    }
  });
});

const SHELL_PROMPT = "~/game $ npm run dev\n\n  VITE v7.1.2  ready in 312 ms\n";
const BACKGROUND_SENTENCE = "An agent cannot carry its background tasks into the new process; Aya tells a team agent resumed afterwards to start again the ones it still needs.";

// [case, screens, busy, foreground, the question (null: none), panes noted, of them quiet (nothing to tell)]
const WORK = [
  ["Claude mid-turn: asked, noted quietly", { "pane-t": CLAUDE_IDLE }, { "pane-t": true }, {}, "Restarting the PTY host stops what these panes are doing (tester pane: mid-turn). An agent mid-turn stops before its turn ends.", ["pane-t"], ["pane-t"]],
  ["a shell running a command: asked, noted quietly", { "pane-s": SHELL_PROMPT }, {}, { "pane-s": "npm run dev" }, "Restarting the PTY host stops what these panes are doing (dev shell: running npm run dev). A command running in a shell stops.", ["pane-s"], ["pane-s"]],
  ["mid-turn with a monitor: one entry, and the note is told", { "pane-t": claudeWith("1 monitor") }, { "pane-t": true }, {}, `Restarting the PTY host stops what these panes are doing (tester pane: mid-turn, 1 monitor). An agent mid-turn stops before its turn ends. ${BACKGROUND_SENTENCE}`, ["pane-t"], []],
  ["all three kinds in three panes, in the panes' order", { "pane-t": CLAUDE_IDLE, "pane-x": claudeWith("1 shell"), "pane-s": SHELL_PROMPT }, { "pane-t": true }, { "pane-s": "make watch" }, `Restarting the PTY host stops what these panes are doing (tester pane: mid-turn; loose: 1 shell; dev shell: running make watch). An agent mid-turn stops before its turn ends. A command running in a shell stops. ${BACKGROUND_SENTENCE}`, ["pane-s", "pane-t", "pane-x"], ["pane-s", "pane-t"]],
  ["an idle agent and a shell at its prompt: no question", { "pane-t": CLAUDE_IDLE, "pane-s": "~/game $ " }, {}, {}, null, [], []],
  ["a pane that is not running is not asked about, busy or not", {}, { "pane-t": true }, { "pane-s": "npm run dev" }, null, [], []],
];

describe("asking before a restart cuts off a turn or a command", () => {
  for (const [name, screens, busy, foreground, question, noted, quiet] of WORK) {
    test(name, async () => {
      const t = setup({ screens, busy, foreground });
      try {
        const questions = [];
        assert.equal(await confirmRestart(t.relaunch, "Restarting the PTY host", async (q) => (questions.push(q), true)), true);
        assert.deepEqual(questions, question ? [question] : []);
        const kept = notes(t);
        assert.deepEqual(Object.keys(kept).sort(), noted);
        assert.deepEqual(Object.keys(kept).filter((id) => kept[id].quiet).sort(), quiet);
        for (const id of noted) assert.equal(kept[id].pid, t.pids[id]);
        // The question names the command; the note on disk does not.
        if (kept["pane-s"]) assert.equal(kept["pane-s"].work, "running a command");
      } finally {
        t.cleanup();
      }
    });
  }

  test("the host is asked whether an agent is mid-turn, ps what a shell runs: never the other way round", async () => {
    const t = setup({ screens: { "pane-t": CLAUDE_IDLE, "pane-c": CODEX_BUSY, "pane-s": "~/game $ " } });
    try {
      assert.equal(await confirmRestart(t.relaunch, "Restarting", async () => assert.fail("nothing to ask about")), true);
      assert.deepEqual(t.asked, [["busy", "pane-t"], ["busy", "pane-c"], ["foreground", "pane-s"]]);
    } finally {
      t.cleanup();
    }
  });

  test("a pane whose agent is not known (no preset) is read as a shell", async () => {
    const t = setup({ screens: { "pane-s": "~/game $ " }, foreground: { "pane-s": "npm run dev" } });
    t.relaunch.agentOf = async () => undefined;
    try {
      const questions = [];
      await confirmRestart(t.relaunch, "Restarting", async (q) => (questions.push(q), true));
      assert.match(questions[0], /\(dev shell: running npm run dev\)/);
      assert.deepEqual(t.asked, [["foreground", "pane-s"]]);
    } finally {
      t.cleanup();
    }
  });

  test("a failed answer counts as no turn and no command", async () => {
    const t = setup({ screens: { "pane-t": CLAUDE_IDLE, "pane-s": "~/game $ " } });
    t.relaunch.busy = async () => Promise.reject(new Error("host gone"));
    t.relaunch.foreground = async () => Promise.reject(new Error("ps failed"));
    try {
      assert.equal(await confirmRestart(t.relaunch, "Restarting", async () => assert.fail("nothing to ask about")), true);
    } finally {
      t.cleanup();
    }
  });

  test("Cancel keeps no note", async () => {
    const t = setup({ screens: { "pane-t": CLAUDE_IDLE }, busy: { "pane-t": true } });
    try {
      assert.equal(await confirmRestart(t.relaunch, "Restarting", async () => false), false);
      assert.deepEqual(notes(t), {});
    } finally {
      t.cleanup();
    }
  });

  test("a quiet note waits for the new process, then goes untyped, even in a team pane resumed and free", async () => {
    const t = setup({ screens: { "pane-t": CLAUDE_IDLE }, busy: { "pane-t": true }, commands: { "pane-t": CLAUDE_RESUMED } });
    try {
      await t.store.assign("tester", "pane-t");
      await confirmRestart(t.relaunch, "Restarting", async () => true);
      assert.equal(await deliverRelaunchNotes(t.team, t.relaunch), 0);
      assert.ok("pane-t" in notes(t), "kept while the old process runs");
      t.pids["pane-t"] += 1;
      assert.equal(await deliverRelaunchNotes(t.team, t.relaunch), 0);
      assert.deepEqual(t.typed, []);
      assert.deepEqual(notes(t), {});
    } finally {
      t.cleanup();
    }
  });
});

describe("restarting one pane when its work cannot be checked", () => {
  test("the check answers: its answer stands, nothing else is asked", async () => {
    const asked = [];
    for (const answer of [true, false]) {
      assert.equal(await confirmPaneRestart(async () => answer, async (q) => (asked.push(q), true), "shell 1"), answer);
    }
    assert.deepEqual(asked, []);
  });

  for (const answer of [true, false]) {
    test(`the check fails: the user is asked plainly, with the reason, and ${answer ? "Restart" : "Cancel"} decides`, async () => {
      const asked = [];
      const ok = await confirmPaneRestart(async () => Promise.reject(new Error("host gone")), async (q) => (asked.push(q), answer), "shell 1");
      assert.equal(ok, answer);
      assert.deepEqual(asked, ["Aya could not check what shell 1 is doing (host gone). Restarting it stops anything it runs: a turn, a command or background tasks."]);
    });
  }
});
