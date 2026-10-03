// The login shell is slow under load (20 parallel: 2.4-4.8 s each, past the limit): a shell that
// does not answer in time leaves names unknown, never missing, and nothing of it is saved.

import { describe, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// These cases change process.env, cwd and module caches. A fresh guarded Node
// child per case isolates all three while keeping the original assertion body.
const selectedCase = process.env.AYA_PROBE_CASE;
const test = (name, fn) => {
  if (selectedCase !== undefined) return name === selectedCase ? nodeTest(name, fn) : undefined;
  return nodeTest(name, async () => {
    const home = mkdtempSync("/tmp/aya-spdI-probe-");
    const env = { ...process.env, HOME: home, AYA_HOME: path.join(home, "aya"), AYA_PROBE_CASE: name, AYA_PROBE_IDLE_SHELL: shells.idle, AYA_PROBE_LOADED_SHELL: shells.loaded };
    for (const key of ["CI", "AYA_SOCKET", "AYA_TERMINAL_ID", "AYA_PROJECT_SLUG", "AYA_PRESET_ID", "AYA_DEV", "NODE_TEST_CONTEXT"]) delete env[key];
    try {
      const output = await new Promise((resolve, reject) => {
        execFile(process.execPath, ["--import", new URL("./helpers/preload-guard.mjs", import.meta.url).pathname, "--test", "--test-reporter=tap", new URL(import.meta.url).pathname], { env }, (err, stdout, stderr) => {
          if (err) reject(new Error(`${name}: ${stdout}\n${stderr}`, { cause: err }));
          else resolve(stdout);
        });
      });
      assert.match(output, /^# tests 1$/m, "the child ran exactly this case");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
};
test.after = nodeTest.after;

const root = mkdtempSync(path.join(tmpdir(), "aya-probe-path-"));
process.env.AYA_HOME = path.join(root, "aya-home");
mkdirSync(process.env.AYA_HOME);
const presetsFile = path.join(process.env.AYA_HOME, "presets.json");
const { commandExists, notePathRepaired, presetInstalled } = await import("../dist-electron/command-probe.js");
const { listPresets, resetPresetsCache } = await import("../dist-electron/presets.js");
const { COMMAND_PROBE_TIMEOUT_MS } = await import("../dist-electron/constants.js");

const pathBin = path.join(root, "path-bin");
const shellBin = path.join(root, "shell-bin");
const calls = path.join(root, "calls");
mkdirSync(pathBin);
mkdirSync(shellBin);
const stub = (dir, name) => {
  writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(dir, name), 0o755);
};
stub(pathBin, "claude");
stub(shellBin, "codex");
// Not executable: the shell would not run it, so it is not installed.
writeFileSync(path.join(pathBin, "gemini"), "#!/bin/sh\n");
chmodSync(path.join(pathBin, "gemini"), 0o644);
// A directory named like a CLI is not one either.
mkdirSync(path.join(pathBin, "aider"));
process.env.PATH = `${pathBin}:/usr/bin:/bin`;

// Logs a call, waits delayMs, runs the -c script with shellBin on PATH (as .zshrc would add it).
const LOADED_MS = COMMAND_PROBE_TIMEOUT_MS + 1_000;
function loginShell(delayMs) {
  const file = path.join(root, `shell-${delayMs}`);
  writeFileSync(
    file,
    `#!/bin/sh\n[ "\${1:-}" != --aya-fixture-ready ] || exit 0\nfor a; do last=$a; done\necho x >> "\$AYA_PROBE_CALLS"\nsleep ${delayMs / 1000}\nPATH="\$AYA_PROBE_SHELL_BIN":$PATH exec /bin/sh -c "$last"\n`,
  );
  chmodSync(file, 0o755);
  return file;
}
const shells = selectedCase === undefined
  ? { idle: loginShell(0), loaded: loginShell(LOADED_MS) }
  : { idle: process.env.AYA_PROBE_IDLE_SHELL, loaded: process.env.AYA_PROBE_LOADED_SHELL };
// Share only executable code. Each child sends the stub to its own log/bin.
process.env.AYA_PROBE_CALLS = calls;
process.env.AYA_PROBE_SHELL_BIN = shellBin;
// Warm only the executable stub: macOS can gate the first exec of a new file.
// Its actual probe path still logs once and waits past the production timeout.
for (const shell of selectedCase === undefined ? Object.values(shells) : []) {
  const ready = spawnSync(shell, ["--aya-fixture-ready"]);
  assert.equal(ready.status, 0, "the fixture shell starts before any probe deadline");
}
const shellCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").length : 0);
const ids = (presets) => presets.map((p) => p.id);
const saved = () => (existsSync(presetsFile) ? ids(JSON.parse(readFileSync(presetsFile, "utf8")).presets) : null);

function setup(latency, repaired) {
  rmSync(calls, { force: true });
  rmSync(presetsFile, { force: true });
  resetPresetsCache();
  process.env.SHELL = shells[latency];
  notePathRepaired(repaired);
}

const SCAN = [
  { latency: "idle", repaired: true, shows: ["claude", "shell"], saves: ["claude", "shell"], shells: 0 },
  { latency: "loaded", repaired: true, shows: ["claude", "shell"], saves: ["claude", "shell"], shells: 0 },
  { latency: "idle", repaired: false, shows: ["claude", "codex", "shell"], saves: ["claude", "codex", "shell"], shells: 1 },
  // codex may be installed: the scan shows what it knows and saves nothing.
  { latency: "loaded", repaired: false, shows: ["claude", "shell"], saves: null, shells: 1 },
];

describe("command probes with isolated processes", { concurrency: 4 }, () => {
  for (const row of SCAN) {
    test(`first launch | shell ${row.latency}, PATH ${row.repaired ? "repaired" : "not repaired"} -> shows ${row.shows.join("+")}, saves ${row.saves?.join("+") ?? "nothing"}, ${row.shells} shell(s)`, async () => {
      setup(row.latency, row.repaired);
      assert.deepEqual(ids(await listPresets()), row.shows);
      assert.deepEqual(saved(), row.saves);
      assert.equal(shellCalls(), row.shells);
    });
  }

  let seq = 0;
  const SPAWN = [];
  for (const latency of ["idle", "loaded"]) {
    for (const repaired of [true, false]) {
      SPAWN.push(
        { latency, repaired, cli: "on PATH", place: pathBin, starts: true, shells: 0 },
        { latency, repaired, cli: "only in the login shell", place: shellBin, starts: true, shells: 1 },
        // A shell past the limit is no proof of absence: the pane's own shell says so if it is.
        { latency, repaired, cli: "missing", place: null, starts: latency === "loaded", shells: 1 },
      );
    }
  }

  for (const row of SPAWN) {
    test(`spawn | ${row.cli}, shell ${row.latency}, PATH ${row.repaired ? "repaired" : "not repaired"} -> ${row.starts ? "starts" : "command not found"}`, async () => {
      const name = `cli-${++seq}`;
      if (row.place) stub(row.place, name);
      setup(row.latency, row.repaired);
      assert.equal(await commandExists(name), row.starts);
      assert.equal(shellCalls(), row.shells);
    });
  }

  test("spawn | an unknown from a shell past the limit is not remembered", async () => {
    const name = `cli-${++seq}`;
    setup("loaded", true);
    assert.equal(await commandExists(name), true);
    setup("idle", true);
    assert.equal(await commandExists(name), false);
  });

  // "node_modules/.bin" in PATH means the pane's dir to its shell; read against Aya's own
  // cwd (the repo under Aya Dev) it would make Aya's own CLIs "installed" for every project.
  test("relative PATH entries | not read against Aya's cwd: the scan skips them, the spawn asks the shell", async () => {
    const relBin = path.join(root, "node_modules", ".bin");
    mkdirSync(relBin, { recursive: true });
    stub(relBin, "codex");
    const name = `cli-${++seq}`;
    stub(relBin, name);
    await inRootWithPath(`node_modules/.bin::.:${pathBin}:/usr/bin:/bin`, async () => {
      setup("idle", true);
      assert.deepEqual(ids(await listPresets()), ["claude", "shell"]);
      assert.equal(shellCalls(), 0);
      setup("idle", true);
      await commandExists(name);
      assert.equal(shellCalls(), 1, "a CLI only in a relative PATH dir is the login shell's call");
    });
  });

  async function inRootWithPath(PATH, fn) {
    const cwd = process.cwd();
    const before = process.env.PATH;
    process.chdir(root);
    process.env.PATH = PATH;
    try {
      await fn();
    } finally {
      process.env.PATH = before;
      process.chdir(cwd);
      rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
    }
  }

  test("spawn | a CLI in a relative PATH dir counts where the pane runs, not where Aya runs", async () => {
    const name = `cli-${++seq}`;
    const withCli = path.join(root, "project-with");
    const without = path.join(root, "project-without");
    for (const dir of [withCli, without]) mkdirSync(dir, { recursive: true });
    for (const dir of [withCli, root]) {
      mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
      stub(path.join(dir, "node_modules", ".bin"), name);
    }
    await inRootWithPath("node_modules/.bin:/usr/bin:/bin", async () => {
      setup("idle", true);
      assert.equal(await commandExists(name, withCli), true, "in the project that has it");
      assert.equal(await commandExists(name, without), false, "in a project without it, though Aya's cwd has it");
      assert.equal(await commandExists(name, path.join(root, "gone")), true, "a pane dir that is not there: Aya's cwd, as before");
    });
  });

  test("spawn | a launcher the shell found is remembered for the process", async () => {
    const name = `cli-${++seq}`;
    stub(shellBin, name);
    setup("idle", true);
    assert.equal(await commandExists(name), true);
    unlinkSync(path.join(shellBin, name));
    assert.equal(await commandExists(name), true);
    assert.equal(shellCalls(), 1);
  });

  test("spawn | a command that is not a plain binary needs no probe", async () => {
    setup("idle", false);
    assert.equal(await presetInstalled({ command: "$SHELL" }), true);
    assert.equal(await presetInstalled({ command: "FOO=1 cli-not-anywhere" }), true);
    assert.equal(shellCalls(), 0);
  });

  test("first launch | an unsaved seed is not scanned again on every poll of the same launch", async () => {
    setup("loaded", false);
    await listPresets();
    assert.deepEqual(ids(await listPresets()), ["claude", "shell"]);
    assert.equal(shellCalls(), 1, "the 30 s polls reuse the seed");
    assert.equal(saved(), null);
  });

  test("first launch | a slow scan is not saved, and the next launch that answers seeds what it finds", async () => {
    setup("loaded", false);
    assert.deepEqual(ids(await listPresets()), ["claude", "shell"]);
    setup("idle", false);
    assert.deepEqual(ids(await listPresets()), ["claude", "codex", "shell"]);
    assert.deepEqual(saved(), ["claude", "codex", "shell"]);
  });

  test.after(() => rmSync(root, { recursive: true, force: true }));

  test("preset list | every preset checked at once asks one login shell for all the names it did not find", async () => {
    const { presetChoices } = await import("../dist-electron/team-panes.js");
    const inShell = `cli-${++seq}`;
    stub(shellBin, inShell);
    const names = ["claude", inShell, ...[1, 2, 3, 4].map(() => `cli-${++seq}`)];
    setup("idle", true);
    const choices = await presetChoices(
      {
        listPresets: async () => names.map((n) => ({ id: n, name: n, icon: "", color: "", command: n })),
        presetInstalled,
        roleLaunch: async () => ({ reach: "unknown", refused: null }),
      },
      null,
    );
    assert.deepEqual(choices.map((c) => c.installed), [true, true, false, false, false, false]);
    assert.equal(shellCalls(), 1);
  });
});
