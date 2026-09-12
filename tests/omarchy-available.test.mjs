// omarchyAvailable() against a real home dir: a colors.toml that EXISTS but
// yields no usable palette is not availability. os.homedir() honours $HOME on
// POSIX and omarchy.js resolves its paths at load, so HOME is set before import.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// os.homedir() only consults $HOME on POSIX, so the redirect below is inert on
// Windows and there is nothing here to run.
const skip = process.platform === "win32" ? "the $HOME redirect is POSIX-only" : false;

const HOME = mkdtempSync(join(tmpdir(), "aya-omarchy-home-"));
process.env.HOME = HOME;

const { OMARCHY_COLORS_FILE, omarchyAvailable } = await import(
  "../dist-electron/omarchy.js"
);

const THEME_DIR = dirname(OMARCHY_COLORS_FILE);

/** Install a colors.toml under the redirected home; null uninstalls Omarchy. */
function setColors(contents) {
  rmSync(THEME_DIR, { recursive: true, force: true });
  if (contents === null) return;
  mkdirSync(THEME_DIR, { recursive: true });
  writeFileSync(OMARCHY_COLORS_FILE, contents);
}

const toml = (...lines) => lines.join("\n") + "\n";
const BG = 'background = "#1a1b26"';
const FG = 'foreground = "#a9b1d6"';
const AC = 'accent = "#7aa2f7"';

test("no Omarchy install at all reports unavailable", { skip }, async () => {
  setColors(null);
  assert.equal(await omarchyAvailable(), false);
});

test("a colors.toml we cannot skin from is NOT availability", { skip }, async () => {
  // Both fixtures are ON DISK: a plain existence check calls each one available
  // and Settings then offers a theme neither CSSOM nor xterm can apply.
  const unusable = [
    ["accent missing", toml('mode = "dark"', BG, FG)],
    ["accent is not a color", toml('mode = "dark"', BG, FG, 'accent = "mauve"')],
  ];
  for (const [why, body] of unusable) {
    setColors(body);
    assert.ok(existsSync(OMARCHY_COLORS_FILE), `${why}: fixture must exist`);
    assert.equal(await omarchyAvailable(), false, why);
  }
});

test("a complete, skinnable palette reports available", { skip }, async () => {
  // The other direction, so a mutant that always answers false cannot survive.
  setColors(toml('mode = "dark"', BG, FG, AC));
  assert.equal(await omarchyAvailable(), true);
});

test.after(() => {
  rmSync(HOME, { recursive: true, force: true });
});
