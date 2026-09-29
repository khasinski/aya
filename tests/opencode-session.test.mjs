// opencode keys a project by the repo's root commit, so `--continue` in one git
// worktree resumed the newest session of ANY worktree of that repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
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
  const list = async (cwd) => {
    calls.push(cwd);
    return sessions;
  };
  return { list, calls };
};

function withFakeOpencode(script) {
  const bin = mkdtempSync(path.join(tmpdir(), "oc-bin-"));
  writeFileSync(path.join(bin, "opencode"), `#!/bin/sh\n${script}\n`);
  chmodSync(path.join(bin, "opencode"), 0o755);
  return bin;
}

async function onPath(bin, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
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

test("a failed lookup keeps the command as it was", async () => {
  const out = await ownSessionCommand("opencode --continue", A, async () => {
    throw new Error("opencode not found");
  });
  assert.equal(out, "opencode --continue");
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

test("listOpencodeSessions asks the opencode on PATH, from the pane's directory", async () => {
  const log = path.join(mkdtempSync(path.join(tmpdir(), "oc-log-")), "log");
  const bin = withFakeOpencode(
    `echo "$PWD|$*" > '${log}'\necho '[{"id":"ses_A","directory":"${A}","updated":9}]'`,
  );
  assert.deepEqual(await onPath(bin, () => listOpencodeSessions(A)), [
    { id: "ses_A", directory: A, updated: 9 },
  ]);
  assert.equal(readFileSync(log, "utf8").trim(), `${A}|session list --format json`);
});

test("a long session list, past execFile's default 1 MB, is still read", async () => {
  const title = "t".repeat(1000);
  const rows = Array.from({ length: 3000 }, (_, i) => ({ id: `ses_${i}`, title, updated: i, directory: B }));
  rows.push({ id: "ses_A", title, updated: 1, directory: A });
  const file = path.join(mkdtempSync(path.join(tmpdir(), "oc-big-")), "list.json");
  writeFileSync(file, JSON.stringify(rows));
  assert.ok(readFileSync(file).length > 2_000_000);
  const bin = withFakeOpencode(`cat '${file}'`);
  const out = await onPath(bin, () => ownSessionCommand("opencode --continue", A));
  assert.equal(out, "opencode --session ses_A");
});

test("output past the named buffer cap is a failed lookup that keeps the command", async () => {
  const bin = withFakeOpencode(`head -c ${OPENCODE_LIST_MAX_BUFFER_BYTES + 1} /dev/zero`);
  await onPath(bin, () => assert.rejects(listOpencodeSessions(A), /maxBuffer/));
  const out = await onPath(bin, () => ownSessionCommand("opencode --continue", A));
  assert.equal(out, "opencode --continue");
});

test("listOpencodeSessions gives up on an opencode that hangs, so the pane still spawns", async () => {
  const bin = withFakeOpencode("exec sleep 60");
  const started = Date.now();
  await onPath(bin, () => assert.rejects(listOpencodeSessions(A)));
  assert.ok(Date.now() - started < 15_000);
});
