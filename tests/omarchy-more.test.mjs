// readOmarchyTheme/readOmarchyStatus against a redirected home (theme name,
// light.mode fallback) and watchOmarchyTheme, both against a real directory and
// through a fake fs.watch where timing has to be exact. omarchy.js resolves its
// paths at load, so HOME is set before import, as in omarchy-available.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs, {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";

// os.homedir() only consults $HOME on POSIX, so the redirect below is inert on
// Windows and there is nothing here to run.
const skip = process.platform === "win32" ? "the $HOME redirect is POSIX-only" : false;

const HOME = mkdtempSync(join(tmpdir(), "aya-omarchy-more-"));
process.env.HOME = HOME;

const {
  OMARCHY_COLORS_FILE,
  OMARCHY_WATCH_DEBOUNCE_MS,
  parseOmarchyColors,
  readOmarchyStatus,
  readOmarchyTheme,
  watchOmarchyTheme,
} = await import("../dist-electron/omarchy.js");

const THEME_DIR = dirname(OMARCHY_COLORS_FILE);
const STATE_DIR = dirname(THEME_DIR);
const NAME_FILE = join(STATE_DIR, "theme.name");
const LIGHT_MODE_FILE = join(THEME_DIR, "light.mode");

const toml = (...lines) => lines.join("\n") + "\n";
const BG = 'background = "#1a1b26"';
const FG = 'foreground = "#a9b1d6"';
const AC = 'accent = "#7aa2f7"';

/** A fresh Omarchy state dir; `name` null leaves theme.name out. */
function install({ colors, name = null, lightMode = false }) {
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(THEME_DIR, { recursive: true });
  writeFileSync(OMARCHY_COLORS_FILE, colors);
  if (lightMode) writeFileSync(LIGHT_MODE_FILE, "");
  if (name !== null) writeFileSync(NAME_FILE, name);
}

// Runs first, while the redirected home has no Omarchy state dir at all.
test("watching with no Omarchy install neither throws nor watches", { skip }, () => {
  // fs.watch on an absent dir throws ENOENT synchronously; it must stay inside
  // watchOmarchyTheme, or app startup on any non-Omarchy machine crashes.
  const unwatch = watchOmarchyTheme(() => assert.fail("nothing to watch"));
  assert.equal(typeof unwatch, "function");
  unwatch();
});

test("the theme name is read from theme.name, trimmed", { skip }, async () => {
  // Written by shell tools with a trailing newline; untrimmed it shows in
  // Settings as "tokyo-night\n".
  install({ colors: toml(BG, FG, AC), name: "tokyo-night\n" });
  const theme = await readOmarchyTheme();
  assert.equal(theme.name, "tokyo-night");
  assert.equal(theme.palette.accent, "#7aa2f7");
  assert.deepStrictEqual(await readOmarchyStatus(), {
    available: true,
    themeName: "tokyo-night",
  });
});

test("a missing or blank theme.name still yields a usable theme", { skip }, async () => {
  // The name is cosmetic: losing it must not take the skin away.
  for (const [why, name] of [["missing", null], ["blank", "  \n"]]) {
    install({ colors: toml(BG, FG, AC), name });
    const theme = await readOmarchyTheme();
    assert.ok(theme, `${why}: the palette alone is enough`);
    assert.equal(theme.name, "", why);
    assert.deepStrictEqual(
      await readOmarchyStatus(),
      { available: true, themeName: null },
      `${why}: an empty name is reported as no name, not ""`,
    );
  }
});

test("an unusable palette reports no theme name either", { skip }, async () => {
  // theme.name is present, but Settings must not name a theme it cannot apply.
  install({ colors: toml(BG, FG), name: "broken" });
  assert.equal(await readOmarchyTheme(), null);
  assert.deepStrictEqual(await readOmarchyStatus(), {
    available: false,
    themeName: null,
  });
});

test("a colors.toml that cannot be read as a file is no theme, not a throw", { skip }, async () => {
  // A directory in its place: readFile rejects with EISDIR, which the IPC
  // handler would otherwise forward to the renderer as an error.
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(OMARCHY_COLORS_FILE, { recursive: true });
  assert.equal(await readOmarchyTheme(), null);
});

test("light.mode makes a palette that names no mode light", { skip }, async () => {
  // Omarchy marks light themes with a light.mode file, not a key in colors.toml.
  install({ colors: toml(BG, FG, AC), lightMode: true });
  assert.equal((await readOmarchyTheme()).palette.mode, "light");
  install({ colors: toml(BG, FG, AC), lightMode: false });
  assert.equal((await readOmarchyTheme()).palette.mode, "dark");
});

test("the palette's own mode beats a light.mode marker", { skip }, async () => {
  // light.mode is only the fallback; the opposite answer makes this falsifiable.
  install({ colors: toml('mode = "dark"', BG, FG, AC), lightMode: true });
  assert.equal((await readOmarchyTheme()).palette.mode, "dark");
});

/** Resolves on the next onChange; the test's own timeout bounds the wait. */
function nextChange() {
  let resolve;
  const changed = new Promise((r) => (resolve = r));
  return { changed, onChange: () => resolve() };
}

/** Waits until a real watch hears a change (the poke, repeated until one gets through), then until it has
 *  been quiet for three debounces, so a late sentinel event is not taken for the change under test. On macOS
 *  fs.watch rides on FSEvents, which starts asynchronously: on a busy machine a change made right after the
 *  watch starts is lost (8 of 16 probes, 2026-10-14), and the test then waited out its timeout. */
async function watchIsLive(poke, setHandler, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let last = 0;
  setHandler(() => (last = Date.now()));
  // Pokes further apart than the debounce, or each one would restart it and nothing would fire. The
  // deadline ends the loop itself: a test timeout fails the test but would leave this loop writing.
  while (last === 0) {
    if (Date.now() > deadline) throw new Error(`the watch heard no change in ${deadlineMs} ms`);
    poke();
    await sleep(OMARCHY_WATCH_DEBOUNCE_MS * 2);
  }
  while (Date.now() - last < OMARCHY_WATCH_DEBOUNCE_MS * 3) await sleep(50);
}

test("relinking the theme symlink, as omarchy-theme-set does, fires onChange", { skip, timeout: 10_000 }, async (t) => {
  // Two installed themes; current/theme is a symlink to one of them.
  const themes = join(HOME, "themes");
  rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(themes, { recursive: true, force: true });
  for (const [dir, accent] of [["night", "#7aa2f7"], ["day", "#1e66f5"]]) {
    mkdirSync(join(themes, dir), { recursive: true });
    writeFileSync(join(themes, dir, "colors.toml"), toml(BG, FG, `accent = "${accent}"`));
  }
  mkdirSync(STATE_DIR, { recursive: true });
  symlinkSync(join(themes, "night"), THEME_DIR);
  assert.equal((await readOmarchyTheme()).palette.accent, "#7aa2f7");

  let heard = () => {};
  const unwatch = watchOmarchyTheme(() => heard());
  t.after(unwatch);
  await watchIsLive(() => writeFileSync(join(STATE_DIR, "sentinel"), String(Date.now())), (h) => (heard = h), 5_000);
  const { changed, onChange } = nextChange();
  heard = onChange;

  // Atomic relink: a new symlink renamed over the old one. The relink alone must fire onChange, so
  // theme.name, which omarchy-theme-set also writes, is written only after the change was heard.
  const tmpLink = join(STATE_DIR, "theme.tmp");
  symlinkSync(join(themes, "day"), tmpLink);
  renameSync(tmpLink, THEME_DIR);

  await changed;
  assert.equal((await readOmarchyTheme()).palette.accent, "#1e66f5", "the switched-to palette is what a re-read sees");
  writeFileSync(NAME_FILE, "day\n");
  assert.equal((await readOmarchyTheme()).name, "day");
});

/** A stand-in for fs.watch whose events the test fires by hand. */
function fakeWatch(t) {
  const fake = { listener: null, closed: 0, watcher: null };
  t.mock.method(fs, "watch", (dir, listener) => {
    assert.equal(dir, STATE_DIR, "the watch is on the state dir");
    fake.listener = listener;
    fake.watcher = Object.assign(new EventEmitter(), {
      close: () => {
        fake.closed += 1;
      },
    });
    return fake.watcher;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return fake;
}

test("a burst of watch events yields one onChange, 150 ms after the last", { skip }, (t) => {
  // One theme switch touches the symlink and theme.name; re-skinning per event
  // makes every window repaint several times.
  const fake = fakeWatch(t);
  let calls = 0;
  const unwatch = watchOmarchyTheme(() => (calls += 1));
  t.after(unwatch);

  fake.listener("rename", "theme");
  t.mock.timers.tick(100);
  fake.listener("change", "theme.name");
  t.mock.timers.tick(100);
  fake.listener("change", "theme.name");
  // 200 ms since the first event: a leading or fixed-window debounce has fired.
  t.mock.timers.tick(OMARCHY_WATCH_DEBOUNCE_MS - 1);
  assert.equal(calls, 0, "still inside the quiet period of the last event");
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  assert.equal(calls, 1, "the burst is reported once");
});

test("unwatch cancels a pending change and closes the watcher", { skip }, (t) => {
  // before-quit calls unwatch; a change fired after it would message windows
  // that are being torn down.
  const fake = fakeWatch(t);
  let calls = 0;
  const unwatch = watchOmarchyTheme(() => (calls += 1));
  fake.listener("rename", "theme");
  unwatch();
  t.mock.timers.tick(1000);
  assert.equal(calls, 0);
  assert.equal(fake.closed, 1, "the OS watch handle is released");
});

test("a watcher error is absorbed and releases the watch", { skip }, (t) => {
  // An "error" with no listener is an uncaught exception in the main process.
  const fake = fakeWatch(t);
  const unwatch = watchOmarchyTheme(() => {});
  assert.doesNotThrow(() => fake.watcher.emit("error", new Error("EMFILE")));
  assert.equal(fake.closed, 1, "the broken watch is closed");
  assert.doesNotThrow(unwatch, "unwatch after an error is still safe");
});

// Bug: electron/omarchy.ts:110 only recognises a header that ends the line, but
// TOML allows `[table] # comment`. Such a header is skipped, so the keys under
// it land in the TOP-LEVEL map and, last-wins, overwrite the real palette.
test(
  "a table header with a trailing comment still opens that table",
  () => {
    const p = parseOmarchyColors(
      toml(BG, FG, AC, 'red = "#ff0000"', "[ui] # editor chrome", 'background = "#000000"', 'red = "#00ff00"'),
    );
    assert.equal(p.background, "#1a1b26", "a non-palette table cannot restyle the background");
    assert.equal(p.red, "#ff0000");
  },
);

test.after(() => {
  rmSync(HOME, { recursive: true, force: true });
});
