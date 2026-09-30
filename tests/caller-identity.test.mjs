// A pane's id arriving from a command that runs in ANOTHER open project is a
// borrowed identity: Codex's shared app-server daemon ran every pane's commands
// with the env of the pane that started it (codex-cli 0.158.0, measured).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { foreignIdentity } from "../dist-electron/caller-identity.js";

const { startControlServerOn } = await import("../dist-electron/control.js");

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-caller-")));
const dir = (...parts) => {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
const A = dir("a");
const B = dir("b");
const WT = dir("a-wt");
const BOUND = dir("bound");
const NESTED = dir("a", "nested");
const OUTSIDE = dir("elsewhere");
symlinkSync(A, join(root, "link-a"));

const project = (slug, directory, tabs, extra = {}) => ({ slug, name: slug, directory, tabs, ...extra });
const tab = (id, cwd) => ({ id, presetId: "codex", name: id, ...(cwd ? { cwd } : {}) });
const PROJECTS = [
  project("a", A, [tab("pane-a")]),
  project("b", B, [tab("pane-b")]),
  project("a-wt", WT, [tab("pane-wt")]),
  project("bound", BOUND, [tab("pane-bound")]),
  project("nested", NESTED, [tab("pane-nested")]),
  project("linked", join(root, "link-a"), [tab("pane-linked")]),
  project("with-binding", dir("wb"), [tab("pane-wb", BOUND)]),
  project("remote", dir("remote-mirror"), [tab("pane-remote")], { remote: { hostId: "h", label: "h", sshTarget: "h", directory: "/srv" } }),
];
const worktrees = async (directory) => (directory === A ? [A, WT] : []);

const TABLE = [
  ["caller in A, cwd A", { terminalId: "pane-a", cwd: A }, null],
  ["caller in A, cwd below A", { terminalId: "pane-a", cwd: dir("a", "src") }, null],
  ["caller in A, cwd in A's worktree opened as its own project", { terminalId: "pane-a", cwd: dir("a-wt", "src") }, null],
  ["caller in A, cwd in a nested project inside A", { terminalId: "pane-a", cwd: NESTED }, null],
  ["caller in A, cwd outside every project", { terminalId: "pane-a", cwd: OUTSIDE }, null],
  ["caller in A, cwd through a symlink to A", { terminalId: "pane-a", cwd: join(root, "link-a") }, null],
  ["caller in a project opened through a symlink, cwd the real dir", { terminalId: "pane-linked", cwd: A }, null],
  ["caller's tab bound to a directory that is another project", { terminalId: "pane-wb", cwd: BOUND }, null],
  ["caller in a remote project", { terminalId: "pane-remote", cwd: B }, null],
  ["no caller id (outside Aya)", { cwd: B }, null],
  ["caller id no project knows", { terminalId: "gone-1234", cwd: B }, null],
  ["caller without cwd (older CLI)", { terminalId: "pane-a" }, null],
  ["caller in A, cwd in project B", { terminalId: "pane-a", cwd: B }, /AYA_TERMINAL_ID=pane-a/],
  ["caller in B, cwd in A", { terminalId: "pane-b", cwd: dir("a", "src") }, /project "a"/],
  ["caller in the nested project, cwd in its parent", { terminalId: "pane-nested", cwd: A }, /--no-daemon/],
  ["caller in A's worktree project, cwd in B", { terminalId: "pane-wt", cwd: B }, /Codex's app-server daemon/],
];

for (const [name, caller, expected] of TABLE) {
  test(`foreignIdentity: ${name}`, async () => {
    const refusal = await foreignIdentity(PROJECTS, caller, worktrees);
    if (expected === null) assert.equal(refusal, null);
    else assert.match(refusal ?? "", expected);
  });
}

test("the refusal names the pane's project, the cwd's project and the fix", async () => {
  const refusal = await foreignIdentity(PROJECTS, { terminalId: "pane-a", cwd: B }, worktrees);
  assert.equal(
    refusal,
    `this command runs with another pane's identity (AYA_TERMINAL_ID=pane-a, a pane of project "a") in ${B}, project "b"; ` +
      "a CLI that runs commands in a shared background process - such as Codex's app-server daemon - loses the pane's identity. " +
      "Restart this pane (Aya now starts Codex with --no-daemon)",
  );
});

test("worktrees are listed only when the cwd is outside the caller's own directories", async () => {
  const asked = [];
  const spy = async (d) => {
    asked.push(d);
    return [];
  };
  await foreignIdentity(PROJECTS, { terminalId: "pane-a", cwd: A }, spy);
  await foreignIdentity(PROJECTS, { terminalId: "pane-a", cwd: OUTSIDE }, spy);
  assert.deepEqual(asked, []);
  await foreignIdentity(PROJECTS, { terminalId: "pane-a", cwd: B }, spy);
  assert.deepEqual(asked, [A]);
});

function rpc(socket, frame) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socket);
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (chunk) => (buf += chunk));
    c.on("close", () => resolve(JSON.parse(buf.split("\n")[0])));
    c.on("error", reject);
    c.on("connect", () => c.write(`${JSON.stringify(frame)}\n`));
  });
}

async function withServer(options, body) {
  const sockDir = mkdtempSync(join(tmpdir(), "aya-ctrl-id-"));
  const socket = join(sockDir, "aya.sock");
  const stop = startControlServerOn(socket, { getWindow: () => null, openProject: () => {}, ...options });
  try {
    return await body(socket);
  } finally {
    stop();
    rmSync(sockDir, { recursive: true, force: true });
  }
}

test("the control server refuses a borrowed identity before the command acts, for every pane-acting request", async () => {
  const written = [];
  const options = {
    listProjects: async () => PROJECTS,
    readPane: async () => "output",
    writePane: async (id, data) => {
      written.push([id, data]);
      return true;
    },
    worktrees,
    team: { teamHome: dir("team-home"), listProjects: async () => PROJECTS },
  };
  const borrowed = { terminalId: "pane-a", cwd: B };
  await withServer(options, async (socket) => {
    for (const request of [
      { type: "pane-send", target: "pane-b", text: "hi" },
      { type: "pane-read", target: "pane-b" },
      { type: "pane-list" },
      { type: "status", level: "active", text: "x", terminalId: "pane-a" },
      { type: "notify", body: "x", terminalId: "pane-a" },
      { type: "team-whoami" },
      { type: "team-send", role: "r", text: "x" },
      { type: "team-inbox" },
      { type: "team-guide", cwd: B },
    ]) {
      const reply = await rpc(socket, { ...request, caller: borrowed });
      assert.equal(reply.ok, false, request.type);
      assert.match(reply.error, /another pane's identity \(AYA_TERMINAL_ID=pane-a/, request.type);
    }
    assert.deepEqual(written, []);
    const own = await rpc(socket, { type: "pane-send", target: "pane-b", text: "hi", caller: { terminalId: "pane-a", cwd: A } });
    assert.equal(own.ok, true);
    const worktree = await rpc(socket, { type: "pane-send", target: "pane-b", text: "hi", caller: { terminalId: "pane-a", cwd: WT } });
    assert.equal(worktree.ok, true, worktree.error);
    const outside = await rpc(socket, { type: "pane-send", target: "pane-b", text: "hi", caller: { cwd: B } });
    assert.equal(outside.ok, true);
    const unknown = await rpc(socket, { type: "team-whoami", caller: { terminalId: "gone-1234", cwd: B } });
    assert.equal(unknown.error, "this pane belongs to no open project");
    const capabilities = await rpc(socket, { type: "capabilities", caller: borrowed });
    assert.equal(capabilities.ok, true);
  });
});

test("a request without a pane id or cwd does not read the projects for the check", async () => {
  let reads = 0;
  const options = { listProjects: async () => (reads++, PROJECTS), getWindows: () => [] };
  await withServer(options, async (socket) => {
    for (const caller of [{}, { cwd: B }, { terminalId: "pane-a" }]) {
      const reply = await rpc(socket, { type: "status", level: "active", text: "x", terminalId: "pane-a", caller });
      assert.equal(reply.ok, true);
    }
    assert.equal(reads, 0);
    await rpc(socket, { type: "status", level: "active", text: "x", terminalId: "pane-a", caller: { terminalId: "pane-a", cwd: A } });
    assert.equal(reads, 1);
  });
});
