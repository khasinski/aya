// The aya brief: the marked section must be idempotent and
// never touch the rest of the user's file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  BRIEF_BEGIN,
  BRIEF_END,
  antigravityBriefFile,
  roleChannel,
  briefText,
  teamNote,
  codexHomeFor,
  commandWithBriefArg,
  commandWithEnvVar,
  ownedBriefContent,
  withBriefSection,
  withoutBriefSection,
  withOwnedBrief,
  withoutOwnedBrief,
} from "../dist-electron/agent-brief.js";
import { AGENT_KINDS, isPreset, normalizePreset } from "../dist-electron/presets.js";
import { agentBriefHint } from "../dist-test/agentPreset.js";

test("channels: claude/grok by argument, opencode by env, codex by config, antigravity by its own file, rest none", () => {
  assert.deepEqual(roleChannel("claude"), { kind: "arg", flag: "--append-system-prompt" });
  assert.deepEqual(roleChannel("grok"), { kind: "arg", flag: "--rules" });
  assert.deepEqual(roleChannel("opencode"), { kind: "env", name: "OPENCODE_CONFIG", inline: "OPENCODE_CONFIG_CONTENT" });
  assert.deepEqual(roleChannel("codex"), { kind: "config" });
  assert.deepEqual(roleChannel("antigravity"), { kind: "none", reason: "antigravity takes no per-session instruction" });
  assert.deepEqual(roleChannel("pi"), { kind: "none", reason: "pi takes no per-session instruction" });
  assert.deepEqual(roleChannel(undefined), { kind: "none", reason: "an unrecognized CLI takes no per-session instruction" });
});

test("grok: the brief goes in as --rules, one argument", () => {
  assert.equal(
    commandWithBriefArg("grok --continue", roleChannel("grok"), "b"),
    "grok --continue --rules 'b'",
  );
  assert.equal(commandWithBriefArg("grok --rules 'mine'", roleChannel("grok"), "b"), null);
  assert.equal(commandWithBriefArg("grok", roleChannel("grok"), "it's"), "grok --rules 'it'\\''s'");
});

test("a preset ending in a # comment or a backslash is not simple: an appended flag would be swallowed", () => {
  const grok = roleChannel("grok");
  for (const command of ["grok # mine", "grok --continue  #note", "grok \\", "grok --x a\\\\\\"]) {
    assert.equal(commandWithBriefArg(command, grok, "b"), null, command);
  }
  // Not comments and not continuations: a # inside a word, an escaped # and an escaped backslash.
  assert.equal(commandWithBriefArg("grok a#b", grok, "b"), "grok a#b --rules 'b'");
  assert.equal(commandWithBriefArg("grok \\#x", grok, "b"), "grok \\#x --rules 'b'");
  assert.equal(commandWithBriefArg("grok a\\\\", grok, "b"), "grok a\\\\ --rules 'b'");
});

const ENV = roleChannel("opencode");
const BRIEF_FILE = "/Users/dev/.aya/it's here/agent-brief.json";

test("opencode: the variable reaches the process as the path of Aya's config file", () => {
  const command = commandWithEnvVar("opencode", ENV.name, BRIEF_FILE, undefined);
  // Swap the program for one that prints the variable, keep the prefix as built.
  const probe = command.replace(/ opencode$/, ` /bin/sh -c 'printf %s "$OPENCODE_CONFIG"'`);
  const seen = spawnSync("/bin/sh", ["-c", probe], { encoding: "utf8" }).stdout;
  assert.equal(seen, BRIEF_FILE);
});

test("opencode: no env where it would clobber the user's own config file", () => {
  assert.equal(commandWithEnvVar("opencode", ENV.name, BRIEF_FILE, "/home/u/opencode.json"), null);
  assert.equal(
    commandWithEnvVar(`OPENCODE_CONFIG='/x.json' opencode`, ENV.name, BRIEF_FILE, undefined),
    null,
  );
  assert.equal(commandWithEnvVar("opencode; echo hi", ENV.name, BRIEF_FILE, undefined), null);
});

test("the Settings toggle shows for exactly the harnesses with a channel", () => {
  for (const agent of [...AGENT_KINDS, undefined]) {
    assert.equal(
      agentBriefHint(agent) !== null,
      roleChannel(agent).kind !== "none" || agent === "antigravity",
      String(agent),
    );
  }
});

test("the brief points at aya capabilities; the file form is conditional", () => {
  assert.match(briefText(false), /aya capabilities/);
  assert.doesNotMatch(briefText(false), /AYA_TERMINAL_ID/);
  // A global file is read outside Aya too.
  assert.match(briefText(true), /^If the AYA_TERMINAL_ID environment variable is set/);
  assert.ok(briefText(false).split("\n").length <= 6);
});

test("every agent learns from one brief line how to define, give panes to and start a team", () => {
  for (const conditional of [false, true]) {
    const lines = briefText(conditional).split("\n").filter((l) => /aya team (new|open|start)/.test(l));
    assert.deepEqual(lines, ['Teams: `aya team new "<what for>"` defines one, `aya team open` gives its roles panes, `aya team start <team> "<task>"` starts it; open and start only on the user\'s word, never to give a role work (that is `aya team send`).'], `conditional ${conditional}`);
  }
});

const ARG = roleChannel("claude");

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
  assert.equal(withoutBriefSection("a\n\n\nb"), "a\n\n\nb");
  // A file that held only our section becomes empty (main.ts deletes it).
  assert.equal(withoutBriefSection(withBriefSection("", "b")), "");
});

test("section: user text written AFTER our section survives removal", () => {
  const edited = `${withBriefSection(USER, "b")}\n## Added later\n`;
  assert.equal(withoutBriefSection(edited), `${USER}\n## Added later\n`);
});

test("section: removal leaves the user's own blank lines elsewhere alone", () => {
  const spaced = "# A\n\n\n\n# B\n";
  assert.equal(withoutBriefSection(withBriefSection(spaced, "b")), spaced);
  const first = `${withBriefSection("", "b")}\n# Mine\n\n\n\nend`;
  assert.equal(withoutBriefSection(first), "# Mine\n\n\n\nend");
  assert.equal(withoutBriefSection(`\n\nlead\n\n${withBriefSection("", "b")}`), "\n\nlead\n");
});

test("agentBrief survives the preset roundtrip; a non-boolean is rejected", () => {
  const base = { id: "c", name: "C", icon: "C", color: "", agent: "codex", command: "codex" };
  assert.equal(normalizePreset({ ...base, agentBrief: true }).agentBrief, true);
  assert.equal(isPreset({ ...base, agentBrief: "yes" }), false);
});

const expand = (p) => p.replace(/^(~|\$HOME)(?=\/|$)/, "/Users/dev");

test("codex home: the stock ~/.codex configDir defers to the command, then CODEX_HOME", () => {
  const envHome = "/env/codex-home";
  assert.equal(codexHomeFor({ configDir: "~/.codex", command: "codex" }, envHome, expand), envHome);
  assert.equal(codexHomeFor({ configDir: "$HOME/.codex", command: "codex" }, envHome, expand), envHome);
  assert.equal(codexHomeFor({ configDir: "  ", command: "codex" }, envHome, expand), envHome);
  assert.equal(codexHomeFor({}, envHome, expand), envHome);
  assert.equal(
    codexHomeFor({ configDir: "~/.codex", command: 'CODEX_HOME="$HOME/.codex" codex' }, envHome, expand),
    "/Users/dev/.codex",
  );
  assert.equal(
    codexHomeFor({ configDir: "~/.codex-work", command: 'CODEX_HOME="$HOME/.codex-b" codex' }, envHome, expand),
    "/Users/dev/.codex-work",
  );
  assert.equal(codexHomeFor({ configDir: "~/.codex-work" }, envHome, expand), "/Users/dev/.codex-work");
});

test("codex home: a relative dir resolves against the tab cwd, never Aya's", () => {
  const envHome = "/env/codex-home";
  const inline = { command: "CODEX_HOME=.codex codex" };
  assert.equal(codexHomeFor(inline, envHome, expand, "/project"), "/project/.codex");
  assert.equal(codexHomeFor(inline, envHome, expand), undefined);
  assert.equal(codexHomeFor({ configDir: "../h", command: "codex" }, envHome, expand, "/project/a"), "/project/h");
  assert.equal(codexHomeFor({ configDir: ".codex", command: "codex" }, envHome, expand), undefined);
  assert.equal(codexHomeFor({ configDir: "/abs/h", command: "codex" }, envHome, expand), "/abs/h");
  assert.equal(codexHomeFor({ configDir: "~/.codex-w", command: "codex" }, envHome, expand, "/project"), "/Users/dev/.codex-w");
  assert.equal(codexHomeFor({ configDir: "/Users/dev/.codex", command: "codex" }, envHome, expand), envHome);
  assert.equal(codexHomeFor({ command: "codex" }, envHome, expand, "/project"), envHome);
});

test("codex home: a relative .codex is not the stock home even when Aya runs from ~", () => {
  const expandFromHome = (p) => (/^[~/$]/.test(p) ? expand(p) : `/Users/dev/${p}`);
  assert.equal(
    codexHomeFor({ configDir: ".codex", command: "codex" }, "/env/codex-home", expandFromHome, "/project"),
    "/project/.codex",
  );
});

// agy 1.2.11 only loaded config/rules/ files whose frontmatter opens the file.
test("antigravity: Aya's own always-on rule file, frontmatter first", () => {
  assert.equal(antigravityBriefFile("/Users/dev"), "/Users/dev/.gemini/config/rules/aya-brief.md");
  const content = ownedBriefContent("b");
  assert.ok(content.startsWith("---\ntrigger: always_on\n---\n"));
  assert.ok(content.includes("\nb\n"));
});

test("antigravity off: our file is deleted, a user's file of that name is kept", () => {
  assert.equal(withoutOwnedBrief(ownedBriefContent("b")), "");
  const mine = "---\ntrigger: always_on\n---\nmy own rule\n";
  assert.equal(withoutOwnedBrief(mine), mine);
});

test("antigravity off: text a user added to our file survives, our section goes", () => {
  const edited = `${ownedBriefContent("b")}my own rule\n`;
  const after = withoutOwnedBrief(edited);
  assert.ok(after.includes("my own rule"));
  assert.ok(!after.includes("aya:brief"));
});

test("antigravity on: a user's own aya-brief.md is never overwritten", () => {
  const mine = "---\ntrigger: always_on\n---\nmy own rule\n";
  assert.equal(withOwnedBrief(mine, "b"), mine);
  assert.equal(withOwnedBrief("", "b"), ownedBriefContent("b"));
  const refreshed = withOwnedBrief(`${ownedBriefContent("old")}my note\n`, "new");
  assert.ok(refreshed.startsWith("---\ntrigger: always_on\n---\n"));
  assert.ok(refreshed.includes("my note") && refreshed.includes("new") && !refreshed.includes("old"));
});

// --- #122 review regressions ------------------------------------------------

test("a deleted end marker leaves AGENTS.md untouched instead of eating user text", async () => {
  const { withBriefSection, withoutBriefSection, briefMarkersIntact, BRIEF_BEGIN, BRIEF_END } =
    await import("../dist-electron/agent-brief.js");
  // The user deleted our end marker, then kept writing.
  const damaged = `# mine\n\n${BRIEF_BEGIN}\nold brief\n\n## user notes added later\nkeep me\n`;
  assert.equal(briefMarkersIntact(damaged), false);
  assert.equal(withBriefSection(damaged, "new brief"), damaged, "ensure must not touch it");
  assert.equal(withoutBriefSection(damaged), damaged, "remove must not touch it");
  // A second begin before any end (the old repro) is damaged too.
  const doubled = `${BRIEF_BEGIN}\na\n${BRIEF_BEGIN}\nb\n${BRIEF_END}\nkeep me\n`;
  assert.equal(briefMarkersIntact(doubled), false);
  assert.ok(withoutBriefSection(doubled).includes("keep me"));
  // Intact files still work.
  const ok = withBriefSection("# mine\n", "brief");
  assert.equal(briefMarkersIntact(ok), true);
  assert.equal(withoutBriefSection(ok).trim(), "# mine");
});

test("the brief tells every agent how to find its team role", () => {
  assert.match(briefText(false), /aya team whoami/);
});

test("a team pane's note names its role and treats peer messages as reports", () => {
  const note = teamNote("ux-review", "tester");
  assert.match(note, /^You are the tester in the Aya team ux-review\./);
  assert.match(note, /aya team whoami/);
  assert.match(note, /\/clear/);
  assert.match(note, /\[team[\s\S]*not the user's instructions/);
});

test("the Settings toggle's hint text per harness", () => {
  assert.equal(agentBriefHint("claude"), "Adds a short note via --append-system-prompt when the pane starts.");
  assert.equal(agentBriefHint("codex"), "Adds a short note via -c developer_instructions when the pane starts; not when your Codex config or the command already sets developer_instructions, which Aya never replaces.");
  assert.equal(agentBriefHint("grok"), "Adds a short note via --rules when the pane starts.");
  assert.equal(
    agentBriefHint("opencode"),
    "Adds a short note to opencode's instructions for Aya panes only (OPENCODE_CONFIG).",
  );
  assert.equal(
    agentBriefHint("antigravity"),
    "Adds one always-on Antigravity rule, shared by all agy presets (deleted when none opts in).",
  );
  assert.equal(agentBriefHint(undefined), null);
  assert.equal(agentBriefHint("toString"), null);
});
