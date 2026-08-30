// Codex's `notify` is a SINGLE program (not an array), so the installer edits
// ~/.codex/config.toml by hand: add our line only when there's no top-level
// notify, and remove only a notify line that is ours. These pin that safety —
// a user's own notify (top-level or under a table) must never be clobbered.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codexNotifyLine,
  findTopLevelNotify,
  notifyIsOurs,
  withCodexNotify,
  withoutCodexNotify,
  codexNotifyScriptSource,
} from "../dist-electron/status-hook-codex.js";

const SCRIPT = "/Users/x/.aya/aya-status-codex-notify.sh";

test("codexNotifyLine renders a TOML array with the quoted script path", () => {
  assert.equal(codexNotifyLine(SCRIPT), `notify = ["${SCRIPT}"]`);
});

test("findTopLevelNotify finds a top-level notify and ignores one under a table", () => {
  assert.equal(findTopLevelNotify(`notify = ["/a"]\n`), `notify = ["/a"]`);
  // A notify under [tui] is that table's key, not Codex's global program.
  assert.equal(findTopLevelNotify(`model = "gpt-5"\n[tui]\nnotify = "x"\n`), null);
  assert.equal(findTopLevelNotify(`model = "gpt-5"\n`), null);
  assert.equal(findTopLevelNotify(""), null);
});

test("withCodexNotify adds our line when there is no notify (empty file)", () => {
  const { toml, installed, conflict } = withCodexNotify("", SCRIPT);
  assert.equal(installed, true);
  assert.equal(conflict, false);
  assert.equal(toml, `notify = ["${SCRIPT}"]\n`);
});

test("withCodexNotify prepends, preserving existing content", () => {
  const start = `model = "gpt-5"\n\n[tui]\nfoo = 1\n`;
  const { toml, installed } = withCodexNotify(start, SCRIPT);
  assert.equal(installed, true);
  assert.equal(toml, `notify = ["${SCRIPT}"]\n${start}`);
  // The existing config is still all there.
  assert.ok(toml.includes(`model = "gpt-5"`));
  assert.ok(toml.includes(`[tui]`));
});

test("withCodexNotify is idempotent when ours is already set", () => {
  const start = `notify = ["${SCRIPT}"]\nmodel = "gpt-5"\n`;
  const { toml, installed, conflict } = withCodexNotify(start, SCRIPT);
  assert.equal(installed, true);
  assert.equal(conflict, false);
  assert.equal(toml, start); // unchanged, no duplicate line
});

test("withCodexNotify reports a conflict and changes nothing for a user's own notify", () => {
  const start = `notify = ["/usr/bin/their-notifier", "--flag"]\n`;
  const { toml, installed, conflict } = withCodexNotify(start, SCRIPT);
  assert.equal(installed, false);
  assert.equal(conflict, true);
  assert.equal(toml, start); // untouched
});

test("withoutCodexNotify removes only our line", () => {
  const start = `notify = ["${SCRIPT}"]\nmodel = "gpt-5"\n`;
  assert.equal(withoutCodexNotify(start, SCRIPT), `model = "gpt-5"\n`);
});

test("withoutCodexNotify leaves a user's own notify alone", () => {
  const start = `notify = ["/usr/bin/their-notifier"]\nmodel = "gpt-5"\n`;
  assert.equal(withoutCodexNotify(start, SCRIPT), start);
});

test("withoutCodexNotify never touches a notify under a table", () => {
  const start = `model = "gpt-5"\n[tui]\nnotify = "x"\n`;
  assert.equal(withoutCodexNotify(start, SCRIPT), start);
});

test("notifyIsOurs distinguishes ours from theirs from none", () => {
  assert.equal(notifyIsOurs(`notify = ["${SCRIPT}"]\n`, SCRIPT), true);
  assert.equal(notifyIsOurs(`notify = ["/other"]\n`, SCRIPT), false);
  assert.equal(notifyIsOurs(``, SCRIPT), false);
});

test("install then uninstall round-trips back to the original config", () => {
  const start = `model = "gpt-5"\n\n[tui]\nfoo = 1\n`;
  const { toml } = withCodexNotify(start, SCRIPT);
  assert.equal(withoutCodexNotify(toml, SCRIPT), start);
});

test("the generated notify program maps agent-turn-complete to done and no-ops elsewhere", () => {
  const src = codexNotifyScriptSource(
    "/Applications/Aya.app/Contents/Resources/app.asar.unpacked/bin/aya",
  );
  // No-op guards outside an Aya terminal.
  assert.match(src, /AYA_SOCKET:-.*\|\| exit 0/);
  assert.match(src, /AYA_TERMINAL_ID:-.*\|\| exit 0/);
  // Codex passes the JSON as the last argv -> read $1.
  assert.match(src, /PAYLOAD="\$\{1:-\}"/);
  // The one event Codex emits today -> green done.
  assert.match(src, /agent-turn-complete\)[\s\S]*status done "Turn finished"/);
  // The bundled CLI path is baked as the PATH fallback.
  assert.match(src, /app\.asar\.unpacked\/bin\/aya/);
});
