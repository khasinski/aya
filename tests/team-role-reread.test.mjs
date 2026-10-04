// A Save that changes what `aya team whoami` prints for a role tells that role's running pane to read it again,
// and the Teams window marks the role "started with an older role" until its next whoami (N3.3, finding 9).
// Table: what the save changes x the panes' state x what happens (typed, row note, cleared on whoami).

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");
const { handleTeamAuthorRequest } = await import("../dist-electron/team-author.js");
const { listTeams, saveTeam } = await import("../dist-electron/team-admin.js");
const { parseTeamFile } = await import("../dist-electron/team-definition.js");
const { olderRoleNote } = await import("../dist-test/team-view.js");

const PANES = { tester: "pane-t", implementer: "pane-i" };
const HELD = "shows an approval prompt";

const team = ({ tester = "Plays the game each round.", mustNot = "skip a report", protocol = "Findings are hypotheses.", cadence = 30 } = {}) => `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code
${tester}

## Role: implementer
Sends to: tester (the commit to check)
Must not: ${mustNot}
Fixes each finding.

## Lead
tester

## Cadence
tester every ${cadence} min

## Protocol
${protocol}
`;

const SAVES = [
  ["role A's responsibilities", { tester: "Plays the game and reports each crash." }, ["tester"]],
  ["role B's must-not", { mustNot: "leave a finding unanswered" }, ["implementer"]],
  ["the protocol every role shares", { protocol: "Findings carry a way to check them." }, ["tester", "implementer"]],
  ["nothing whoami prints (the cadence only)", { cadence: 10 }, []],
];
const PANE_STATES = ["present", "missing", "held"];

async function setup(paneState, { start = true } = {}) {
  const { teamHome, project, cleanup } = teamProject("aya-role-reread-", { teamFile: team() });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  for (const [role, pane] of Object.entries(PANES)) await store.assign(role, pane);
  const typed = [];
  const held = new Set();
  const deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void typed.push({ pane, text }),
    holdReason: async (pane) => (held.has(pane) ? HELD : null),
    headCommit: async () => null,
  };
  const runner = new TeamRunner(deps, () => () => {});
  if (start) assert.equal((await runner.start("game", "ux-review")).started, true);
  typed.length = 0;
  if (paneState === "missing") for (const pane of Object.values(PANES)) await store.releasePane(pane);
  if (paneState === "held") for (const pane of Object.values(PANES)) held.add(pane);
  const save = async (change) => runner.refresh("game", "ux-review", await saveTeam(teamHome, project, parseTeamFile("ux-review", team(change)), { fromWindow: true }));
  const older = async () => (await listTeams(teamHome, project)).find((t) => t.name === "ux-review").olderRoles;
  const whoami = (role) => handleTeamRequest({ type: "team-whoami" }, PANES[role], deps);
  return { teamHome, project, store, typed, held, deps, runner, save, older, whoami, cleanup };
}

const toldPanes = (t) => t.typed.filter((w) => /run aya team whoami again/.test(w.text)).map((w) => w.pane).sort();

for (const [saveLabel, change, changed] of SAVES) {
  for (const paneState of PANE_STATES) {
    test(`save changes ${saveLabel} | panes ${paneState}`, async () => {
      const t = await setup(paneState);
      try {
        await t.save(change);
        const expectTyped = paneState === "present" ? changed.map((r) => PANES[r]).sort() : [];
        assert.deepEqual(toldPanes(t), expectTyped, "typed to each changed role whose pane takes it, nobody else");
        assert.ok(t.typed.every((w) => /^\[team ux-review \| from aya \|/.test(w.text)), "a message from aya");

        const noted = paneState === "missing" ? [] : changed;
        const older = await t.older();
        assert.deepEqual(Object.keys(older).sort(), [...noted].sort(), "the row note: changed roles that have a pane");
        for (const role of noted) assert.match(olderRoleNote(older[role]), /^started with an older role: it changed at \d\d:\d\d/);

        const log = await t.store.log();
        const tells = log.filter((m) => m.from === "aya" && /run aya team whoami again/.test(m.text));
        if (paneState === "held") {
          assert.deepEqual(tells.map((m) => [m.to, m.delivered, m.held]).sort(), changed.map((r) => [r, false, HELD]).sort(), "logged as held");
          t.held.clear();
          await t.runner.redeliverWaiting();
          assert.deepEqual(toldPanes(t), [], "dropped: a held tell is never typed later");
        } else {
          assert.deepEqual(tells.map((m) => m.to).sort(), paneState === "present" ? [...changed].sort() : []);
        }

        if (paneState !== "missing") {
          for (const role of changed) {
            const { output } = await t.whoami(role);
            assert.match(output, new RegExp(`you +${role}`));
            assert.equal(role in (await t.older()), false, `${role}'s note clears at its whoami`);
          }
        }
      } finally {
        t.cleanup();
      }
    });
  }
}

test("a second save of the same text tells nobody again, and a pane given the role afresh carries no mark", async () => {
  const t = await setup("present");
  try {
    await t.save(SAVES[0][1]);
    t.typed.length = 0;
    await t.save(SAVES[0][1]);
    assert.deepEqual(toldPanes(t), []);
    assert.deepEqual(Object.keys(await t.older()), ["tester"], "the first change is still unread");
    await t.store.assign("tester", "pane-i");
    assert.deepEqual(Object.keys(await t.older()), [], "a newly assigned pane starts with the current role note");
  } finally {
    t.cleanup();
  }
});

test("a whoami that read the old text before the save does not clear the mark", async () => {
  const t = await setup("present");
  try {
    await t.store.noteWhoami("tester", new Date(Date.now() - 1000).toISOString());
    await t.save(SAVES[0][1]);
    assert.deepEqual(Object.keys(await t.older()), ["tester"]);
  } finally {
    t.cleanup();
  }
});

test("a team that is not running gets nothing typed; the row still says the role is older", async () => {
  const t = await setup("present", { start: false });
  try {
    await t.save(SAVES[2][1]);
    assert.deepEqual(t.typed, []);
    assert.deepEqual(Object.keys(await t.older()).sort(), ["implementer", "tester"]);
  } finally {
    t.cleanup();
  }
});

test("aya team save --replace tells the changed role and says so", async () => {
  const t = await setup("present");
  try {
    const { output } = await handleTeamAuthorRequest(
      { type: "team-save", text: team(SAVES[1][1]), replace: true, projectSlug: "game" },
      undefined,
      t.deps,
      (slug, name, changed) => t.runner.refresh(slug, name, changed),
    );
    assert.match(output, /aya team whoami changed for implementer: Aya tells its pane to run it again while the team runs/);
    assert.deepEqual(toldPanes(t), ["pane-i"]);
  } finally {
    t.cleanup();
  }
});
