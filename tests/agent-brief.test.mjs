// The aya brief (#117): the codex AGENTS.md section must be idempotent and
// never touch the rest of the user's file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  BRIEF_BEGIN,
  BRIEF_END,
  antigravityBriefFile,
  briefChannel,
  briefText,
  teamNote,
  codexAgentsFile,
  codexHomeFor,
  commandWithBriefArg,
  commandWithBriefEnv,
  ownedBriefContent,
  planCodexBriefs,
  withBriefSection,
  withoutBriefSection,
  withOwnedBrief,
  withoutOwnedBrief,
} from "../dist-electron/agent-brief.js";
import { AGENT_KINDS, isPreset, normalizePreset } from "../dist-electron/presets.js";
import { agentBriefHint } from "../dist-test/agentPreset.js";

test("channels: claude/grok by argument, opencode by env, codex by file, rest none", () => {
  assert.deepEqual(briefChannel("claude"), { kind: "arg", flag: "--append-system-prompt" });
  assert.deepEqual(briefChannel("grok"), { kind: "arg", flag: "--rules" });
  assert.deepEqual(briefChannel("opencode"), { kind: "env", name: "OPENCODE_CONFIG_CONTENT" });
  assert.deepEqual(briefChannel("codex"), { kind: "file" });
  assert.deepEqual(briefChannel("antigravity"), { kind: "ownedFile" });
  assert.deepEqual(briefChannel("pi"), { kind: "none" });
  assert.deepEqual(briefChannel(undefined), { kind: "none" });
});

test("grok: the brief goes in as --rules, one argument", () => {
  assert.equal(
    commandWithBriefArg("grok --continue", briefChannel("grok"), "b"),
    "grok --continue --rules 'b'",
  );
  assert.equal(commandWithBriefArg("grok --rules 'mine'", briefChannel("grok"), "b"), null);
  assert.equal(commandWithBriefArg("grok", briefChannel("grok"), "it's"), "grok --rules 'it'\\''s'");
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
  assert.ok(briefText(false).split("\n").length <= 6);
});

test("every agent learns from one brief line how to define, give panes to and start a team", () => {
  for (const conditional of [false, true]) {
    const lines = briefText(conditional).split("\n").filter((l) => /aya team (new|open|start)/.test(l));
    assert.deepEqual(lines, ['Teams: `aya team new "<what for>"` defines one, `aya team open` gives its roles panes, `aya team start <team> "<task>"` starts it; open and start only on the user\'s word.'], `conditional ${conditional}`);
  }
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
  assert.equal(
    codexAgentsFile({ configDir: "~/.codex", command: "codex" }, envHome, expand),
    `${envHome}/AGENTS.md`,
  );
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
  assert.equal(codexAgentsFile(inline, envHome, expand, "/project"), "/project/.codex/AGENTS.md");
  assert.equal(codexAgentsFile(inline, envHome, expand), undefined);
});

test("codex home: a relative .codex is not the stock home even when Aya runs from ~", () => {
  const expandFromHome = (p) => (/^[~/$]/.test(p) ? expand(p) : `/Users/dev/${p}`);
  assert.equal(
    codexHomeFor({ configDir: ".codex", command: "codex" }, "/env/codex-home", expandFromHome, "/project"),
    "/project/.codex",
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

test("files Aya wrote to that no codex preset wants any more are orphans", async () => {
  const { orphanedBriefFiles } = await import("../dist-electron/agent-brief.js");
  const plan = { ensure: ["/h/a/AGENTS.md"], remove: ["/h/b/AGENTS.md"] };
  assert.deepEqual(
    orphanedBriefFiles(["/h/a/AGENTS.md", "/h/b/AGENTS.md", "/h/gone/AGENTS.md", "/h/gone/AGENTS.md"], plan),
    ["/h/gone/AGENTS.md"],
  );
  assert.deepEqual(orphanedBriefFiles([], plan), []);
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
  assert.equal(agentBriefHint("codex"), "Adds a marked section to this account's AGENTS.md (removed when off).");
  assert.equal(agentBriefHint("grok"), "Adds a short note via --rules when the pane starts.");
  assert.equal(
    agentBriefHint("opencode"),
    "Adds a short note to opencode's instructions for Aya panes only (OPENCODE_CONFIG_CONTENT).",
  );
  assert.equal(
    agentBriefHint("antigravity"),
    "Adds one always-on Antigravity rule, shared by all agy presets (deleted when none opts in).",
  );
  assert.equal(agentBriefHint(undefined), null);
  assert.equal(agentBriefHint("toString"), null);
});

test("settings sync leaves a relative home's launch-written brief alone while it opts in", async () => {
  const { codexBriefSync } = await import("../dist-electron/agent-brief.js");
  const envHome = "/env/codex-home";
  const recorded = ["/project/.codex/AGENTS.md", "/other/sub/.codex/AGENTS.md", "/h/gone/AGENTS.md"];
  const rel = (agentBrief) => ({ command: "CODEX_HOME=.codex codex", agentBrief });
  assert.deepEqual(codexBriefSync([rel(true)], recorded, envHome, expand), {
    ensure: [],
    remove: ["/h/gone/AGENTS.md"],
  });
  assert.deepEqual(codexBriefSync([rel(false)], recorded, envHome, expand), {
    ensure: [],
    remove: [...recorded].sort(),
  });
  assert.deepEqual(
    codexBriefSync([{ configDir: "./sub/.codex", command: "codex", agentBrief: true }], recorded, envHome, expand),
    { ensure: [], remove: ["/h/gone/AGENTS.md", "/project/.codex/AGENTS.md"] },
  );
  assert.deepEqual(
    codexBriefSync([{ configDir: "../h/gone", command: "codex", agentBrief: true }], recorded, envHome, expand).remove,
    ["/other/sub/.codex/AGENTS.md", "/project/.codex/AGENTS.md"],
  );
  // "." has no tail to tell its files by; a launch never writes there (codexBriefInProject).
  assert.deepEqual(
    codexBriefSync([{ configDir: ".", command: "codex", agentBrief: true }], recorded, envHome, expand).remove,
    [...recorded].sort(),
  );
  assert.deepEqual(
    codexBriefSync([{ configDir: "~/.a", command: "codex", agentBrief: true }, { command: "codex" }], [], envHome, expand),
    { ensure: ["/Users/dev/.a/AGENTS.md"], remove: [`${envHome}/AGENTS.md`] },
  );
});

test("settings sync keeps a shared file an absolute preset turned off while a relative one opts in", async () => {
  const { codexBriefSync } = await import("../dist-electron/agent-brief.js");
  const file = "/Users/dev/work/.codex/AGENTS.md";
  const presets = [
    { configDir: "/Users/dev/work/.codex", command: "codex", agentBrief: false },
    { configDir: ".codex", command: "codex", agentBrief: true },
  ];
  assert.deepEqual(codexBriefSync(presets, [file], "/env/codex-home", expand), { ensure: [], remove: [] });
  assert.deepEqual(codexBriefSync([presets[0]], [file], "/env/codex-home", expand), { ensure: [], remove: [file] });
});

test("an opted-out home's brief is removed even while a relative .codex preset opts in", async () => {
  const { codexBriefSync } = await import("../dist-electron/agent-brief.js");
  const presets = [
    { command: "codex", agentBrief: false },
    { configDir: ".codex", command: "codex", agentBrief: true },
  ];
  // ~/.codex/AGENTS.md ends in .codex too, but no launch of the relative preset wrote it.
  assert.deepEqual(codexBriefSync(presets, [], "/Users/dev/.codex", expand).remove, ["/Users/dev/.codex/AGENTS.md"]);
});

test("a relative CODEX_HOME that is the project itself gets no brief written into it", async () => {
  const { codexBriefInProject } = await import("../dist-electron/agent-brief.js");
  assert.equal(codexBriefInProject("/p/repo/AGENTS.md", "/p/repo"), true);
  assert.equal(codexBriefInProject("/p/AGENTS.md", "/p/repo/sub"), true);
  assert.equal(codexBriefInProject("/p/repo/.codex/AGENTS.md", "/p/repo"), false);
  assert.equal(codexBriefInProject("/Users/dev/.codex/AGENTS.md", "/p/repo"), false);
});
