// Covers the PATH-recovery helpers that let GUI-launched Aya find CLIs
// installed in dirs only .zshrc/.bashrc add (e.g. ~/.local/bin). Everything is
// deterministic: the pure parse/merge/argv logic is exercised directly, and
// resolveLoginShellPath is tested through its injectable platform/execFile
// seam so we assert the win32, error, and success paths without spawning a
// real shell.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shellPathProbeArgv,
  parseResolvedPath,
  mergePath,
  resolveLoginShellPath,
} from "../dist-electron/shell-path.js";

test("shellPathProbeArgv builds a login+interactive shell that prints PATH", () => {
  const argv = shellPathProbeArgv("/bin/zsh");
  assert.equal(argv[0], "/bin/zsh");
  // -i is what sources .zshrc/.bashrc; -l keeps the login profile too.
  assert.ok(argv.includes("-l"), `missing -l: ${argv.join(" ")}`);
  assert.ok(argv.includes("-i"), `missing -i: ${argv.join(" ")}`);
  assert.equal(argv[argv.length - 2], "-c");
  // $PATH must be expanded by the shell, so it stays double-quoted (not single).
  assert.match(argv[argv.length - 1], /"\$PATH"/);
});

test("parseResolvedPath extracts the value between the sentinels", () => {
  const out = `__AYA_PATH_BEGIN__/usr/bin:/bin:/Users/me/.local/bin__AYA_PATH_END__`;
  assert.equal(parseResolvedPath(out), "/usr/bin:/bin:/Users/me/.local/bin");
});

test("parseResolvedPath ignores rc-file noise printed around the markers", () => {
  const out = [
    "Last login: somewhere",
    "\x1b[32mwelcome banner\x1b[0m",
    `__AYA_PATH_BEGIN__/opt/homebrew/bin:/usr/bin__AYA_PATH_END__`,
    "trailing instant-prompt junk",
  ].join("\n");
  assert.equal(parseResolvedPath(out), "/opt/homebrew/bin:/usr/bin");
});

test("parseResolvedPath takes the first BEGIN and the first END after it", () => {
  // An rc file that itself echoes a sentinel must not change which value wins.
  const out =
    "noise __AYA_PATH_END__ __AYA_PATH_BEGIN__/real/path__AYA_PATH_END__ __AYA_PATH_BEGIN__/second";
  assert.equal(parseResolvedPath(out), "/real/path");
});

test("parseResolvedPath rejects fish's space-joined $PATH instead of corrupting PATH", () => {
  // fish expands "$PATH" as a space-joined list, not a colon scalar. Such a
  // value has spaces but no ':' — merging it would glue the list into one
  // bogus entry, so we drop it and leave PATH unchanged.
  const fish = `__AYA_PATH_BEGIN__/usr/bin /bin /Users/me/.local/bin__AYA_PATH_END__`;
  assert.equal(parseResolvedPath(fish), null);
});

test("parseResolvedPath returns null when markers are absent or empty", () => {
  assert.equal(parseResolvedPath("no markers here"), null);
  assert.equal(parseResolvedPath("__AYA_PATH_BEGIN__only-start"), null);
  assert.equal(parseResolvedPath("__AYA_PATH_BEGIN____AYA_PATH_END__"), null);
});

test("mergePath prepends resolved entries, keeps current extras, dedupes", () => {
  const resolved = "/opt/homebrew/bin:/usr/bin:/Users/me/.local/bin";
  const current = "/usr/bin:/sbin"; // /usr/bin already present, /sbin is new
  assert.equal(
    mergePath(resolved, current),
    "/opt/homebrew/bin:/usr/bin:/Users/me/.local/bin:/sbin",
  );
});

test("mergePath tolerates an undefined current PATH and empty segments", () => {
  assert.equal(mergePath("/a::/b:/a", undefined), "/a:/b");
});

test("mergePath returns an unchanged value when current already equals resolved", () => {
  // This is the equality repairProcessPath relies on to no-op (no PATH change).
  assert.equal(mergePath("/usr/bin:/bin", "/usr/bin:/bin"), "/usr/bin:/bin");
});

test("resolveLoginShellPath short-circuits to null on Windows without spawning", async () => {
  let spawned = false;
  const run = () => {
    spawned = true;
  };
  assert.equal(await resolveLoginShellPath("win32", run), null);
  assert.equal(spawned, false);
});

test("resolveLoginShellPath resolves null when the shell errors", async () => {
  const run = (_file, _args, _opts, cb) => cb(new Error("boom"), "");
  assert.equal(await resolveLoginShellPath("darwin", run), null);
});

test("resolveLoginShellPath parses the PATH the shell prints", async () => {
  const run = (_file, _args, _opts, cb) =>
    cb(null, `__AYA_PATH_BEGIN__/opt/homebrew/bin:/usr/bin__AYA_PATH_END__`);
  assert.equal(
    await resolveLoginShellPath("darwin", run),
    "/opt/homebrew/bin:/usr/bin",
  );
});
