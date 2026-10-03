// After a relaunch `aya team inbox` hands over what a peer or the user left held; Aya's own rounds and delivery
// tests go stale and are never handed to the agent hours later.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";

const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");

const TEAM = `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code
Plays the build each round.

## Role: implementer
Sends to: tester
Must not: skip a report
Fixes findings.

## Cadence
tester every 30 min
`;

const ORIGINS = {
  "Aya round": {
    from: "aya",
    text: "Round 3: run your round as the team protocol says.",
    shown: false,
  },
  "Aya delivery test": {
    from: "aya",
    text: "Delivery test: run aya team whoami.",
    shown: false,
  },
  "the user's task": { from: "user", text: "Ship the login fix.", shown: true },
  "a peer's report": {
    from: "tester",
    text: "Finding: the button is off screen.",
    shown: true,
  },
};
const TEAM_STATES = {
  running: (store) => store.setPaused(false),
  paused: async (store) => {
    await store.setPaused(false);
    await store.setPaused(true);
  },
  "never started": async () => {},
};

for (const [origin, { from, text, shown }] of Object.entries(ORIGINS)) {
  for (const [teamState, apply] of Object.entries(TEAM_STATES)) {
    test(`inbox | held by ${origin}, ${teamState} team`, async () => {
      const t = teamProject("aya-inbox-origin-", {
        teamFile: TEAM,
        tabs: [{ id: "pane-t" }, { id: "pane-i" }],
      });
      try {
        const dir = teamDir(t.teamHome, "game", "ux-review");
        const store = new TeamStore(dir);
        await store.assign("tester", "pane-t");
        await store.assign("implementer", "pane-i");
        await apply(store);
        await store.append({
          from,
          to: "implementer",
          commit: null,
          text,
          delivered: false,
          held: "shows an approval prompt",
        });
        // Every request opens the team's files afresh, so this is what a relaunched app reads.
        const deps = {
          teamHome: t.teamHome,
          listProjects: async () => [t.project],
        };
        const read = () =>
          handleTeamRequest({ type: "team-inbox" }, "pane-i", deps);
        const out = (await read()).output;
        assert.equal(
          out.includes(text),
          shown,
          `the entry ${shown ? "is" : "is not"} printed: ${out}`,
        );
        assert.equal(
          (await read()).output,
          "no unread messages\n",
          "whatever was held is marked read either way",
        );
      } finally {
        t.cleanup();
      }
    });
  }
}

test("inbox | a stale Aya round beside a peer's report prints only the report", async () => {
  const t = teamProject("aya-inbox-origin-", {
    teamFile: TEAM,
    tabs: [{ id: "pane-t" }, { id: "pane-i" }],
  });
  try {
    const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
    await store.assign("implementer", "pane-i");
    await store.append({
      from: "aya",
      to: "implementer",
      commit: null,
      text: "Round 3: old",
      delivered: false,
      held: "no pane assigned",
    });
    await store.append({
      from: "tester",
      to: "implementer",
      commit: null,
      text: "peer report",
      delivered: false,
      held: "no pane assigned",
    });
    const out = (
      await handleTeamRequest({ type: "team-inbox" }, "pane-i", {
        teamHome: t.teamHome,
        listProjects: async () => [t.project],
      })
    ).output;
    assert.match(out, /^#2 .*peer report\n$/);
  } finally {
    t.cleanup();
  }
});
