// Rows follow the measurements in docs/teams.md ("States a team depends on"): codex-cli 0.158.0 TUI,
// opencode 1.18.30, Claude Code 2.1.284, grok 1.0.44; later versions are named where used.

import { test } from "node:test";
import assert from "node:assert/strict";
import { UNREAD_SPELLINGS } from "./helpers/wrapped-spellings.mjs";
import { cantReach, launchFiles, launchHoldOf, launchMode, launchNoteOf, launchUnsure, teamLaunch, withLaunchArgs, LAUNCH_UNREACHABLE, LAUNCH_STARTING, LAUNCH_UNSUPPORTED, NO_LAUNCH_RECORD, launchBlockOf } from "../dist-electron/launch-mode.js";

const SOCK = "/Users/me/.aya/aya.sock";
const NET = "sandbox_workspace_write.network_access=true";
const FULL_NEVER = ["-s", "danger-full-access", "-a", "never"];

function config({ codexUser = null, codexProfile = null, codexProject = [], trusted = true, ocUser = null, ocProject = [], ocContent = null, claude = [], claudeFile = null } = {}) {
  return {
    codex: codexUser === null ? [] : [codexUser],
    codexProfile,
    codexProject,
    codexTrusted: trusted,
    opencode: [ocUser, ...ocProject].filter((t) => t !== null),
    opencodeContent: ocContent,
    claude: [...claude, claudeFile].filter((t) => t !== null),
    socket: SOCK,
  };
}

const RO = 'sandbox_mode = "read-only"';
const FULL = 'sandbox_mode = "danger-full-access"';
const SANDBOXED = JSON.stringify({ sandbox: { enabled: true, allowUnsandboxedCommands: false } });

// [command, config, mode, reach, why]
const MODES = [
  ["codex --no-daemon", {}, "sandbox workspace-write", "blocked", /workspace-write blocks the socket/],
  ["codex --no-daemon -s read-only", {}, "sandbox read-only", "blocked", /read-only blocks the socket/],
  [`codex --no-daemon -c ${NET}`, {}, "sandbox workspace-write + network", "reaches"],
  [`codex --no-daemon -c '${NET}'`, {}, "sandbox workspace-write + network", "reaches"],
  [`codex --no-daemon -s read-only -c ${NET}`, {}, "sandbox read-only", "blocked", /read-only/],
  ["codex --no-daemon -s danger-full-access", {}, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon --sandbox=danger-full-access", {}, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon --dangerously-bypass-approvals-and-sandbox", {}, "no sandbox", "reaches"],
  ["codex --no-daemon --yolo", {}, "no sandbox", "reaches"],
  ["codex --no-daemon -c 'sandbox_workspace_write.writable_roots=[\"/tmp/s\"]'", {}, "sandbox workspace-write", "blocked", /workspace-write/],
  ["codex --no-daemon --approve-for-me", {}, "sandbox workspace-write", "blocked", /workspace-write/],
  ["codex --no-daemon", { codexUser: RO }, "sandbox read-only", "blocked", /read-only/],
  [`codex --no-daemon -c 'sandbox_mode="danger-full-access"' -s read-only`, {}, "sandbox read-only", "blocked", /read-only/],
  ["codex --no-daemon", { codexUser: '# sandbox_mode = "danger-full-access"' }, "sandbox workspace-write", "blocked", /workspace-write/],
  ["codex --no-daemon", { codexUser: 'sandbox_mode = "danger-full-access" # for the team' }, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon", { codexUser: 'sandbox_mode = "external-sandbox"' }, "sandbox external-sandbox", "unknown", /not measured/],
  ["codex --no-daemon --remote ws://box:4000", {}, "remote app server", "unknown", /remote app server/],
  ["codex --no-daemon", { codexUser: FULL }, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon", { codexUser: 'sandbox_mode = "workspace-write"' }, "sandbox workspace-write", "blocked", /workspace-write/],
  ["codex --no-daemon", { codexUser: "[sandbox_workspace_write]\nnetwork_access = true" }, "sandbox workspace-write + network", "reaches"],
  ["codex --no-daemon", { codexUser: "[tui]\nsandbox_mode = \"danger-full-access\"" }, "sandbox workspace-write", "blocked", /workspace-write/],
  [`codex --no-daemon -s workspace-write -c ${NET}`, { codexUser: RO }, "sandbox workspace-write + network", "reaches"],
  [`codex --no-daemon -c ${NET}`, { codexUser: RO }, "sandbox read-only", "blocked", /read-only/],
  ["codex --no-daemon -p team", { codexProfile: FULL }, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon -p team", { codexProfile: RO }, "sandbox read-only", "blocked", /read-only/],
  ["codex --no-daemon", { codexUser: RO, codexProject: [FULL] }, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon", { codexUser: FULL, codexProject: [RO] }, "sandbox read-only", "blocked", /read-only/],
  ["codex --no-daemon -p team", { codexProfile: FULL, codexProject: [RO] }, "sandbox read-only", "blocked", /read-only/],
  [`codex --no-daemon -s workspace-write -c ${NET}`, { codexProject: [RO] }, "sandbox workspace-write + network", "reaches"],
  ["codex --no-daemon --dangerously-bypass-approvals-and-sandbox", { codexProject: [RO] }, "no sandbox", "reaches"],
  ["codex --no-daemon", { codexUser: RO, codexProject: [FULL], trusted: false }, "untrusted project config", "unknown", /trusted/],
  ["codex --no-daemon -c sandbox_workspace_write.network_access=true", { codexProject: ["[sandbox_workspace_write]\nnetwork_access = false"], trusted: false }, "sandbox workspace-write + network", "reaches"],
  ["codex --no-daemon", { codexProject: [FULL], trusted: false }, "untrusted project config", "unknown", /trusted/],
  ["codex --no-daemon", { codexProject: [RO], trusted: false }, "untrusted project config", "unknown", /trusted/],
  ["codex --no-daemon", { codexProject: ["[sandbox_workspace_write]\nnetwork_access = true"], trusted: false }, "untrusted project config", "unknown", /trusted/],
  ["codex --no-daemon", { codexProject: ["[sandbox_workspace_write]\nnetwork_access = true"], trusted: true }, "sandbox workspace-write + network", "reaches", null],
  ["codex --no-daemon -s read-only", { codexProject: ["[sandbox_workspace_write]\nnetwork_access = true"], trusted: false }, "sandbox read-only", "blocked", /read-only/],
  ["codex --no-daemon", { codexProject: ["[tui]\ntheme = \"x\""], trusted: false }, "sandbox workspace-write", "blocked", /workspace-write/],
  ["codex --no-daemon --yolo", { codexProject: [RO], trusted: false }, "no sandbox", "reaches"],
  ["codex --no-daemon -s danger-full-access", { codexProject: [RO], trusted: false }, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon", { codexUser: '"sandbox_mode" = "read-only"' }, "sandbox read-only", "blocked", /read-only/],
  ["codex --no-daemon", { codexUser: "'sandbox_mode' = 'read-only'" }, "sandbox read-only", "blocked", /read-only/],
  ["codex --no-daemon", { codexUser: "sandbox_workspace_write = { network_access = true }" }, "sandbox workspace-write + network", "reaches"],
  ["codex --no-daemon", { codexUser: 'sandbox_workspace_write = { writable_roots = ["/a"], network_access = true }' }, "sandbox workspace-write + network", "reaches"],
  ["codex --no-daemon", { codexUser: 'sandbox_workspace_write."network_access" = true' }, "sandbox workspace-write + network", "reaches"],
  ["codex --no-daemon", { codexUser: '["sandbox_workspace_write"]\n"network_access" = true' }, "sandbox workspace-write + network", "reaches"],
  ["codex --no-daemon", { codexUser: "sandbox_workspace_write = { network_access = false }" }, "sandbox workspace-write", "blocked", /workspace-write/],
  [`codex --no-daemon -c 'sandbox_workspace_write={network_access=true}'`, {}, "sandbox workspace-write + network", "reaches"],
  ["codex --no-daemon", { codexUser: "sandbox_workspace_write = [\"network_access\"]" }, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon", { codexUser: "sandbox_mode = mode_var" }, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon", { codexUser: 'sandbox_mode = """read-only"""' }, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon", { codexUser: "[sandbox_workspace_write]\nnetwork_access = 1" }, "unread config", "unknown", /Codex config/],
  // A project entry that is no table is a form Aya does not read: it cannot tell whether the project is trusted.
  ["codex --no-daemon", { codexUser: '[projects]\n"/repo" = "trusted"' }, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon", { codexUser: 'notify = [\n  "a",\n  "b",\n]\n[sandbox_workspace_write]\nnetwork_access = true' }, "sandbox workspace-write + network", "reaches"],
  ["codex --no-daemon", { codexUser: `${FULL}\n[profiles.careful]\nsandbox_mode = "read-only"` }, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon -p careful", { codexUser: `${FULL}\n[profiles.careful]\nsandbox_mode = "read-only"` }, "legacy profile setting", "unknown", /cannot start.*profile/],
  ["codex --no-daemon --profile=careful", { codexUser: `${FULL}\n[profiles.other]\nsandbox_mode = "read-only"` }, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon", { codexUser: `profile = "careful"\n${FULL}` }, "legacy profile setting", "unknown", /cannot start.*profile/],
  ["codex --no-daemon -c 'profile=\"careful\"'", { codexUser: FULL }, "legacy profile setting", "unknown", /cannot start.*profile/],
  ["codex --no-daemon --yolo", { codexUser: 'profile = "careful"' }, "legacy profile setting", "unknown", /cannot start.*profile/],
  // Measured on Codex 0.159.2: a trusted project's `profile` / `[profiles.x]` is ignored with a warning, not refused.
  ["codex --no-daemon", { codexUser: FULL, codexProject: ['profile = "careful"'] }, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon -p careful", { codexUser: FULL, codexProject: ['[profiles.careful]\nsandbox_mode = "read-only"'] }, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon --yolo -p careful", { codexProject: ["[profiles.careful]"] }, "no sandbox", "reaches"],
  // An empty [profiles.x] table stops Codex from starting as well, bypass flag or not.
  ["codex --no-daemon -p careful", { codexUser: "[profiles.careful]" }, "legacy profile setting", "unknown", /cannot start.*profile/],
  ["codex --no-daemon --yolo -p careful", { codexUser: "[profiles.careful]" }, "legacy profile setting", "unknown", /cannot start.*profile/],
  ["codex --no-daemon --yolo -p careful", { codexUser: "[profiles.careful.sandbox_workspace_write]" }, "legacy profile setting", "unknown", /cannot start.*profile/],
  ["codex --no-daemon -p careful", { codexUser: "[profiles.other]" }, "sandbox workspace-write", "blocked", /workspace-write/],
  // Only config.toml is checked for [profiles.<name>]; the profile file's own copy is accepted, its `profile` key is not.
  ["codex --no-daemon -p careful", { codexUser: FULL, codexProfile: "[profiles.careful]\nmodel = \"x\"" }, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon -p careful", { codexUser: FULL, codexProfile: 'profile = "other"' }, "legacy profile setting", "unknown", /cannot start.*profile/],
  ["codex --no-daemon -p careful", { codexProfile: RO }, "sandbox read-only", "blocked", /read-only/],
  ["codex --no-daemon -p careful", { codexUser: `${RO}\n[profiles.other]\nsandbox_mode = mode_var`, codexProfile: FULL }, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon", { codexUser: `${FULL}\n[profiles.other]\nsandbox_mode = mode_var` }, "sandbox danger-full-access", "reaches"],
  ["codex --no-daemon -p careful", { codexProfile: "sandbox_mode = mode_var" }, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon --yolo -p careful", { codexProfile: "sandbox_mode = mode_var" }, "no sandbox", "reaches"],
  ["codex --no-daemon -p careful", { codexUser: "[profiles.careful.sandbox_workspace_write]\nnetwork_access = true" }, "legacy profile setting", "unknown", /cannot start.*profile/],
  ["codex --no-daemon", { codexUser: "[profiles.careful.sandbox_workspace_write]\nnetwork_access = true" }, "sandbox workspace-write", "blocked", /workspace-write/],
  [`codex --no-daemon -p careful -s workspace-write -c ${NET}`, { codexProfile: RO }, "sandbox workspace-write + network", "reaches"],
  ["codex --no-daemon", { codexProject: ["sandbox_mode = mode_var"] }, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon", { codexProject: ["sandbox_mode = mode_var"], trusted: false }, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon", { codexUser: "this is not toml" }, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon -c sandbox_mode=$MODE", {}, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon -c 'sandbox_mode=[1]'", {}, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon -c 'sandbox_workspace_write={network_access=true'", {}, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon", { codexUser: "[[sandbox_workspace_write]]\nnetwork_access = true" }, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon", { codexUser: "[sandbox_workspace_write] x\nnetwork_access = true" }, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon", { codexUser: 'sandbox_mode = [\n"danger-full-access"' }, "unread config", "unknown", /Codex config/],
  ["codex --no-daemon -p careful", { codexUser: 'profiles.careful.sandbox_mode = "read-only"' }, "legacy profile setting", "unknown", /cannot start.*profile/],
  ["codex --no-daemon -c", {}, "sandbox workspace-write", "blocked", /workspace-write/],
  ["codex --no-daemon -c 'sandbox_mode.=danger-full-access'", {}, "unread config", "unknown", /Codex config/],
  [
    "codex --no-daemon",
    { codexUser: "[sandbox_workspace_write]\nnetwork_access = true", codexProject: ["[sandbox_workspace_write]\nnetwork_access = false"] },
    "sandbox workspace-write",
    "blocked",
    /workspace-write/,
  ],
  ["codex --no-daemon -m -s read-only", {}, "sandbox workspace-write", "blocked", /workspace-write/],
  ["codex --no-daemon --yolo", { codexUser: "this is not toml" }, "no sandbox", "reaches"],
  ["CODEX_HOME='/a b' codex --no-daemon resume --last", {}, "sandbox workspace-write", "blocked", /workspace-write/],
  ["codex --dangerously-bypass-approvals-and-sandbox", {}, "no sandbox, shared daemon", "blocked", /shared daemon.*another Codex pane/],
  ["codex", {}, "sandbox workspace-write", "blocked", /workspace-write/],
  ["codex exec 'fix it'", {}, "codex exec", "unknown", /not an interactive/],
  ["opencode", {}, "agent build", "reaches"],
  ["opencode --session ses_1", {}, "agent build", "reaches"],
  ["opencode --agent plan", {}, "agent plan", "blocked", /plan agent is read-only/],
  ["opencode", { ocProject: ['{"default_agent": "plan"}'] }, "agent plan", "blocked", /plan agent/],
  ["opencode", { ocUser: '{"default_agent": "plan"}', ocProject: ['{"default_agent": "build"}'] }, "agent build", "reaches"],
  ["opencode --agent build", { ocProject: ['{"default_agent": "plan"}'] }, "agent build", "reaches"],
  ["opencode", { ocUser: '{\n  // "default_agent": "plan",\n  "model": "x"\n}' }, "agent build", "reaches"],
  ["opencode", { ocUser: '{ /* "default_agent": "plan", */ "model": "x" }' }, "agent build", "reaches"],
  [`OPENCODE_CONFIG_CONTENT='{"default_agent":"plan"}' opencode`, {}, "agent plan", "blocked", /plan agent/],
  ["opencode", { ocContent: '{"default_agent":"plan"}' }, "agent plan", "blocked", /plan agent/],
  ["opencode", { ocContent: '{"default_agent":"build"}', ocProject: ['{"default_agent": "plan"}'] }, "agent build", "reaches"],
  ["opencode", { ocContent: '{"instructions":["/b.md"]}', ocProject: ['{"default_agent": "plan"}'] }, "agent plan", "blocked", /plan agent/],
  [`OPENCODE_CONFIG_CONTENT='{"instructions":["/b.md"]}' opencode`, { ocContent: '{"default_agent":"plan"}' }, "agent build", "reaches"],
  [`OPENCODE_CONFIG_CONTENT='{"default_agent":"plan"}' opencode --agent build`, {}, "agent build", "reaches"],
  ["opencode --agent algo", {}, "agent algo", "unknown", /not measured/],
  ["opencode run hi", {}, "opencode run", "unknown", /not an interactive/],
  ["claude", {}, "no sandbox", "reaches"],
  ["claude --dangerously-skip-permissions", {}, "no sandbox", "reaches"],
  ["claude", { claude: [SANDBOXED] }, "sandbox on", "blocked", /sandbox is on and does not allow Aya's socket/],
  ["claude --dangerously-skip-permissions", { claude: [SANDBOXED] }, "sandbox on", "blocked", /sandbox is on/],
  [`claude --settings '${SANDBOXED}'`, {}, "sandbox on", "blocked", /sandbox is on/],
  ["claude --settings team.json", { claudeFile: SANDBOXED }, "sandbox on", "blocked", /sandbox is on/],
  [
    "claude",
    { claude: [JSON.stringify({ sandbox: { enabled: true, network: { allowUnixSockets: [SOCK] } } })] },
    "sandbox on, Aya's socket allowed",
    "reaches",
  ],
  ["claude", { claude: [JSON.stringify({ sandbox: { enabled: true, network: { allowAllUnixSockets: true } } })] }, "sandbox on, Aya's socket allowed", "reaches"],
  // Claude Code 2.1.285, measured with a scripted tool call: a directory that holds the socket is allowed
  // as well (its parent, a grandparent, a trailing slash), a sibling or a name prefix is not. "/" was not measured, so
  // Aya adds its own entry for it rather than bet the pane on it.
  ...[
    ["/Users/me/.aya", "reaches"],
    ["/Users/me", "reaches"],
    ["/Users/me/.aya/", "reaches"],
    ["/Users/me/.ay", "blocked"],
    ["/Users/me/.aya-dev", "blocked"],
    ["/Users/me/.aya/aya.sock.d", "blocked"],
    ["/", "blocked"],
    [123, "blocked"],
    [null, "blocked"],
  ].map(([entry, reach]) => [
    "claude",
    { claude: [JSON.stringify({ sandbox: { enabled: true, network: { allowUnixSockets: [entry] } } })] },
    reach === "reaches" ? "sandbox on, Aya's socket allowed" : "sandbox on",
    reach,
    reach === "reaches" ? undefined : /sandbox is on/,
  ]),
  [
    `claude --settings '${JSON.stringify({ sandbox: { network: { allowUnixSockets: [SOCK] } } })}'`,
    { claude: [SANDBOXED] },
    "sandbox on, Aya's socket allowed",
    "reaches",
  ],
  ["claude", { claude: ["{not json"] }, "settings unreadable", "unknown", /could not read/],
  ["claude", { claude: ["", " \n"] }, "no sandbox", "reaches"],
  ["claude", { claude: ["", SANDBOXED] }, "sandbox on", "blocked", /sandbox is on/],
  ["claude", { claude: [JSON.stringify({ sandbox: { enabled: true, network: { allowUnixSockets: ["/tmp/other.sock"] } } })] }, "sandbox on", "blocked", /sandbox is on/],
  ["claude --permission-mode plan", {}, "plan mode", "unknown", /plan mode/],
  ["claude", { claude: [JSON.stringify({ permissions: { defaultMode: "plan" } })] }, "plan mode", "blocked", /plan mode/],
  ["claude", { claude: [JSON.stringify({ permissions: { defaultMode: "plan" } }), JSON.stringify({ permissions: { defaultMode: "default" } })] }, "no sandbox", "reaches"],
  ["claude --dangerously-skip-permissions", { claude: [JSON.stringify({ permissions: { defaultMode: "plan" } })] }, "no sandbox", "reaches"],
  ["claude --permission-mode acceptEdits", { claude: [JSON.stringify({ permissions: { defaultMode: "plan" } })] }, "no sandbox", "reaches"],
  ["grok", {}, "default", "reaches"],
  ["grok --sandbox read-only", {}, "sandbox read-only", "reaches"],
  ["grok --permission-mode plan", {}, "default", "reaches"],
  ["$SHELL", {}, "shell", "unknown", /whatever is typed/],
  ["aider", {}, "aider", "unknown", /run directly .*, not of aider$/],
];

for (const [command, cfg, mode, reach, why] of MODES) {
  test(`launch mode | ${command} ${JSON.stringify(cfg)}`, () => {
    const got = launchMode(command, config(cfg));
    assert.deepEqual([got.mode, got.reach], [mode, reach]);
    if (why) assert.match(got.why, why);
    else assert.equal(got.why, null);
  });
}

// [command, config, args added, or the refusal]
const TEAM = [
  ["codex --no-daemon", {}, FULL_NEVER],
  ["codex --no-daemon -s danger-full-access", {}, []],
  ["codex --no-daemon -a on-request", {}, ["-c", NET]],
  ["codex --no-daemon -s read-only", {}, /Codex is read-only.*Choose a preset with access/],
  ["codex --no-daemon", { codexUser: RO }, /read-only/],
  ["codex --no-daemon", { codexUser: 'sandbox_mode = "workspace-write"\napproval_policy = "on-request"' }, FULL_NEVER],
  ["codex --dangerously-bypass-approvals-and-sandbox", {}, /shared with other panes.*separate Codex pane/],
  ["codex", {}, /shared with other panes.*separate Codex pane/],
  ["opencode", {}, []],
  ["opencode", { ocProject: ['{"default_agent": "plan"}'] }, ["--agent", "build"]],
  ["opencode --agent plan", {}, /planning mode is read-only.*Choose a preset with access/],
  ["opencode", { ocContent: '{"default_agent":"plan"}' }, ["--agent", "build"]],
  [`OPENCODE_CONFIG_CONTENT='{"default_agent":"plan"}' opencode`, {}, ["--agent", "build"]],
  ["claude", { claude: [JSON.stringify({ permissions: { defaultMode: "plan" } })] }, /planning mode.*Choose a preset/],
  ["claude", {}, []],
  ["claude", { claude: [SANDBOXED] }, ["--settings", JSON.stringify({ sandbox: { network: { allowUnixSockets: [SOCK] } } })]],
  [`claude --settings '${SANDBOXED}'`, {}, /current access settings prevent it from sending team messages/],
  ["grok", {}, []],
  ["$SHELL", {}, []],
];

for (const [command, cfg, expected] of TEAM) {
  test(`team launch | ${command} ${JSON.stringify(cfg)}`, () => {
    const got = teamLaunch(command, config(cfg));
    if (expected instanceof RegExp) {
      assert.ok("refused" in got, JSON.stringify(got));
      assert.match(got.refused, expected);
    } else {
      assert.deepEqual(got, { args: expected });
      if (expected.length) assert.equal(launchMode(withLaunchArgs(command, expected), config(cfg)).reach, "reaches", "the added args make it reach");
    }
  });
}

const INSERT = [
  ["codex --no-daemon resume --last", ["-c", NET], `codex -c ${NET} --no-daemon resume --last`],
  ["CODEX_HOME='/a b' codex", ["-c", NET], `CODEX_HOME='/a b' codex -c ${NET}`],
  ["opencode --session ses_1", ["--agent", "build"], "opencode --agent build --session ses_1"],
  ["claude", ["--settings", '{"a":["/x y"]}'], `claude --settings '{"a":["/x y"]}'`],
  ["codex", [], "codex"],
];

for (const [command, args, expected] of INSERT) {
  test(`with launch args | ${command} + ${args.join(" ")}`, () => {
    assert.equal(withLaunchArgs(command, args), expected);
  });
}

test("the message for a pane that can't reach Aya names the fix Aya would use", () => {
  assert.equal(
    cantReach(launchMode("codex --no-daemon", config())),
    "can't reach Aya: Codex's current access settings prevent it from sending team messages; Choose a preset with access that allows team messages, or change this pane's access settings and choose Restart terminal",
  );
  assert.equal(
    cantReach(launchMode("codex --no-daemon -s read-only", config())),
    "can't reach Aya: Codex is read-only, so it cannot do this role's work; Choose a preset with access that allows team messages, or change this pane's access settings and choose Restart terminal",
  );
  assert.match(cantReach(launchMode("codex -s danger-full-access", config())), /^can't reach Aya: This Codex session is shared with other panes.*Use a separate Codex pane/);
  assert.equal(cantReach(launchMode("codex --no-daemon --yolo", config())), null);
  assert.equal(
    cantReach(launchMode("opencode --agent plan", config())),
    "can't reach Aya: OpenCode's planning mode is read-only, so it cannot make the changes this role needs; Choose a preset with access that allows team messages, or change this pane's access settings and choose Restart terminal",
    "a new pane of the same preset would not help",
  );
  assert.match(cantReach(launchMode(`claude --settings '${SANDBOXED}'`, config())), /Claude Code's current access settings prevent it from sending team messages; Choose a preset/);
  assert.equal(cantReach(launchMode("$SHELL", config())), null, "a shell is unknown but not held");
});

// [command, config, what the note tells the user]: an unknown verdict is never held, only noted in the window.
const NOTED_UNKNOWN = [
  ["codex --no-daemon", { codexProject: [FULL], trusted: false }, /^Codex has not trusted this project.*Trust the project in Codex, then choose Restart terminal\./],
  ["codex --no-daemon", { codexUser: "sandbox_mode = mode_var" }, /^Aya could not understand one of Codex's access settings.*Review that setting in Codex, then choose Restart terminal\./],
  ["codex --no-daemon -c sandbox_mode=$X", {}, /^Aya could not understand one of Codex's access settings/],
  ["codex --no-daemon -p careful", { codexUser: "[profiles.careful]\nmodel = \"x\"" }, /^This Codex setup uses an older profile setting.*Remove the old profile setting in Codex, then choose Restart terminal\./],
  ["codex --no-daemon", { codexUser: 'profile = "careful"' }, /^This Codex setup uses an older profile setting/],
  ["claude --permission-mode plan", {}, /^Claude Code's planning mode may not make changes.*Choose a mode that can make changes, then choose Restart terminal\./],
  ["claude", { claude: ["{not json"] }, /^Aya could not understand Claude Code's access settings.*Check those settings in Claude Code, then choose Restart terminal\./],
  ["$SHELL", {}, /^This pane accepts commands you type/],
  ["aider", {}, /^Aya could not identify how this pane connects/],
  ["codex exec hi", {}, /^This command runs once and exits instead of opening an interactive Codex pane/],
  ["opencode run hi", {}, /^This command runs once and exits instead of opening an interactive OpenCode pane/],
  ["opencode --agent algo", {}, /^Aya has not checked what OpenCode's algo mode allows/],
  ["codex --no-daemon", { codexUser: 'sandbox_mode = "external-sandbox"' }, /^Aya has not checked what this Codex access setting allows/],
  ["npx codex", {}, /^Aya could not identify how this pane connects/],
];

for (const [command, cfg, expected] of NOTED_UNKNOWN) {
  test(`unknown is noted, never held | ${command} ${JSON.stringify(cfg)}`, () => {
    const mode = launchMode(command, config(cfg));
    assert.equal(mode.reach, "unknown");
    assert.equal(cantReach(mode), null);
    assert.equal(launchHoldOf({ command, cwd: "/p", mode }), null);
    assert.match(launchNoteOf({ command, cwd: "/p", mode }), expected);
  });
}

test("a verdict that reaches is not held, whatever unread config a bypass makes moot", () => {
  assert.equal(cantReach(launchMode("codex --no-daemon --yolo", config({ codexUser: "sandbox_mode = mode_var" }))), null);
  assert.equal(cantReach(launchMode("claude", config())), null);
});

const ENV = { HOME: "/h" };
const DIRS = ["/repo", "/repo/app"];
const MANAGED = "/Library/Application Support/ClaudeCode/managed-settings.json";

// [command, env, files]: which files decide the default, lowest precedence first.
const FILES = [
  ["codex", ENV, { codex: ["/h/.codex/config.toml", "/repo/.codex/config.toml", "/repo/app/.codex/config.toml"] }],
  ["CODEX_HOME=~/.codex-work codex -p team", ENV, { codex: ["/h/.codex-work/config.toml", "/h/.codex-work/team.config.toml", "/repo/.codex/config.toml", "/repo/app/.codex/config.toml"] }],
  ["codex --profile=team", { ...ENV, CODEX_HOME: "/c" }, { codex: ["/c/config.toml", "/c/team.config.toml", "/repo/.codex/config.toml", "/repo/app/.codex/config.toml"] }],
  [
    "opencode",
    ENV,
    {
      opencode: [
        "/h/.config/opencode/opencode.json", "/h/.config/opencode/opencode.jsonc",
        "/repo/opencode.json", "/repo/opencode.jsonc", "/repo/.opencode/opencode.json", "/repo/.opencode/opencode.jsonc",
        "/repo/app/opencode.json", "/repo/app/opencode.jsonc", "/repo/app/.opencode/opencode.json", "/repo/app/.opencode/opencode.jsonc",
      ],
    },
  ],
  [
    "OPENCODE_CONFIG=/x/oc.json opencode",
    { ...ENV, XDG_CONFIG_HOME: "/xdg" },
    {
      opencode: [
        "/xdg/opencode/opencode.json", "/xdg/opencode/opencode.jsonc", "/x/oc.json",
        "/repo/opencode.json", "/repo/opencode.jsonc", "/repo/.opencode/opencode.json", "/repo/.opencode/opencode.jsonc",
        "/repo/app/opencode.json", "/repo/app/opencode.jsonc", "/repo/app/.opencode/opencode.json", "/repo/app/.opencode/opencode.jsonc",
      ],
    },
  ],
  ["claude", ENV, { claude: ["/h/.claude/settings.json", "/repo/app/.claude/settings.json", "/repo/app/.claude/settings.local.json", MANAGED] }],
  [
    'CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude --settings team.json',
    ENV,
    { claude: ["/h/.claude-work/settings.json", "/repo/app/.claude/settings.json", "/repo/app/.claude/settings.local.json", "/repo/app/team.json", MANAGED] },
  ],
  [`claude --settings '{"a":1}'`, ENV, { claude: ["/h/.claude/settings.json", "/repo/app/.claude/settings.json", "/repo/app/.claude/settings.local.json", MANAGED] }],
  ["grok", ENV, {}],
  ["$SHELL", ENV, {}],
];

for (const [command, env, files] of FILES) {
  test(`launch files | ${command}`, () => {
    assert.deepEqual(launchFiles(command, env, DIRS), { codex: [], opencode: [], claude: [], ...files });
  });
}

// The program may come behind `NAME=value` and a plain `exec`: the same spellings agentProgram reads as the agent.
const PROGRAMS = {
  claude: [`--settings '${SANDBOXED}'`, "blocked", "sandbox on"],
  codex: ["--no-daemon", "blocked", "sandbox workspace-write"],
  opencode: ["--agent plan", "blocked", "agent plan"],
  grok: ["--sandbox strict", "reaches", "sandbox strict"],
};
const SPELLINGS = [(c) => c, (c) => `exec ${c}`, (c) => `FOO=1 ${c}`, (c) => `FOO=1 exec ${c}`, (c) => `FOO='a b' exec  ${c}`];

for (const [agent, [args, reach, mode]] of Object.entries(PROGRAMS)) {
  for (const spell of SPELLINGS) {
    const command = spell(`${agent} ${args}`);
    test(`launch mode | ${command}`, async () => {
      const got = launchMode(command, config());
      assert.deepEqual([got.cli, got.reach, got.mode], [agent, reach, mode]);
      const { agentProgram } = await import("../dist-electron/agent-session.js");
      assert.equal(agentProgram(command), agent, "agentProgram reads the same spelling as this agent");
    });
    test(`launch args go after the program | ${command}`, () => {
      assert.equal(withLaunchArgs(command, ["-c", "x=1"]), command.replace(new RegExp(`(${agent})( |$)`), "$1 -c x=1$2"));
    });
  }
}

// Behind anything else Aya reads no flags: the pane is unknown, opened as written, noted and never held.
const UNREAD = [...UNREAD_SPELLINGS, "cd sub && env codex", "cd sub && npx claude", "FOO=1 env grok --x"];

test("every spelling Aya does not read through is unknown, noted and never held", () => {
    const wrong = UNREAD.filter((c) => {
    const mode = launchMode(c, config());
    return mode.reach !== "unknown" || cantReach(mode) !== null || !/Aya could not identify how this pane connects/.test(launchNoteOf({ command: c, cwd: "/p", mode }) ?? "");
  });
  assert.deepEqual(wrong, []);
});

test("a pane whose agent has called aya since its spawn reaches Aya: only structured uncertainty goes away", () => {
  const mode = launchMode("npx codex", config());
  assert.match(launchNoteOf({ command: "npx codex", cwd: "/p", mode }, false), /Aya could not identify how this pane connects/);
  assert.equal(launchNoteOf({ command: "npx codex", cwd: "/p", mode }, true), null);
  const untrusted = launchMode("codex --no-daemon -s danger-full-access -a untrusted", config());
  assert.match(launchNoteOf({ command: "codex", cwd: "/p", mode: untrusted }, true), /Codex will ask you before running each team action/);
});

test("Aya adds no flags to a command it does not read through", () => {
  for (const c of UNREAD) assert.deepEqual(teamLaunch(c, config()), { args: [] }, c);
});

test("launch uncertainty comes from the launch result, not user-facing note text", () => {
  const mode = launchMode("npx codex", config());
  const unknownLaunch = { command: "codex", cwd: "/p", added: ["-c", "sandbox_workspace_write.network_access=true"], mode };
  const note = launchNoteOf(unknownLaunch);
  assert.match(note, /^Aya allowed this Codex pane to connect to any network host.*Aya could not identify how this pane connects/);
  assert.equal(launchUnsure(unknownLaunch), true);
  const reachedLaunch = { ...unknownLaunch, mode: { ...mode, reach: "reaches" } };
  assert.equal(launchUnsure(reachedLaunch), false);
  assert.equal(launchUnsure({ ...reachedLaunch, note: "may not reach Aya: user supplied wording" }), false);
  assert.equal(launchUnsure(null), true);
  assert.equal(launchUnsure(LAUNCH_UNREACHABLE), true);
});

test("team-card launch text is plain language and names the available next step", () => {
  const blocks = [
    NO_LAUNCH_RECORD,
    launchBlockOf(LAUNCH_UNREACHABLE),
    launchBlockOf(LAUNCH_STARTING),
    launchBlockOf(LAUNCH_UNSUPPORTED),
    cantReach(launchMode("codex --no-daemon", config())),
    cantReach(launchMode("claude", config({ claude: [SANDBOXED] }))),
  ].join(" ");
  assert.match(blocks, /Restart terminal|Settings > Diagnostics > PTY host > Restart/);
  assert.doesNotMatch(blocks, /launch flags|preflight|socket|launch record|--no-daemon|allowUnixSockets/);

  const notes = [
    launchNoteOf({ command: "npx codex", cwd: "/p", mode: launchMode("npx codex", config()) }),
    launchNoteOf({ command: "claude --permission-mode plan", cwd: "/p", mode: launchMode("claude --permission-mode plan", config()) }),
    launchNoteOf({ command: "codex --no-daemon", cwd: "/p", added: ["-c", NET], mode: launchMode("codex --no-daemon", config()) }),
    launchNoteOf({ command: "codex --no-daemon", cwd: "/p", added: ["-s", "danger-full-access"], mode: launchMode("codex --no-daemon", config()) }),
  ].join(" ");
  assert.match(notes, /Aya allowed this Codex pane to connect to any network host/);
  assert.match(notes, /without a sandbox.*access your files/);
  assert.doesNotMatch(notes, /launch flags|preflight|socket|launch record|--dangerously|sandbox_workspace/);
});

test("structured user-facing launch copy survives the closed recovery checkpoint schema", async () => {
  const { validateRecoveryLaunch } = await import("../dist-electron/pty-core-checkpoint.js");
  const launch = { command: "npx codex", cwd: "/project", mode: launchMode("npx codex", config()) };
  assert.doesNotThrow(() => validateRecoveryLaunch("pane-1", { ptyId: "pane-1", command: "npx codex", cwd: "/project", cols: 80, rows: 24 }, launch, 1));
});
