// An `aya team` call before the window has loaded or the projects are restored is answered from the saved team,
// or refused as retryable: never "belongs to no open project", never lost.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { handleTeamRequest } = await import("../dist-electron/team-control.js");
const { handleTeamPanesRequest, askWindowToOpenPanes, RendererRequests, teamPaneDeps } = await import("../dist-electron/team-panes.js");
const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { HOLD_STARTING } = await import("../dist-electron/pane-holds.js");

const TEAM = `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code

## Role: implementer
Sends to: tester
Must not: skip a report
`;

const PRESETS = [{ id: "claude", name: "Claude Code", icon: "*", color: "", command: "claude" }];

/** What the control server can see of the app in each phase. */
const PHASES = {
  "socket up, no window": { starting: true, window: () => null },
  "window not loaded": { starting: true, window: (send) => ({ isDestroyed: () => false, webContents: { isLoading: () => true, send } }) },
  "projects loading (the project list is still empty)": { starting: true, window: () => null, noProjects: true },
  ready: { starting: false, window: (send) => ({ isDestroyed: () => false, webContents: { isLoading: () => false, send } }) },
};

function setup(phase) {
  const tabs = [{ id: "pane-t", presetId: "claude", name: "Tester" }, { id: "pane-i", presetId: "claude", name: "Implementer" }];
  const t = teamProject("aya-team-starting-", { teamFile: TEAM, tabs });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  mkdirSync(store.dir, { recursive: true });
  writeFileSync(join(store.dir, "assignments.json"), JSON.stringify({ tester: "pane-t", implementer: "pane-i" }));
  let project = t.project;
  const typed = [];
  const requests = new RendererRequests();
  const control = {
    teamHome: t.teamHome,
    listProjects: async () => (phase.noProjects ? [] : [project]),
    deliver: async (pane, text) => void typed.push({ pane, text }),
    headCommit: async () => null,
    holdReason: async () => (phase.starting ? HOLD_STARTING : null),
    starting: () => phase.starting,
  };
  const send = (_channel, request) => {
    project = { ...project, tabs: [...project.tabs, ...request.panes.map((p) => ({ id: p.id, presetId: p.presetId, name: p.name }))] };
    requests.answer(request.requestId, null);
  };
  const host = {
    listPresets: async () => PRESETS,
    presetInstalled: async () => true,
    roleLaunch: async () => ({ reach: "reaches", refused: null }),
    launchBlock: async () => null,
    launchNote: async () => null,
    paneAlive: async () => !phase.starting,
    openPanes: (slug, panes) => askWindowToOpenPanes(phase.window(send), requests, slug, panes, phase.starting),
    newPaneId: () => "new-1",
  };
  const panes = { ...teamPaneDeps(control, host, new TeamRunner(control)), startWaitMs: 200 };
  return { ...t, store, control, panes, typed };
}

const phaseTest = (name, ...args) => {
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

const ENVS = { "restored pane env": "pane-t", "unknown env": "pane-gone" };

const retryable = (err) => err.retryable === true && /Aya is still starting|still loading/.test(err.message);

for (const [phaseName, phase] of Object.entries(PHASES)) {
  for (const [envName, env] of Object.entries(ENVS)) {
    const known = env === "pane-t" && !phase.noProjects;
    const cell = `${phaseName}, ${envName}`;

    for (const type of ["team-whoami", "team-inbox", "team-send"]) {
      phaseTest(`${type}: ${cell}`, phase, async (t) => {
        const request = type === "team-send" ? { type, role: "implementer", text: "early report" } : { type };
        if (type === "team-inbox") await t.store.append({ from: "implementer", to: "tester", commit: null, text: "note for the tester", delivered: false });
        const call = handleTeamRequest(request, env, t.control);
        if (known) {
          const answer = type === "team-send" ? await call.catch((err) => ({ output: err.message })) : await call;
          assert.doesNotMatch(answer.output, /belongs to no open project/);
          if (type === "team-whoami") assert.match(answer.output, /you +tester/);
          if (type === "team-inbox") {
            assert.match(answer.output, /^#\d+ .*note for the tester\n$/);
            assert.deepEqual(await t.store.unread("tester"), [], "reading the inbox marks it read");
          }
          if (type === "team-send") {
            // Kept for the pane, typed now or redelivered later: never lost.
            const kept = (await t.store.unread("implementer")).map((m) => m.text);
            assert.deepEqual(kept, phase.starting ? ["early report"] : []);
            assert.equal(t.typed.length, phase.starting ? 0 : 1);
          }
        } else if (phase.starting) {
          await assert.rejects(call, retryable);
        } else {
          await assert.rejects(call, { message: "this pane belongs to no open project" });
        }
      });
    }

    phaseTest(`team-open: ${cell}`, phase, async (t) => {
      const call = handleTeamPanesRequest({ type: "team-open", team: "ux-review", panes: [{ role: "tester", target: "new:claude" }], replace: true }, env, t.panes);
      if (known && phase.starting) {
        await assert.rejects(call, retryable);
        assert.deepEqual(await t.store.assignments(), { tester: "pane-t", implementer: "pane-i" });
      } else if (known) {
        assert.match((await call).output, /gave 1 role a pane, 1 new/);
      } else if (phase.starting) {
        await assert.rejects(call, retryable);
      } else {
        await assert.rejects(call, /run aya team open in an Aya pane/);
      }
    });

    phaseTest(`team-start: ${cell}`, phase, async (t) => {
      const call = handleTeamPanesRequest({ type: "team-start", team: "ux-review" }, env, t.panes);
      if (known && phase.starting) {
        // Every pane is still starting: nothing is sent, and a retry once they are up starts the team.
        await assert.rejects(call, retryable);
        assert.deepEqual(t.typed, []);
      } else if (known) {
        assert.match((await call).output, /started team ux-review/);
      } else if (phase.starting) {
        await assert.rejects(call, retryable);
      } else {
        await assert.rejects(call, /run aya team start in an Aya pane/);
      }
    });
  }
}
