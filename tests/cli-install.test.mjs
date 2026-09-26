// #115: the shim went to an rvm gemset and vanished on `rvm use`, while a dead
// copy further down PATH took over and Settings still said healthy.

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

test("~/.local/bin on PATH but not writable: the next stable writable dir", () => {
  const writable = (dir) => dir !== LOCAL_BIN;
  assert.deepEqual(chooseCliInstallDir([LOCAL_BIN, "/opt/homebrew/bin"], HOME, writable), {
    dir: "/opt/homebrew/bin",
    onPath: true,
  });
});

test("a trailing slash on the PATH entry still counts as ~/.local/bin", () => {
  assert.deepEqual(chooseCliInstallDir([`${LOCAL_BIN}/`], HOME, everyDirWritable), {
    dir: LOCAL_BIN,
    onPath: true,
  });
});

test("version-manager dirs are recognised; stable dirs are not", () => {
  for (const dir of [
    `${HOME}/.rvm/gems/ruby-3.4.4/bin`,
    `${HOME}/.rbenv/shims`,
    `${HOME}/.pyenv/shims`,
    `${HOME}/.nvm/versions/node/v20.1.0/bin`,
    `${HOME}/.asdf/shims`,
    `${HOME}/.fnm/node-versions/v22.0.0/installation/bin`,
    `${HOME}/.local/share/mise/installs/node/22/bin`,
    `${HOME}/.gem/ruby/3.4.0/bin`,
    "/repo/node_modules/.bin",
  ]) {
    assert.equal(isVersionManagedDir(dir), true, dir);
  }
  for (const dir of [
    LOCAL_BIN,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${HOME}/bin`,
    "/repo/node_modules/.binaries",
  ]) {
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

test("a user's wrapper that merely ends in an aya exec line is not ours", () => {
  // Accepting any matching LINE let startup repair / Reinstall overwrite, or
  // delete, a hand-written wrapper like this one (#120 review).
  const wrapper =
    '#!/bin/bash\nexport FOO=1\nsource ~/.secrets\nexec "/opt/aya-fork/bin/aya" "$@"\n';
  assert.deepEqual(ayaShimTargets(wrapper), []);
  // Same exec line under a different interpreter is not the legacy shim either.
  assert.deepEqual(ayaShimTargets('#!/bin/bash\nexec "/x/bin/aya" "$@"\n'), []);
});

test("bin dirs that version managers regenerate or prune count as managed", () => {
  for (const dir of [
    `${HOME}/Library/Caches/fnm_multishells/123_456/bin`,
    `${HOME}/.local/share/fnm/node-versions/v24/installation/bin`,
    `${HOME}/.local/share/mise/shims`,
    `${HOME}/.nodenv/shims`,
    `${HOME}/.rubies/ruby-3.4.4/bin`,
    `${HOME}/miniconda3/bin`,
    `${HOME}/anaconda3/bin`,
    `${HOME}/.conda/envs/x/bin`,
  ]) {
    assert.equal(isVersionManagedDir(dir), true, dir);
  }
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

test("a dead first copy asks for Reinstall; healthy copies below are not called dead", () => {
  const healthyBelow = { path: "/usr/local/bin/aya", ours: true, broken: false };
  assert.equal(
    describeCliStatus([deadLocalCopy, healthyBelow], LOCAL_CHOICE),
    `Installed at ${deadLocalCopy.path}, but it points at a moved or renamed Aya.app - click Reinstall to repair.`,
  );
});

test("a foreign aya first on PATH is named, not judged; a dead copy below it still shows", () => {
  const foreignFirst = { path: "/opt/homebrew/bin/aya", ours: false, broken: false };
  assert.equal(
    describeCliStatus([foreignFirst], LOCAL_CHOICE),
    "/opt/homebrew/bin/aya comes first on PATH and was not installed by Aya.",
  );
  assert.match(
    describeCliStatus([foreignFirst, deadLocalCopy], LOCAL_CHOICE),
    new RegExp(`not installed by Aya\\. Also, a dead copy.*${deadLocalCopy.path}.*Reinstall`),
  );
});

test("nothing installed: the target, plus a warning when it is off PATH", () => {
  assert.equal(describeCliStatus([], LOCAL_CHOICE), `Install to ${LOCAL_BIN}/aya`);
  assert.match(
    describeCliStatus([], { dir: LOCAL_BIN, onPath: false }),
    /not on your PATH/,
  );
});

const foreignCopy = { path: "/opt/homebrew/bin/aya", ours: false, broken: false };
const deadElsewhere = { path: "/usr/local/bin/aya", ours: true, broken: true };

test("#115 reinstall: gemset copy removed, dead copy elsewhere rewritten, foreign untouched", () => {
  const plan = planCliInstall(
    [gemsetCopy, deadElsewhere, deadLocalCopy, foreignCopy],
    `${LOCAL_BIN}/aya`,
  );
  assert.deepEqual(plan, {
    rewrite: ["/usr/local/bin/aya"],
    remove: [gemsetCopy.path],
  });
});

test("reinstall keeps the gemset copy when removing it would not hand PATH to the new shim", () => {
  const rewriteGemset = { rewrite: [gemsetCopy.path], remove: [] };
  // Target off PATH: removing would leave no aya at all.
  assert.deepEqual(planCliInstall([gemsetCopy], `${LOCAL_BIN}/aya`), rewriteGemset);
  // A foreign aya between them would become the one the shell runs.
  assert.deepEqual(
    planCliInstall([gemsetCopy, foreignCopy, deadLocalCopy], `${LOCAL_BIN}/aya`),
    rewriteGemset,
  );
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
