// The control server's reply is where every command's text is made printable (control.ts printableReply), so no
// command has to remember to. One server whose every dependency carries characters that act on a terminal (a
// window title OSC, C1 CSI, a bidi override), and each command that quotes outside text, in its output or its
// error, through the real CLI: none reaches stdout or stderr raw, and each shows as its escape. Outside text
// includes the caller's own (its role argument, its AYA_TERMINAL_ID). The outputs that do not cross this socket
// have their own tests: the remote socket (remote-server-commands), team stats and team debug.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";

const { startControlServerOn } = await import("../dist-electron/control.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");

const C = (n) => String.fromCharCode(n);
const U = (hex) => `\\u${hex}`;
// Built from numbers, so this file holds none of them raw.
const HOSTILE = `\x1b]0;owned\x07${C(0x9b)}31m${C(0x202e)}`;
const SHOWN = `${U("001b")}]0;owned${U("0007")}${U("009b")}31m${U("202e")}`;
const ACTS = new RegExp(`[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f${[0x61c, 0x200e, 0x200f].map(C).join("")}${C(0x2028)}-${C(0x202e)}${C(0x2066)}-${C(0x206f)}]`);

const cli = resolve("bin/aya");
const root = mkdtempSync(join(tmpdir(), "aya-reply-printable-"));
const directory = join(root, "game");
const ayaHome = join(root, "aya");
mkdirSync(directory);
mkdirSync(ayaHome);
const PANE = "3f1c2a9e-0d4b-4e8a-9c51-7b2d6e0f1a11";
const project = { slug: "game", name: "game", directory, tabs: [{ id: PANE, name: `w${HOSTILE}`, presetId: "shell" }, { id: "pane-t", name: "tester", presetId: "shell" }] };
const listProjects = async () => [project];

// A team whose tester plays in pane-t, for the commands a role runs.
const TEAM = `# crew

## Role: tester
Sends to: lead
Must not: guess
Tests ${HOSTILE}.

## Role: lead
Sends to: tester
Must not: code
Leads.

## Lead
lead
`;
mkdirSync(join(directory, ".aya", "teams"), { recursive: true });
writeFileSync(join(directory, ".aya", "teams", "crew.md"), TEAM);
mkdirSync(join(ayaHome, "teams", "game", "crew"), { recursive: true });
writeFileSync(join(ayaHome, "teams", "game", "crew", "saved.md"), TEAM);
await new TeamStore(teamDir(ayaHome, "game", "crew")).assign("tester", "pane-t");
writeFileSync(join(ayaHome, "machines.json"), JSON.stringify({ version: 1, machines: [{ id: "box", reach: "local", ollama: { port: 11434 } }] }));

const socket = join(root, "aya.sock");
const stop = startControlServerOn(socket, {
  getWindow: () => null,
  openProject: async () => {
    throw new Error(`cannot open ${HOSTILE}`);
  },
  listProjects,
  readPane: async () => `screen ${HOSTILE}\n`,
  writePane: async () => false,
  paneHold: async () => null,
  machines: {
    ayaHome,
    userHome: root,
    probe: async () => ({
      reachable: true, checkedAt: new Date().toISOString(), error: null, cpuName: `cpu ${HOSTILE}`, cpus: 1, load1: 0, memUsedBytes: 1, memTotalBytes: 2, gpus: [],
      ollama: { up: true, version: "0.1", modelsError: null, loaded: [{ name: `model ${HOSTILE}`, vramBytes: null, expiresAt: null, pinned: false }] },
    }),
  },
  team: { teamHome: ayaHome, listProjects, deliver: async () => null, headCommit: async () => null, holdReason: async () => null },
  teamRunner: { refresh: async () => {}, pause: async () => {} },
  teamPanes: {
    teamHome: ayaHome, listProjects, holdReason: async () => null,
    listPresets: async () => [{ id: "evil", name: `preset ${HOSTILE}`, icon: "", color: "", command: "sh" }],
    presetInstalled: async () => true,
    roleLaunch: async () => ({ reach: "reaches", refused: null }),
  },
});
test.after(() => {
  stop();
  rmSync(root, { recursive: true, force: true });
});

function aya(args, env = {}) {
  return new Promise((done, fail) => {
    const child = spawn("/bin/sh", [cli, ...args], { cwd: root, env: { ...envWithoutAya(), HOME: root, AYA_HOME: ayaHome, AYA_SOCKET: socket, AYA_PROJECT_SLUG: "game", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

const AS_TESTER = { AYA_TERMINAL_ID: "pane-t" };
// [command, where the hostile text comes from, args, env, stream that shows it, exit status]
const CASES = [
  ["open", "the window's refusal", ["open", directory], {}, "stderr", 1],
  ["machines", "a host's CPU and model names", ["machines"], {}, "stdout", 0],
  ["pane list", "a tab name", ["pane", "list"], {}, "stdout", 0],
  ["pane read", "a pane's screen", ["pane", "read", PANE], {}, "stdout", 0],
  ["pane send", "a tab name in the refusal", ["pane", "send", PANE, "hi"], {}, "stderr", 1],
  ["presets", "a preset's name", ["presets"], {}, "stdout", 0],
  ["team new", "the request quoted back", ["team", "new", `ux ${HOSTILE}`], {}, "stdout", 0],
  ["team send", "the role named, in the refusal", ["team", "send", `r${HOSTILE}`, "x"], AS_TESTER, "stderr", 1],
  ["team show", "a role's responsibilities", ["team", "show", "crew"], {}, "stdout", 0],
  ["team whoami", "the caller's responsibilities", ["team", "whoami"], AS_TESTER, "stdout", 0],
  ["status", "the teammate waited on, in the refusal", ["status", "waiting", "--on", `r${HOSTILE}`, "x"], AS_TESTER, "stderr", 1],
  ["capabilities", "the caller's own AYA_TERMINAL_ID", ["capabilities"], { AYA_TERMINAL_ID: `pane${HOSTILE}` }, "stdout", 0],
];

for (const [command, source, args, env, stream, status] of CASES) {
  test(`aya ${command}: ${source} reaches the terminal as text`, async () => {
    const r = await aya(args, env);
    assert.equal(r.status, status, `${r.stdout}${r.stderr}`);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, ACTS);
    assert.ok(r[stream].includes(SHOWN), r[stream]);
  });
}

test("aya focus prints nothing", async () => {
  assert.deepEqual(await aya(["focus"]), { status: 0, stdout: "", stderr: "" });
});

test("a pane's screen keeps its tab and newline, and only those", async () => {
  const r = await aya(["pane", "read", PANE]);
  assert.equal(r.stdout, `screen ${SHOWN}\n`);
});
