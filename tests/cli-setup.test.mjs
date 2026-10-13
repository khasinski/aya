// CLI setup against temporary PATH entries, a stand-in app and filesystem failures.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, statSync, existsSync, lstatSync, symlinkSync, rmSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "aya-cli-setup-"));
const savedEnv = Object.fromEntries(["HOME", "AYA_HOME", "PATH", "APPIMAGE"].map((key) => [key, process.env[key]]));
process.env.HOME = root;
process.env.AYA_HOME = path.join(root, "config");
const { createCliSetup, pathEntries, findExecutableOnPath, anyExecutable, isWritableDir, foreignFileAt, ayaCopiesOnPath, writeCliShim } = await import("../dist-electron/cli-setup.js");
const { renderCliShim, defaultInstallAyaCliPath } = await import("../dist-electron/cli-shim.js");
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function file(target, text = "#!/bin/sh\nexit 0\n", mode = 0o755) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
  chmodSync(target, mode);
  return target;
}

function setup(t, over = {}) {
  const dir = mkdtempSync(path.join(root, "case-"));
  const home = path.join(dir, "home");
  mkdirSync(home);
  const local = path.join(home, ".local", "bin");
  const source = file(path.join(dir, "bundle", "bin", "aya"));
  process.env.HOME = home;
  process.env.PATH = local;
  delete process.env.APPIMAGE;
  const app = { isPackaged: true };
  const deps = { app, mainDirname: path.join(dir, "bundle", "dist-electron"), isDev: false, ...over };
  const cli = createCliSetup(deps);
  const dead = renderCliShim(path.join(dir, "missing", "aya"), null);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, home, local, source, app, deps, cli, dead, target: path.join(local, "aya") };
}

test("PATH probes filter relative and empty entries, keep order and read the live environment", (t) => {
  const x = setup(t);
  const a = path.join(x.dir, "first");
  const b = path.join(x.dir, "second");
  file(path.join(a, "tool"), "no exec", 0o644);
  file(path.join(b, "tool"));
  process.env.PATH = ["", ".", "node_modules/.bin", " ", a, b, a].join(path.delimiter);
  assert.deepEqual(pathEntries(), [a, b, a]);
  assert.equal(findExecutableOnPath("tool"), path.join(b, "tool"));
  chmodSync(path.join(a, "tool"), 0o755);
  assert.equal(findExecutableOnPath("tool"), path.join(a, "tool"));
  assert.equal(findExecutableOnPath("missing"), null);
  delete process.env.PATH;
  assert.deepEqual(pathEntries(), []);
});

test("executable candidates are tried in order and stop at the first success", async (t) => {
  const x = setup(t);
  const noExec = file(path.join(x.dir, "no-exec"), "x", 0o644);
  const calls = [];
  const access = fs.access;
  t.mock.method(fs, "access", async (...args) => { calls.push(args[0]); return access(...args); });
  assert.equal(await anyExecutable([noExec, x.source, "never probed"]), true);
  assert.deepEqual(calls, [noExec, x.source]);
  assert.equal(await anyExecutable([noExec, path.join(x.dir, "missing")]), false);
  assert.equal(await anyExecutable([]), false);
});

test("a missing install dir uses its existing ancestor; files and children of files are rejected", (t) => {
  const x = setup(t);
  assert.equal(isWritableDir(x.local), true);
  assert.equal(isWritableDir(x.source), false);
  assert.equal(isWritableDir(path.join(x.source, "child")), false);
  assert.deepEqual(x.cli.cliInstallDir(), { dir: x.local, onPath: true });
});

test("foreign-file protection accepts only plain Aya shims and missing targets", async (t) => {
  const x = setup(t);
  assert.equal(await foreignFileAt(x.target), false);
  file(x.target, x.dead);
  assert.equal(await foreignFileAt(x.target), false);
  const link = path.join(x.dir, "link");
  symlinkSync(x.target, link);
  assert.equal(await foreignFileAt(link), true);
  symlinkSync(path.join(x.dir, "missing"), path.join(x.dir, "dangling"));
  assert.equal(await foreignFileAt(path.join(x.dir, "dangling")), true);
  file(x.target, "#!/bin/sh\necho user wrapper\n");
  assert.equal(await foreignFileAt(x.target), true);
  assert.equal(await foreignFileAt(x.home), true);
});

test("PATH copies are deduplicated, classify symlinks as foreign and ignore asar targets", async (t) => {
  const x = setup(t);
  const asar = file(path.join(x.dir, "app.asar", "bin", "aya"));
  const targets = [
    file(x.target, renderCliShim(asar, null)),
    file(path.join(x.dir, "fallback", "aya"), renderCliShim(asar, x.source)),
    file(path.join(x.dir, "foreign", "aya"), "#!/bin/sh\necho mine\n"),
    path.join(x.dir, "link", "aya"),
    file(path.join(x.dir, "not-executable", "aya"), x.dead, 0o644),
  ];
  mkdirSync(path.dirname(targets[3]));
  symlinkSync(targets[0], targets[3]);
  process.env.PATH = [x.local, ...targets.map(path.dirname)].join(path.delimiter);
  assert.deepEqual(await ayaCopiesOnPath(), [
    { path: targets[0], ours: true, broken: true },
    { path: targets[1], ours: true, broken: false },
    { path: targets[2], ours: false, broken: false },
    { path: targets[3], ours: false, broken: false },
  ]);
});

test("unreadable PATH copies stay foreign, including a failed lstat after access", async (t) => {
  const x = setup(t);
  file(x.target, x.dead);
  t.mock.method(fs, "lstat", async () => { throw new Error("vanished"); });
  t.mock.method(fs, "readFile", async () => { throw new Error("unreadable"); });
  assert.deepEqual(await ayaCopiesOnPath(), [{ path: x.target, ours: false, broken: false }]);
  assert.equal(await foreignFileAt(x.target), true);
});

test("status reports the first PATH copy, dead copies below it and a healthy install without a message", async (t) => {
  const x = setup(t);
  assert.deepEqual(await x.cli.cliStatus(), {
    installed: false, path: null, installDir: x.local, installable: true, copies: [], message: `Install to ${x.target}`,
  });
  file(x.target, x.cli.freshCliShim());
  assert.deepEqual(await x.cli.cliStatus(), {
    installed: true, path: x.target, installDir: x.local, installable: true,
    copies: [{ path: x.target, ours: true, broken: false }],
  });
  const lower = file(path.join(x.dir, "lower", "aya"), x.dead);
  process.env.PATH += path.delimiter + path.dirname(lower);
  file(x.target, "#!/bin/sh\necho foreign\n");
  assert.equal((await x.cli.cliStatus()).message, `${x.target} comes first on PATH and was not installed by Aya. Also, a dead copy further down PATH takes over if it disappears (${lower}) - click Reinstall to repair.`);
});

test("fresh shim uses the supplied main directory and the platform fallback", (t) => {
  const x = setup(t);
  assert.equal(x.cli.freshCliShim(), renderCliShim(x.source, defaultInstallAyaCliPath(process.platform)));
});

test("writing a shim chmods before rename and replaces a symlink without touching its destination", async (t) => {
  const x = setup(t);
  const original = file(path.join(x.dir, "original"), "user content");
  mkdirSync(x.local, { recursive: true });
  symlinkSync(original, x.target);
  const calls = [];
  for (const name of ["writeFile", "chmod", "rename"]) {
    const fn = fs[name];
    t.mock.method(fs, name, async (...args) => { calls.push([name, ...args]); return fn(...args); });
  }
  await writeCliShim(x.target, x.dead);
  const tmp = `${x.target}.aya-${process.pid}.tmp`;
  assert.deepEqual(calls, [["writeFile", tmp, x.dead, { mode: 0o755 }], ["chmod", tmp, 0o755], ["rename", tmp, x.target]]);
  assert.equal(lstatSync(x.target).isSymbolicLink(), false);
  assert.equal(readFileSync(original, "utf8"), "user content");
  assert.equal(statSync(x.target).mode & 0o777, 0o755);
});

test("a failed shim write preserves the target, removes its temp file and rethrows the error", async (t) => {
  const x = setup(t);
  file(x.target, "old content");
  const failure = new Error("chmod failed");
  t.mock.method(fs, "chmod", async () => { throw failure; });
  await assert.rejects(writeCliShim(x.target, x.dead), (err) => err === failure);
  assert.equal(readFileSync(x.target, "utf8"), "old content");
  assert.deepEqual(readdirSync(x.local), ["aya"]);
});

test("install refuses an unexecutable bundle before creating the install directory", async (t) => {
  const x = setup(t);
  chmodSync(x.source, 0o644);
  assert.deepEqual(await x.cli.installCli(), {
    installed: false, path: null, installDir: x.local, installable: false,
    message: `Bundled aya CLI is not executable at ${x.source}`,
  });
  assert.equal(existsSync(x.local), false);
});

test("install refuses foreign files and symlinks with the existing status and exact repair message", async (t) => {
  const x = setup(t);
  const foreign = "#!/bin/sh\necho foreign\n";
  file(x.target, foreign);
  const status = await x.cli.cliStatus();
  assert.deepEqual(await x.cli.installCli(), { ...status, message: `${x.target} exists and was not installed by Aya - move it away, then click Reinstall.` });
  assert.equal(readFileSync(x.target, "utf8"), foreign);
  rmSync(x.target);
  symlinkSync(x.source, x.target);
  assert.match((await x.cli.installCli()).message, /exists and was not installed by Aya/);
  assert.equal(lstatSync(x.target).isSymbolicLink(), true);
});

test("install writes the target, rewrites stable copies, removes managed copies and leaves foreign ones", async (t) => {
  const x = setup(t);
  const managed = file(path.join(x.home, ".rvm", "gems", "bin", "aya"), x.dead);
  const stable = file(path.join(x.dir, "stable", "aya"), x.dead);
  const foreign = file(path.join(x.dir, "foreign", "aya"), "foreign");
  process.env.PATH = [path.dirname(managed), x.local, path.dirname(stable), path.dirname(foreign)].join(path.delimiter);
  const effects = [];
  for (const name of ["mkdir", "rename", "rm"]) {
    const fn = fs[name];
    t.mock.method(fs, name, async (...args) => { effects.push([name, name === "rename" ? args[1] : args[0]]); return fn(...args); });
  }
  const status = await x.cli.installCli();
  assert.deepEqual(effects, [["mkdir", x.local], ["rename", x.target], ["rename", stable], ["rm", managed]]);
  assert.equal(readFileSync(x.target, "utf8"), x.cli.freshCliShim());
  assert.equal(readFileSync(stable, "utf8"), x.cli.freshCliShim());
  assert.equal(readFileSync(foreign, "utf8"), "foreign");
  assert.equal(status.path, x.target);
  assert.equal(status.message, `Installed at ${x.target}`);
  assert.equal(status.copies.length, 3);
});

test("dev install writes only its chosen shim", async (t) => {
  const x = setup(t, { isDev: true });
  const managed = file(path.join(x.home, ".rbenv", "shims", "aya"), x.dead);
  const stable = file(path.join(x.dir, "stable", "aya"), x.dead);
  process.env.PATH = [x.local, path.dirname(managed), path.dirname(stable)].join(path.delimiter);
  await x.cli.installCli();
  assert.equal(readFileSync(x.target, "utf8"), x.cli.freshCliShim());
  assert.equal(readFileSync(managed, "utf8"), x.dead);
  assert.equal(readFileSync(stable, "utf8"), x.dead);
});

test("off-PATH install creates local bin, rewrites a managed copy and reports the PATH note", async (t) => {
  const x = setup(t);
  const managed = file(path.join(x.home, ".nvm", "version", "bin", "aya"), x.dead);
  process.env.PATH = path.dirname(managed);
  const status = await x.cli.installCli();
  assert.equal(status.path, managed);
  assert.equal(readFileSync(managed, "utf8"), x.cli.freshCliShim());
  assert.equal(status.message, `Installed at ${x.target} - ${x.local} is not on your PATH, add it to use the command`);
});

test("a foreign first copy keeps managed copies on PATH and remains the reported active command", async (t) => {
  const x = setup(t);
  const foreign = file(path.join(x.dir, "foreign", "aya"), "foreign");
  const managed = file(path.join(x.home, ".pyenv", "shims", "aya"), x.dead);
  process.env.PATH = [path.dirname(foreign), path.dirname(managed), x.local].join(path.delimiter);
  const status = await x.cli.installCli();
  assert.equal(status.path, foreign);
  assert.equal(status.message, `${foreign} comes first on PATH and was not installed by Aya.`);
  assert.equal(readFileSync(managed, "utf8"), x.cli.freshCliShim());
});

test("failed secondary rewrites and removals are reported in order while installation continues", async (t) => {
  const x = setup(t);
  const stable = file(path.join(x.dir, "stable", "aya"), x.dead);
  const managed = file(path.join(x.home, ".asdf", "shims", "aya"), x.dead);
  process.env.PATH = [x.local, path.dirname(managed), path.dirname(stable)].join(path.delimiter);
  const rename = fs.rename;
  const rm = fs.rm;
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === stable) throw new Error("rewrite failed");
    return rename(from, to);
  });
  t.mock.method(fs, "rm", async (target, opts) => {
    if (target === managed) throw new Error("remove failed");
    return rm(target, opts);
  });
  const status = await x.cli.installCli();
  assert.equal(status.message, `Installed at ${x.target}. Could not update ${stable}, ${managed}.`);
  assert.equal(status.installed, true);
  assert.equal(readFileSync(stable, "utf8"), x.dead);
  assert.deepEqual(readdirSync(path.dirname(stable)), ["aya"]);
});

test("failure writing the chosen shim rejects before other copies are changed", async (t) => {
  const x = setup(t);
  const stable = file(path.join(x.dir, "stable", "aya"), x.dead);
  process.env.PATH = [x.local, path.dirname(stable)].join(path.delimiter);
  t.mock.method(fs, "rename", async () => { throw new Error("target write failed"); });
  await assert.rejects(x.cli.installCli(), /target write failed/);
  assert.equal(existsSync(x.target), false);
  assert.equal(readFileSync(stable, "utf8"), x.dead);
});

test("startup repair skips dev, unpackaged apps, AppImages and an unexecutable source", async (t) => {
  const x = setup(t);
  file(x.target, x.dead);
  await createCliSetup({ ...x.deps, isDev: true }).healDeadCliShims();
  x.app.isPackaged = false;
  await x.cli.healDeadCliShims();
  x.app.isPackaged = true;
  process.env.APPIMAGE = path.join(x.dir, "Aya.AppImage");
  await x.cli.healDeadCliShims();
  delete process.env.APPIMAGE;
  chmodSync(x.source, 0o644);
  await x.cli.healDeadCliShims();
  assert.equal(readFileSync(x.target, "utf8"), x.dead);
});

test("startup repair only rewrites dead owned copies, logs failures and continues to the next copy", async (t) => {
  const x = setup(t);
  file(x.target, x.dead);
  const next = file(path.join(x.dir, "next", "aya"), x.dead);
  const healthy = file(path.join(x.dir, "healthy", "aya"), renderCliShim(x.source, null));
  const foreign = file(path.join(x.dir, "foreign", "aya"), "foreign");
  const link = path.join(x.dir, "link", "aya");
  mkdirSync(path.dirname(link));
  symlinkSync(x.target, link);
  process.env.PATH = [x.target, next, healthy, foreign, link].map(path.dirname).join(path.delimiter);
  const error = new Error("repair failed");
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === x.target) throw error;
    return rename(from, to);
  });
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(["log", ...args]));
  t.mock.method(console, "warn", (...args) => logs.push(["warn", ...args]));
  await x.cli.healDeadCliShims();
  assert.deepEqual(logs, [
    ["warn", `[aya] could not repair dead aya shim at ${x.target}:`, error],
    ["log", `[aya] repaired dead aya shim at ${next}`],
  ]);
  assert.equal(readFileSync(x.target, "utf8"), x.dead);
  assert.equal(readFileSync(next, "utf8"), x.cli.freshCliShim());
  assert.equal(readFileSync(healthy, "utf8"), renderCliShim(x.source, null));
  assert.equal(readFileSync(foreign, "utf8"), "foreign");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
});
