// The role note reaches a pane whose role is written as it spawns (aya team open, Apply panes); a pane
// whose role changes later shows that its CLI still holds the old note (or none).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { ARGV_DUMP_COMMAND } from "./helpers/agent-bin";
import { envWithoutAya } from "./helpers/env";
import { AYA, HERMETIC_SHELL, openTeams, teamSeed, BARE_TEAM } from "./helpers/team";
import { firstTerminalShown } from "./helpers/terminal";
import { AGENT_START_TIMEOUT_MS, AGENT_TEST_TIMEOUT_MS } from "./timeouts";

test.describe.configure({ timeout: AGENT_TEST_TIMEOUT_MS });

const NOTE = /tester in the Aya team ux-review/;
const AGENTS = ["claude", "grok", "opencode", "codex"] as const;

const presets = (agent: string) =>
  ["shell", "fresh"].map((id) => ({ id, name: `Fake ${agent}`, icon: "$", color: "", agent, command: ARGV_DUMP_COMMAND }));

const cli = (ayaHome: string) => {
  const env = { ...envWithoutAya(), AYA_SOCKET: join(ayaHome, "aya.sock"), AYA_TERMINAL_ID: "tab-left" };
  return (args: string[]) => spawnSync(AYA, args, { env, encoding: "utf8" });
};

type Dump = { args: string[]; opencodeConfigContent: string | null; opencodeConfig: string | null };
const dumpOf = (dir: string, id: string): Dump | null => {
  const file = join(dir, `argv-${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
};

/** Everything the CLI was told at launch: argv, plus the files OpenCode's config names. */
function told(dump: Dump): string {
  const configs = [dump.opencodeConfig && readFileSync(dump.opencodeConfig, "utf8"), dump.opencodeConfigContent].filter(Boolean) as string[];
  const files = configs.flatMap((c) => (JSON.parse(c).instructions as string[]).map((f) => readFileSync(f, "utf8")));
  return [...dump.args, ...files].join("\n");
}

for (const agent of AGENTS) {
  test.describe(`${agent}: role written while the pane spawns`, () => {
    // The role is saved 4 s after the panes open, so the pane spawns first.
    test.use(
      teamSeed(BARE_TEAM, {
        presetList: presets(agent),
        assignments: null,
        seed: { ...HERMETIC_SHELL, launchEnv: { ...HERMETIC_SHELL.launchEnv, AYA_E2E_ASSIGN_DELAY_MS: "4000" } },
      }),
    );

    test("aya team open: the new pane carries its role note", async ({ window, seeded }) => {
      await firstTerminalShown(window);
      const opened = cli(seeded.ayaHome)(["team", "open", "ux-review", "tester=new:fresh"]);
      const id = /\(id (\S+)\)/.exec(opened.stdout)?.[1] ?? "";
      expect(id, opened.stdout + opened.stderr).not.toBe("");
      await expect.poll(() => dumpOf(seeded.projectDir, id) !== null, { timeout: AGENT_START_TIMEOUT_MS }).toBe(true);
      expect(told(dumpOf(seeded.projectDir, id)!)).toMatch(NOTE);
      const card = (await openTeams(window)).getByTestId("team-ux-review");
      await expect(card.getByLabel("tester role note")).toHaveCount(0);
    });
  });
}

const LOGIN_SHELL = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";

// The rc file takes over 5 s, still under the 20 s a spawn waits for the login shell's env (LOGIN_ENV_TIMEOUT).
const RC_SECONDS = 6;
test.describe(`opencode with a login shell that takes ${RC_SECONDS} s to start`, () => {
  test.use(
    teamSeed(BARE_TEAM, {
      presetList: presets("opencode"),
      assignments: null,
      seed: { homeFiles: { ".zshrc": `sleep ${RC_SECONDS}\n`, ".bash_profile": `sleep ${RC_SECONDS}\n` }, launchEnv: { SHELL: LOGIN_SHELL } },
    }),
  );

  test("aya team open: the pane still carries its role note", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    const opened = cli(seeded.ayaHome)(["team", "open", "ux-review", "tester=new:fresh"]);
    const id = /\(id (\S+)\)/.exec(opened.stdout)?.[1] ?? "";
    expect(id, opened.stdout + opened.stderr).not.toBe("");
    await expect.poll(() => dumpOf(seeded.projectDir, id) !== null, { timeout: AGENT_START_TIMEOUT_MS }).toBe(true);
    expect(told(dumpOf(seeded.projectDir, id)!)).toMatch(NOTE);
  });
});

test.describe("role given or changed while panes run", () => {
  test.use(teamSeed(BARE_TEAM, { presetList: presets("claude"), assignments: null, seed: HERMETIC_SHELL }));

  test("a running pane given a role says it started without the note, and moving the role marks the old pane", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    for (const id of ["tab-left", "tab-right"]) {
      await expect.poll(() => dumpOf(seeded.projectDir, id) !== null, { timeout: AGENT_START_TIMEOUT_MS }).toBe(true);
    }
    const aya = cli(seeded.ayaHome);
    aya(["team", "open", "ux-review", "tester=pane:tab-right"]);
    const card = (await openTeams(window)).getByTestId("team-ux-review");
    await expect(card.getByLabel("tester role note")).toContainText("started before it had this role");
    await expect(card.getByLabel("tester role note")).toContainText("aya team whoami");

    aya(["team", "open", "ux-review", "--replace", "tester=pane:tab-left"]);
    await expect(card.getByLabel("tester role note")).toContainText("started before it had this role");
  });
});

for (const agent of AGENTS) {
  test.describe(`${agent}: a running pane Aya has no launch record of`, () => {
    test.use(teamSeed(BARE_TEAM, { presetList: presets(agent), assignments: null, seed: HERMETIC_SHELL }));

    test("given a role, it says it started before Aya recorded what it was told", async ({ window, seeded }) => {
      await firstTerminalShown(window);
      await expect.poll(() => dumpOf(seeded.projectDir, "tab-right") !== null, { timeout: AGENT_START_TIMEOUT_MS }).toBe(true);
      rmSync(join(seeded.ayaHome, "pane-launch-roles.json"), { force: true });
      cli(seeded.ayaHome)(["team", "open", "ux-review", "tester=pane:tab-right"]);
      const card = (await openTeams(window)).getByTestId("team-ux-review");
      await expect(card.getByLabel("tester role note")).toContainText("started before Aya recorded what it was told");
    });
  });
}

test.describe("a pane launched with a role that is then taken away", () => {
  test.use(teamSeed(BARE_TEAM, { presetList: presets("claude"), assignments: { tester: "tab-right" }, seed: HERMETIC_SHELL }));

  test("the Teams window marks the pane that still carries the old note", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    await expect.poll(() => dumpOf(seeded.projectDir, "tab-right") !== null, { timeout: AGENT_START_TIMEOUT_MS }).toBe(true);
    expect(told(dumpOf(seeded.projectDir, "tab-right")!)).toMatch(NOTE);
    cli(seeded.ayaHome)(["team", "open", "ux-review", "--replace", "tester=pane:tab-left"]);
    const card = (await openTeams(window)).getByTestId("team-ux-review");
    await expect(card.getByLabel("stale role notes")).toContainText("still carries the role note of tester");
  });
});

test.describe("a pane that is re-mounted while it runs", () => {
  test.use(teamSeed(BARE_TEAM, { presetList: presets("claude"), assignments: { tester: "tab-right" }, seed: HERMETIC_SHELL }));

  test("a reload does not make the pane look as if it had been started again", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    await expect.poll(() => dumpOf(seeded.projectDir, "tab-right") !== null, { timeout: AGENT_START_TIMEOUT_MS }).toBe(true);
    cli(seeded.ayaHome)(["team", "open", "ux-review", "--replace", "tester=pane:tab-left"]);
    const stale = () => openTeams(window).then((teams) => teams.getByTestId("team-ux-review").getByLabel("stale role notes"));
    await expect(await stale()).toContainText("still carries the role note of tester");

    const replays = () => (existsSync(join(seeded.ayaHome, "pty-events.log")) ? readFileSync(join(seeded.ayaHome, "pty-events.log"), "utf8") : "");
    await window.reload();
    await firstTerminalShown(window);
    await expect.poll(() => /spawn-replay[^\n]*tab-right/.test(replays()), { timeout: AGENT_START_TIMEOUT_MS }).toBe(true);
    await expect(await stale()).toContainText("still carries the role note of tester");
  });
});
