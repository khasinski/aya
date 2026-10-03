// `aya team pause "why"` from the lead's pane pauses the team as the Pause button does, and the log says who and
// why. Anyone else, and a team that is not running, is refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { teamProject } from "./helpers/team.mjs";
import { envWithoutAya } from "./helpers/env.mjs";
import { CLI_SHELLS, shellOptions } from "./helpers/cli-shells.mjs";

const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");
const { parseControlRequest, TEAM_MESSAGE_MAX_CHARS } = await import("../dist-electron/control-protocol.js");
const { startControlServerOn } = await import("../dist-electron/control.js");

const cli = resolve("bin/aya");
const ROLES = `## Role: boss
Sends to: worker (the next step)
Must not: edit code

## Role: worker
Sends to: boss (the result)
Must not: skip a report
`;
const FILES = {
  "lead boss": `# ux-review\n\n${ROLES}\n## Lead\nboss\n`,
  "lead worker": `# ux-review\n\n${ROLES}\n## Lead\nworker\n`,
  "cadence boss, no Lead": `# ux-review\n\n${ROLES}\n## Cadence\nboss every 3 min\n`,
  "no lead": `# ux-review\n\n${ROLES}`,
};

async function setup(file, state) {
  const tabs = [{ id: "pane-b" }, { id: "pane-w" }, { id: "pane-x" }];
  const t = teamProject("aya-lead-pause-", { teamFile: file, tabs });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("boss", "pane-b");
  await store.assign("worker", "pane-w");
  if (state === "running") await store.setPaused(false);
  if (state === "paused") {
    await store.setPaused(false);
    await store.setPaused(true);
  }
  const paused = [];
  const deps = { teamHome: t.teamHome, listProjects: async () => [t.project], deliver: async () => {}, headCommit: async () => null, holdReason: async () => null };
  const pause = async (slug, name) => {
    paused.push(`${slug}/${name}`);
    await store.setPaused(true);
  };
  const call = (pane, text) => handleTeamRequest({ type: "team-pause", ...(text === undefined ? {} : { text }) }, pane, deps, pause);
  return { ...t, store, paused, call, deps };
}

const leadTest = (name, ...args) => {
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

// team file x caller pane x team state x reason -> refused (message) or paused
const ROWS = [
  ["lead boss", "pane-b", "running", "no lower complexity is possible", "paused"],
  ["lead boss", "pane-b", "running", undefined, "paused"],
  ["lead boss", "pane-w", "running", "I am done", /only the lead \(boss\) can pause the team/],
  ["lead boss", "pane-x", "running", "I am done", /no team role/],
  ["lead worker", "pane-w", "running", "done", "paused"],
  ["lead worker", "pane-b", "running", "done", /only the lead \(worker\) can pause the team/],
  ["cadence boss, no Lead", "pane-b", "running", "done", "paused"],
  ["cadence boss, no Lead", "pane-w", "running", "done", /only the lead \(boss\) can pause the team/],
  ["no lead", "pane-b", "running", "done", /has no lead; pause it in the Teams window/],
  ["lead boss", "pane-b", "paused", "done", "already"],
  ["lead boss", "pane-b", "never", "done", /is not running; nothing to pause/],
];

for (const [file, pane, state, reason, want] of ROWS) {
  leadTest(`team pause: ${file}, from ${pane}, team ${state}, reason ${reason ?? "(none)"}`, FILES[file], state, async (t) => {
    if (want instanceof RegExp) {
      await assert.rejects(() => t.call(pane, reason), want);
      assert.deepEqual(t.paused, [], "refused: nothing paused");
      assert.deepEqual((await t.store.state()).paused, state === "paused");
      return;
    }
    const { output } = await t.call(pane, reason);
    if (want === "already") {
      assert.match(output, /already paused/);
      assert.deepEqual(t.paused, [], "nothing to do twice");
      return;
    }
    assert.deepEqual(t.paused, ["game/ux-review"]);
    assert.equal((await t.store.state()).paused, true);
    assert.match(output, /^team ux-review is paused/);
    const entry = (await t.store.log()).at(-1);
    assert.equal(entry.from, "aya");
    assert.equal(entry.delivered, true, "a record, not owed to anyone's inbox");
    assert.match(entry.text, new RegExp(`^${file.endsWith("worker") ? "worker" : "boss"} \\(the lead\\) paused the team${reason ? `: ${reason}` : "\\.?$"}`));
    assert.deepEqual(await t.store.unread("boss"), []);
    assert.deepEqual(await t.store.unread("worker"), []);
  });
}

test("the request: parsed with an optional reason, capped like a message", () => {
  assert.deepEqual(parseControlRequest({ type: "team-pause" }), { type: "team-pause" });
  assert.deepEqual(parseControlRequest({ type: "team-pause", text: "done" }), { type: "team-pause", text: "done" });
  assert.throws(() => parseControlRequest({ type: "team-pause", text: "x".repeat(TEAM_MESSAGE_MAX_CHARS + 1) }), /characters, the most is/);
});

leadTest("whoami tells the lead how to end the team, and nobody else", FILES["lead boss"], "running", async (t) => {
  const lead = (await handleTeamRequest({ type: "team-whoami" }, "pane-b", t.deps)).output;
  const other = (await handleTeamRequest({ type: "team-whoami" }, "pane-w", t.deps)).output;
  assert.match(lead, /aya team pause "/);
  assert.doesNotMatch(other, /aya team pause/);
});

leadTest("a real runner: after the lead pauses, no round is typed and Resume is the way back", FILES["lead boss"], "running", async (t) => {
  const typed = [];
  const jobs = [];
  const fake = (fn, ms) => {
    const job = { fn, ms, cancelled: false };
    jobs.push(job);
    return () => (job.cancelled = true);
  };
  const runner = new TeamRunner({ ...t.deps, deliver: async (pane, text) => void typed.push({ pane, text }) }, fake, Date.now);
  await runner.resume("game", "ux-review");
  assert.ok(jobs.length > 0 && jobs.every((j) => !j.cancelled), "armed");
  await handleTeamRequest({ type: "team-pause", text: "done" }, "pane-b", t.deps, (slug, name) => runner.pause(slug, name));
  assert.ok(jobs.every((j) => j.cancelled), "the timers are cancelled");
  for (const job of jobs) await job.fn();
  assert.deepEqual(typed, [], "a timer that still fires types nothing");
  await runner.resume("game", "ux-review");
  assert.equal((await t.store.state()).running, true);
  runner.stopAll();
});

for (const shell of CLI_SHELLS) {
  test(`through the real CLI and control server: aya team pause (${shell})`, shellOptions(shell), async () => {
    const t = await setup(FILES["lead boss"], "running");
    const socket = join(t.root, "aya.sock");
    const runner = new TeamRunner(t.deps, () => () => {});
    const stop = startControlServerOn(socket, {
      getWindow: () => null,
      openProject: () => {},
      listProjects: t.deps.listProjects,
      readPane: async () => "",
      writePane: async () => {},
      team: t.deps,
      teamRunner: runner,
    });
    const run = (pane, ...args) =>
      new Promise((done, fail) => {
        const child = spawn(shell, [cli, "team", "pause", ...args], { env: { ...envWithoutAya(), AYA_SOCKET: socket, AYA_TERMINAL_ID: pane } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => (stdout += c));
        child.stderr.on("data", (c) => (stderr += c));
        child.on("error", fail);
        child.on("close", (status) => done({ status, stdout, stderr }));
      });
    try {
      const refused = await run("pane-w", "done");
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /only the lead \(boss\) can pause/);
      assert.equal((await t.store.state()).paused, false);
      const ok = await run("pane-b", "no", "lower", "complexity");
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /team ux-review is paused/);
      assert.equal((await t.store.state()).paused, true);
      assert.match((await t.store.log()).at(-1).text, /paused the team: no lower complexity$/);
    } finally {
      stop();
      runner.stopAll();
      t.cleanup();
    }
  });
}
