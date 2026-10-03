// The guard that keeps a test's write out of the real ~/.claude, ~/.codex, ~/.aya
// (a mutant of an env guard once wrote the real settings.json).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HELPER = fileURLToPath(new URL("./helpers/isolate-home.mjs", import.meta.url));
const TESTS = fileURLToPath(new URL(".", import.meta.url));

const run = (body, env = {}, roots) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-guard-"));
  const watched = join(dir, "settings.json");
  writeFileSync(watched, "{}");
  const script = `import { isolateHome } from ${JSON.stringify(HELPER)};
    import { writeFileSync } from "node:fs";
    isolateHome(${JSON.stringify(dir)}, { files: [${JSON.stringify(watched)}], roots: ${JSON.stringify(roots)} });
    ${body.replaceAll("WATCHED", JSON.stringify(watched))}`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, ...env } });
};

test("a test that leaves the watched config alone exits clean", () => {
  const r = run("");
  assert.equal(r.status, 0, r.stderr);
});

test("a test that writes the watched config fails its process", () => {
  const r = run('await new Promise((ok) => setTimeout(ok, 20)); writeFileSync(WATCHED, "{\\"x\\":1}");');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /test wrote the real config/);
});

test("isolateHome clears the agent config dirs the environment names", () => {
  const r = run('console.log(String(process.env.CLAUDE_CONFIG_DIR) + "|" + String(process.env.CODEX_HOME));', {
    CLAUDE_CONFIG_DIR: "/real/claude",
    CODEX_HOME: "/real/codex",
  });
  assert.equal(r.stdout.trim(), "undefined|undefined");
});

test("isolateHome moves HOME and AYA_HOME under the root", () => {
  const r = run('console.log(process.env.HOME + "|" + process.env.AYA_HOME);');
  const [home, aya] = r.stdout.trim().split("|");
  assert.match(home, /aya-guard-.*\/home$/);
  assert.match(aya, /aya-guard-.*\/aya$/);
});

// Every test that installs a hook (which writes settings.json) must use the helper.
test("hook-installing tests isolate through the shared helper", () => {
  const writers = readdirSync(TESTS).filter((f) => f.endsWith(".test.mjs") && /\b(un)?install(Status|Usage)Hook\(|\bmigrateStatusHookCommand\(/.test(readFileSync(join(TESTS, f), "utf8")));
  assert.ok(writers.length >= 2, `found ${writers}`);
  for (const f of writers) assert.match(readFileSync(join(TESTS, f), "utf8"), /isolateHome\(/, f);
});

// Prevention: a preload makes the write itself throw, for every dir of the real config.
const PRELOAD = fileURLToPath(new URL("./helpers/preload-guard.mjs", import.meta.url));
const PRELOAD_AT_FAKE_HOME = fileURLToPath(new URL("./helpers/preload-guard-fake-home.mjs", import.meta.url));
const PROTECTED = [".claude", ".claude_chris", ".codex", ".codex-ct", ".aya", ".aya-dev", ".grok", ".config/opencode", ".local/share/opencode"];
const WRITES = {
  writeFileSync: 'fs.writeFileSync(F, "x")',
  appendFileSync: 'fs.appendFileSync(F, "x")',
  mkdirSync: 'fs.mkdirSync(F + "/d", { recursive: true })',
  rmSync: "fs.rmSync(F, { force: true })",
  renameSync: 'fs.renameSync(TMP + "/src", F)',
  copyFileSync: 'fs.copyFileSync(TMP + "/src", F)',
  createWriteStream: "fs.createWriteStream(F)",
  openSync: 'fs.openSync(F, "w")',
  "named writeFileSync": 'writeFileSync(F, "x")',
  "named createWriteStream": "createWriteStream(F)",
  "promises.writeFile": 'await fs.promises.writeFile(F, "x")',
  utimesSync: "fs.utimesSync(F, 1, 1)",
  chmodSync: "fs.chmodSync(F, 0o600)",
  chownSync: "fs.chownSync(F, 0, 0)",
  truncateSync: "fs.truncateSync(F)",
  unlinkSync: "fs.unlinkSync(F)",
  symlinkSync: 'fs.symlinkSync(TMP + "/src", F)',
  "a file: URL": 'fs.writeFileSync(pathToFileURL(F), "x")',
  "a Buffer path": 'fs.writeFileSync(Buffer.from(F), "x")',
  "promises.utimes": "await fs.promises.utimes(F, 1, 1)",
  "promises.mkdir": 'await fs.promises.mkdir(F + "/d", { recursive: true })',
};

function underGuard(dirName, write, { env = {}, preload = PRELOAD_AT_FAKE_HOME, exists = true } = {}) {
  const fake = mkdtempSync(join(tmpdir(), "aya-real-home-"));
  if (exists) mkdirSync(join(fake, dirName), { recursive: true });
  writeFileSync(join(fake, "src"), "s");
  const script = `import fs, { createWriteStream, writeFileSync } from "node:fs"; import { pathToFileURL } from "node:url"; const F = ${JSON.stringify(join(fake, dirName, "f"))}; const TMP = ${JSON.stringify(fake)};
    try { ${write}; console.log("WROTE"); } catch (e) { console.log(e.message); }`;
  const r = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, AYA_GUARD_HOME: fake, ...env },
  });
  return { out: r.stdout.trim(), stderr: r.stderr, fake };
}

/** One preloaded child per home runs every blocked operation under the same guard; it cannot change the
 *  fixture, so later operations still see the same protected (or not-yet-existing) directory. */
function underGuardWrites(dir, entries, options) {
  const attempts = entries.map(([name, write]) => `{
    try { ${write}; console.log(JSON.stringify([${JSON.stringify(name)}, "WROTE"])); }
    catch (e) { console.log(JSON.stringify([${JSON.stringify(name)}, e.message])); }
  }`).join("\n");
  const { out, stderr } = underGuard(dir, attempts, options);
  const answers = new Map(out.split("\n").filter((line) => line.startsWith("[")).map((line) => JSON.parse(line)));
  return entries.map(([name]) => [name, { out: answers.get(name) ?? "", stderr }]);
}

for (const dir of PROTECTED) {
  test(`the preload refuses every kind of write into ${dir}`, () => {
    for (const [name, { out, stderr }] of underGuardWrites(dir, Object.entries(WRITES))) {
      assert.match(out, /test tried to write the real config/, `${name}: ${out} ${stderr}`);
    }
  });
}

// Snapshotting the dirs that exist at install missed the ones an agent CLI creates later.
const NOT_YET_THERE = [".grok", ".aya", ".aya-dev", ".codex-ct", ".claude-new", ".gemini", ".config/opencode", ".local/share/opencode"];
for (const dir of NOT_YET_THERE) {
  test(`the preload refuses a write into ${dir} although it does not exist yet`, () => {
    const writes = ["writeFileSync", "mkdirSync", "createWriteStream", "promises.mkdir"].map((name) => [name, WRITES[name]]);
    for (const [name, { out, stderr }] of underGuardWrites(dir, writes, { exists: false })) {
      assert.match(out, /test tried to write the real config/, `${name}: ${out} ${stderr}`);
    }
  });
}

test("the preload leaves the account's other files alone", () => {
  for (const name of [".zsh_history", ".cache/tool/f", "Projects/x", ".config/starship.toml", ".claudia-notes"]) {
    const { out } = underGuard("", `fs.mkdirSync(TMP + "/${dirname(name)}", { recursive: true }); fs.writeFileSync(TMP + "/${name}", "x")`);
    assert.equal(out, "WROTE", name);
  }
});

test("the preload lets a write outside the real config through, and reads inside it", () => {
  const { out } = underGuard(".claude", 'fs.writeFileSync(TMP + "/elsewhere", "x"); fs.readdirSync(TMP + "/.claude")');
  assert.equal(out, "WROTE");
});

for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "AYA_HOME", "GROK_HOME"]) {
  test(`the preload protects the dir ${key} names, too`, () => {
    const dir = mkdtempSync(join(tmpdir(), "aya-named-"));
    const { out } = underGuard(".claude", `fs.writeFileSync(${JSON.stringify(join(dir, "f"))}, "x")`, { env: { [key]: dir } });
    assert.match(out, /test tried to write the real config/);
  });
}

test("the preload follows a symlink named as a config dir to its target", () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-named-"));
  const link = dir + "-link";
  symlinkSync(dir, link);
  const { out } = underGuard(".claude", `fs.writeFileSync(${JSON.stringify(join(dir, "f"))}, "x")`, { env: { CODEX_HOME: link } });
  assert.match(out, /test tried to write the real config/);
});

test("the preload guards a home that is itself a symlink", () => {
  const home = mkdtempSync(join(tmpdir(), "aya-real-home-"));
  const link = home + "-link";
  symlinkSync(home, link);
  const script = `import fs from "node:fs"; try { fs.writeFileSync(${JSON.stringify(join(home, ".grok-new"))}, "x"); console.log("WROTE"); } catch (e) { console.log(e.message); }`;
  const r = spawnSync(process.execPath, ["--import", PRELOAD_AT_FAKE_HOME, "--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, AYA_GUARD_HOME: link },
  });
  assert.match(r.stdout, /test tried to write the real config/, r.stderr);
});

test("the real home is the passwd one, whatever a test sets HOME to", async () => {
  const { realHome } = await import("./helpers/real-config-guard.mjs");
  const saved = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "aya-fake-home-"));
  try {
    assert.equal(realHome(), userInfo().homedir);
  } finally {
    process.env.HOME = saved;
  }
});

test("the preload guards a dir, not every path that starts with its name", () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-named-"));
  const { out } = underGuard(".claude", `fs.writeFileSync(${JSON.stringify(dir + "-sibling")}, "x")`, { env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(out, "WROTE");
});

test("the preload follows a symlink into the real config", () => {
  const { out } = underGuard(".claude", 'fs.symlinkSync(TMP + "/.claude", TMP + "/link"); fs.writeFileSync(TMP + "/link/f", "x")');
  assert.match(out, /test tried to write the real config/);
});

test("AYA_GUARD_HOME does not re-aim the guard the tests run under", () => {
  const { out } = underGuard(".claude", 'fs.writeFileSync(F, "x")', { preload: PRELOAD });
  assert.equal(out, "WROTE");
});

// A test file run directly (node --test file) has no --import, so isolateHome guards too.
test("isolateHome alone makes a write into the real config throw", () => {
  const fake = mkdtempSync(join(tmpdir(), "aya-real-home-"));
  mkdirSync(join(fake, ".claude"));
  const r = run(`try { writeFileSync(${JSON.stringify(join(fake, ".claude", "f"))}, "x"); console.log("WROTE"); } catch (e) { console.log(e.message); }`, {}, [
    join(fake, ".claude"),
  ]);
  assert.match(r.stdout, /test tried to write the real config/);
});

test("both ways of running the tests load the guard", () => {
  const { scripts } = JSON.parse(readFileSync(join(TESTS, "..", "package.json"), "utf8"));
  for (const name of ["test", "test:file"]) assert.match(scripts[name], /--import \.\/tests\/helpers\/preload-guard\.mjs/, name);
});

test("the preload refuses a socket connect into the real Aya home: a test must never reach the live pty host", () => {
  const ways = {
    createConnection: 'const net = await import("node:net"); net.createConnection(TMP + "/.aya/pty-host.sock").on("error", () => {})',
    "connect({ path })": 'const net = await import("node:net"); new net.Socket().on("error", () => {}).connect({ path: TMP + "/.aya/aya.sock" })',
  };
  for (const [name, connect] of Object.entries(ways)) {
    const { out, stderr } = underGuard(".aya", connect);
    assert.match(out, /test tried to connect to the real Aya/, `${name}: ${out} ${stderr}`);
  }
  const { out } = underGuard(".aya", 'const net = await import("node:net"); net.createConnection(TMP + "/elsewhere.sock").on("error", () => {})');
  assert.equal(out, "WROTE", "a socket outside the real config is let through");
});

test("a node child the test spawns without the preload is guarded too", () => {
  const child = 'const net = require("node:net"); try { net.createConnection(process.argv[1] + "/.aya/pty-host.sock").on("error", () => {}); console.log("WROTE"); } catch (e) { console.log(e.message); }';
  const { out, stderr } = underGuard(".aya", `const { spawnSync } = await import("node:child_process"); const r = spawnSync(process.execPath, ["-e", ${JSON.stringify(child)}, TMP], { encoding: "utf8" }); throw new Error(r.stdout.trim() || r.stderr)`);
  assert.match(out, /test tried to connect to the real Aya/, `${out} ${stderr}`);
});

test("a node child given only NODE_OPTIONS, not the parent's roots, still starts and is guarded", () => {
  const child = 'const net = require("node:net"); try { net.createConnection(process.argv[1] + "/.aya/pty-host.sock").on("error", () => {}); console.log("WROTE"); } catch (e) { console.log(e.message); }';
  const { out, stderr } = underGuard(".aya", `const { spawnSync } = await import("node:child_process"); const r = spawnSync(process.execPath, ["-e", ${JSON.stringify(child)}, TMP], { encoding: "utf8", env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, AYA_GUARD_REAL_HOME: TMP } }); throw new Error(r.stdout.trim() || r.stderr)`);
  assert.match(out, /test tried to connect to the real Aya/, `${out} ${stderr}`);
});

test("bin/aya started by a test cannot reach the real Aya: its node gets the guard", () => {
  const aya = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "aya");
  const live = 'const net = await import("node:net"); await new Promise((r) => net.createServer().unref().listen(TMP + "/.aya/aya.sock", r));';
  const { out, stderr } = underGuard(".aya", `${live} const { spawnSync } = await import("node:child_process"); const r = spawnSync(${JSON.stringify(aya)}, ["capabilities"], { encoding: "utf8", timeout: 10_000, env: { ...process.env, AYA_SOCKET: TMP + "/.aya/aya.sock" } }); throw new Error(r.stdout + r.stderr)`);
  assert.match(out, /test tried to connect to the real Aya/, `${out} ${stderr}`);
});

test("on macOS a differently cased spelling of the real Aya home is refused too", { skip: process.platform !== "darwin" }, () => {
  const { out, stderr } = underGuard(".aya", 'const net = await import("node:net"); net.createConnection(TMP + "/.AYA/aya.sock").on("error", () => {})');
  assert.match(out, /test tried to connect to the real Aya/, `${out} ${stderr}`);
  const { out: wrote } = underGuard(".aya", 'fs.writeFileSync(TMP + "/.Aya/f", "x")');
  assert.match(wrote, /test tried to write the real config/);
});
