// An e2e that does not ask for a fake HOME still never gets the account's: Aya syncs the
// antigravity rule and the CLI shims under os.homedir() at startup.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function seedModule() {
  const source = readFileSync(join(REPO, "e2e", "helpers", "seed.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  const dir = join(REPO, "e2e", "helpers");
  new Function("require", "module", "exports", "__dirname", outputText)(createRequire(join(dir, "seed.ts")), module, module.exports, dir);
  return module.exports;
}
const loadSeedEnv = () => seedModule().seedEnv;

const ANTIGRAVITY_PRESET = { id: "shell", name: "agy", icon: "$", color: "", agent: "antigravity", agentBrief: true, command: "true" };
const SEEDS = {
  "an antigravity preset with a brief, no fakeHome": { presetList: [ANTIGRAVITY_PRESET] },
  "no options": {},
  "a launchEnv without HOME": { launchEnv: { FOO: "1" } },
  "the PATH repair harness": { pathRepairHarness: true },
  "fake binaries": { fakeBins: ["agy"] },
  "the CLI install harness": { cliInstallHarness: true },
  "Grok credits": { grokCredits: { pct: 5, end: "2026-01-01T00:00:00Z", ts: "2026-01-01T00:00:00Z" } },
};

for (const [name, opts] of Object.entries(SEEDS)) {
  test(`seed: ${name} launches Aya with a HOME inside the seeded root`, () => {
    const seeded = loadSeedEnv()(opts);
    try {
      const home = seeded.launchEnv?.HOME;
      assert.ok(home, "HOME is not set for the launch, so Aya gets the account's");
      assert.ok(home.startsWith(seeded.root + "/"), `${home} is outside ${seeded.root}`);
    } finally {
      rmSync(seeded.root, { recursive: true, force: true });
    }
  });
}

test("seed: a launchEnv HOME outside the seeded root is refused", () => {
  const outside = mkdtempSync(join(tmpdir(), "aya-outside-"));
  assert.throws(() => loadSeedEnv()({ launchEnv: { HOME: outside } }), /HOME/);
  rmSync(outside, { recursive: true, force: true });
});

const HOSTILE = {
  PATH: "/usr/bin",
  HOME: "/Users/real",
  CLAUDE_CONFIG_DIR: "/Users/real/.claude_chris",
  CODEX_HOME: "/Users/real/.codex",
  GROK_HOME: "/Users/real/.grok",
  XDG_CONFIG_HOME: "/Users/real/.config",
  OPENCODE_CONFIG_DIR: "/Users/real/.config/opencode",
  ELECTRON_RUN_AS_NODE: "1",
  AYA_DEV: "1",
  AYA_HOME: "/Users/real/.aya",
};

test("appEnv: a hostile runner env reaches the app only inside the seeded root", () => {
  const { seedEnv, appEnv } = seedModule();
  const seeded = seedEnv({});
  try {
    const env = appEnv(seeded, HOSTILE);
    for (const key of ["HOME", "AYA_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"]) {
      assert.ok(env[key]?.startsWith(seeded.root + "/"), `${key}=${env[key]} is outside ${seeded.root}`);
    }
    assert.equal(env.PATH, "/usr/bin");
    assert.ok(!("ELECTRON_RUN_AS_NODE" in env) && !("AYA_DEV" in env));
  } finally {
    rmSync(seeded.root, { recursive: true, force: true });
  }
});

test("appEnv: config dirs the runner never set stay unset", () => {
  const { seedEnv, appEnv } = seedModule();
  const seeded = seedEnv({});
  try {
    const env = appEnv(seeded, { PATH: "/usr/bin" });
    assert.ok(!("XDG_CONFIG_HOME" in env) && !("OPENCODE_CONFIG_DIR" in env) && !("CLAUDE_CONFIG_DIR" in env));
  } finally {
    rmSync(seeded.root, { recursive: true, force: true });
  }
});

const listTs = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listTs(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
const LAUNCHES_APP = /_electron|electron\.launch\(|dist-electron[^\n]*(main|pty-host)\.js/;

test("no e2e file launches the app or its pty host without the shared env builder", () => {
  const launchers = listTs(join(REPO, "e2e")).filter((f) => LAUNCHES_APP.test(readFileSync(f, "utf8")));
  assert.ok(launchers.length >= 2, `found ${launchers}`);
  for (const file of launchers) {
    const source = readFileSync(file, "utf8");
    assert.ok(/\bappEnv\(/.test(source), `${file} launches the app without appEnv()`);
    assert.ok(!/\.\.\.process\.env|Object\.entries\(process\.env\)/.test(source), `${file} spreads the runner's env`);
  }
  const fixtures = readFileSync(join(REPO, "e2e", "fixtures.ts"), "utf8");
  assert.equal(fixtures.match(/\bappEnv\(/g)?.length, 2, "launchApp and the pre-started pty host both use appEnv()");
});

test("insideRoot: a sibling dir that merely starts with the root's name is outside it", () => {
  const { insideRoot } = seedModule();
  assert.equal(insideRoot("/tmp/aya-e2e-x/home", "/tmp/aya-e2e-x"), true);
  assert.equal(insideRoot("/tmp/aya-e2e-x-sibling/home", "/tmp/aya-e2e-x"), false);
  assert.equal(insideRoot("/tmp/aya-e2e-x", "/tmp/aya-e2e-x"), false);
});
