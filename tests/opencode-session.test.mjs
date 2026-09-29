// opencode keys a project by the repo's root commit, so `--continue` in one git
// worktree resumed the newest session of ANY worktree of that repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listOpencodeSessions,
  parseSessionList,
  withOwnOpencodeSession,
} from "../dist-electron/opencode-session.js";

const A = realpathSync(mkdtempSync(path.join(tmpdir(), "oc-wt-a-")));
const B = realpathSync(mkdtempSync(path.join(tmpdir(), "oc-wt-b-")));

const spawn = (command, extra = {}) => ({ ptyId: "p1", command, cwd: A, cols: 80, rows: 24, ...extra });
const lister = (sessions) => {
  const calls = [];
  const list = async (cwd) => {
    calls.push(cwd);
    return sessions;
  };
  return { list, calls };
};

test("a worktree pane resumes its own session, not the newer one of a sibling worktree", async () => {
  const { list } = lister([
    { id: "ses_B", directory: B, updated: 300 },
    { id: "ses_A", directory: A, updated: 100 },
  ]);
  const req = spawn("opencode --continue", { presetId: "oc", agent: "opencode" });
  const out = await withOwnOpencodeSession(req, list);
  assert.deepEqual(out, { ...req, command: "opencode --session ses_A" });
});

test("a preset command with stray whitespace is still recognised", async () => {
  const { list } = lister([{ id: "ses_A", directory: A, updated: 1 }]);
  const out = await withOwnOpencodeSession(spawn("  opencode --continue  "), list);
  assert.equal(out.command, "opencode --session ses_A");
});

test("a cwd that no longer exists is matched as given", async () => {
  const gone = path.join(A, "deleted-worktree");
  const { list, calls } = lister([{ id: "ses_G", directory: gone, updated: 1 }]);
  const out = await withOwnOpencodeSession(spawn("opencode --continue", { cwd: gone }), list);
  assert.equal(out.command, "opencode --session ses_G");
  assert.deepEqual(calls, [gone]);
});

test("the newest of the directory's own sessions wins, whatever the list order", async () => {
  const { list } = lister([
    { id: "ses_old", directory: A, updated: 100 },
    { id: "ses_new", directory: A, updated: 200 },
    { id: "ses_B", directory: B, updated: 300 },
  ]);
  const out = await withOwnOpencodeSession(spawn("opencode --continue"), list);
  assert.equal(out.command, "opencode --session ses_new");
});

test("no session of its own: the pane starts fresh instead of borrowing another directory's", async () => {
  const { list } = lister([{ id: "ses_B", directory: B, updated: 300 }]);
  const out = await withOwnOpencodeSession(spawn("opencode --continue"), list);
  assert.equal(out.command, "opencode");
});

test("the preset's other arguments survive the rewrite", async () => {
  const { list } = lister([{ id: "ses_A", directory: A, updated: 1 }]);
  const out = await withOwnOpencodeSession(spawn("opencode --model x/y --continue --port 0"), list);
  assert.equal(out.command, "opencode --model x/y --session ses_A --port 0");
  const fresh = await withOwnOpencodeSession(
    spawn("opencode --model x/y --continue --port 0", { cwd: B }),
    lister([]).list,
  );
  assert.equal(fresh.command, "opencode --model x/y --port 0");
});

test("a cwd reached through a symlink matches the physical directory opencode records", async () => {
  const link = path.join(mkdtempSync(path.join(tmpdir(), "oc-link-")), "wt");
  symlinkSync(A, link);
  const { list, calls } = lister([{ id: "ses_A", directory: A, updated: 1 }]);
  const out = await withOwnOpencodeSession(spawn("opencode --continue", { cwd: link }), list);
  assert.equal(out.command, "opencode --session ses_A");
  assert.deepEqual(calls, [A]);
});

test("left untouched, without asking opencode: no --continue, another agent, attach-only", async () => {
  const cases = [
    spawn("opencode"),
    spawn("opencode --session ses_X"),
    spawn("opencode --continued"),
    spawn("claude --continue"),
    spawn("ssh -tt host 'opencode --continue'"),
    spawn("ssh -tt host opencode --continue"),
    spawn("opencode-dev --continue"),
    spawn("opencode --continue", { attachOnly: true }),
  ];
  for (const req of cases) {
    const { list, calls } = lister([{ id: "ses_A", directory: A, updated: 1 }]);
    assert.equal(await withOwnOpencodeSession(req, list), req, req.command);
    assert.deepEqual(calls, [], req.command);
  }
});

test("a failed lookup keeps the command as it was", async () => {
  const req = spawn("opencode --continue");
  const out = await withOwnOpencodeSession(req, async () => {
    throw new Error("opencode not found");
  });
  assert.equal(out, req);
});

test("parseSessionList: empty output is no sessions; malformed or shell-unsafe entries are dropped", () => {
  assert.deepEqual(parseSessionList(""), []);
  assert.deepEqual(parseSessionList("  \n"), []);
  const stdout = JSON.stringify([
    { id: "ses_ok", title: "t", updated: 5, created: 1, projectId: "p", directory: A },
    { id: "ses_x; rm -rf ~", updated: 6, directory: A },
    { id: 7, updated: 6, directory: A },
    null,
    { id: "ses_nodir", updated: 6 },
    { id: "ses_notime", directory: A },
  ]);
  assert.deepEqual(parseSessionList(stdout), [{ id: "ses_ok", directory: A, updated: 5 }]);
  assert.throws(() => parseSessionList("not json"));
  assert.throws(() => parseSessionList('{"id":"ses_a"}'));
});

test("listOpencodeSessions asks the opencode on PATH, from the pane's directory", async () => {
  const bin = mkdtempSync(path.join(tmpdir(), "oc-bin-"));
  const log = path.join(bin, "log");
  writeFileSync(
    path.join(bin, "opencode"),
    `#!/bin/sh\necho "$PWD|$*" > '${log}'\necho '[{"id":"ses_A","directory":"${A}","updated":9}]'\n`,
  );
  chmodSync(path.join(bin, "opencode"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    assert.deepEqual(await listOpencodeSessions(A), [{ id: "ses_A", directory: A, updated: 9 }]);
  } finally {
    process.env.PATH = saved;
  }
  assert.equal(readFileSync(log, "utf8").trim(), `${A}|session list --format json`);
});

test("listOpencodeSessions gives up on an opencode that hangs, so the pane still spawns", async () => {
  const bin = mkdtempSync(path.join(tmpdir(), "oc-hang-"));
  writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\nexec sleep 60\n");
  chmodSync(path.join(bin, "opencode"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  const started = Date.now();
  try {
    await assert.rejects(listOpencodeSessions(A));
  } finally {
    process.env.PATH = saved;
  }
  assert.ok(Date.now() - started < 15_000);
});
