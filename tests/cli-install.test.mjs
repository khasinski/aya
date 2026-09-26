// Where the `aya` shim is installed and how every copy on PATH is judged
// (#115): the first writable PATH entry was an rvm gemset, so the shim
// vanished on `rvm use`, and a dead pre-#39 shim further down took over
// while Settings still reported a healthy install.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ayaShimTargets,
  chooseCliInstallDir,
  describeCliStatus,
  insideAsarArchive,
  isVersionManagedDir,
  planCliInstall,
} from "../dist-electron/cli-install.js";
import { renderCliShim } from "../dist-electron/cli-shim.js";

const HOME = "/Users/dev";
const LOCAL_BIN = `${HOME}/.local/bin`;
// The measured PATH from #115, positions 1-5.
const RVM_PATH = [
  `${HOME}/.rvm/gems/ruby-3.4.4/bin`,
  `${HOME}/.rvm/gems/ruby-3.4.4@global/bin`,
  `${HOME}/.rvm/rubies/ruby-3.4.4/bin`,
  "/usr/bin",
  LOCAL_BIN,
];
const everyDirWritable = () => true;

test("#115: rvm dirs come first on PATH, the shim still goes to ~/.local/bin", () => {
  assert.deepEqual(chooseCliInstallDir(RVM_PATH, HOME, everyDirWritable), {
    dir: LOCAL_BIN,
    onPath: true,
  });
});

test("no ~/.local/bin on PATH: first writable dir that no version manager owns", () => {
  const entries = [
    `${HOME}/.rbenv/shims`,
    `${HOME}/.nvm/versions/node/v20.1.0/bin`,
    "/usr/bin",
    "/opt/homebrew/bin",
  ];
  const writable = (dir) => dir !== "/usr/bin";
  assert.deepEqual(chooseCliInstallDir(entries, HOME, writable), {
    dir: "/opt/homebrew/bin",
    onPath: true,
  });
});

test("only version-managed dirs are writable: ~/.local/bin, flagged off PATH", () => {
  const entries = [`${HOME}/.asdf/shims`, "/usr/bin"];
  const writable = (dir) => dir !== "/usr/bin";
  assert.deepEqual(chooseCliInstallDir(entries, HOME, writable), {
    dir: LOCAL_BIN,
    onPath: false,
  });
});

test("a trailing slash on the PATH entry still counts as ~/.local/bin", () => {
  assert.equal(
    chooseCliInstallDir([`${LOCAL_BIN}/`], HOME, everyDirWritable).onPath,
    true,
  );
});

test("version-manager dirs are recognised; stable dirs are not", () => {
  for (const dir of [
    `${HOME}/.rvm/gems/ruby-3.4.4/bin`,
    `${HOME}/.rbenv/shims`,
    `${HOME}/.pyenv/shims`,
    `${HOME}/.nvm/versions/node/v20.1.0/bin`,
    `${HOME}/.asdf/shims`,
    `${HOME}/.local/share/mise/installs/node/22/bin`,
    `${HOME}/.gem/ruby/3.4.0/bin`,
    "/repo/node_modules/.bin",
  ]) {
    assert.equal(isVersionManagedDir(dir), true, dir);
  }
  for (const dir of [LOCAL_BIN, "/opt/homebrew/bin", "/usr/local/bin", `${HOME}/bin`]) {
    assert.equal(isVersionManagedDir(dir), false, dir);
  }
});

const APP_CLI = "/Applications/Aya.app/Contents/Resources/app.asar.unpacked/bin/aya";

test("the current shim and the pre-#39 one-liner are ours; a foreign wrapper is not", () => {
  assert.deepEqual(ayaShimTargets(renderCliShim(APP_CLI, null)), [APP_CLI]);
  // The dead shim from #115, verbatim.
  const preFix =
    '#!/bin/sh\nexec "/Applications/Aya.app/Contents/Resources/app.asar/bin/aya" "$@"\n';
  assert.deepEqual(ayaShimTargets(preFix), [
    "/Applications/Aya.app/Contents/Resources/app.asar/bin/aya",
  ]);
  assert.deepEqual(ayaShimTargets('#!/bin/sh\nexec "/usr/local/bin/other" "$@"\n'), []);
  assert.deepEqual(ayaShimTargets("#!/bin/sh\necho hi\n"), []);
});

const gemsetCopy = { path: `${HOME}/.rvm/gems/ruby-3.4.4/bin/aya`, ours: true, broken: false };
const deadLocalCopy = { path: `${LOCAL_BIN}/aya`, ours: true, broken: true };
const LOCAL_CHOICE = { dir: LOCAL_BIN, onPath: true };

test("#115 status: healthy gemset shim with a dead copy below is NOT reported healthy", () => {
  const message = describeCliStatus([gemsetCopy, deadLocalCopy], LOCAL_CHOICE);
  assert.match(message, /version manager/);
  assert.match(message, new RegExp(`dead copy.*${deadLocalCopy.path}`));
  assert.match(message, /Reinstall/);
});

test("one healthy shim in a stable dir: no message, Settings shows the plain path", () => {
  assert.equal(
    describeCliStatus([{ path: `${LOCAL_BIN}/aya`, ours: true, broken: false }], LOCAL_CHOICE),
    undefined,
  );
});

test("a dead first copy asks for Reinstall", () => {
  assert.match(describeCliStatus([deadLocalCopy], LOCAL_CHOICE), /moved or renamed.*Reinstall/);
});

test("a foreign aya first on PATH is named, not judged", () => {
  const message = describeCliStatus(
    [{ path: "/opt/homebrew/bin/aya", ours: false, broken: false }],
    LOCAL_CHOICE,
  );
  assert.match(message, /not installed by Aya/);
});

test("nothing installed: the target, plus a warning when it is off PATH", () => {
  assert.equal(describeCliStatus([], LOCAL_CHOICE), `Install to ${LOCAL_BIN}/aya`);
  assert.match(
    describeCliStatus([], { dir: LOCAL_BIN, onPath: false }),
    /not on your PATH/,
  );
});

test("#115 reinstall: gemset copy removed, dead copy elsewhere rewritten, foreign untouched", () => {
  const foreign = { path: "/opt/homebrew/bin/aya", ours: false, broken: false };
  const deadElsewhere = { path: "/usr/local/bin/aya", ours: true, broken: true };
  const plan = planCliInstall(
    [gemsetCopy, foreign, deadElsewhere, deadLocalCopy],
    `${LOCAL_BIN}/aya`,
  );
  assert.deepEqual(plan, {
    rewrite: ["/usr/local/bin/aya"],
    remove: [gemsetCopy.path],
  });
});

// Electron's fs reads into archives, so from inside the app an X_OK probe of
// the pre-#39 target passes (measured: Electron "X_OK passes", Node ENOTDIR).
test("a target inside app.asar is never executable; app.asar.unpacked is fine", () => {
  assert.equal(
    insideAsarArchive("/Applications/Aya.app/Contents/Resources/app.asar/bin/aya"),
    true,
  );
  assert.equal(insideAsarArchive(APP_CLI), false);
  assert.equal(insideAsarArchive("/Applications/Aya.app/Contents/Resources/app.asar"), false);
});
