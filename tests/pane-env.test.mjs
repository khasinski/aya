import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { AYA_HOME } from "../dist-electron/paths.js";
import { safeEnv } from "../dist-electron/pty.js";

const CLAUDE = {
  AI_AGENT: "claude-code_1_agent",
  CLAUDECODE: "1",
  CLAUDE_CODE_CHILD_SESSION: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_EXECPATH: "/x/claude",
  CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/s.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "t",
  CLAUDE_CODE_SESSION_ATTENDED: "1",
  CLAUDE_CODE_SESSION_ID: "abc",
  CLAUDE_PID: "1",
};
const CODEX = {
  CODEX_CI: "1",
  CODEX_SANDBOX: "seatbelt",
  CODEX_SANDBOX_NETWORK_DISABLED: "1",
  CODEX_SESSION_ID: "s",
  CODEX_THREAD_ID: "t",
};
const OPENCODE = { AGENT: "1", OPENCODE: "1", OPENCODE_PID: "2" };
const GROK = { GROK_AGENT: "1", GROK_SESSION_ID: "g" };
const OUTER_AYA = {
  AYA_HOME: "/outer/home",
  AYA_SOCKET: "/outer/sock",
  AYA_TERMINAL_ID: "outer-pty",
  AYA_PROJECT_DIR: "/outer/dir",
  AYA_PROJECT_SLUG: "outer-project",
  AYA_PRESET_ID: "outer-preset",
};
const LAUNCHERS = {
  "plain terminal": {},
  "Claude session": CLAUDE,
  "Codex session": CODEX,
  "OpenCode session": OPENCODE,
  "Grok session": GROK,
  "Aya pane": OUTER_AYA,
  "Aya pane inside a Codex session": { ...OUTER_AYA, ...CODEX },
  "Claude session that started a Codex session": { ...CLAUDE, ...CODEX },
  "Codex session that set TERM=dumb": { ...CODEX, TERM: "dumb", COLORTERM: "0" },
};
const FOREIGN = [...Object.keys(CLAUDE), ...Object.keys(CODEX), ...Object.keys(OPENCODE), ...Object.keys(GROK)];
const AYA_OWNED = Object.keys(OUTER_AYA);

function envFor(launcher, req) {
  const saved = process.env;
  process.env = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/u/.claude", CODEX_HOME: "/u/.codex", ...launcher };
  try {
    return safeEnv({ ptyId: "p1", ...req }, "/work/dir");
  } finally {
    process.env = saved;
  }
}

for (const [name, launcher] of Object.entries(LAUNCHERS)) {
  for (const [reqName, req] of [
    ["request with slug+preset", { projectSlug: "mine", presetId: "team1" }],
    ["request without them", {}],
  ]) {
    test(`pane env: launched from ${name}, ${reqName}`, () => {
      const env = envFor(launcher, req);
      for (const key of FOREIGN) assert.equal(key in env, false, `${key} leaked`);
      assert.equal(env.CLAUDE_CONFIG_DIR, "/u/.claude");
      assert.equal(env.CODEX_HOME, "/u/.codex");
      assert.equal(env.AYA_TERMINAL_ID, "p1");
      assert.equal(env.AYA_PROJECT_DIR, "/work/dir");
      assert.notEqual(env.AYA_HOME, "/outer/home");
      assert.notEqual(env.AYA_SOCKET, "/outer/sock");
      assert.equal(env.AYA_PROJECT_SLUG, req.projectSlug);
      assert.equal(env.AYA_PRESET_ID, req.presetId);
      // A key holding undefined would reach the child as the string "undefined".
      assert.equal("AYA_PROJECT_SLUG" in env, "projectSlug" in req);
      assert.equal("AYA_PRESET_ID" in env, "presetId" in req);
      for (const key of AYA_OWNED) assert.notEqual(env[key], OUTER_AYA[key], `${key} is the outer Aya's`);
    });
  }
}

test("pane env: the pane's terminal is Aya's, whatever the launcher's", () => {
  for (const launcher of Object.values(LAUNCHERS)) {
    const env = envFor({ ...launcher, TERM: "dumb", COLORTERM: "0" }, {});
    assert.deepEqual([env.TERM, env.COLORTERM], ["xterm-256color", "truecolor"]);
  }
});

test("pane env: two sessions' companions are both dropped", () => {
  const env = envFor({ ...CLAUDE, ...CODEX, ...GROK, GIT_EDITOR: "true", NO_COLOR: "1", CODEX_VERSION: "1", CLAUDE_EFFORT: "high", CI: "true" }, {});
  for (const key of ["GIT_EDITOR", "NO_COLOR", "CODEX_VERSION", "CLAUDE_EFFORT", "CI"]) assert.equal(key in env, false, key);
});

// Aya's own PTY host is started with this so it runs as plain Node; a pane must not get it.
test("pane env: ELECTRON_RUN_AS_NODE is the host's, never a pane's, whatever launched Aya", () => {
  for (const launcher of Object.values(LAUNCHERS)) {
    assert.equal("ELECTRON_RUN_AS_NODE" in envFor({ ...launcher, ELECTRON_RUN_AS_NODE: "1" }, {}), false);
  }
});

test("pane env: the outer Aya's mode switches are not passed on, its remote socket is", () => {
  const env = envFor(
    { AYA_DEV: "1", AYA_E2E_HEADLESS: "1", AYA_E2E_PTY_SHUTDOWN: "1", AYA_E2E_APPLE_HELPER: "x", AYA_CLAUDE_SETTINGS: "/o/s.json", AYA_REMOTE_SOCKET: "/o/r.sock" },
    {},
  );
  for (const key of ["AYA_DEV", "AYA_E2E_HEADLESS", "AYA_E2E_PTY_SHUTDOWN", "AYA_E2E_APPLE_HELPER", "AYA_CLAUDE_SETTINGS"]) {
    assert.equal(key in env, false, key);
  }
  assert.equal(env.AYA_REMOTE_SOCKET, "/o/r.sock");
});

// What each CLI sets for its children besides its session markers (measured). A user's own setting of the
// same name survives when no such session launched Aya.
const OWN = {
  NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat", GH_PAGER: "cat", GIT_EDITOR: "true", CI: "true", FORCE_COLOR: "1",
  CLAUDE_EFFORT: "high", TRACEPARENT: "00-a-b-01", CODEX_VERSION: "1", CODEX_MANAGED_BY_NPM: "1", AGENT: "mine", OPENCODE: "/mine",
};
const DROPPED = {
  "plain terminal": [],
  "Claude session": ["CLAUDE_EFFORT", "TRACEPARENT", "GIT_EDITOR"],
  "Codex session": ["NO_COLOR", "PAGER", "GIT_PAGER", "GH_PAGER", "CODEX_VERSION", "CODEX_MANAGED_BY_NPM"],
  "Grok session": ["CI", "FORCE_COLOR", "NO_COLOR", "PAGER", "GIT_PAGER", "GH_PAGER", "GIT_EDITOR"],
  "OpenCode session": ["AGENT", "OPENCODE"],
};
for (const [name, dropped] of Object.entries(DROPPED)) {
  test(`pane env: launched from ${name}, the user's own variables of the same names`, () => {
    const env = envFor({ ...LAUNCHERS[name], ...OWN }, {});
    for (const [key, value] of Object.entries(OWN)) {
      if (dropped.includes(key)) assert.equal(key in env, false, `${key} is the session's`);
      else assert.equal(env[key], value, `${key} is the user's`);
    }
  });
}

test("pane env: a session's companion is dropped only at the value the session sets", () => {
  assert.equal(envFor({ ...CLAUDE, GIT_EDITOR: "vim" }, {}).GIT_EDITOR, "vim");
  assert.equal(envFor({ ...CODEX, PAGER: "less", NO_COLOR: "" }, {}).PAGER, "less");
  assert.equal(envFor({ ...GROK, CI: "false" }, {}).CI, "false");
});

test("pane env: AGENT and OPENCODE are the user's without an OpenCode session marker", () => {
  const env = envFor({ AGENT: "mine", OPENCODE: "/mine" }, {});
  assert.deepEqual([env.AGENT, env.OPENCODE], ["mine", "/mine"]);
});

// Every companion by session, as measured (null: any value): dropped at that
// value, kept at another. One row per variable, so none can be lost unnoticed.
const COMPANIONS = {
  "Claude session": {
    AI_AGENT: null, CLAUDE_EFFORT: null, CLAUDE_CODE_HOST_SESSION_ID: null, CLAUDE_JOB_DIR: null, CLAUDE_BG_BACKEND: null,
    TRACEPARENT: null, GIT_EDITOR: "true",
  },
  "Codex session": {
    CODEX_MANAGED_BY_NPM: null, CODEX_MANAGED_PACKAGE_ROOT: null, CODEX_VERSION: null, NO_COLOR: "1", PAGER: "cat",
    GIT_PAGER: "cat", GH_PAGER: "cat", LOGNAME: "root",
  },
  "OpenCode session": { AGENT: null, OPENCODE: null },
  "Grok session": {
    AWS_PAGER: "", CARGO_TERM_PROGRESS_WHEN: "always", CARGO_TERM_PROGRESS_WIDTH: "80", CI: "true", CLICOLOR: "1",
    CLICOLOR_FORCE: "1", FORCE_COLOR: "1", GH_PAGER: "cat", GIT_EDITOR: "true", GIT_PAGER: "cat", GIT_SEQUENCE_EDITOR: "true",
    GIT_TERMINAL_PROMPT: "0", GRADLE_OPTS: "-Dorg.gradle.console=rich", MANPAGER: "cat", MAVEN_OPTS: "-Dstyle.color=always",
    NO_COLOR: "1", NPM_CONFIG_PROGRESS: "true", PAGER: "cat", PIP_PROGRESS_BAR: "on", SYSTEMD_PAGER: "cat",
  },
};
for (const [name, companions] of Object.entries(COMPANIONS)) {
  for (const [key, value] of Object.entries(companions)) {
    test(`pane env: ${key}${value === null ? "" : `=${value}`} from a ${name.replace(" session", "")} session goes, another value stays`, () => {
      assert.equal(key in envFor({ ...LAUNCHERS[name], [key]: value ?? "set-by-session" }, {}), false);
      if (value !== null) assert.equal(envFor({ ...LAUNCHERS[name], [key]: `${value}-mine` }, {})[key], `${value}-mine`);
    });
  }
}

// Measured in a login shell: LOGNAME=root makes `logname` print root, LC_ALL=C.UTF-8 changes
// the sort order. Codex sets both for its children; neither is the user's.
test("pane env: Codex's C.UTF-8 locale is replaced by Aya's default, the user's own locale stays", () => {
  const env = envFor({ ...CODEX, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, {});
  assert.deepEqual([env.LANG, env.LC_ALL], ["en_US.UTF-8", "en_US.UTF-8"]);
  const own = envFor({ ...CODEX, LANG: "pl_PL.UTF-8", LC_ALL: "pl_PL.UTF-8" }, {});
  assert.deepEqual([own.LANG, own.LC_ALL], ["pl_PL.UTF-8", "pl_PL.UTF-8"]);
  const plain = envFor({ LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, {});
  assert.deepEqual([plain.LANG, plain.LC_ALL], ["C.UTF-8", "C.UTF-8"]);
});

// The pane's AYA_HOME is how `aya` finds its instance. Only an Aya Dev pane starting a prod Aya crosses homes.
test("pane env: an Aya started from a pane uses the pane's AYA_HOME", () => {
  const env = envFor({ AYA_HOME: "/outer/home" }, {});
  assert.equal(env.AYA_HOME, AYA_HOME);
  const r = spawnSync(process.execPath, ["-e", 'console.log(require("./dist-electron/paths.js").AYA_HOME)'], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { PATH: env.PATH, AYA_HOME: env.AYA_HOME },
    encoding: "utf8",
  });
  assert.equal(r.stdout.trim(), AYA_HOME);
});

// A session variable that is set but empty still marks the session (`key in env`, not truthiness).
const EMPTY_MARKED = { "Claude session": ["GIT_EDITOR", "true"], "Codex session": ["PAGER", "cat"], "Grok session": ["PAGER", "cat"], "OpenCode session": ["AGENT", "mine"] };
const COMPANION_ONLY = ["AI_AGENT", "AGENT", "OPENCODE"];
for (const [name, [companion, value]] of Object.entries(EMPTY_MARKED)) {
  for (const marker of Object.keys(LAUNCHERS[name]).filter((key) => key !== companion && !COMPANION_ONLY.includes(key))) {
    test(`pane env: ${marker}= (empty) alone marks a ${name.replace(" session", "")} session`, () => {
      const env = envFor({ [marker]: "", [companion]: value }, {});
      assert.equal(marker in env, false, `${marker} leaked`);
      assert.equal(companion in env, false, `${companion} is the session's`);
    });
  }
}
