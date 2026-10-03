// bin/aya over operation x window (no app, slow to answer, ready) x concurrency x shell: with no app every request
// fails with exit 1; otherwise each concurrent request exits 0 and arrives once; a refused op sends nothing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { CLI_SHELLS, distinctShells, programOf, runCli, shellOptions, stubApp } from "./helpers/cli-shells.mjs";

const LOADING_REPLY_DELAY_MS = 400;
const NO_APP_WAIT_SECONDS = "1";
// bin/aya keeps no state between runs (no temp file, lock or $$ in it): N at once has no branch of its own.
const CONCURRENCY = [1];
const WINDOWS = ["none", "loading", "loaded"];

/** args(i, dir): the i-th of N invocations; key(request) is compared with expected(i). */
const OPS = {
  open: {
    type: "open",
    args: (i, dir) => ["open", join(dir, `project-${i}`)],
    key: (r) => basename(r.path),
    expected: (i) => `project-${i}`,
  },
  "team send": {
    type: "team-send",
    args: (i) => ["team", "send", "implementer", `message`, `number`, `${i}`],
    key: (r) => r.text,
    expected: (i) => `message number ${i}`,
  },
  "team save": {
    type: "team-save",
    args: (i, dir) => ["team", "save", join(dir, `team-${i}.md`)],
    key: (r) => r.text ?? r.definition ?? JSON.stringify(r),
    expected: (i) => teamFile(i).trimEnd(),
  },
  "team open": {
    type: "team-open",
    args: (i) => ["team", "open", "ux-fix", `reviewer=preset-${i}`],
    key: (r) => r.panes[0].target,
    expected: (i) => `preset-${i}`,
  },
  "team start": {
    type: "team-start",
    args: (i) => ["team", "start", "ux-fix", `task ${i}`],
    key: (r) => r.task,
    expected: (i) => `task ${i}`,
  },
  "team new": {
    type: "team-guide",
    args: (i) => ["team", "new", `description ${i}`],
    key: (r) => r.description,
    expected: (i) => `description ${i}`,
  },
  presets: {
    type: "presets",
    args: () => ["presets"],
    key: (r) => r.type,
    expected: () => "presets",
  },
  focus: { type: "focus", args: () => ["focus"], key: (r) => r.type, expected: () => "focus" },
  capabilities: { type: "capabilities", args: () => ["capabilities"], key: (r) => r.type, expected: () => "capabilities" },
  notify: {
    type: "notify",
    args: (i) => ["notify", "--title", "t", "body", `${i}`],
    key: (r) => `${r.title}|${r.body}`,
    expected: (i) => `t|body ${i}`,
  },
  "status set": {
    type: "status",
    args: (i) => ["status", "set", "working", `${i}`],
    key: (r) => `${r.level}|${r.text}`,
    expected: (i) => `active|working ${i}`,
  },
  "status clear": { type: "status", args: () => ["status", "clear"], key: (r) => r.level, expected: () => "clear" },
  "pane list": { type: "pane-list", args: () => ["pane", "list"], key: (r) => r.type, expected: () => "pane-list" },
  "pane read": { type: "pane-read", args: (i) => ["pane", "read", `p${i}`], key: (r) => r.target, expected: (i) => `p${i}` },
  "team whoami": { type: "team-whoami", args: () => ["team", "whoami"], key: (r) => r.type, expected: () => "team-whoami" },
  "team inbox": { type: "team-inbox", args: () => ["team", "inbox"], key: (r) => r.type, expected: () => "team-inbox" },
  "team send without a role": {
    refused: true,
    args: () => ["team", "send"],
  },
  "pane send": {
    type: "pane-send",
    args: (i) => ["pane", "send", "reviewer", `text ${i}`],
    key: (r) => r.text,
    expected: (i) => `text ${i}`,
  },
};

const teamFile = (i) => `# team-${i}\n\n## Role: only\nDoes the work.\n`;

const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("AYA_")));

// Every cell owns its directory and socket; no process.env mutations or
// shared app are involved, so delayed acknowledgements can overlap.
describe("CLI shell matrix with isolated sockets", { concurrency: 8 }, () => {
  for (const [opName, op] of Object.entries(OPS)) {
    for (const window of WINDOWS) {
      for (const n of CONCURRENCY) {
        for (const shell of CLI_SHELLS) {
          test(`${opName} x window ${window} x ${n} at once x ${shell}`, shellOptions(shell), async () => {
            const dir = mkdtempSync(join(tmpdir(), "aya-mx-"));
            const socket = join(dir, "aya.sock");
            let app;
            try {
              for (let i = 0; i < n; i += 1) {
                mkdirSync(join(dir, `project-${i}`));
                writeFileSync(join(dir, `team-${i}.md`), teamFile(i));
              }
              if (window !== "none") app = await stubApp(socket, window === "loading" ? LOADING_REPLY_DELAY_MS : 0);
              const env = { ...cleanEnv(), AYA_SOCKET: socket, AYA_OPEN_WAIT_SECONDS: NO_APP_WAIT_SECONDS };
              const results = await Promise.all(
                Array.from({ length: n }, (_, i) => runCli(shell, op.args(i, dir), env)),
              );

              if (op.refused) {
                for (const { status, stderr } of results) {
                  assert.equal(status, 1, stderr);
                  assert.match(stderr, /Usage/);
                }
                assert.deepEqual(app?.requests ?? [], []);
                return;
              }
              if (window === "none") {
                for (const { status, stderr } of results) {
                  assert.equal(status, 1, stderr);
                  assert.match(stderr, /control socket not found|no Aya is listening/);
                }
                return;
              }
              for (const { status, stderr } of results) assert.equal(status, 0, stderr);
              const arrived = app.requests.map((r) => {
                assert.equal(r.type, op.type);
                return op.key(r);
              });
              const wanted = Array.from({ length: n }, (_, i) => op.expected(i));
              assert.deepEqual(arrived.sort(), wanted.sort());
            } finally {
              await app?.close();
              rmSync(dir, { recursive: true, force: true });
            }
          });
        }
      }
    }
  }
});
test("each program behind the shell paths runs once: on macOS /bin/sh stands for the bash 3.2 of /bin/bash", shellOptions("/bin/dash"), () => {
  const bashVersion = spawnSync("/bin/bash", ["-c", "echo $BASH_VERSION"], { encoding: "utf8" }).stdout.trim();
  assert.equal(programOf("/bin/bash"), `bash ${bashVersion}`);
  assert.notEqual(programOf("/bin/dash"), programOf("/bin/bash"));
  if (process.platform === "darwin") {
    assert.match(bashVersion, /^3\.2\./);
    assert.deepEqual(distinctShells(CLI_SHELLS), ["/bin/sh", "/bin/dash"]);
    assert.match(shellOptions("/bin/bash").skip, /same program as \/bin\/sh/);
  }
});
