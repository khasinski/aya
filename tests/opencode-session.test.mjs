// opencode keys a project by the repo's root commit, so `--continue` in one git
// worktree resumed the newest session of ANY worktree of that repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPENCODE_LIST_ARGV,
  OPENCODE_LIST_MAX_BUFFER_BYTES,
  listOpencodeSessions,
  ownSessionCommand,
  parseSessionList,
} from "../dist-electron/opencode-session.js";

const A = realpathSync(mkdtempSync(path.join(tmpdir(), "oc-wt-a-")));
const B = realpathSync(mkdtempSync(path.join(tmpdir(), "oc-wt-b-")));
const FIXTURE = readFileSync(new URL("./fixtures/opencode-session-list.json", import.meta.url), "utf8");

const lister = (sessions) => {
  const calls = [];
  const lookups = [];
  const list = async (cwd, lookup) => {
    calls.push(cwd);
    lookups.push(lookup);
    return sessions;
  };
  return { list, calls, lookups };
};

function withFakeOpencode(script) {
  const bin = mkdtempSync(path.join(tmpdir(), "oc-bin-"));
  writeFileSync(path.join(bin, "opencode"), `#!/bin/sh\n${script}\n`);
  chmodSync(path.join(bin, "opencode"), 0o755);
  return bin;
}

test("a worktree pane resumes its own session, not the newer one of a sibling worktree", async () => {
  const { list } = lister([
    { id: "ses_B", directory: B, updated: 300 },
    { id: "ses_A", directory: A, updated: 100 },
  ]);
  assert.equal(await ownSessionCommand("opencode --continue", A, list), "opencode --session ses_A");
});

test("a preset command with stray whitespace is still recognised", async () => {
  const { list } = lister([{ id: "ses_A", directory: A, updated: 1 }]);
  assert.equal(await ownSessionCommand("  opencode --continue  ", A, list), "opencode --session ses_A");
});

test("leading env assignments are kept and do not hide the opencode command", async () => {
  const { list } = lister([{ id: "ses_A", directory: A, updated: 1 }]);
  const cases = [
    ["FOO=1 opencode --continue", "FOO=1 opencode --session ses_A"],
    [
      `OPENCODE_CONFIG_CONTENT='{"x": "a --continue b"}' opencode --continue`,
      `OPENCODE_CONFIG_CONTENT='{"x": "a --continue b"}' opencode --session ses_A`,
    ],
    ["A=1 B=\"two words\" opencode --model m --continue", "A=1 B=\"two words\" opencode --model m --session ses_A"],
  ];
  for (const [command, expected] of cases) {
    assert.equal(await ownSessionCommand(command, A, list), expected, command);
  }
});

test("a cwd that no longer exists is matched as given", async () => {
  const gone = path.join(A, "deleted-worktree");
  const { list, calls } = lister([{ id: "ses_G", directory: gone, updated: 1 }]);
  assert.equal(await ownSessionCommand("opencode --continue", gone, list), "opencode --session ses_G");
  assert.deepEqual(calls, [gone]);
});

test("the newest of the directory's own sessions wins, whatever the list order", async () => {
  const { list } = lister([
    { id: "ses_old", directory: A, updated: 100 },
    { id: "ses_new", directory: A, updated: 200 },
    { id: "ses_B", directory: B, updated: 300 },
  ]);
  assert.equal(await ownSessionCommand("opencode --continue", A, list), "opencode --session ses_new");
});

test("no session of its own: the pane starts fresh instead of borrowing another directory's", async () => {
  const { list } = lister([{ id: "ses_B", directory: B, updated: 300 }]);
  assert.equal(await ownSessionCommand("opencode --continue", A, list), "opencode");
  assert.equal(await ownSessionCommand("FOO=1 opencode --continue", A, list), "FOO=1 opencode");
});

test("the preset's other arguments survive the rewrite", async () => {
  const { list } = lister([{ id: "ses_A", directory: A, updated: 1 }]);
  assert.equal(
    await ownSessionCommand("opencode --model x/y --continue --port 0", A, list),
    "opencode --model x/y --session ses_A --port 0",
  );
  assert.equal(
    await ownSessionCommand("opencode --model x/y --continue --port 0", B, lister([]).list),
    "opencode --model x/y --port 0",
  );
});

test("a cwd reached through a symlink matches the physical directory opencode records", async () => {
  const link = path.join(mkdtempSync(path.join(tmpdir(), "oc-link-")), "wt");
  symlinkSync(A, link);
  const { list, calls } = lister([{ id: "ses_A", directory: A, updated: 1 }]);
  assert.equal(await ownSessionCommand("opencode --continue", link, list), "opencode --session ses_A");
  assert.deepEqual(calls, [A]);
});

test("left untouched, without asking opencode: no --continue, another agent, look-alikes", async () => {
  const commands = [
    "opencode",
    "opencode --session ses_X",
    "opencode --continued",
    "claude --continue",
    "FOO=1 claude --continue",
    "X='opencode --continue' claude",
    "ssh -tt host 'opencode --continue'",
    "ssh -tt host opencode --continue",
    "opencode-dev --continue",
    "1X=1 opencode --continue",
    "a-b=1 opencode --continue",
  ];
  for (const command of commands) {
    const { list, calls } = lister([{ id: "ses_A", directory: A, updated: 1 }]);
    assert.equal(await ownSessionCommand(command, A, list), command, command);
    assert.deepEqual(calls, [], command);
  }
});

test("a failed lookup keeps the command as it was, and is reported", async () => {
  const reported = [];
  const failure = new Error("opencode not found");
  const out = await ownSessionCommand(
    "opencode --continue",
    A,
    async () => {
      throw failure;
    },
    (err) => reported.push(err),
  );
  assert.equal(out, "opencode --continue");
  assert.deepEqual(reported, [failure]);
});

test("an unrecognised list shape is a failed lookup, not 'no session here'", async () => {
  const shapes = [
    JSON.stringify({ sessions: [{ id: "ses_A", directory: A, updated: 1 }] }),
    JSON.stringify([{ id: "ses_A", dir: A, updated: 1 }]),
    JSON.stringify([{ id: "ses_A", directory: A, updated: "2026-09-29T10:00:00Z" }]),
    JSON.stringify([{ sessionID: "ses_A", directory: A, updated: 1 }]),
    JSON.stringify([null]),
    JSON.stringify([{ id: "ses_x; rm -rf ~", directory: A, updated: 1 }]),
    "null",
    "not json",
  ];
  for (const stdout of shapes) {
    assert.throws(
      () => parseSessionList(stdout),
      stdout === "not json" ? SyntaxError : /unrecognised output shape/,
      stdout,
    );
    const out = await ownSessionCommand("opencode --continue", A, async () => parseSessionList(stdout));
    assert.equal(out, "opencode --continue", stdout);
  }
});

test("parseSessionList reads the shape the real CLI prints (opencode 1.18.30)", () => {
  assert.deepEqual(parseSessionList(FIXTURE), [
    { id: "ses_0000000000BBBBBBBBBBBBBBBB", directory: "/work/repo-wt-b", updated: 1790672445497 },
    { id: "ses_0000000000AAAAAAAAAAAAAAAA", directory: "/work/repo-wt-a", updated: 1790672385497 },
  ]);
  assert.deepEqual(parseSessionList(""), []);
  assert.deepEqual(parseSessionList("  \n"), []);
});

test("session ids follow the same shell-safe rule as the rest of Aya's session ids", () => {
  const ids = ["ses_a.b", "ses:a/b-c", "x".repeat(200)];
  for (const id of ids) {
    assert.deepEqual(parseSessionList(JSON.stringify([{ id, directory: A, updated: 1 }]))[0].id, id);
  }
  for (const id of ["", "x".repeat(201), "a b", "a$b", "a'b"]) {
    assert.throws(() => parseSessionList(JSON.stringify([{ id, directory: A, updated: 1 }])), undefined, id);
  }
});

test("the lookup gets the command's env assignments as data, not as command text", async () => {
  const { list, calls, lookups } = lister([{ id: "ses_A", directory: A, updated: 1 }]);
  await ownSessionCommand(`PATH="/x:$PATH" OPENCODE_CONFIG_CONTENT='{}' opencode -m m --continue`, A, list);
  assert.deepEqual(calls, [A]);
  assert.deepEqual(lookups, [[`PATH="/x:$PATH"`, `OPENCODE_CONFIG_CONTENT='{}'`]]);
});

const HOME = mkdtempSync(path.join(tmpdir(), "oc-home-"));
const fakeEnv = (script) => ({ HOME, PATH: `${withFakeOpencode(script)}:/usr/bin:/bin` });

test("listOpencodeSessions runs a fixed command line through the login shell, in the directory, with the env", async () => {
  const log = path.join(mkdtempSync(path.join(tmpdir(), "oc-log-")), "log");
  const env = {
    ...fakeEnv(`echo "$PWD|$MARK|$*" > '${log}'\necho '[{"id":"ses_A","directory":"${A}","updated":9}]'`),
    MARK: "a b",
  };
  assert.deepEqual(await listOpencodeSessions("/bin/sh", A, env), [{ id: "ses_A", directory: A, updated: 9 }]);
  assert.equal(readFileSync(log, "utf8").trim(), `${A}|a b|session list --format json`);
  assert.deepEqual(OPENCODE_LIST_ARGV, ["-l", "-i", "-c", "exec opencode session list --format json"]);
});

test("shell startup noise before the list is skipped; noise alone or after it is a failed lookup", async () => {
  const list = JSON.stringify([{ id: "ses_A", title: "[WIP] a\n[b]", directory: A, updated: 9 }], null, 2);
  const file = path.join(mkdtempSync(path.join(tmpdir(), "oc-noise-")), "list.json");
  writeFileSync(file, list);
  const run = (script) => listOpencodeSessions("/bin/sh", A, fakeEnv(script));
  assert.deepEqual(await run(`echo 'Agent pid 42'; echo '[x]'; cat '${file}'`), [
    { id: "ses_A", directory: A, updated: 9 },
  ]);
  assert.deepEqual(await run("true"), []);
  await assert.rejects(run("echo 'Agent pid 42'"));
  await assert.rejects(run(`cat '${file}'; echo bye`));
});

test("a long session list, past execFile's default 1 MB, is still read", async () => {
  const title = "t".repeat(1000);
  const rows = Array.from({ length: 3000 }, (_, i) => ({ id: `ses_${i}`, title, updated: i, directory: B }));
  rows.push({ id: "ses_A", title, updated: 1, directory: A });
  const file = path.join(mkdtempSync(path.join(tmpdir(), "oc-big-")), "list.json");
  writeFileSync(file, JSON.stringify(rows, null, 2));
  assert.ok(readFileSync(file).length > 2_000_000);
  const env = fakeEnv(`cat '${file}'`);
  const out = await ownSessionCommand("opencode --continue", A, (dir) => listOpencodeSessions("/bin/sh", dir, env));
  assert.equal(out, "opencode --session ses_A");
});

test("output past the named buffer cap is a failed lookup that keeps the command", async () => {
  const env = fakeEnv(`head -c ${OPENCODE_LIST_MAX_BUFFER_BYTES + 1} /dev/zero`);
  await assert.rejects(listOpencodeSessions("/bin/sh", A, env), /maxBuffer/);
  const out = await ownSessionCommand("opencode --continue", A, (dir) => listOpencodeSessions("/bin/sh", dir, env));
  assert.equal(out, "opencode --continue");
});

test("listOpencodeSessions gives up on a lookup that hangs, so the pane still spawns", async () => {
  const started = Date.now();
  await assert.rejects(listOpencodeSessions("/bin/sh", A, fakeEnv("exec sleep 60")));
  assert.ok(Date.now() - started < 20_000);
});
