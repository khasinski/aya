// The aya brief (#117): per-harness channel, the launch argument, and the
// marked section in codex's AGENTS.md - idempotent, and never touching the
// rest of the user's file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  BRIEF_BEGIN,
  BRIEF_END,
  briefChannel,
  briefText,
  codexAgentsFile,
  commandWithBriefArg,
  commandWithBriefEnv,
  pathWithFallbackDir,
  planCodexBriefs,
  withBriefSection,
  withoutBriefSection,
} from "../dist-electron/agent-brief.js";
import { AGENT_KINDS } from "../dist-electron/presets.js";
import { agentBriefHint } from "../dist-test/agentPreset.js";

test("channels: claude/grok by argument, opencode by env, codex by file, rest none", () => {
  assert.deepEqual(briefChannel("claude"), { kind: "arg", flag: "--append-system-prompt" });
  assert.deepEqual(briefChannel("grok"), { kind: "arg", flag: "--rules" });
  assert.deepEqual(briefChannel("opencode"), { kind: "env", name: "OPENCODE_CONFIG_CONTENT" });
  assert.deepEqual(briefChannel("codex"), { kind: "file", file: "codex-agents-md" });
  assert.deepEqual(briefChannel("pi"), { kind: "none" });
  assert.deepEqual(briefChannel(undefined), { kind: "none" });
});

test("grok: the brief goes in as --rules, one argument", () => {
  assert.equal(
    commandWithBriefArg("grok --continue", briefChannel("grok"), "b"),
    "grok --continue --rules 'b'",
  );
  assert.equal(commandWithBriefArg("grok --rules 'mine'", briefChannel("grok"), "b"), null);
});

const ENV = briefChannel("opencode");
const BRIEF_FILE = "/Users/dev/.aya/it's here/agent-brief.md";

test("opencode: the variable reaches the process as JSON naming Aya's brief file", () => {
  const command = commandWithBriefEnv("opencode", ENV, BRIEF_FILE, undefined);
  // Swap the program for one that prints the variable, keep the prefix as built.
  const probe = command.replace(/ opencode$/, ` /bin/sh -c 'printf %s "$OPENCODE_CONFIG_CONTENT"'`);
  const seen = spawnSync("/bin/sh", ["-c", probe], { encoding: "utf8" }).stdout;
  assert.deepEqual(JSON.parse(seen), { instructions: [BRIEF_FILE] });
});

test("opencode: no env where it would clobber the user's own inline config", () => {
  assert.equal(commandWithBriefEnv("opencode", ENV, BRIEF_FILE, '{"model":"x"}'), null);
  assert.equal(
    commandWithBriefEnv(`OPENCODE_CONFIG_CONTENT='{}' opencode`, ENV, BRIEF_FILE, undefined),
    null,
  );
  assert.equal(commandWithBriefEnv("opencode; echo hi", ENV, BRIEF_FILE, undefined), null);
});

test("the Settings toggle shows for exactly the harnesses with a channel", () => {
  for (const agent of [...AGENT_KINDS, undefined]) {
    assert.equal(
      agentBriefHint(agent) !== null,
      briefChannel(agent).kind !== "none",
      String(agent),
    );
  }
});

test("the brief points at aya capabilities; the file form is conditional", () => {
  assert.match(briefText(false), /aya capabilities/);
  assert.doesNotMatch(briefText(false), /AYA_TERMINAL_ID/);
  // A global file is read outside Aya too.
  assert.match(briefText(true), /^If the AYA_TERMINAL_ID environment variable is set/);
  assert.ok(briefText(false).split("\n").length <= 5);
});

const ARG = briefChannel("claude");

test("the argument survives the shell as ONE argument, quotes and backticks included", () => {
  const command = commandWithBriefArg("claude --continue", ARG, briefText(false));
  const argv = spawnSync("/bin/sh", ["-c", `printf '%s\\0' ${command.replace(/^claude /, "")}`], {
    encoding: "utf8",
  }).stdout.split("\0").filter(Boolean);
  assert.deepEqual(argv, ["--continue", "--append-system-prompt", briefText(false)]);
});

test("no argument where it could land on the wrong command or duplicate a flag", () => {
  for (const command of [
    "claude; echo done",
    "claude && say hi",
    "claude | tee log",
    "claude `x`",
    "claude $(x)",
    "claude --append-system-prompt 'mine'",
    "claude --append-system-prompt='mine'",
    "   ",
  ]) {
    assert.equal(commandWithBriefArg(command, ARG, "b"), null, command);
  }
  assert.equal(
    commandWithBriefArg('CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude', ARG, "b"),
    `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude --append-system-prompt 'b'`,
  );
});

const USER = "# My rules\n\nAlways run the tests.\n";

test("section: added at the end, the user's text untouched, idempotent", () => {
  const once = withBriefSection(USER, "brief v1");
  assert.ok(once.startsWith(USER));
  assert.ok(once.includes(`${BRIEF_BEGIN}\nbrief v1\n${BRIEF_END}\n`));
  assert.equal(withBriefSection(once, "brief v1"), once);
});

test("section: an updated brief replaces the old one instead of stacking", () => {
  const updated = withBriefSection(withBriefSection(USER, "brief v1"), "brief v2");
  assert.equal(updated.split(BRIEF_BEGIN).length, 2);
  assert.ok(updated.includes("brief v2"));
  assert.ok(!updated.includes("brief v1"));
});

test("section: removal restores the user's file byte for byte", () => {
  assert.equal(withoutBriefSection(withBriefSection(USER, "b")), USER);
  assert.equal(withoutBriefSection(USER), USER);
  // A file that held only our section becomes empty (main.ts deletes it).
  assert.equal(withoutBriefSection(withBriefSection("", "b")), "");
});

test("section: user text written AFTER our section survives removal", () => {
  const edited = `${withBriefSection(USER, "b")}\n## Added later\n`;
  const removed = withoutBriefSection(edited);
  assert.ok(removed.includes("# My rules"));
  assert.ok(removed.includes("## Added later"));
  assert.ok(!removed.includes(BRIEF_BEGIN));
});

const expand = (p) => p.replace(/^~/, "/Users/dev");

test("codex file: configDir, else inline CODEX_HOME, else the default home", () => {
  assert.equal(
    codexAgentsFile({ configDir: "~/.codex-work", command: "codex" }, "/Users/dev/.codex", expand),
    "/Users/dev/.codex-work/AGENTS.md",
  );
  assert.equal(
    codexAgentsFile({ command: 'CODEX_HOME="$HOME/.codex-b" codex' }, "/Users/dev/.codex", expand),
    "/Users/dev/.codex-b/AGENTS.md",
  );
  assert.equal(
    codexAgentsFile({ command: "codex" }, "/Users/dev/.codex", expand),
    "/Users/dev/.codex/AGENTS.md",
  );
});

test("a shared codex home keeps the section while any preset opts in", () => {
  assert.deepEqual(
    planCodexBriefs([
      { file: "/h/a/AGENTS.md", agentBrief: true },
      { file: "/h/a/AGENTS.md", agentBrief: false },
      { file: "/h/b/AGENTS.md", agentBrief: false },
    ]),
    { ensure: ["/h/a/AGENTS.md"], remove: ["/h/b/AGENTS.md"] },
  );
});

test("the bundled CLI is appended to PATH, never ahead of an installed shim", () => {
  assert.equal(pathWithFallbackDir("/a:/b", "/app/bin"), "/a:/b:/app/bin");
  assert.equal(pathWithFallbackDir("/app/bin:/a", "/app/bin"), "/app/bin:/a");
  assert.equal(pathWithFallbackDir(undefined, "/app/bin"), "/app/bin");
});
