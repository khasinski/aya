// aya presets / aya team open and the Teams window's Apply panes: one main path
// that checks every role and target first, then gives each role its pane.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envWithoutAya } from "./helpers/env.mjs";
import { teamProject } from "./helpers/team.mjs";

const {
  openTeamPanes,
  presetChoices,
  formatPresets,
  formatOpened,
  handleTeamPanesRequest,
  presetAgent,
  RendererRequests,
  teamPaneDeps,
} = await import("../dist-electron/team-panes.js");
const { presetInstalled } = await import("../dist-electron/command-probe.js");
const { startControlServerOn } = await import("../dist-electron/control.js");
const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { HOLD_NOT_RUNNING, HOLD_STARTING } = await import("../dist-electron/pane-holds.js");

const TEAM = `# ux-review

## Role: reviewer
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (what changed)
Must not: skip a report

## Role: tester
Sends to: implementer (failing tests)
Must not: change the code to pass a test
`;

const PRESETS = [
  { id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" },
  { id: "claude", name: "Claude Code", icon: "*", color: "", command: "claude" },
  { id: "codex", name: "Codex", icon: "o", color: "", command: "codex" },
  { id: "grok", name: "Grok", icon: "g", color: "", command: "grok" },
  { id: "missing", name: "Missing", icon: "m", color: "", command: "missing-cli" },
];

// pane-c is where the agent runs aya team open; pane-dead's agent has exited.
const TABS = [
  { id: "pane-c", name: "Claude Code", presetId: "claude" },
  { id: "pane-x", name: "Codex", presetId: "codex" },
  { id: "pane-dead", name: "old tester", presetId: "claude" },
  { id: "pane-w1", name: "worker", presetId: "shell" },
  { id: "pane-w2", name: "worker", presetId: "shell" },
];

const ALIVE = ["pane-c", "pane-x", "pane-w1", "pane-w2"];

/** A pane with no running agent is held as the terminal host holds it. */
const hostHolds = (pane) => (ALIVE.includes(pane) || pane.startsWith("new-") ? null : HOLD_NOT_RUNNING);

function setup({ saved = true, state = null, assignments = {}, alive = ALIVE, holds = hostHolds, remote = false } = {}) {
  const t = teamProject("aya-team-panes-", { teamFile: TEAM, saved, tabs: TABS });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  mkdirSync(store.dir, { recursive: true });
  if (state) writeFileSync(join(store.dir, "state.json"), JSON.stringify(state));
  writeFileSync(join(store.dir, "assignments.json"), JSON.stringify(assignments));
  let project = remote ? { ...t.project, remote: { host: "box" } } : t.project;
  const opened = [];
  const typed = [];
  let next = 0;
  const control = {
    teamHome: t.teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void typed.push({ pane, text }),
    headCommit: async () => null,
    holdReason: async (pane) => holds(pane),
  };
  const host = {
    listPresets: async () => PRESETS,
    presetInstalled: async (p) => p.id !== "missing",
    paneAlive: async (pane) => alive.includes(pane) || pane.startsWith("new-"),
    openPanes: async (slug, panes) => {
      opened.push(...panes);
      project = { ...project, tabs: [...project.tabs, ...panes.map((p) => ({ id: p.id, presetId: p.presetId, name: p.name }))] };
    },
    newPaneId: () => `new-${++next}`,
  };
  const deps = { ...teamPaneDeps(control, host, new TeamRunner(control)), startWaitMs: 1_000 };
  const open = (picks, { replace = false, callerId = "pane-c", team = "ux-review" } = {}) =>
    openTeamPanes(deps, project, team, picks, { replace, callerId });
  return {
    ...t,
    store,
    deps,
    opened,
    typed,
    open,
    tabs: () => project.tabs.map((tab) => tab.id),
    assignments: () => JSON.parse(readFileSync(join(store.dir, "assignments.json"), "utf8")),
  };
}

/** "reviewer=claude tester=this" as picks. */
const picks = (line) =>
  line.split(" ").filter(Boolean).map((pair) => {
    const at = pair.indexOf("=");
    return { role: pair.slice(0, at), target: pair.slice(at + 1) };
  });

async function refused(t, line, message, options) {
  const before = t.assignments();
  await assert.rejects(() => t.open(picks(line), options), (err) => {
    assert.match(err.message, message);
    assert.match(err.message, /nothing was opened$/);
    return true;
  });
  assert.deepEqual(t.opened, [], "no pane opened");
  assert.deepEqual(t.assignments(), before, "no role moved");
}

const RUNNING = { started: true, paused: false };

// Each row: the setup, the picks, and either the refusal or what happens.
// `opens` are the new sessions [role, preset]; `assigned` the team's panes after.
const USE_CASES = [
  {
    name: "one Claude pane open, three roles on three new Claude sessions; the calling pane keeps no role",
    picks: "reviewer=claude implementer=claude tester=claude",
    opens: [["reviewer", "claude"], ["implementer", "claude"], ["tester", "claude"]],
    assigned: { reviewer: "new-1", implementer: "new-2", tester: "new-3" },
  },
  {
    name: "the calling pane takes a role, the rest get new sessions",
    picks: "reviewer=this implementer=claude tester=codex",
    opens: [["implementer", "claude"], ["tester", "codex"]],
    assigned: { reviewer: "pane-c", implementer: "new-1", tester: "new-2" },
  },
  {
    name: "mixed CLIs",
    picks: "reviewer=claude implementer=codex tester=grok",
    opens: [["reviewer", "claude"], ["implementer", "codex"], ["tester", "grok"]],
    assigned: { reviewer: "new-1", implementer: "new-2", tester: "new-3" },
  },
  {
    name: "roles with live panes are left alone; only the missing ones are opened",
    assignments: { reviewer: "pane-c" },
    picks: "implementer=codex tester=claude",
    opens: [["implementer", "codex"], ["tester", "claude"]],
    assigned: { reviewer: "pane-c", implementer: "new-1", tester: "new-2" },
  },
  {
    name: "existing panes only, by id and by name: no new session",
    picks: "reviewer=pane-c implementer=codex-pane-by-name",
    rename: { "codex-pane-by-name": "Codex" },
    opens: [],
    assigned: { reviewer: "pane-c", implementer: "pane-x" },
  },
  {
    name: "a role whose agent exited gets a new session in its place",
    assignments: { tester: "pane-dead" },
    picks: "tester=claude",
    opens: [["tester", "claude"]],
    assigned: { tester: "new-1" },
  },
  {
    name: "a running team introduces every role given a pane, new or existing",
    state: RUNNING,
    picks: "reviewer=this tester=claude",
    opens: [["tester", "claude"]],
    assigned: { reviewer: "pane-c", tester: "new-1" },
    introduced: ["pane-c", "new-1"],
  },
  {
    name: "--replace moves a pane another role plays, and says who is left without one",
    assignments: { implementer: "pane-x" },
    picks: "tester=pane-x",
    replace: true,
    opens: [],
    assigned: { tester: "pane-x" },
    left: ["implementer"],
  },
  {
    name: "a role given the live pane it already has is not a replace",
    assignments: { tester: "pane-x" },
    picks: "tester=pane-x",
    opens: [],
    assigned: { tester: "pane-x" },
  },
  {
    name: "... or by its name",
    assignments: { tester: "pane-x" },
    picks: "tester=codex-pane-by-name",
    rename: { "codex-pane-by-name": "Codex" },
    opens: [],
    assigned: { tester: "pane-x" },
  },
  {
    name: "a pane still running after its tab closed does not hold the role",
    assignments: { tester: "pane-orphan" },
    alive: [...ALIVE, "pane-orphan"],
    picks: "tester=claude",
    opens: [["tester", "claude"]],
    assigned: { tester: "new-1" },
  },
  {
    name: "refused: a pane that plays a role in another team, without --replace",
    other: { writer: "pane-x" },
    picks: "tester=pane-x",
    refused: /^pane "Codex" plays writer in team docs; add --replace to move it \(writer is then left without a pane\); nothing/,
  },
  { name: "refused: a preset whose CLI is not installed", picks: "tester=missing", refused: /^preset "missing" \(Missing\) is not installed; nothing/ },
  {
    name: "refused: an unknown role",
    picks: "qa=claude",
    refused: /^team ux-review has no role "qa"; its roles: reviewer, implementer, tester; nothing/,
  },
  {
    name: "refused: an unknown preset or pane",
    picks: "tester=vim",
    refused: /^no preset or pane "vim"; presets: shell, claude, codex, grok, missing; panes: Claude Code, Codex, old tester, worker, worker; nothing/,
  },
  { name: "refused: a role listed twice", picks: "tester=claude tester=codex", refused: /^role "tester" is listed twice; nothing/ },
  {
    name: "refused: one pane given to two roles",
    picks: "reviewer=this tester=pane-c",
    refused: /^pane "Claude Code" is given to both reviewer and tester; nothing/,
  },
  {
    name: "refused: an ambiguous pane name, with the candidates",
    picks: "tester=worker",
    refused: /^pane name "worker" is ambiguous: worker \(id pane-w1\), worker \(id pane-w2\); use an id; nothing/,
  },
  {
    name: "refused: this, run outside a pane",
    picks: "reviewer=this",
    callerId: null,
    refused: /^"this" is the pane running the command; run it in an Aya pane of this project; nothing/,
  },
  {
    name: "refused: a role that has a live pane, without --replace",
    assignments: { tester: "pane-x" },
    picks: "tester=claude",
    refused: /^role "tester" already has a live pane \(pane-x\); add --replace to give it another \(the old one keeps running, without the role\); nothing/,
  },
  {
    name: "refused: a pane another role plays, without --replace",
    assignments: { implementer: "pane-x" },
    picks: "tester=pane-x",
    refused: /^pane "Codex" plays implementer; add --replace to move it \(implementer is then left without a pane\); nothing/,
  },
  {
    name: "a tab whose agent is not running yet can still take a role; a running team says why it was not told",
    state: RUNNING,
    picks: "tester=pane-dead",
    opens: [],
    assigned: { tester: "pane-dead" },
    notReached: { tester: "is not running (exited, or its tab was not opened yet)" },
  },
  {
    name: "refused: every problem at once",
    picks: "qa=claude tester=missing",
    refused: /^team ux-review has no role "qa"; its roles: reviewer, implementer, tester; preset "missing" \(Missing\) is not installed; nothing was opened$/,
  },
];

test("use cases: new sessions, this, existing panes, mixes, refusals", async (s) => {
  for (const row of USE_CASES) {
    await s.test(row.name, async () => {
      const t = setup({ assignments: row.assignments ?? {}, state: row.state ?? null, ...(row.alive ? { alive: row.alive } : {}) });
      if (row.other) {
        mkdirSync(join(t.directory, ".aya", "teams"), { recursive: true });
        writeFileSync(join(t.directory, ".aya", "teams", "docs.md"), "# docs\n");
        const docs = new TeamStore(teamDir(t.teamHome, "game", "docs"));
        mkdirSync(docs.dir, { recursive: true });
        writeFileSync(join(docs.dir, "assignments.json"), JSON.stringify(row.other));
      }
      const line = Object.entries(row.rename ?? {}).reduce((l, [from, to]) => l.replace(from, to), row.picks);
      const options = { replace: row.replace ?? false, ...("callerId" in row ? { callerId: row.callerId } : {}) };
      try {
        if (row.refused) {
          await refused(t, line, row.refused, options);
          return;
        }
        const result = await t.open(picks(line), options);
        const presetName = (id) => PRESETS.find((p) => p.id === id).name;
        assert.deepEqual(
          t.opened,
          row.opens.map(([role, preset], i) => ({ id: `new-${i + 1}`, presetId: preset, name: `${presetName(preset)} - ${role}` })),
        );
        assert.deepEqual(t.assignments(), row.assigned);
        assert.deepEqual(result.leftWithoutPane, row.left ?? []);
        for (const id of ["pane-c", "pane-x", "pane-dead"]) assert.ok(t.tabs().includes(id), `${id} is never closed`);
        const told = t.typed.filter((m) => m.text.includes("Delivery test")).map((m) => m.pane);
        for (const [role, why] of Object.entries(row.notReached ?? {})) assert.equal(result.panes.find((p) => p.role === role).notReached, why);
        assert.deepEqual(told.sort(), (row.introduced ?? []).sort(), "only a running team introduces");
        assert.deepEqual(
          result.panes.map((p) => [p.role, p.paneId, p.preset]),
          picks(line).map(({ role }) => {
            const opened = t.opened.find((o) => o.name.endsWith(` - ${role}`));
            return [role, row.assigned[role], opened ? presetName(opened.presetId) : null];
          }),
        );
      } finally {
        t.cleanup();
      }
    });
  }
});

test("setup refusals: a remote project, no such team, a team not saved in Aya, no picks", async (s) => {
  const cases = [
    ["a remote project", { remote: true }, "tester=claude", /^teams work only on local projects; nothing/],
    ["no such team", {}, "tester=claude", /^no team "nope" in this project; its teams: ux-review; nothing/, { team: "nope" }],
    ["a team not saved in Aya", { saved: false }, "tester=claude", /^team ux-review is not saved in Aya yet/],
    ["no picks", {}, "", /^name at least one role=target; nothing/],
  ];
  for (const [name, options, line, message, extra] of cases) {
    await s.test(name, async () => {
      const t = setup(options);
      try {
        await refused(t, line, message, extra);
      } finally {
        t.cleanup();
      }
    });
  }
});

test("roles come from the definition saved in Aya, not a later repo edit", async () => {
  const t = setup();
  try {
    writeFileSync(join(t.directory, ".aya", "teams", "ux-review.md"), `${TEAM}\n## Role: qa\nMust not: x\n`);
    await refused(t, "qa=claude", /has no role "qa"/);
  } finally {
    t.cleanup();
  }
});

const TEAM_STATES = { "never started": null, running: RUNNING, paused: { started: true, paused: true } };
const PANE_STATES = {
  "a live pane": { assignments: { tester: "pane-x" } },
  "a dead pane": { assignments: { tester: "pane-dead" } },
  "a pane whose tab is gone": { assignments: { tester: "pane-gone" } },
  "no pane": {},
};
const TARGETS = { "a new session": "claude", "an existing pane": "pane-w1" };

test("team state x the role's pane x target x --replace", async (s) => {
  for (const [teamState, state] of Object.entries(TEAM_STATES)) {
    for (const [paneState, options] of Object.entries(PANE_STATES)) {
      for (const [targetName, target] of Object.entries(TARGETS)) {
        for (const replace of [false, true]) {
          await s.test(`${teamState}, ${paneState}, ${targetName}, ${replace ? "--replace" : "no --replace"}`, async () => {
            const t = setup({ state, ...options });
            try {
              if (paneState === "a live pane" && !replace) {
                await refused(t, `tester=${target}`, /already has a live pane/, { replace });
                return;
              }
              const { panes } = await t.open(picks(`tester=${target}`), { replace });
              const pane = target === "claude" ? "new-1" : "pane-w1";
              assert.equal(panes[0].paneId, pane);
              assert.equal(t.assignments().tester, pane);
              assert.equal(t.opened.length, target === "claude" ? 1 : 0);
              assert.equal(await t.store.roleOf(options.assignments?.tester ?? "none"), null, "the old pane lost the role");
              assert.ok(t.tabs().includes("pane-x") && t.tabs().includes("pane-dead"), "no pane is closed");
              const told = t.typed.filter((m) => m.pane === pane && m.text.includes("Delivery test"));
              assert.equal(told.length, teamState === "running" ? 1 : 0, "only a running team introduces the role");
            } finally {
              t.cleanup();
            }
          });
        }
      }
    }
  }
});

test("a running team introduces a new pane once it has started, or says why not", async () => {
  let checks = 0;
  const starting = setup({ state: RUNNING, holds: () => (++checks < 3 ? HOLD_STARTING : null) });
  try {
    const { panes } = await starting.open(picks("tester=claude"));
    assert.equal(panes[0].notReached, null);
    assert.equal(starting.typed.length, 1);
  } finally {
    starting.cleanup();
  }
  let asked = 0;
  const never = setup({ state: RUNNING, holds: () => (asked++, HOLD_NOT_RUNNING) });
  try {
    const started = Date.now();
    const { panes } = await never.open(picks("tester=claude"));
    assert.ok(Date.now() - started >= never.deps.startWaitMs, "waits the whole start window");
    assert.ok(asked <= never.deps.startWaitMs / 250 + 2, `polls every 250 ms, not in a busy loop (${asked} checks)`);
    assert.equal(panes[0].notReached, HOLD_NOT_RUNNING);
    assert.equal(never.typed.length, 0);
  } finally {
    never.cleanup();
  }
  const shell = setup({ state: RUNNING, holds: () => "runs a shell" });
  try {
    const started = Date.now();
    const { panes } = await shell.open(picks("tester=claude"));
    assert.ok(Date.now() - started < shell.deps.startWaitMs, "a hold that is not start-up is reported at once");
    assert.equal(panes[0].notReached, "runs a shell");
  } finally {
    shell.cleanup();
  }
});

test("a window that fails to open the panes assigns nothing", async () => {
  const t = setup();
  t.deps.openPanes = async () => {
    throw new Error("project game is not open in an Aya window");
  };
  try {
    await assert.rejects(() => t.open(picks("reviewer=this tester=claude")), /not open in an Aya window/);
    assert.deepEqual(t.assignments(), {});
  } finally {
    t.cleanup();
  }
});

test("presets list id, name, agent and whether the CLI is installed", async () => {
  const t = setup();
  try {
    const choices = await presetChoices(t.deps);
    assert.deepEqual(choices.slice(0, 3), [
      { id: "shell", name: "Shell", agent: "custom", installed: true },
      { id: "claude", name: "Claude Code", agent: "claude", installed: true },
      { id: "codex", name: "Codex", agent: "codex", installed: true },
    ]);
    assert.deepEqual(choices[4], { id: "missing", name: "Missing", agent: "custom", installed: false });
    assert.equal(
      formatPresets(choices),
      [
        "id       name         agent   installed",
        "shell    Shell        custom  yes",
        "claude   Claude Code  claude  yes",
        "codex    Codex        codex   yes",
        "grok     Grok         grok    yes",
        "missing  Missing      custom  no",
        "",
      ].join("\n"),
    );
  } finally {
    t.cleanup();
  }
});

test("a preset's agent: its own field, else an account prefix, else its binary, else custom", () => {
  const agent = (command, extra = {}) => presetAgent({ id: "x", name: "x", icon: "", color: "", command, ...extra });
  assert.equal(agent("codex", { agent: "grok" }), "grok");
  assert.equal(agent("opencode --model x"), "opencode");
  assert.equal(agent("cursor-agent"), "cursor");
  assert.equal(agent("CLAUDE_CONFIG_DIR=~/.claude-work claude"), "claude");
  assert.equal(agent("CODEX_HOME=~/.codex-2 codex"), "codex");
  assert.equal(agent("claudette"), "custom");
  assert.equal(agent("$SHELL"), "custom");
});

test("installed is what the spawn check would say: a missing binary is not, $SHELL and compound commands are", async () => {
  const preset = (command) => ({ id: "x", name: "x", icon: "", color: "", command });
  assert.equal(await presetInstalled(preset("aya-no-such-binary-4c1f")), false);
  assert.equal(await presetInstalled(preset("sh -c true")), true);
  assert.equal(await presetInstalled(preset("sh -c false")), true, "a found binary stays found (cached)");
  assert.equal(await presetInstalled(preset("$SHELL")), true);
  assert.equal(await presetInstalled(preset("FOO=1 aya-no-such-binary-4c1f")), true);
});

test("the summary names each role's pane, who lost one, and leaves Start to the user", () => {
  const result = {
    panes: [
      { role: "reviewer", paneId: "pane-c", name: "Claude Code", preset: null, notReached: null },
      { role: "tester", paneId: "new-1", name: "Codex - tester", preset: "Codex", notReached: "runs a shell" },
    ],
    leftWithoutPane: [],
  };
  assert.equal(
    formatOpened("ux-review", result, { running: false, paused: false }),
    'team ux-review: gave 2 roles a pane, 1 new:\n  reviewer -> pane "Claude Code" (id pane-c)\n  tester -> new pane "Codex - tester" (id new-1)\n' +
      "Start it in the Teams window, or ask me to.\n",
  );
  assert.match(formatOpened("ux-review", result, { running: false, paused: true }), /\nThe team is paused; resume it in the Teams window\.\n$/);
  const running = formatOpened("ux-review", { ...result, leftWithoutPane: ["implementer"] }, { running: true, paused: false });
  assert.match(running, /reviewer -> pane "Claude Code" \(id pane-c\); told its role\n/);
  assert.match(running, /tester -> new pane "Codex - tester" \(id new-1\); not told its role: runs a shell\nleft without a pane: implementer\n$/);
  assert.match(formatOpened("t", { panes: [result.panes[0]], leftWithoutPane: [] }, { running: true, paused: false }), /^team t: gave 1 role a pane, 0 new:\n/);
});

test("the control request: the caller's project and pane, then the same path", async () => {
  const t = setup();
  try {
    const request = { type: "team-open", team: "ux-review", panes: picks("reviewer=this tester=claude"), replace: false };
    const { output } = await handleTeamPanesRequest(request, "pane-c", t.deps);
    assert.match(output, /^team ux-review: gave 2 roles a pane, 1 new:\n  reviewer -> pane "Claude Code" \(id pane-c\)\n  tester -> new pane "Claude Code - tester" \(id new-1\)\n/);
    assert.deepEqual(t.assignments(), { reviewer: "pane-c", tester: "new-1" });
    await assert.rejects(
      () => handleTeamPanesRequest({ ...request, replace: true }, "pane-elsewhere", t.deps),
      /^Error: run aya team open in an Aya pane, or in the directory of a project open in Aya; nothing was opened$/,
    );
    const presets = await handleTeamPanesRequest({ type: "presets", json: false }, undefined, t.deps);
    assert.match(presets.output, /^id +name +agent +installed\n/);
    const json = await handleTeamPanesRequest({ type: "presets", json: true }, undefined, t.deps);
    assert.deepEqual(JSON.parse(json.output), await presetChoices(t.deps));
  } finally {
    t.cleanup();
  }
});

test("the real CLI through the control server: presets and team open, or teams unavailable", async () => {
  const t = setup();
  const run = async (options, args) => {
    const socket = join(t.root, "aya.sock");
    const stop = startControlServerOn(socket, { getWindow: () => null, openProject: () => {}, ...options });
    try {
      return await new Promise((done) => {
        const child = spawn("bin/aya", args, { env: { ...envWithoutAya(), AYA_SOCKET: socket, AYA_TERMINAL_ID: "pane-c" } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => (stdout += c));
        child.stderr.on("data", (c) => (stderr += c));
        child.on("close", (status) => done({ status, stdout, stderr }));
      });
    } finally {
      stop();
    }
  };
  try {
    const presets = await run({ teamPanes: t.deps }, ["presets"]);
    assert.equal(presets.status, 0, presets.stderr);
    assert.match(presets.stdout, /^missing +Missing +custom +no$/m);
    const opened = await run({ teamPanes: t.deps }, ["team", "open", "ux-review", "reviewer=this", "tester=claude"]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, /tester -> new pane "Claude Code - tester" \(id new-1\)\nStart it in the Teams window, or ask me to\.\n$/);
    const off = await run({}, ["team", "open", "ux-review", "tester=claude"]);
    assert.equal(off.status, 1);
    assert.equal(off.stderr, "aya: teams are not available\n");
  } finally {
    t.cleanup();
  }
});

test("a renderer request settles on its answer, its error, or its deadline", async () => {
  const requests = new RendererRequests();
  const sent = [];
  const ok = requests.ask((id) => sent.push(id), 1_000);
  const failed = requests.ask((id) => sent.push(id), 1_000);
  assert.equal(new Set(sent).size, 2, "each request has its own id");
  requests.answer("unknown", null);
  requests.answer(sent[1], "no such preset");
  requests.answer(sent[0], null);
  await ok;
  await assert.rejects(failed, /^Error: no such preset$/);
  await assert.rejects(requests.ask(() => {}, 20), /^Error: the Aya window did not open the panes in time$/);
  const odd = [];
  const oddAnswer = requests.ask((id) => odd.push(id), 1_000);
  requests.answer(odd[0], { not: "a message" });
  await oddAnswer;
  const late = [];
  const timedOut = requests.ask((id) => late.push(id), 20);
  await assert.rejects(timedOut);
  requests.answer(late[0], null);
});
