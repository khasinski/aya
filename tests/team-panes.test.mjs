// aya presets / aya team open and the Teams window's Apply panes: one main path
// that checks every role and target first, then gives each role its pane.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  PaneOpenTimeout,
  SPAWN_WAIT_WINDOWS,
  teamPaneDeps,
} = await import("../dist-electron/team-panes.js");
const { presetInstalled } = await import("../dist-electron/command-probe.js");
const { startControlServerOn } = await import("../dist-electron/control.js");
const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { HOLD_NOT_RUNNING, HOLD_STARTING } = await import("../dist-electron/pane-holds.js");
const { withLaunchHolds } = await import("../dist-electron/team-control.js");
const { cantReach, launchBlockOf, launchNoteOf, launchMode, teamLaunch, LAUNCH_UNREACHABLE, LAUNCH_STARTING, LAUNCH_UNSUPPORTED } = await import("../dist-electron/launch-mode.js");

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
  { id: "codex-ro", name: "Codex read-only", icon: "o", color: "", command: "codex -s read-only" },
];
const WRAPPED_PRESET = { id: "wrapped", name: "Wrapped Codex", icon: "o", color: "", command: "env codex" };

// What main derives (electron/launch-mode.ts) for the Codex tab pane-x, launched in
// Codex's default sandbox, and for a new pane of the read-only preset.
const NO_CONFIG = { codex: [], opencode: [], claude: [], socket: "/h/.aya/aya.sock" };
const NETWORK_NOTE = "Aya opened it with -c sandbox_workspace_write.network_access=true so it reaches Aya; Codex's sandbox then lets its commands reach every network host, not only Aya's socket";
const X_BLOCKED = cantReach(launchMode("codex --no-daemon", NO_CONFIG));
const RO_REFUSED = teamLaunch("codex --no-daemon -s read-only", NO_CONFIG).refused;
const WRAPPED_COMMAND = "env codex";
const ROLE_LAUNCH = {
  shell: { reach: "unknown", refused: null },
  "codex-ro": { reach: "blocked", refused: RO_REFUSED },
  wrapped: { reach: launchMode(WRAPPED_COMMAND, NO_CONFIG).reach, refused: teamLaunch(WRAPPED_COMMAND, NO_CONFIG).refused ?? null },
};
const X_LAUNCH_BLOCKED = { "pane-x": X_BLOCKED };

// pane-c is where the agent runs aya team open; pane-dead's agent has exited.
const TABS = [
  { id: "pane-c", name: "Claude Code", presetId: "claude" },
  { id: "pane-x", name: "Codex", presetId: "codex" },
  { id: "pane-dead", name: "old tester", presetId: "claude" },
  { id: "pane-w1", name: "worker", presetId: "shell" },
  { id: "pane-w2", name: "worker", presetId: "shell" },
];

const ALIVE = ["pane-c", "pane-x", "pane-w1", "pane-w2"];

const panesTest = (name, ...args) => {
  const fn = args.pop();
  test(name, async () => {
    const t = await setup(...args);
    try {
      await fn(t);
    } finally {
      t.cleanup();
    }
  });
};

/** A pane with no running agent is held as the terminal host holds it. */
const hostHolds = (pane) => (ALIVE.includes(pane) || pane.startsWith("new-") ? null : HOLD_NOT_RUNNING);

function setup({ slug = "game", saved = true, state = null, assignments = {}, alive = ALIVE, holds = hostHolds, remote = false, deliver, launchBlocks = {}, launchNotes = {}, launchOf = null, presets = PRESETS } = {}) {
  const t = teamProject("aya-team-panes-", { teamFile: TEAM, saved, tabs: TABS });
  if (slug !== "game") {
    renameSync(join(t.teamHome, "teams", "game"), join(t.teamHome, "teams", slug));
    t.project.slug = slug;
  }
  const store = new TeamStore(teamDir(t.teamHome, slug, "ux-review"));
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
    deliver: deliver ?? (async (pane, text) => void typed.push({ pane, text })),
    headCommit: async () => null,
    holdReason: withLaunchHolds(async (pane) => holds(pane), async (pane) => launchBlocks[pane] ?? null),
  };
  const host = {
    listPresets: async () => presets,
    presetInstalled: async (p) => p.id !== "missing",
    roleLaunch: async (p) => ROLE_LAUNCH[p.id] ?? { reach: "reaches", refused: null },
    launchBlock: async (pane) => (launchOf ? launchBlockOf(launchOf(pane)) : (launchBlocks[pane] ?? null)),
    launchNote: async (pane) => (launchOf ? launchNoteOf(launchOf(pane)) : (launchNotes[pane] ?? null)),
    paneAlive: async (pane) => alive.includes(pane) || pane.startsWith("new-"),
    openPanes: async (slug, panes) => {
      opened.push(...panes);
      project = { ...project, tabs: [...project.tabs, ...panes.map((p) => ({ id: p.id, presetId: p.presetId, name: p.name }))] };
    },
    newPaneId: () => `new-${++next}`,
  };
  const deps = { ...teamPaneDeps(control, host, new TeamRunner(control)), startWaitMs: 1_000 };
  const open = (picks, { replace = false, callerId = "pane-c", team = "ux-review", release } = {}) =>
    openTeamPanes(deps, project, team, picks, { replace, callerId, release });
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
    picks: "reviewer=this implementer=claude tester=new:codex",
    opens: [["implementer", "claude"], ["tester", "codex"]],
    assigned: { reviewer: "pane-c", implementer: "new-1", tester: "new-2" },
  },
  {
    name: "mixed CLIs",
    picks: "reviewer=claude implementer=new:codex tester=grok",
    opens: [["reviewer", "claude"], ["implementer", "codex"], ["tester", "grok"]],
    assigned: { reviewer: "new-1", implementer: "new-2", tester: "new-3" },
  },
  {
    name: "roles with live panes are left alone; only the missing ones are opened",
    assignments: { reviewer: "pane-c" },
    picks: "implementer=new:codex tester=claude",
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
    name: "... or as this",
    assignments: { reviewer: "pane-c" },
    picks: "reviewer=this",
    opens: [],
    assigned: { reviewer: "pane-c" },
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
  {
    name: "refused: a target that is both a preset id and a pane name, with the explicit forms",
    picks: "tester=codex",
    refused: /^"codex" is both a preset and a pane name; write new:codex for a new session or pane:codex for the pane; nothing/,
  },
  {
    name: "new: and pane: say which is meant",
    picks: "tester=new:codex implementer=pane:codex",
    opens: [["tester", "codex"]],
    assigned: { tester: "new-1", implementer: "pane-x" },
  },
  { name: "refused: new: names no preset", picks: "tester=new:vim", refused: /^no preset "vim"; presets: shell, claude, codex, grok, missing, codex-ro; nothing/ },
  {
    name: "refused: pane: names no pane",
    picks: "tester=pane:claude",
    refused: /^no pane "claude"; panes: Claude Code, Codex, old tester, worker, worker; nothing/,
  },
  {
    name: "a dead pane another role had can be taken without --replace, and that role is named",
    assignments: { implementer: "pane-dead" },
    picks: "tester=pane-dead",
    opens: [],
    assigned: { tester: "pane-dead" },
    left: ["implementer"],
  },
  {
    name: "... also from another team's role",
    other: { writer: "pane-dead" },
    picks: "tester=pane-dead",
    opens: [],
    assigned: { tester: "pane-dead" },
    left: ["writer in team docs"],
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
    refused: /^no preset or pane "vim"; presets: shell, claude, codex, grok, missing, codex-ro; panes: Claude Code, Codex, old tester, worker, worker; nothing/,
  },
  { name: "refused: a role listed twice", picks: "tester=claude tester=grok", refused: /^role "tester" is listed twice; nothing/ },
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
    name: "refused: a new pane whose preset launches Codex read-only: Aya does not escalate it",
    picks: "tester=codex-ro",
    refused:
      /^role "tester": preset "codex-ro" \(Codex read-only\) can't reach Aya: Codex sandbox read-only blocks the socket; pick a preset that allows it \(one that runs codex with -s danger-full-access -a never\); nothing/,
  },
  {
    name: "an open pane whose launch mode can't reach Aya takes the role, and says so",
    picks: "implementer=pane:codex",
    opens: [],
    assigned: { implementer: "pane-x" },
    cantReach: { implementer: X_BLOCKED },
    launchBlocks: X_LAUNCH_BLOCKED,
  },
  {
    name: "... and a running team does not type its role into it",
    state: RUNNING,
    picks: "implementer=pane:codex reviewer=this",
    opens: [],
    assigned: { implementer: "pane-x", reviewer: "pane-c" },
    introduced: ["pane-c"],
    notReached: { implementer: X_BLOCKED },
    cantReach: { implementer: X_BLOCKED },
    launchBlocks: X_LAUNCH_BLOCKED,
  },
  {
    name: "a pane Aya widened to make it reach says what it widened",
    picks: "implementer=pane:codex",
    opens: [],
    assigned: { implementer: "pane-x" },
    launchNotes: { "pane-x": NETWORK_NOTE },
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
      const t = setup({ assignments: row.assignments ?? {}, state: row.state ?? null, launchBlocks: row.launchBlocks ?? {}, launchNotes: row.launchNotes ?? {}, ...(row.alive ? { alive: row.alive } : {}) });
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
          row.opens.map(([role, preset], i) => ({ id: `new-${i + 1}`, presetId: preset, name: `${presetName(preset)} - ${role}`, teamLaunch: true })),
        );
        assert.deepEqual(t.assignments(), row.assigned);
        assert.deepEqual(result.leftWithoutPane, row.left ?? []);
        for (const id of ["pane-c", "pane-x", "pane-dead"]) assert.ok(t.tabs().includes(id), `${id} is never closed`);
        const told = t.typed.filter((m) => m.text.includes("Delivery test")).map((m) => m.pane);
        for (const [role, why] of Object.entries(row.notReached ?? {})) assert.equal(result.panes.find((p) => p.role === role).notReached, why);
        for (const p of result.panes) assert.equal(p.cantReach, row.cantReach?.[p.role] ?? null, `${p.role} can't reach Aya?`);
        for (const p of result.panes) assert.equal(p.note, row.launchNotes?.[p.paneId] ?? null, `${p.role} widened?`);
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

const REACHING = {
  command: "codex --no-daemon",
  cwd: "/p",
  added: ["sandbox_workspace_write.network_access=true"],
  mode: { cli: "codex", mode: "workspace-write", reach: "reaches" },
};

test("a new pane is asked how it was launched only once the host has recorded it", async (s) => {
  await s.test("the record arrives after the pane opened: no false 'no record', the note is kept", async () => {
    let asked = 0;
    const t = setup({ launchOf: () => (++asked > 3 ? REACHING : null) });
    try {
      const result = await t.open(picks("tester=claude"));
      assert.equal(result.panes[0].cantReach, null);
      assert.equal(result.panes[0].note, NETWORK_NOTE);
    } finally {
      t.cleanup();
    }
  });
  await s.test("a pane that never gets a record is reported once the start window ends, not waited on forever", async () => {
    let over = false;
    const t = setup({ launchOf: () => (over ? REACHING : null) });
    try {
      const started = Date.now();
      const window = t.deps.startWaitMs;
      const result = await Promise.race([t.open(picks("tester=claude")), new Promise((r) => setTimeout(() => r("hung"), window * 3))]);
      over = true;
      assert.notEqual(result, "hung", "still waiting after three windows");
      assert.ok(Date.now() - started >= window, "waits the whole window");
      assert.match(result.panes[0].cantReach, /no record of how this pane was launched/);
    } finally {
      over = true;
      t.cleanup();
    }
  });
  await s.test("the host does not answer at first: a new pane is asked again, an open one is told to try again", async () => {
    let asked = 0;
    const flaky = setup({ launchOf: () => (++asked > 3 ? REACHING : LAUNCH_UNREACHABLE) });
    try {
      assert.equal((await flaky.open(picks("tester=claude"))).panes[0].cantReach, null);
    } finally {
      flaky.cleanup();
    }
    const down = setup({ launchOf: () => LAUNCH_UNREACHABLE });
    const started = Date.now();
    try {
      const result = await down.open(picks("tester=pane-w1"));
      assert.match(result.panes[0].cantReach, /could not ask.*try again/);
      assert.ok(Date.now() - started < 500, "an open pane is not waited on");
    } finally {
      down.cleanup();
    }
  });
  await s.test("an open pane without a record is reported at once", async () => {
    const t = setup({ launchOf: () => null });
    const started = Date.now();
    try {
      const result = await t.open(picks("tester=pane-w1"));
      assert.match(result.panes[0].cantReach, /no record/);
      assert.ok(Date.now() - started < 500, "no waiting for a pane that was already running");
    } finally {
      t.cleanup();
    }
  });
});

// The window's banner after Apply says "May not reach Aya" for a pane Aya has no verdict for or whose verdict is
// unknown; main decides that and hands it over as `unsure`, so the window reads no wording of main's texts.
// [launch answer, unsure]
const UNSURE = [
  ["no record", () => null, true],
  ["the host did not answer", () => LAUNCH_UNREACHABLE, true],
  ["still starting", () => LAUNCH_STARTING, true],
  ["a host too old to record", () => LAUNCH_UNSUPPORTED, true],
  ["an unknown verdict (wrapped)", () => ({ command: WRAPPED_COMMAND, cwd: "/p", added: [], mode: launchMode(WRAPPED_COMMAND, NO_CONFIG) }), true],
  ["reaches", () => REACHING, false],
  ["can't reach (measured)", () => ({ command: "codex --no-daemon", cwd: "/p", added: [], mode: launchMode("codex --no-daemon", NO_CONFIG) }), false],
];
for (const [label, launch, unsure] of UNSURE) {
  panesTest(`an opened pane is unsure whether it reaches Aya | ${label} -> ${unsure}`, { launchOf: launch }, async (t) => {
    assert.equal((await t.open(picks("tester=pane-w1"))).panes[0].unsure, unsure);
  });
}

panesTest("a new pane of a wrapped preset is opened, noted and not held, with no flags added to it", { presets: [...PRESETS, WRAPPED_PRESET], launchOf: () => ({ command: WRAPPED_COMMAND, cwd: "/p", added: [], mode: launchMode(WRAPPED_COMMAND, NO_CONFIG) }) }, async (t) => {
  const result = await t.open(picks("tester=new:wrapped"));
  assert.equal(result.panes[0].cantReach, null);
  assert.match(result.panes[0].note, /^may not reach Aya: /);
  assert.deepEqual(teamLaunch(WRAPPED_COMMAND, NO_CONFIG), { args: [] });
});

test("a plain shell pane's verdict is unknown and not held: what is typed into it is not seen", async () => {
  const mode = launchMode("$SHELL", NO_CONFIG);
  assert.equal(mode.reach, "unknown");
  assert.equal(cantReach(mode), null);
  const t = setup({ launchOf: () => ({ command: "$SHELL", cwd: "/p", added: [], mode }) });
  try {
    assert.equal((await t.open(picks("tester=pane-w1"))).panes[0].cantReach, null);
  } finally {
    t.cleanup();
  }
});

test("a new pane's launch is pending while its host has no pane yet or is still in the spawn preflight", { concurrency: 8 }, async (s) => {
  // Each timeline owns a project slug as well as its files, so its project
  // queue and real clock can advance independently.
  const checks = [];
  // Host timeline: no pane for `gone` ms, spawn preflight until `recorded` ms, then the record.
  const timeline = (gone, recorded) => {
    const t0 = Date.now();
    return () => {
      const at = Date.now() - t0;
      return at < gone ? null : at < recorded ? LAUNCH_STARTING : REACHING;
    };
  };
  // The start window is 1 s; a spawn preflight may take up to three windows.
  for (const [gone, recorded] of [[0, 0], [0, 500], [400, 400], [400, 1500], [0, 2500], [800, 2500]]) {
    checks.push(s.test(`no pane for ${gone} ms, record at ${recorded} ms: no false 'no record'`, async () => {
      const t = setup({ slug: `launch-${gone}-${recorded}`, launchOf: timeline(gone, recorded) });
      try {
        const result = await t.open(picks("tester=claude"));
        assert.equal(result.panes[0].cantReach, null);
        assert.equal(result.panes[0].note, NETWORK_NOTE);
      } finally {
        t.cleanup();
      }
    }));
  }
  checks.push(s.test("a spawn that never ends is reported after three windows, as still starting", async () => {
    assert.equal(SPAWN_WAIT_WINDOWS, 3);
    const t = setup({ slug: "launch-stuck", launchOf: () => LAUNCH_STARTING });
    try {
      const started = Date.now();
      const result = await t.open(picks("tester=claude"));
      const took = Date.now() - started;
      assert.match(result.panes[0].cantReach, /still starting/);
      assert.ok(took >= SPAWN_WAIT_WINDOWS * t.deps.startWaitMs && took < (SPAWN_WAIT_WINDOWS + 1.5) * t.deps.startWaitMs, `waited ${took} ms`);
    } finally {
      t.cleanup();
    }
  }));
  checks.push(s.test("a pane gone after its spawn (failed) is reported at once, not waited on for a window", async () => {
    let first = true;
    const t = setup({ slug: "launch-failed", launchOf: () => (first ? ((first = false), LAUNCH_STARTING) : null) });
    try {
      const started = Date.now();
      const result = await t.open(picks("tester=claude"));
      assert.match(result.panes[0].cantReach, /no record of how this pane was launched/);
      assert.ok(Date.now() - started < 500, "a spawn that ended without a record is final");
    } finally {
      t.cleanup();
    }
  }));
  checks.push(s.test("a host that predates the launch request is flagged at once, truthfully", async () => {
    const t = setup({ slug: "launch-old", launchOf: () => LAUNCH_UNSUPPORTED });
    try {
      const started = Date.now();
      const result = await t.open(picks("tester=claude"));
      assert.match(result.panes[0].cantReach, /older.*does not record how panes are launched/);
      assert.ok(Date.now() - started < 500, "an old host is never going to record");
    } finally {
      t.cleanup();
    }
  }));
  await Promise.all(checks);
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

test("the window's assign to a team not saved in Aya is refused and assigns nothing; releasing is allowed", async () => {
  const { assignRoleLocked } = await import("../dist-electron/team-panes.js");
  const t = setup({ saved: false });
  try {
    await assert.rejects(assignRoleLocked(t.deps, "game", "ux-review", "tester", "pane-w1"), /not saved in Aya yet/);
    assert.deepEqual(t.assignments(), {});
    await assignRoleLocked(t.deps, "game", "ux-review", "tester", null);
  } finally {
    t.cleanup();
  }
});

panesTest("roles come from the definition saved in Aya, not a later repo edit", async (t) => {
  writeFileSync(join(t.directory, ".aya", "teams", "ux-review.md"), `${TEAM}\n## Role: qa\nMust not: x\n`);
  await refused(t, "qa=claude", /has no role "qa"/);
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
  // A startup dialog with numbered options needs a person: reported at once, not waited out like start-up.
  const choice = setup({ state: RUNNING, holds: () => "shows a numbered choice" });
  try {
    const started = Date.now();
    const { panes } = await choice.open(picks("tester=claude"));
    assert.ok(Date.now() - started < choice.deps.startWaitMs, "a numbered choice is reported at once");
    assert.equal(panes[0].notReached, "shows a numbered choice");
  } finally {
    choice.cleanup();
  }
});

panesTest("a window that saved the tabs but missed its reply: the roles still get them, and a retry opens no second pane", async (t) => {
  const open = t.deps.openPanes;
  t.deps.openPanes = async (slug, panes) => {
    await open(slug, panes);
    throw new Error("the Aya window did not open the panes in time");
  };
  const { panes } = await t.open(picks("reviewer=claude tester=claude"));
  assert.deepEqual(panes.map((p) => p.paneId), ["new-1", "new-2"]);
  assert.deepEqual(t.assignments(), { reviewer: "new-1", tester: "new-2" });
  await assert.rejects(() => t.open(picks("reviewer=claude tester=claude")), /already has a live pane/);
  assert.equal(t.opened.length, 2, "no second pane");
});

panesTest("a window that saves the tabs after the deadline: its late reply still gives the roles their panes", async (t) => {
  const open = t.deps.openPanes;
  let saved;
  t.deps.openPanes = async (slug, panes) => {
    const late = new Promise((resolve) => (saved = async () => (await open(slug, panes), resolve())));
    throw new PaneOpenTimeout(late);
  };
  await assert.rejects(
    () => t.open(picks("reviewer=claude tester=claude")),
    /^Error: the Aya window did not open the panes in time; nothing was assigned; if it still opens them, the new panes get their roles$/,
  );
  assert.deepEqual(t.assignments(), {});
  await saved();
  for (let i = 0; i < 50 && !t.assignments().tester; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(t.assignments(), { reviewer: "new-1", tester: "new-2" });
  await assert.rejects(() => t.open(picks("reviewer=claude")), /already has a live pane/);
  assert.equal(t.opened.length, 2, "no second pane");
});

/** A window that misses the deadline and saves the tabs when `save()` is called. */
function lateWindow(t) {
  const open = t.deps.openPanes;
  let save;
  t.deps.openPanes = async (slug, panes) => {
    const late = new Promise((resolve) => (save = async () => (await open(slug, panes), resolve())));
    throw new PaneOpenTimeout(late);
  };
  return async () => {
    await save();
    // The late path runs on its own; let it settle.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));
  };
}

panesTest("a late reply gives only the new panes their roles: an open pane picked with them is left as it was", { assignments: { implementer: "pane-x" } }, async (t) => {
  const save = lateWindow(t);
  await assert.rejects(() => t.open(picks("reviewer=claude tester=pane-x"), { replace: true }), /nothing was assigned/);
  assert.deepEqual(t.assignments(), { implementer: "pane-x" });
  await save();
  assert.deepEqual(t.assignments(), { implementer: "pane-x", reviewer: "new-1" }, "pane-x did not move to tester");
});

test("a late reply does not overwrite a role given another pane meanwhile", async (s) => {
  for (const replace of [false, true]) {
    await s.test(replace ? "--replace (Apply panes): the other roles still get theirs" : "no --replace: the check now refuses, nothing is assigned", async () => {
      const t = setup();
      const save = lateWindow(t);
      const warn = console.warn;
      console.warn = () => {};
      try {
        await assert.rejects(() => t.open(picks("reviewer=claude tester=claude"), { replace }), /nothing was assigned/);
        await t.store.assign("reviewer", "pane-x");
        await save();
        assert.deepEqual(t.assignments(), replace ? { reviewer: "pane-x", tester: "new-2" } : { reviewer: "pane-x" });
      } finally {
        console.warn = warn;
        t.cleanup();
      }
    });
  }
});

test("a late reply assigns nothing when the picks no longer pass the check", async () => {
  const t = setup();
  const save = lateWindow(t);
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => void warned.push(args.map(String).join(" "));
  try {
    await assert.rejects(() => t.open(picks("reviewer=claude")), /nothing was assigned/);
    t.deps.presetInstalled = async () => false;
    await save();
    assert.deepEqual(t.assignments(), {});
    assert.match(warned.join("\n"), /not given their roles after a late reply.*preset "claude" \(Claude Code\) is not installed/s);
  } finally {
    console.warn = warn;
    t.cleanup();
  }
});

panesTest("a picked pane that closed before it got its role is reported, with no window error", async (t) => {
  const list = t.deps.listProjects;
  // The first read is the check's; pane-x is closed by the next one.
  let reads = 0;
  t.deps.listProjects = async () =>
    (await list()).map((p) => (++reads === 1 ? p : { ...p, tabs: p.tabs.filter((tab) => tab.id !== "pane-x") }));
  await assert.rejects(
    () => t.open(picks("reviewer=claude tester=pane-x")),
    /^Error: a picked pane closed before it got its role; reviewer got its new pane \(new-1\); tester got none$/,
  );
  assert.deepEqual(t.assignments(), { reviewer: "new-1" });
  reads = 0;
  await assert.rejects(() => t.open(picks("tester=pane-x")), /^Error: a picked pane closed before it got its role; tester got none$/);
});

panesTest("a released role loses its pane only once every pick passed the check", { assignments: { reviewer: "pane-c", tester: "pane-x" } }, async (t) => {
  await refused(t, "implementer=missing", /preset "missing" \(Missing\) is not installed; nothing was opened$/, { release: ["reviewer"] });
  await refused(t, "", /^team ux-review has no role "qa"; nothing was opened$/, { release: ["qa"] });
  await refused(t, "reviewer=claude", /^role "reviewer" is listed twice; nothing was opened$/, { release: ["reviewer"], replace: true });
  const result = await t.open(picks("implementer=claude"), { release: ["reviewer"] });
  assert.deepEqual(t.assignments(), { tester: "pane-x", implementer: "new-1" });
  assert.deepEqual(result.leftWithoutPane, [], "a role the user released is not reported as lost");
  const only = await t.open([], { release: ["tester"] });
  assert.deepEqual(only, { panes: [], leftWithoutPane: [] });
  assert.deepEqual(t.assignments(), { implementer: "new-1" });
});

panesTest("two opens of one team run in turn: the second is checked against what the first assigned", async (t) => {
  const open = t.deps.openPanes;
  t.deps.openPanes = async (slug, panes) => {
    await new Promise((r) => setTimeout(r, 20));
    await open(slug, panes);
  };
  const [first, second] = await Promise.allSettled([t.open(picks("reviewer=claude")), t.open(picks("reviewer=grok"))]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.match(second.reason.message, /^role "reviewer" already has a live pane \(new-1\)/);
  assert.equal(t.opened.length, 1, "one pane opened");
  assert.deepEqual(t.assignments(), { reviewer: "new-1" });
});

panesTest("two teams opening onto the same pane at once: exactly one gets it", async (t) => {
  const OTHER = TEAM.replace("# ux-review", "# other");
  writeFileSync(join(t.directory, ".aya", "teams", "other.md"), OTHER);
  mkdirSync(join(t.teamHome, "teams", "game", "other"), { recursive: true });
  writeFileSync(join(t.teamHome, "teams", "game", "other", "saved.md"), OTHER);
  const listPresets = t.deps.listPresets;
  t.deps.listPresets = async () => {
    await new Promise((r) => setTimeout(r, 20));
    return listPresets();
  };
  const results = await Promise.allSettled([
    t.open(picks("reviewer=pane-w1")),
    t.open(picks("reviewer=pane-w1"), { team: "other" }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const refused = results.find((r) => r.status === "rejected");
  assert.match(refused.reason.message, /plays reviewer.*add --replace/);
  const other = new TeamStore(teamDir(t.teamHome, "game", "other"));
  const holders = [t.assignments(), await other.assignments()].filter((a) => a.reviewer === "pane-w1");
  assert.equal(holders.length, 1, "one role on the pane");
});

const TWO_ROLES = TEAM.replace(/\n## Role: tester[\s\S]*$/, "\n").replace("implementer (what changed)", "reviewer (what changed)").replace("Sends to: tester", "Sends to: reviewer") + "\n## Lead\nreviewer\n";

test("a role removed by a save while its pane opens is not assigned, and the open says so", async () => {
  const { saveTeam } = await import("../dist-electron/team-admin.js");
  const { parseTeamFile } = await import("../dist-electron/team-definition.js");
  const t = setup();
  const open = t.deps.openPanes;
  let saved;
  t.deps.openPanes = async (slug, panes) => {
    await open(slug, panes);
    saved = saveTeam(t.teamHome, t.project, parseTeamFile("ux-review", TWO_ROLES));
    await new Promise((r) => setTimeout(r, 20));
  };
  try {
    await assert.rejects(() => t.open(picks("reviewer=claude tester=claude")), /tester was removed from team ux-review while its panes opened; nothing was assigned/);
    await saved;
    assert.deepEqual(Object.keys(t.assignments()), [], "no role without a definition");
  } finally {
    t.cleanup();
  }
});

panesTest("a window that saved only some tabs before failing: those roles get them, and the error says who did not", async (t) => {
  const open = t.deps.openPanes;
  t.deps.openPanes = async (slug, panes) => {
    await open(slug, panes.slice(0, 1));
    throw new Error("the Aya window did not open the panes in time");
  };
  await assert.rejects(
    () => t.open(picks("reviewer=claude tester=claude implementer=this")),
    /^Error: the Aya window did not open the panes in time; reviewer got its new pane \(new-1\), implementer its pane; tester got none$/,
  );
  assert.deepEqual(t.assignments(), { reviewer: "new-1", implementer: "pane-c" });
});

panesTest("a window that fails to open the panes assigns nothing", async (t) => {
  t.deps.openPanes = async () => {
    throw new Error("project game is not open in an Aya window");
  };
  await assert.rejects(() => t.open(picks("reviewer=this tester=claude")), /not open in an Aya window/);
  assert.deepEqual(t.assignments(), {});
});

panesTest("presets list id, name, agent, whether the CLI is installed and whether a role's pane of it reaches Aya", async (t) => {
  const choices = await presetChoices(t.deps, null);
  assert.deepEqual(choices.slice(0, 3), [
    { id: "shell", name: "Shell", agent: "custom", installed: true, reach: "unknown", cantReach: null },
    { id: "claude", name: "Claude Code", agent: "claude", installed: true, reach: "reaches", cantReach: null },
    { id: "codex", name: "Codex", agent: "codex", installed: true, reach: "reaches", cantReach: null },
  ]);
  assert.deepEqual(choices[4], { id: "missing", name: "Missing", agent: "custom", installed: false, reach: "unknown", cantReach: null });
  assert.deepEqual(choices[5].cantReach, RO_REFUSED);
  assert.equal(
    formatPresets(choices),
    [
      "id        name             agent   installed  reaches aya",
      "shell     Shell            custom  yes        unknown",
      "claude    Claude Code      claude  yes        yes",
      "codex     Codex            codex   yes        yes",
      "grok      Grok             grok    yes        yes",
      "missing   Missing          custom  no         unknown",
      "codex-ro  Codex read-only  codex   yes        no",
      "",
      `codex-ro can't reach Aya: ${RO_REFUSED}`,
      "",
    ].join("\n"),
  );
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
      { role: "reviewer", paneId: "pane-c", name: "Claude Code", preset: null, notReached: null, cantReach: null, note: null },
      { role: "tester", paneId: "new-1", name: "Codex - tester", preset: "Codex", notReached: "runs a shell", cantReach: null, note: null },
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
  const widened = { panes: [{ ...result.panes[0], note: NETWORK_NOTE }], leftWithoutPane: [] };
  assert.match(formatOpened("t", widened, { running: false, paused: false }), new RegExp(`\\(id pane-c\\)\\n    ${NETWORK_NOTE.slice(0, 40)}`));
  assert.match(formatOpened("t", widened, { running: true, paused: false }), /told its role\n    Aya opened it with -c sandbox_workspace_write/);
  const blocked = { panes: [{ role: "implementer", paneId: "pane-x", name: "Codex", preset: null, notReached: null, cantReach: X_BLOCKED, note: null }], leftWithoutPane: [] };
  const told = formatOpened("t", blocked, { running: false, paused: false });
  assert.ok(told.includes(`\n  implementer -> pane "Codex" (id pane-x); ${X_BLOCKED}\n`), told);
});

panesTest("the control request: the caller's project and pane, then the same path", async (t) => {
  const request = { type: "team-open", team: "ux-review", panes: picks("reviewer=this tester=claude"), replace: false };
  const { output } = await handleTeamPanesRequest(request, "pane-c", t.deps);
  assert.match(output, /^team ux-review: gave 2 roles a pane, 1 new:\n  reviewer -> pane "Claude Code" \(id pane-c\)\n  tester -> new pane "Claude Code - tester" \(id new-1\)\n/);
  assert.deepEqual(t.assignments(), { reviewer: "pane-c", tester: "new-1" });
  await assert.rejects(
    () => handleTeamPanesRequest({ ...request, replace: true }, "pane-elsewhere", t.deps),
    /^Error: run aya team open in an Aya pane, or in the directory of a project open in Aya; nothing was opened$/,
  );
  const asked = [];
  const roleLaunch = t.deps.roleLaunch;
  t.deps.roleLaunch = async (preset, project) => (asked.push(project?.slug ?? null), roleLaunch(preset, project));
  await handleTeamPanesRequest({ type: "presets", json: false }, "pane-c", t.deps);
  assert.ok(asked.length > 0 && asked.every((slug) => slug === "game"), "the caller's project config decides its presets' launch modes");
  t.deps.roleLaunch = roleLaunch;
  const presets = await handleTeamPanesRequest({ type: "presets", json: false }, undefined, t.deps);
  assert.match(presets.output, /^id +name +agent +installed +reaches aya\n/);
  const json = await handleTeamPanesRequest({ type: "presets", json: true }, undefined, t.deps);
  assert.deepEqual(JSON.parse(json.output), await presetChoices(t.deps, null));
});

panesTest("the real CLI through the control server: presets and team open, or teams unavailable", async (t) => {
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
  const presets = await run({ teamPanes: t.deps }, ["presets"]);
  assert.equal(presets.status, 0, presets.stderr);
  assert.match(presets.stdout, /^missing +Missing +custom +no +unknown$/m);
  const opened = await run({ teamPanes: t.deps }, ["team", "open", "ux-review", "reviewer=this", "tester=claude"]);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stdout, /tester -> new pane "Claude Code - tester" \(id new-1\)\nStart it in the Teams window, or ask me to\.\n$/);
  const off = await run({}, ["team", "open", "ux-review", "tester=claude"]);
  assert.equal(off.status, 1);
  assert.equal(off.stderr, "aya: teams are not available\n");
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
  const slow = [];
  const timeout = await requests.ask((id) => slow.push(id), 20).catch((err) => err);
  assert.ok(timeout instanceof PaneOpenTimeout);
  requests.answer(slow[0], null);
  await timeout.late;
  const failedLate = [];
  const lateError = await requests.ask((id) => failedLate.push(id), 20).catch((err) => err);
  requests.answer(failedLate[0], "cannot save");
  await assert.rejects(lateError.late, /^Error: cannot save$/);
  const odd = [];
  const oddAnswer = requests.ask((id) => odd.push(id), 1_000);
  requests.answer(odd[0], { not: "a message" });
  await oddAnswer;
  const late = [];
  const timedOut = requests.ask((id) => late.push(id), 20);
  await assert.rejects(timedOut);
  requests.answer(late[0], null);
});

test("a window still loading is refused at once, not after the deadline; a missing or closed one too", async () => {
  const { askWindowToOpenPanes } = await import("../dist-electron/team-panes.js");
  const requests = new RendererRequests();
  const sent = [];
  const win = (loading, destroyed = false) => ({
    isDestroyed: () => destroyed,
    webContents: { isLoading: () => loading, send: (channel, request) => void sent.push({ channel, request }) },
  });
  const panes = [{ id: "new-1", presetId: "claude", name: "Claude Code - tester" }];
  const started = Date.now();
  await assert.rejects(askWindowToOpenPanes(win(true), requests, "game", panes), {
    message: "the Aya window of project game is still loading; run it again in a moment",
  });
  assert.ok(Date.now() - started < 1_000, "no wait for the deadline");
  await assert.rejects(askWindowToOpenPanes(null, requests, "game", panes), { message: "project game is not open in an Aya window" });
  await assert.rejects(askWindowToOpenPanes(win(false, true), requests, "game", panes), { message: "project game is not open in an Aya window" });
  assert.deepEqual(sent, []);
  const asked = askWindowToOpenPanes(win(false), requests, "game", panes);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "teams:open-panes");
  assert.deepEqual({ ...sent[0].request, requestId: "id" }, { requestId: "id", projectSlug: "game", panes });
  requests.answer(sent[0].request.requestId, null);
  await asked;
});

test("the Teams window's select values are main's explicit targets", async () => {
  const view = await import("../dist-test/team-view.js");
  const { NEW_TARGET, PANE_TARGET } = await import("../dist-electron/team-panes.js");
  assert.equal(view.NEW_PANE_PREFIX, NEW_TARGET);
  assert.equal(view.PANE_PREFIX, PANE_TARGET);
});

const READINESS = {
  "every role ready": { assignments: { reviewer: "pane-c", implementer: "pane-x", tester: "pane-w1" } },
  "a role held": { assignments: { reviewer: "pane-c", implementer: "pane-x", tester: "pane-w1" }, holds: (p) => (p === "pane-x" ? "shows an approval prompt" : null) },
  "a role without a pane": { assignments: { reviewer: "pane-c", tester: "pane-w1" } },
};

test("aya team start: team state x readiness, through the Teams window's Start", async (s) => {
  for (const [teamState, state] of Object.entries(TEAM_STATES)) {
    for (const [readiness, options] of Object.entries(READINESS)) {
      await s.test(`${teamState}, ${readiness}`, async () => {
        const t = setup({ state, ...options });
        // From pane-w2, a pane with no role: the user's start.
        const start = () => handleTeamPanesRequest({ type: "team-start", team: "ux-review" }, "pane-w2", t.deps);
        try {
          if (teamState === "running") {
            await assert.rejects(start, /^Error: team ux-review is already running; nothing was sent$/);
            assert.equal(t.typed.length, 0);
            return;
          }
          if (readiness === "every role ready") {
            assert.equal((await start()).output, "started team ux-review; delivery test written to reviewer, implementer, tester\n");
            assert.equal(t.typed.length, 3);
            assert.deepEqual(await t.store.state(), { paused: false, running: true });
            return;
          }
          const why = readiness === "a role held" ? "implementer: shows an approval prompt" : "implementer: no pane assigned";
          await assert.rejects(start, new RegExp(`^Error: team ux-review was not started, nothing was sent; ${why}$`));
          assert.equal(t.typed.length, 0);
          assert.equal((await t.store.state()).running, false);
        } finally {
          t.cleanup();
        }
      });
    }
  }
});

panesTest("aya team start refuses outside a project and for a team that is not there", async (t) => {
  await assert.rejects(
    () => handleTeamPanesRequest({ type: "team-start", team: "ux-review" }, "pane-elsewhere", t.deps),
    /^Error: run aya team start in an Aya pane, or in the directory of a project open in Aya; nothing was sent$/,
  );
  await assert.rejects(
    () => handleTeamPanesRequest({ type: "team-start", team: "nope" }, "pane-c", t.deps),
    /^Error: no team "nope" in this project; its teams: ux-review; nothing was sent$/,
  );
});

test("who gets the task: --to, else the cadence role, else the first role; an unknown --to starts nothing", async (s) => {
  const { taskRecipient } = await import("../dist-electron/team-runner.js");
  const { parseTeamFile } = await import("../dist-electron/team-definition.js");
  const plain = parseTeamFile("ux-review", TEAM);
  const paced = parseTeamFile("ux-review", `${TEAM}\n## Cadence\ntester every 30 min\n`);
  const rows = [
    ["no cadence, no --to", plain, undefined, "reviewer"],
    ["cadence, no --to", paced, undefined, "tester"],
    ["no cadence, --to", plain, "implementer", "implementer"],
    ["cadence, --to", paced, "implementer", "implementer"],
    ["no cadence, unknown --to", plain, "qa", /^team ux-review has no role "qa"; its roles: reviewer, implementer, tester; nothing was started$/],
    ["cadence, unknown --to", paced, "qa", /^team ux-review has no role "qa"/],
  ];
  for (const [name, team, to, expected] of rows) {
    await s.test(name, () => {
      if (expected instanceof RegExp) assert.throws(() => taskRecipient(team, to), { message: expected });
      else assert.equal(taskRecipient(team, to), expected);
    });
  }
});

test("aya team start with a task: team state x task x a role held; the task goes only to a started team", async (s) => {
  const readiness = { "every role ready": READINESS["every role ready"], "a role held": READINESS["a role held"] };
  for (const [teamState, state] of Object.entries(TEAM_STATES)) {
    for (const task of [undefined, "fix the login"]) {
      for (const [ready, options] of Object.entries(readiness)) {
        await s.test(`${teamState}, ${task ? "a task" : "no task"}, ${ready}`, async () => {
          const t = setup({ state, ...options });
          const start = () => handleTeamPanesRequest({ type: "team-start", team: "ux-review", ...(task ? { task } : {}) }, "pane-w2", t.deps);
          const taskMessages = () => t.typed.filter((m) => m.text.includes("fix the login"));
          try {
            if (teamState === "running" || ready === "a role held") {
              await assert.rejects(start);
              assert.deepEqual(taskMessages(), [], "no task without a start");
              return;
            }
            const { output } = await start();
            assert.equal(output.endsWith(task ? "; task sent to reviewer\n" : "tester\n"), true, output);
            if (!task) return assert.deepEqual(taskMessages(), []);
            assert.equal(taskMessages().length, 1);
            assert.equal(taskMessages()[0].pane, "pane-c");
            assert.match(taskMessages()[0].text, /^\[team ux-review \| from user \| \d\d:\d\d\] fix the login$/);
            const log = await t.store.log();
            assert.equal(log.at(-1).from, "user");
            assert.equal(log.at(-1).to, "reviewer");
          } finally {
            t.cleanup();
          }
        });
      }
    }
  }
});

test("aya team start: a typed-only task is in the composer, not the inbox", async () => {
  const { PaneHeldError } = await import("../dist-electron/team-control.js");
  const rows = [
    ["typed, Enter withheld", new PaneHeldError("shows an approval prompt", true), /task for reviewer is typed in its composer, Enter withheld: shows an approval prompt/],
    ["held before typing", new PaneHeldError("shows an approval prompt"), /task for reviewer waits in its inbox: shows an approval prompt/],
  ];
  for (const [name, error, expected] of rows) {
    const t = setup({ ...READINESS["every role ready"], deliver: async (pane, text) => { if (text.includes("fix the login")) throw error; } });
    try {
      const { output } = await handleTeamPanesRequest({ type: "team-start", team: "ux-review", task: "fix the login" }, "pane-c", t.deps);
      assert.match(output, expected, name);
      if (name.startsWith("typed")) assert.doesNotMatch(output, /inbox/, name);
    } finally {
      t.cleanup();
    }
  }
});

test("Start's result names the logged message of a held task, so the window can tell when it went in", async () => {
  const { PaneHeldError } = await import("../dist-electron/team-control.js");
  const t = setup({ ...READINESS["every role ready"], deliver: async (pane, text) => { if (text.includes("fix the login")) throw new PaneHeldError("has text the user is typing"); } });
  try {
    const result = await t.deps.start("game", "ux-review", { text: "fix the login" });
    const logged = (await t.store.log()).find((m) => m.from === "user");
    assert.equal(result.task.held, "has text the user is typing");
    assert.equal(logged.delivered, false);
    assert.equal(result.task.messageId, logged.id);
  } finally {
    t.cleanup();
  }
});

panesTest("aya team start --to an unknown role starts nothing", { ...READINESS["every role ready"] }, async (t) => {
  await assert.rejects(
    () => handleTeamPanesRequest({ type: "team-start", team: "ux-review", task: "x", to: "qa" }, "pane-c", t.deps),
    /^Error: team ux-review has no role "qa"; its roles: reviewer, implementer, tester; nothing was started$/,
  );
  assert.equal(t.typed.length, 0);
  assert.equal((await t.store.state()).running, false);
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const gate = () => {
  let open;
  return { wait: new Promise((r) => (open = r)), open };
};

test("an open waits for a running save of the team before it assigns", async () => {
  const { whileTeamNotSaved } = await import("../dist-electron/team-admin.js");
  const { teamFile } = await import("../dist-electron/team-files.js");
  const t = setup();
  const save = gate();
  const saving = whileTeamNotSaved(teamFile(t.project, "ux-review"), () => save.wait);
  try {
    const opening = t.open(picks("reviewer=claude"));
    await pause(100);
    assert.deepEqual(t.assignments(), {}, "nothing assigned while a save runs");
    save.open();
    await saving;
    await opening;
    assert.deepEqual(t.assignments(), { reviewer: "new-1" });
  } finally {
    save.open();
    t.cleanup();
  }
});

test("a late reply waits for the project's other opens and assigns before it gives roles", async () => {
  const { whileProjectPanesFree } = await import("../dist-electron/team-panes.js");
  const t = setup();
  const completed = gate();
  t.deps.expectRoles = () => completed.open;
  const save = lateWindow(t);
  const busy = gate();
  try {
    await assert.rejects(() => t.open(picks("reviewer=claude")), /nothing was assigned/);
    const other = whileProjectPanesFree("game", () => busy.wait);
    await save();
    assert.deepEqual(t.assignments(), {}, "nothing assigned while another open runs");
    busy.open();
    await other;
    // The late path releases its expected roles after assigning and introducing.
    await completed.wait;
    assert.deepEqual(t.assignments(), { reviewer: "new-1" });
  } finally {
    busy.open();
    t.cleanup();
  }
});

test("a UI assign waits for a running open of the project", async () => {
  const { whileProjectPanesFree, assignRoleLocked } = await import("../dist-electron/team-panes.js");
  const t = setup();
  const busy = gate();
  try {
    const other = whileProjectPanesFree("game", () => busy.wait);
    const assigning = assignRoleLocked(t.deps, "game", "ux-review", "tester", "pane-w1");
    await pause(100);
    assert.deepEqual(t.assignments(), {}, "not assigned while an open runs");
    busy.open();
    await Promise.all([other, assigning]);
    assert.deepEqual(t.assignments(), { tester: "pane-w1" });
  } finally {
    busy.open();
    t.cleanup();
  }
});

test("a UI assign waits for a running save of the team", async () => {
  const { whileTeamNotSaved } = await import("../dist-electron/team-admin.js");
  const { teamFile } = await import("../dist-electron/team-files.js");
  const { assignRoleLocked } = await import("../dist-electron/team-panes.js");
  const t = setup();
  const save = gate();
  try {
    const saving = whileTeamNotSaved(teamFile(t.project, "ux-review"), () => save.wait);
    const assigning = assignRoleLocked(t.deps, "game", "ux-review", "tester", "pane-w1");
    await pause(100);
    assert.deepEqual(t.assignments(), {}, "not assigned while a save runs");
    save.open();
    await Promise.all([saving, assigning]);
    assert.deepEqual(t.assignments(), { tester: "pane-w1" });
  } finally {
    save.open();
    t.cleanup();
  }
});

test("a UI release of a closed pane waits for a running open of the project", async () => {
  const { whileProjectPanesFree, releasePaneLocked } = await import("../dist-electron/team-panes.js");
  const t = setup({ assignments: { tester: "pane-w1" } });
  const busy = gate();
  try {
    const other = whileProjectPanesFree("game", () => busy.wait);
    const releasing = releasePaneLocked(t.deps, "game", "pane-w1");
    await pause(100);
    assert.deepEqual(t.assignments(), { tester: "pane-w1" }, "not released while an open runs");
    busy.open();
    await Promise.all([other, releasing]);
    assert.deepEqual(t.assignments(), {});
  } finally {
    busy.open();
    t.cleanup();
  }
});

// The repo file was removed on purpose: the saved copy is still the team, for the CLI too.
const removeRepoFile = (t) => rmSync(join(t.directory, ".aya", "teams", "ux-review.md"));

panesTest("aya team start on a running team whose repo file is gone says it is running, not missing", { state: TEAM_STATES.running, assignments: { reviewer: "pane-c", implementer: "pane-x", tester: "pane-w1" } }, async (t) => {
  removeRepoFile(t);
  await assert.rejects(() => handleTeamPanesRequest({ type: "team-start", team: "ux-review" }, "pane-w2", t.deps), /^Error: team ux-review is already running; nothing was sent$/);
});

panesTest("aya team start and open run a stopped team from its saved copy when the repo file is gone", { assignments: { reviewer: "pane-c", implementer: "pane-x", tester: "pane-w1" } }, async (t) => {
  removeRepoFile(t);
  const started = await handleTeamPanesRequest({ type: "team-start", team: "ux-review" }, "pane-c", t.deps);
  assert.match(started.output, /^started team ux-review; delivery test written to reviewer, implementer, tester\n/);
  const opened = await handleTeamPanesRequest({ type: "team-open", team: "ux-review", panes: picks("tester=this"), replace: true }, "pane-c", t.deps);
  assert.match(opened.output, /^team ux-review: gave 1 role a pane/);
});

panesTest("a pane playing a role in a team with no repo file is not taken silently", async (t) => {
  const docs = new TeamStore(teamDir(t.teamHome, "game", "docs"));
  await docs.saveDefinition("# docs\n\n## Role: writer\nSends to: reviewer\nMust not: x\n");
  await docs.assign("writer", "pane-x");
  await refused(t, "reviewer=pane-x", /^pane "Codex" plays writer in team docs; add --replace to move it/);
});

test("new panes are expected with their roles while the window opens them, and forgotten after, failure included", async () => {
  for (const fails of [false, true]) {
    const t = setup();
    try {
      const log = [];
      t.deps.expectRoles = (roles) => (log.push(["expect", roles]), () => log.push(["forget"]));
      const open = t.deps.openPanes;
      t.deps.openPanes = async (slug, panes) => {
        log.push(["open"]);
        if (fails) throw new Error("window closed");
        return open(slug, panes);
      };
      await t.open(picks("reviewer=claude tester=new:codex")).catch((err) => { if (!fails) throw err; });
      assert.deepEqual(log.map(([what]) => what), ["expect", "open", "forget"], fails ? "failed" : "ok");
      assert.deepEqual(log[0][1], [
        { ptyId: "new-1", team: "ux-review", role: "reviewer" },
        { ptyId: "new-2", team: "ux-review", role: "tester" },
      ]);
    } finally {
      t.cleanup();
    }
  }
});

panesTest("a window that misses the deadline: the roles stay expected until its late reply is handled", async (t) => {
  const log = [];
  t.deps.expectRoles = () => (log.push("expect"), () => log.push("forget"));
  const save = lateWindow(t);
  await assert.rejects(() => t.open(picks("reviewer=claude")), /did not open the panes in time/);
  assert.deepEqual(log, ["expect"], "still expected: the pane can spawn after the deadline");
  await save();
  assert.deepEqual(log, ["expect", "forget"]);
});
