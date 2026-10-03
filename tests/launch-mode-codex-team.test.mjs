// A Codex role pane runs with -s danger-full-access -a never: measured 2026-10-03 (codex-cli 0.160), the default sandbox
// failed `git commit` on .git/index.lock and held `aya team send` for an approval. A preset's own sandbox/approval stays.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cantReach, launchMode, launchNoteOf, teamLaunch, withLaunchArgs } from "../dist-electron/launch-mode.js";
import { withNoDaemon } from "../dist-electron/codex-daemon.js";

const SOCK = "/Users/me/.aya/aya.sock";
const config = () => ({ codex: [], codexProfile: null, codexProject: [], codexTrusted: true, opencode: [], opencodeContent: null, claude: [], socket: SOCK });
const NET = "sandbox_workspace_write.network_access=true";
const FULL = ["-s", "danger-full-access", "-a", "never"];
const OPENED_FULL = /Aya opened it with -s danger-full-access -a never/;
const PRESET_DECIDES = /as the preset sets them.*may stop for approvals on git and aya/;
const WILL_STOP = /^Codex sandbox workspace-write will stop for approvals on git and aya; open a new pane for it, or restart this one with -s danger-full-access -a never$/;
const WIDENED = /Aya opened it with -c sandbox_workspace_write\.network_access=true/;

// [preset, new pane: { args | refused, note, cantReach }, existing pane assigned: { note, cantReach }]; note/cantReach: regex, or null for none.
const CASES = [
  ["codex", { args: FULL, note: OPENED_FULL, cantReach: null }, { note: null, cantReach: /workspace-write blocks the socket; open a new pane for it, or restart this one with -s danger-full-access -a never$/ }],
  [`codex -c ${NET}`, { args: FULL, note: OPENED_FULL, cantReach: null }, { note: WILL_STOP, cantReach: null }],
  ["codex -s read-only", { refused: /read-only blocks the socket; pick a preset that allows it \(one that runs codex with -s danger-full-access -a never\)/, note: null, cantReach: /read-only blocks the socket; restart it with -s danger-full-access -a never$/ }, { note: null, cantReach: /read-only blocks the socket/ }],
  ["codex -a on-request", { args: ["-c", NET], note: PRESET_DECIDES, cantReach: null }, { note: null, cantReach: /workspace-write blocks the socket; open a new pane for it, or restart this one with -c sandbox_workspace_write\.network_access=true$/ }],
  ["codex -c approval_policy=on-request", { args: ["-c", NET], note: PRESET_DECIDES, cantReach: null }, { note: null, cantReach: /workspace-write blocks the socket/ }],
  ["codex -c sandbox_mode=workspace-write", { args: ["-c", NET], note: PRESET_DECIDES, cantReach: null }, { note: null, cantReach: /workspace-write blocks the socket/ }],
  ["codex --full-auto", { args: ["-c", NET], note: PRESET_DECIDES, cantReach: null }, { note: null, cantReach: /workspace-write blocks the socket/ }],
  ["codex -s danger-full-access", { args: [], note: PRESET_DECIDES, cantReach: null }, { note: PRESET_DECIDES, cantReach: null }],
  ["codex --dangerously-bypass-approvals-and-sandbox", { args: [], note: null, cantReach: null }, { note: null, cantReach: null }],
  ["codex -s danger-full-access -a never", { args: [], note: null, cantReach: null }, { note: null, cantReach: null }],
  ["cd x && codex", { args: FULL, note: OPENED_FULL, cantReach: null }, { note: null, cantReach: /workspace-write blocks the socket; open a new pane for it, or restart this one with -s danger-full-access -a never$/ }],
  [`cd x && codex -c ${NET}`, { args: FULL, note: OPENED_FULL, cantReach: null }, { note: WILL_STOP, cantReach: null }],
];

// As the terminal host records a pane; `reached`: its agent has called aya, the live run's verdict=reached.
function record(command, added) {
  const mode = launchMode(command, config());
  return { mode, note: launchNoteOf({ command, cwd: "/p", added, mode }, true), cantReach: cantReach(mode) };
}

function expectMatch(got, expected, what) {
  if (expected === null) assert.equal(got, null, what);
  else assert.match(got ?? "", expected, what);
}

for (const [preset, fresh, existing] of CASES) {
  const command = withNoDaemon(preset);

  test(`codex team pane | new pane | ${preset}`, () => {
    const got = teamLaunch(command, config());
    if (fresh.refused) {
      assert.ok("refused" in got, JSON.stringify(got));
      assert.match(got.refused, fresh.refused);
      const launched = record(command, []);
      expectMatch(launched.cantReach, fresh.cantReach, "launched as its preset says, still flagged");
      return;
    }
    assert.deepEqual(got, { args: fresh.args });
    const launched = record(withLaunchArgs(command, got.args), got.args);
    assert.equal(launched.mode.reach, "reaches");
    expectMatch(launched.cantReach, fresh.cantReach, "cantReach");
    expectMatch(launched.note, fresh.note, "note");
    if (fresh.args === FULL) assert.doesNotMatch(launched.note, /may stop|will stop/);
  });

  test(`codex team pane | existing pane assigned | ${preset}`, () => {
    const assigned = record(command, []);
    expectMatch(assigned.cantReach, existing.cantReach, "cantReach");
    expectMatch(assigned.note, existing.note, "note");
  });
}

test("the full-access args go after the program, before the preset's own args and its cd", () => {
  assert.equal(withLaunchArgs("cd x && codex --no-daemon", FULL), "cd x && codex -s danger-full-access -a never --no-daemon");
});
