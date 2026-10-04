// Every (agent channel x preset opt-in x command shape x pane role) cell either carries the role note
// through the CLI's channel or reports a gap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { teamNote, briefText } = await import("../dist-electron/agent-brief.js");
const { withAgentBrief, roleNoteGap, roleNoteReport, removePaneBrief, sweepPaneBriefs, fileLaunchRecords, loginShellEnv, forgetLoginShellEnv, LOGIN_ENV_TIMEOUT, TOLD_DIGEST_HEX_CHARS } = await import("../dist-electron/pane-brief.js");

const ROLE = { team: "ux-review", role: "tester" };
const NOTE = /tester in the Aya team ux-review/;
const BRIEF = /aya capabilities/;
// Pinned, not imported: the CLIs whose team panes always take the brief (user decision 2026-10-03).
const TEAM_BRIEF_AGENTS = ["claude", "codex"];
const AGENTS = ["claude", "grok", "opencode", "codex", "cursor"];
const SHAPES = {
  simple: (bin) => bin,
  "env-prefixed": (bin) => `FOO=1 ${bin}`,
  "cd and": (bin) => `cd sub && ${bin}`,
  "path to binary": (bin) => `/opt/bin/${bin}`,
};

/** The digest of what was told has its own tests; the record checks ignore it. */
const noTold = ({ told, ...rest }) => rest;

const memoryRecords = () => {
  const all = new Map();
  return {
    all,
    get: async (id) => all.get(id),
    ids: async () => [...all.keys()],
    set: async (id, launch) => void all.set(id, launch),
    prune: async (live) => [...all.keys()].filter((id) => !live.has(id)).forEach((id) => all.delete(id)),
  };
};

const presetOf = (agent, command = agent, extra = {}) => ({ id: "p", name: "P", icon: "P", color: "", agent, command, ...extra });

function rig(preset, role) {
  const root = mkdtempSync(join(tmpdir(), "aya-rolenote-"));
  const deps = {
    ayaHome: join(root, "aya"),
    defaultCodexHome: join(root, "codex"),
    expand: (p) => p,
    shellEnv: async () => ({}),
    records: memoryRecords(),
    starts: async () => true,
    running: async () => false,
    listPresets: async () => [preset],
    paneRole: async () => role,
  };
  const spawn = (ptyId = "t1", command = preset.command, cwd = deps.ayaHome) => ({ ptyId, projectSlug: "g", presetId: "p", agent: preset.agent, command, cwd, cols: 80, rows: 24 });
  return {
    root,
    deps,
    spawn,
    start: (...args) => withAgentBrief(spawn(...args), deps),
    gap: (as = role, id = "t1") => roleNoteGap({ id, presetId: "p", name: "t" }, as, deps),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function withRig(preset, role, fn) {
  const r = rig(preset, role);
  try {
    return await fn(r);
  } finally {
    r.cleanup();
  }
}

/** Everything the pane's CLI is told: its command line, and the files named by env. */
function told(spawn, deps) {
  const dir = join(deps.ayaHome, "pane-briefs");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => readFileSync(join(dir, f), "utf8")) : [];
  return [spawn.command, ...files].join("\n");
}

const CHANNEL_TAKES_NOTE = { claude: true, grok: true, opencode: true, codex: true, cursor: false };
const printedCodexArg = (command) => spawnSync("/bin/sh", ["-c", command.replace(/^codex/, "printf '%s\\n'")], { encoding: "utf8" }).stdout.split("\n")[1].replace(/^developer_instructions=/, "");

for (const agent of AGENTS) {
  for (const optedIn of [true, false]) {
    for (const [shape, make] of Object.entries(SHAPES)) {
      for (const hasRole of [true, false]) {
        // With no role there is no role note to carry, whatever the command's shape: one shape stands for all.
        if (!hasRole && shape !== "simple") continue;
        test(`${agent}, brief ${optedIn ? "on" : "off"}, ${shape}, ${hasRole ? "role" : "no role"}`, () =>
          withRig(presetOf(agent, make(agent), optedIn ? { agentBrief: true } : {}), hasRole ? ROLE : null, async ({ deps, start, gap: gapOf }) => {
            const out = await start("t1", undefined, join(deps.ayaHome, "proj"));
            const gap = await gapOf(ROLE);
            if (!hasRole) {
              assert.doesNotMatch(told(out, deps), NOTE);
              return;
            }
            const deliverable = CHANNEL_TAKES_NOTE[agent] && shape !== "cd and";
            if (deliverable) {
              assert.match(told(out, deps), NOTE, "the role note is in the CLI's channel");
              assert.equal(gap, null);
            } else {
              assert.doesNotMatch(told(out, deps), NOTE);
              assert.match(gap ?? "", /^cannot tell this CLI its role: \S/, "a role that cannot be told must be reported");
            }
          }));
      }
    }
  }
}

test("codex: the role note is a -c developer_instructions TOML string, and the user's own is not replaced", () =>
  withRig(presetOf("codex"), ROLE, async ({ deps, start, gap }) => {
    assert.match((await start()).command, /^codex -c 'developer_instructions="You are running inside Aya[\s\S]*You are the tester/);
    mkdirSync(deps.defaultCodexHome, { recursive: true });
    writeFileSync(join(deps.defaultCodexHome, "config.toml"), 'developer_instructions = "mine"\n');
    assert.equal((await start()).command, "codex");
    assert.match(await gap(), /developer_instructions would be replaced/);
  }));

test("opencode: the pane's file holds the shared brief and the note; a brief-off preset still gets the note", async () => {
  for (const agentBrief of [true, false]) {
    await withRig(presetOf("opencode", "opencode", agentBrief ? { agentBrief } : {}), ROLE, async ({ start }) => {
      const config = (await start()).command.match(/^OPENCODE_CONFIG='([^']*)' opencode$/)[1];
      const text = readFileSync(JSON.parse(readFileSync(config, "utf8")).instructions[0], "utf8");
      assert.match(text, NOTE);
      assert.equal(/aya capabilities/.test(text), agentBrief);
    });
  }
});

test("codex with the brief on gets it in developer_instructions, before the note; no AGENTS.md is written", async () => {
  for (const role of [ROLE, null]) {
    await withRig(presetOf("codex", "codex", { agentBrief: true }), role, async ({ deps, start }) => {
      const out = await start("t1", undefined, join(deps.ayaHome, "proj"));
      assert.match(JSON.parse(printedCodexArg(out.command)), role ? /aya capabilities[\s\S]*tester in the Aya team/ : /^You are running inside Aya[\s\S]*aya capabilities/);
      assert.equal(existsSync(join(deps.defaultCodexHome, "AGENTS.md")), false);
      assert.deepEqual(noTold(await deps.records.get("t1")), { role, carried: true });
    });
  }
});

test("a setting of the user's own that the note would replace is left alone and reported", async () => {
  const cases = [
    ["codex", "codex -c 'developer_instructions=\"mine\"'", {}, /developer_instructions would be replaced/],
    ["opencode", "opencode", { OPENCODE_CONFIG: "/home/u/opencode.json", OPENCODE_CONFIG_CONTENT: "{}" }, /OPENCODE_CONFIG and OPENCODE_CONFIG_CONTENT are already set/],
    ["opencode", "opencode", null, /environment could not be read/],
    ["claude", "claude --append-system-prompt mine", {}, /already sets --append-system-prompt/],
  ];
  for (const [agent, command, env, reason] of cases) {
    await withRig(presetOf(agent, command), ROLE, async ({ deps, start, gap }) => {
      deps.shellEnv = async () => env;
      assert.equal((await start()).command, command, agent);
      assert.match(await gap(), reason, agent);
    });
  }
});

test("the shared brief comes before the role note in one argument", () =>
  withRig(presetOf("claude", "claude", { agentBrief: true }), ROLE, async ({ start }) => {
    assert.match((await start()).command, /aya capabilities[\s\S]*tester in the Aya team/);
  }));

test("a shell pane has no role-note gap: its hold already says it runs a shell", () =>
  withRig({ id: "p", name: "P", icon: "P", color: "", command: "$SHELL" }, ROLE, async ({ gap }) => {
    assert.equal(await gap(), null);
  }));

test("opencode: the user's own OPENCODE_CONFIG_CONTENT exported by their shell survives, and both instructions reach opencode", () =>
  withRig(presetOf("opencode"), ROLE, async ({ start }) => {
    const stub = (await start()).command.replace(/ opencode$/, ` /bin/sh -c 'printf "%s|%s" "$OPENCODE_CONFIG_CONTENT" "$OPENCODE_CONFIG"'`);
    const seen = spawnSync("/bin/sh", ["-c", `export OPENCODE_CONFIG_CONTENT='{"model":"mine"}'; ${stub}`], { encoding: "utf8" }).stdout;
    const [content, config] = seen.split("|");
    assert.equal(content, '{"model":"mine"}');
    assert.match(readFileSync(JSON.parse(readFileSync(config, "utf8")).instructions[0], "utf8"), NOTE);
  }));

test("pane-briefs: private files, one per full id, removed with the pane and swept at startup", () =>
  withRig(presetOf("opencode"), ROLE, async ({ deps, start }) => {
    for (const ptyId of ["a/b", "a_b", "keep"]) await start(ptyId);
    const dir = join(deps.ayaHome, "pane-briefs");
    assert.equal(readdirSync(dir).length, 6, "ids that differ only by / and _ do not share files");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
    await removePaneBrief(deps.ayaHome, "a/b");
    assert.equal(readdirSync(dir).length, 4);
    await sweepPaneBriefs(deps, [{ slug: "g", tabs: [{ id: "keep" }] }]);
    assert.equal(readdirSync(dir).length, 2, "only the live pane's files are left");
    assert.deepEqual([...deps.records.all.keys()], ["keep"]);
  }));

test("the codex brief and note are exactly the TOML basic string of the text", async () => {
  const role = { team: 'ux "review"', role: "t\\ster\nüñ" };
  await withRig(presetOf("codex"), role, async ({ start }) => {
    assert.equal(JSON.parse(printedCodexArg((await start()).command)), `${briefText(false)}\n\n${teamNote(role.team, role.role)}`);
  });
});

// The role a pane started with x the role it plays now, per agent and start.
for (const [agent, takesNote] of Object.entries(CHANNEL_TAKES_NOTE)) {
  for (const startedAs of [null, "tester", "implementer"]) {
    for (const now of ["tester", "implementer"]) {
      test(`ordering: ${agent} started as ${startedAs ?? "no role"}, plays ${now}`, () =>
        withRig(presetOf(agent), startedAs && { team: "ux-review", role: startedAs }, async ({ start, gap: gapOf }) => {
          await start();
          const gap = await gapOf({ team: "ux-review", role: now });
          if (!takesNote) assert.match(gap, /^cannot tell this CLI its role: /);
          else if (startedAs === now) assert.equal(gap, null);
          else if (startedAs === null) assert.match(gap, /^started before it had this role: (restart it|start a new session) to give it the role note/);
          else assert.match(gap, new RegExp(`^started with the role note of ${startedAs}: `));
        }));
    }
  }
}

test("ordering: a role taken away leaves the pane listed as still carrying its note", () =>
  withRig(presetOf("claude"), ROLE, async ({ deps, start }) => {
    deps.paneRole = async (spawn) => (spawn.ptyId === "p1" ? ROLE : null);
    for (const ptyId of ["p1", "p2"]) await start(ptyId);
    const project = { slug: "g", tabs: [{ id: "p1", presetId: "p", name: "shell 1" }, { id: "p2", presetId: "p", name: "shell 2" }] };
    assert.deepEqual((await roleNoteReport(project, "ux-review", { tester: "p1" }, deps)).staleNotes, []);
    const moved = await roleNoteReport(project, "ux-review", { tester: "p2" }, deps);
    assert.deepEqual(moved.staleNotes, ["shell 1 still carries the role note of tester: restart it to drop it"]);
    assert.match(moved.roleNotes.tester, /^started before it had this role/);
    assert.deepEqual((await roleNoteReport(project, "other-team", {}, deps)).staleNotes, []);
  }));

test("ordering: a resumed codex session keeps its first note, so a changed role stays flagged", () =>
  withRig(presetOf("codex"), ROLE, async ({ deps, start, gap }) => {
    const implementer = { team: "ux-review", role: "implementer" };
    await start("c1", "codex");
    deps.paneRole = async () => implementer;
    await start("c1", "codex resume abc");
    assert.match(await gap(implementer, "c1"), /^started with the role note of tester: start a new session to give it this one \(a resumed Codex session keeps its first note\)$/);
    await start("c1", "codex");
    assert.equal(await gap(implementer, "c1"), null, "a fresh codex start takes the new role");
  }));

test("fileLaunchRecords keeps what each pane was told across instances, and prunes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-records-"));
  try {
    const file = join(dir, "r.json");
    const one = fileLaunchRecords(file);
    await Promise.all([one.set("a", { role: ROLE, carried: true }), one.set("b", { role: null, carried: false })]);
    const two = fileLaunchRecords(file);
    assert.deepEqual(await two.get("a"), { role: ROLE, carried: true });
    await two.prune(new Set(["b"]));
    assert.equal(await one.get("a"), undefined);
    assert.deepEqual(await one.get("b"), { role: null, carried: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pane whose CLI took no note is not listed as carrying one after its role is taken away", () =>
  withRig(presetOf("cursor", "cursor-agent"), ROLE, async ({ deps, start }) => {
    await start("p1");
    const project = { slug: "g", tabs: [{ id: "p1", presetId: "p", name: "shell 1" }] };
    assert.deepEqual((await roleNoteReport(project, "ux-review", {}, deps)).staleNotes, []);
  }));

test("an older, world-readable per-pane file is tightened when the pane starts again", () =>
  withRig(presetOf("opencode"), ROLE, async ({ deps, start }) => {
    await start("p1");
    const dir = join(deps.ayaHome, "pane-briefs");
    for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o644);
    await start("p1");
    for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  }));

test("a spawn that only attaches to a live pane changes neither its record nor its files", async () => {
  for (const agent of ["claude", "opencode"]) {
    await withRig(presetOf(agent), ROLE, async ({ deps, spawn, start, gap }) => {
      await start("p1");
      const before = { record: await deps.records.get("p1"), files: told(spawn("p1"), deps) };
      const implementer = { team: "ux-review", role: "implementer" };
      deps.paneRole = async () => implementer;
      deps.starts = async () => false;
      const out = await withAgentBrief({ ...spawn("p1"), attachIfReused: true }, deps);
      assert.equal(out.command, agent, `${agent}: the command is left alone`);
      assert.deepEqual(await deps.records.get("p1"), before.record, `${agent}: record`);
      assert.equal(told(spawn("p1"), deps), before.files, `${agent}: files`);
      assert.match(await gap(implementer, "p1"), /^started with the role note of tester/);
    });
  }
});

const NEW_ROLE = { team: "ux-review", role: "implementer" };
const RECORDS = {
  none: undefined,
  carried: { role: ROLE, carried: true },
  "not carried": { role: null, carried: false },
};
const RESUME = { codex: "codex resume abc", claude: "claude --continue", grok: "grok --continue", opencode: "opencode --continue" };

for (const [agent, resumeCommand] of Object.entries(RESUME)) {
  for (const [state, before] of Object.entries(RECORDS)) {
    for (const resumed of [false, true]) {
      test(`record after ${resumed ? "a resume of" : "a start of"} ${agent} with ${state} record`, () =>
        withRig(presetOf(agent), NEW_ROLE, async ({ deps, start, gap: gapOf }) => {
          if (before) await deps.records.set("p1", before);
          await start("p1", resumed ? resumeCommand : agent);
          const record = await deps.records.get("p1");
          const gap = await gapOf(NEW_ROLE, "p1");
          if (agent === "codex" && resumed && !before) {
            assert.deepEqual(record, { role: null, carried: false, unknown: true });
            assert.match(gap, /^started before Aya recorded what it was told: start a new session/);
          } else if (agent === "codex" && resumed) {
            assert.deepEqual(record, before, "a resumed codex session keeps its first note");
          } else {
            assert.deepEqual(noTold(record), { role: NEW_ROLE, carried: true }, "the note went through the command line");
            assert.equal(gap, null);
          }
        }));
    }
  }
}

test("shared brief files are never seen empty or partial while spawns rewrite them", () =>
  withRig(presetOf("opencode", "opencode", { agentBrief: true }), null, async ({ deps, start }) => {
    await start("p0");
    const files = ["agent-brief.md", "agent-brief.json"].map((f) => join(deps.ayaHome, f));
    const whole = files.map((f) => readFileSync(f, "utf8"));
    let running = true;
    let bad = 0;
    let reads = 0;
    const reader = (async () => {
      while (running) {
        files.forEach((f, i) => (reads++, readFileSync(f, "utf8") !== whole[i] && bad++));
        await new Promise((r) => setImmediate(r));
      }
    })();
    for (let round = 0; round < 60; round++) await Promise.all(Array.from({ length: 8 }, (_, i) => start(`p${i}`)));
    running = false;
    await reader;
    assert.ok(reads > 100, `the reader ran (${reads})`);
    assert.equal(bad, 0, `${bad} of ${reads} reads were empty or partial`);
  }));

test("a resumed codex pane that could never be told its role says that, not just that its start is unknown", () =>
  withRig(presetOf("codex", "cd sub && codex resume abc"), NEW_ROLE, async ({ deps, start, gap }) => {
    await start("p1");
    assert.deepEqual(await deps.records.get("p1"), { role: null, carried: false, unknown: true });
    assert.match(await gap(NEW_ROLE, "p1"), /^cannot tell this CLI its role/);
  }));

// A bare `resume` word makes a codex start a resume, not one inside a quoted prompt; the program may be any wrapper.
const CODEX_COMMANDS = {
  'codex "please resume the refactor"': false,
  "codex 'resume'": false,
  "codex resume abc": true,
  "codex resume --last": true,
  "FOO=1 codex resume abc": true,
  "cd sub && codex resume abc": true,
  "codex --search resume abc": true,
  "'/opt/wrap/node' /opt/wrap/codex.js resume --last": true,
  "npx codex \"fix the resume flow\" --model x": false,
};
for (const [command, resumes] of Object.entries(CODEX_COMMANDS)) {
  test(`codex \`${command}\` is ${resumes ? "" : "not "}a resume`, () =>
    withRig(presetOf("codex", command), NEW_ROLE, async ({ deps, start }) => {
      await deps.records.set("p1", RECORDS.carried);
      await start("p1");
      const record = await deps.records.get("p1");
      if (resumes) assert.deepEqual(record, RECORDS.carried, "a resumed session keeps its first note");
      else assert.deepEqual(noTold(record), { role: NEW_ROLE, carried: true }, "a new session was told the new note");
    }));
}

// A pty host outlives the app, so a running pane may predate the launch records.
const UNKNOWN = /^started before Aya recorded what it was told: (restart it|start a new session) to give it the role note/;
const GAP_CELLS = {
  none: { record: undefined, live: UNKNOWN, idle: null },
  carried: { record: { role: NEW_ROLE, carried: true }, live: null, idle: null },
  "not carried": { record: { role: null, carried: false }, live: /^started before it had this role/, idle: /^started before it had this role/ },
  unknown: { record: { role: null, carried: false, unknown: true }, live: UNKNOWN, idle: UNKNOWN },
};
for (const agent of ["claude", "grok", "opencode", "codex"]) {
  for (const [state, cell] of Object.entries(GAP_CELLS)) {
    for (const running of [true, false]) {
      test(`gap: ${agent}, ${state} record, pane ${running ? "running" : "never started"}`, () =>
        withRig(presetOf(agent), NEW_ROLE, async ({ deps, gap: gapOf }) => {
          if (cell.record) await deps.records.set("p1", cell.record);
          deps.running = async (id) => id === "p1" && running;
          const gap = await gapOf(NEW_ROLE, "p1");
          const want = running ? cell.live : cell.idle;
          if (want === null) assert.equal(gap, null);
          else assert.match(gap, want);
        }));
    }
  }
}

test("startup sweep keeps the records and files of panes the host still holds, whatever the project list says", () =>
  withRig(presetOf("opencode"), ROLE, async ({ deps, start }) => {
    deps.records = fileLaunchRecords(join(deps.ayaHome, "records.json"));
    for (const ptyId of ["live", "gone"]) await start(ptyId);
    deps.running = async (id) => id === "live";
    await sweepPaneBriefs(deps, []);
    assert.ok(await deps.records.get("live"), "the running pane keeps its record");
    assert.equal(await deps.records.get("gone"), undefined);
    assert.equal(readdirSync(join(deps.ayaHome, "pane-briefs")).length, 2, "and its files");
  }));

test("an unreadable records file is neither pruned nor silently overwritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-records-"));
  try {
    const file = join(dir, "r.json");
    writeFileSync(file, "{not json");
    const records = fileLaunchRecords(file);
    await records.prune(new Set());
    assert.equal(readFileSync(file, "utf8"), "{not json", "prune leaves what it cannot read");
    await records.set("a", { role: ROLE, carried: true });
    assert.deepEqual(await records.get("a"), { role: ROLE, carried: true });
    assert.equal(readFileSync(`${file}.corrupt`, "utf8"), "{not json", "the unreadable file is kept aside");
    for (const shape of ["[]", "null", "3"]) {
      writeFileSync(file, shape);
      const other = fileLaunchRecords(file);
      await other.set("b", { role: null, carried: false });
      assert.deepEqual(await other.get("b"), { role: null, carried: false }, `${shape} is not a records file`);
      assert.equal(readFileSync(`${file}.corrupt`, "utf8"), shape);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode: a login shell too slow to answer costs the note, visibly; a later spawn gets it when the shell answers", async () => {
  const saved = { SHELL: process.env.SHELL, ms: LOGIN_ENV_TIMEOUT.ms };
  try {
    await withRig(presetOf("opencode"), ROLE, async ({ root, deps, start, gap }) => {
      const shell = join(root, "sh");
      const script = (body) => (writeFileSync(shell, `#!/bin/sh\n${body}\nexec /bin/sh -c "$3"\n`), chmodSync(shell, 0o755));
      process.env.SHELL = shell;
      LOGIN_ENV_TIMEOUT.ms = 1500;
      forgetLoginShellEnv();
      deps.shellEnv = loginShellEnv;
      script("sleep 6");
      assert.equal((await start("a")).command, "opencode", "no answer within the wait: no note");
      assert.deepEqual(await deps.records.get("a"), { role: ROLE, carried: false });
      assert.match(await gap(ROLE, "a"), /^cannot tell this CLI its role: your shell's environment could not be read/);
      script("sleep 0.3");
      assert.match((await start("b")).command, /^OPENCODE_CONFIG='[^']*' opencode$/, "a slow shell that answers in time: note");
      assert.deepEqual(noTold(await deps.records.get("b")), { role: ROLE, carried: true });
      assert.equal(await gap(ROLE, "b"), null);
    });
  } finally {
    LOGIN_ENV_TIMEOUT.ms = saved.ms;
    if (saved.SHELL === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved.SHELL;
    forgetLoginShellEnv();
  }
});

// Measured with opencode 1.18.30: OPENCODE_CONFIG_CONTENT is another layer, merged with the user's OPENCODE_CONFIG file.
const opencode = spawnSync("opencode", ["--version"], { encoding: "utf8" });
for (const withRole of [true, false]) {
  test(`opencode: a user's own OPENCODE_CONFIG keeps its settings and gets the ${withRole ? "role note" : "shared brief"} through OPENCODE_CONFIG_CONTENT`, { skip: opencode.status !== 0 && "opencode is not installed" }, () =>
    withRig(presetOf("opencode", "opencode", { agentBrief: true }), withRole ? ROLE : null, async ({ root, deps, start, gap }) => {
      const mine = join(root, "mine.json");
      writeFileSync(mine, JSON.stringify({ instructions: ["/mine/rules.md"], model: "mine/model" }));
      deps.shellEnv = async () => ({ OPENCODE_CONFIG: mine });
      const out = await start();
      assert.deepEqual(noTold(await deps.records.get("t1")), { role: withRole ? ROLE : null, carried: true });
      if (withRole) assert.equal(await gap(ROLE), null);
      const home = join(root, "home");
      mkdirSync(home);
      const shown = spawnSync("/bin/sh", ["-c", out.command.replace(/ opencode$/, " opencode debug config")], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, OPENCODE_CONFIG: mine },
      });
      const config = JSON.parse(shown.stdout.slice(shown.stdout.indexOf("{")));
      assert.equal(config.model, "mine/model", shown.stderr);
      assert.equal(config.instructions[0], "/mine/rules.md");
      assert.match(readFileSync(config.instructions[1], "utf8"), withRole ? NOTE : /aya capabilities/);
    }));
}

test("a running pane with no record whose CLI could never be told says that, not unknown", async () => {
  for (const [agent, command] of [["cursor", "cursor"], ["claude", "cd sub && claude"]]) {
    await withRig(presetOf(agent, command), NEW_ROLE, async ({ deps, gap }) => {
      deps.running = async () => true;
      assert.match(await gap(NEW_ROLE, "p1"), /^cannot tell this CLI its role/, command);
    });
  }
});

test("opencode: an inline OPENCODE_CONFIG_CONTENT in the command is the user's own, never replaced", () =>
  withRig(presetOf("opencode"), NEW_ROLE, async ({ deps, start }) => {
    deps.shellEnv = async () => ({ OPENCODE_CONFIG: "/home/u/o.json" });
    const own = "OPENCODE_CONFIG_CONTENT='{}' opencode";
    assert.equal((await start("t1", own)).command, own);
  }));

// A pane keeps what it was told at its start, so the window must say when the brief or the note Aya would
// give it now is not what it carries. A claude or codex role pane always takes the brief, so a preset toggle
// changes nothing it would be told now.
for (const agent of ["claude", "grok", "opencode", "codex"]) {
  const restart = agent === "codex" ? "start a new session" : "restart it";
  for (const [change, mutate, flagged] of [
    ["nothing changed", () => {}, false],
    ["brief turned on after the start", (p) => void (p.agentBrief = true), !TEAM_BRIEF_AGENTS.includes(agent)],
    ["brief turned off after the start", (p) => void delete p.agentBrief, !TEAM_BRIEF_AGENTS.includes(agent)],
  ]) {
    for (const startedOn of [true, false]) {
      if (change === "brief turned on after the start" && startedOn) continue;
      if (change === "brief turned off after the start" && !startedOn) continue;
      test(`stale brief: ${agent}, started brief ${startedOn ? "on" : "off"}, ${change}`, async () => {
        const preset = presetOf(agent, agent, startedOn ? { agentBrief: true } : {});
        await withRig(preset, ROLE, async ({ start, gap: gapOf }) => {
          await start();
          mutate(preset);
          const gap = await gapOf();
          if (!flagged) return assert.equal(gap, null);
          assert.match(gap ?? "", new RegExp(`^started with an older brief: ${restart} to give it the current one$`));
        });
      });
    }
  }
  test(`stale note: ${agent}, a record without a text cannot be judged, a new start takes the current text`, () =>
    withRig(presetOf(agent, agent, { agentBrief: true }), ROLE, async ({ deps, start, gap }) => {
      await deps.records.set("t1", { role: ROLE, carried: true });
      assert.equal(await gap(), null, "an old record cannot be judged");
      await start();
      assert.equal(await gap(), null, "a new start takes the current brief");
    }));
}

// What is recorded is the digest of the very text the CLI got, the role note included, so an Aya update that
// only rewords the note flags every pane started before it.
const toldDigest = (text) => createHash("sha256").update(text).digest("hex").slice(0, TOLD_DIGEST_HEX_CHARS);
const RECEIVED = {
  claude: (command) => spawnSync("/bin/sh", ["-c", command.replace(/^claude --append-system-prompt/, "printf '%s'")], { encoding: "utf8" }).stdout,
  codex: (command) => JSON.parse(spawnSync("/bin/sh", ["-c", command.replace(/^codex -c/, "printf '%s'")], { encoding: "utf8" }).stdout.replace(/^developer_instructions=/, "")),
};
for (const [agent, received] of Object.entries(RECEIVED)) {
  for (const agentBrief of [true, false]) {
    test(`stale note: ${agent}, brief ${agentBrief ? "on" : "off"}: the record is the digest of the text the CLI got, note included; another wording is flagged`, () =>
      withRig(presetOf(agent, agent, agentBrief ? { agentBrief } : {}), ROLE, async ({ deps, start, gap }) => {
        const text = received((await start()).command);
        assert.match(text, /tester in the Aya team ux-review/);
        assert.equal((await deps.records.get("t1")).told, toldDigest(text));
        const older = text.replace("Run `aya team whoami` now", "Run `aya team whoami`");
        assert.notEqual(older, text);
        await deps.records.set("t1", { role: ROLE, carried: true, told: toldDigest(older) });
        const restart = agent === "codex" ? "start a new session" : "restart it";
        assert.equal(await gap(), `started with an older brief: ${restart} to give it the current one`);
      }));
  }
}

test("restart: the digest of what a pane was told survives in the records file, so a changed brief is flagged after Aya restarts", async () => {
  await withRig(presetOf("claude"), ROLE, async ({ deps, start, gap }) => {
    const file = join(deps.ayaHome, "records.json");
    deps.records = fileLaunchRecords(file);
    await start();
    deps.records = fileLaunchRecords(file);
    assert.equal(await gap(), null);
    const launch = await deps.records.get("t1");
    await deps.records.set("t1", { ...launch, told: "0".repeat(TOLD_DIGEST_HEX_CHARS) });
    deps.records = fileLaunchRecords(file);
    assert.match((await gap()) ?? "", /^started with an older brief:/);
  });
});

// The on-disk formats of earlier Ayas, spelled out: another length orphans their files or flags their records.
test("on disk: a record an earlier Aya wrote (12 hex chars of what was told) is still current", () =>
  withRig(presetOf("claude"), ROLE, async ({ deps, start, gap }) => {
    const text = RECEIVED.claude((await start()).command);
    await deps.records.set("t1", { role: ROLE, carried: true, told: createHash("sha256").update(text).digest("hex").slice(0, 12) });
    assert.equal(await gap(), null);
  }));

test("on disk: a pane's brief files an earlier Aya wrote (24 hex chars of the id) are removed with the pane", () =>
  withRig(presetOf("opencode"), ROLE, async ({ deps }) => {
    const dir = join(deps.ayaHome, "pane-briefs");
    mkdirSync(dir, { recursive: true });
    const base = join(dir, createHash("sha256").update("old").digest("hex").slice(0, 24));
    for (const ext of [".md", ".json"]) writeFileSync(base + ext, "x");
    await removePaneBrief(deps.ayaHome, "old");
    assert.deepEqual(readdirSync(dir), []);
  }));

test("a pane brief that cannot be written leaves the command alone and records no note", async () => {
  const preset = { id: "p", name: "P", icon: "P", color: "", agent: "opencode", command: "opencode" };
  const { root, deps, cleanup } = rig(preset, ROLE);
  try {
    writeFileSync(deps.ayaHome, "a file where the folder should be");
    const out = await withAgentBrief({ ptyId: "w1", projectSlug: "g", presetId: "p", agent: "opencode", command: "opencode", cwd: root, cols: 80, rows: 24 }, deps);
    assert.equal(out.command, "opencode");
    assert.equal((await deps.records.get("w1")).carried, false);
  } finally {
    cleanup();
  }
});

test("a CLI with no channel is not told the brief, and that is not reported as a skip", async () => {
  const preset = { id: "p", name: "P", icon: "P", color: "", agent: "cursor", command: "cursor-agent", agentBrief: true };
  const { root, deps, cleanup } = rig(preset, null);
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    const out = await withAgentBrief({ ptyId: "c1", projectSlug: "g", presetId: "p", agent: "cursor", command: "cursor-agent", cwd: root, cols: 80, rows: 24 }, deps);
    assert.equal(out.command, "cursor-agent");
    assert.deepEqual(warned, []);
  } finally {
    console.warn = warn;
    cleanup();
  }
});

// User decision 2026-10-03: the brief stays opt-in for ordinary panes, but a claude or codex pane playing a team
// role always gets it, whatever the preset says and without changing the preset. The other CLIs keep their
// behaviour: one row each (Antigravity has no per-pane channel, so neither brief nor note, and its gap says so).
/** The text a CLI was handed: opencode's instructions file, else the command line itself. */
function handed(out) {
  const config = out.command.match(/OPENCODE_CONFIG='([^']*)'/)?.[1];
  if (!config) return out.command;
  return readFileSync(JSON.parse(readFileSync(config, "utf8")).instructions[0], "utf8");
}
const BIN = { claude: "claude", codex: "codex", grok: "grok", opencode: "opencode", antigravity: "agy" };
const PANES = ["plain pane", "team role pane", "role pane after restart"];
const TEAM_BRIEF_CELLS = [
  ...TEAM_BRIEF_AGENTS.flatMap((agent) =>
    ["unset", "true"].flatMap((presetBrief) =>
      PANES.map((pane) => ({ agent, presetBrief, pane, brief: presetBrief === "true" || pane !== "plain pane", note: pane !== "plain pane" })),
    ),
  ),
  { agent: "grok", presetBrief: "unset", pane: "team role pane", brief: false, note: true },
  { agent: "opencode", presetBrief: "unset", pane: "team role pane", brief: false, note: true },
  { agent: "antigravity", presetBrief: "unset", pane: "team role pane", brief: false, note: false },
];
for (const { agent, presetBrief, pane, brief, note } of TEAM_BRIEF_CELLS) {
  test(`team brief: ${agent}, preset brief ${presetBrief}, ${pane}`, async () => {
    const preset = presetOf(agent, BIN[agent], presetBrief === "true" ? { agentBrief: true } : {});
    const saved = structuredClone(preset);
    const role = pane === "plain pane" ? null : ROLE;
    await withRig(preset, role, async ({ start, gap }) => {
      let out = await start();
      if (pane === "role pane after restart") out = await start();
      const text = handed(out);
      assert.equal(BRIEF.test(text), brief, `brief ${brief ? "missing" : "unexpected"} in: ${text}`);
      assert.equal(NOTE.test(text), note);
      assert.deepEqual(preset, saved, "the preset itself is never changed");
      if (!role) return;
      if (note) assert.equal(await gap(), null, "what the pane got is what Aya would give it now");
      else assert.match((await gap()) ?? "", /^cannot tell this CLI its role: \S/);
    });
  });
}
