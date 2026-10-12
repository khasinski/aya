// Pins how the remote client treats what comes back over ssh, which is untrusted: invalid JSON, a response
// before hello, a response of the wrong type, malformed directory entries and projects, remote errors
// (addressed to this request or not), ssh and node failures read from stderr, a clean exit with no answer,
// and output over the 10 MiB cap. The health check names the stage that failed. A fake `ssh` on PATH
// either runs the real bridge against a local socket this file serves, or prints canned output.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeExecutable } from "./helpers/executable.mjs";

const root = mkdtempSync(join(tmpdir(), "aya-rc-more-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

// Per target, `<root>/<target>.mode` says what this ssh does:
//   bridge:<socket>  run the remote command (the node bridge) here, against <socket>
//   stdout:<file>    print <file> and exit 0
//   exit:<code>      print `<root>/<target>.stderr` (if any) to stderr and exit <code>
writeExecutable(
  join(root, "ssh"),
  `#!/bin/sh
root="${root}"
# ssh -- <target> <command>: skip the "--" that ends ssh's options.
[ "$1" = "--" ] && shift
target="$1"
echo "$target" >> "$root/calls"
mode=$(cat "$root/$target.mode" 2>/dev/null)
case "$mode" in
  bridge:*) AYA_REMOTE_SOCKET="\${mode#bridge:}" exec sh -c "$2" ;;
  stdout:*) exec cat "\${mode#stdout:}" ;;
  exit:*) [ -f "$root/$target.stderr" ] && cat "$root/$target.stderr" >&2; exit "\${mode#exit:}" ;;
esac
echo "fake ssh: no mode for $target" >&2
exit 99
`,
);
process.env.PATH = `${root}:${process.env.PATH}`;

const {
  checkRemoteHealth,
  createRemoteDirectory,
  createRemoteProjectOnHost,
  listRemoteDirectory,
  listRemotePresets,
} = await import("../dist-electron/remote-client.js");

const HOST = { id: "vega-id", name: "vega", platform: "linux", user: "username" };
const HELLO = { type: "hello", protocol: 1, host: HOST, app: { version: "0.0.0-test" }, permissions: { mode: "read-only" } };
const PRESET = { id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" };
const AYA = { slug: "aya", name: "Aya", directory: "/home/username/aya", tabs: [] };
const HOME = { slug: "home", name: "Home", directory: "/home/username", tabs: [] };
function snapshot(over = {}) {
  return {
    type: "snapshot",
    protocol: 1,
    generatedAt: 1,
    snapshot: {
      presets: [PRESET],
      projects: [AYA, HOME],
      projectState: { version: 1, order: ["aya", "home"], open: [], recent: ["home"] },
      ...over,
    },
  };
}

function lineOf(value) {
  return `${typeof value === "string" ? value : JSON.stringify(value)}\n`;
}

/** Serves a remote Aya for `target` on a local socket: `greet` lines go out on connect, `reply(request)`
 *  lines answer each request the bridge sends. Strings go out as they are, anything else as JSON. */
async function serveRemote(t, target, { greet = [HELLO, snapshot()], reply = () => [] }) {
  const socket = join(root, `${target}.sock`);
  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    for (const line of greet) conn.write(lineOf(line));
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) for (const out of reply(JSON.parse(line))) conn.write(lineOf(out));
      }
    });
    conn.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(join(root, `${target}.mode`), `bridge:${socket}`);
}

function sshPrints(target, text) {
  const file = join(root, `${target}.out`);
  writeFileSync(file, text);
  writeFileSync(join(root, `${target}.mode`), `stdout:${file}`);
}

function sshFails(target, code, stderr) {
  writeFileSync(join(root, `${target}.mode`), `exit:${code}`);
  if (stderr !== undefined) writeFileSync(join(root, `${target}.stderr`), stderr);
}

function calls() {
  const file = join(root, "calls");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

function stages(result) {
  return result.checks.map((check) => `${check.stage}:${check.ok}`);
}

function failedMessage(result) {
  assert.equal(result.ok, false);
  const failed = result.checks.filter((check) => !check.ok);
  assert.equal(failed.length, 1);
  return failed[0].message;
}

const QUICK = { bridgeMs: 5_000, sshKillMs: 20_000 };

// --- health check ------------------------------------------------------------

test("a blank target fails the health check at ssh without running ssh", async () => {
  const before = calls().length;
  const result = await checkRemoteHealth("   ", QUICK);
  assert.equal(result.sshTarget, "   ");
  assert.deepEqual(stages(result), ["ssh:false"]);
  assert.equal(failedMessage(result), "Remote SSH target is required.");
  assert.equal(calls().length, before);
});

test("a healthy remote passes all four stages and reports the host and counts, for the trimmed target", async (t) => {
  await serveRemote(t, "healthy", {
    reply: (req) => [{ type: "fs:list-result", protocol: 1, id: req.id, path: "/home/username", entries: [] }],
  });
  const result = await checkRemoteHealth("  healthy  ", QUICK);
  assert.equal(result.ok, true);
  assert.equal(result.sshTarget, "healthy");
  assert.deepEqual(result.host, HOST);
  assert.equal(result.presetsCount, 1);
  assert.equal(result.recentProjectsCount, 1);
  assert.deepEqual(stages(result), ["ssh:true", "node:true", "aya-remote:true", "snapshot:true"]);
  assert.equal(result.checks[0].message, "Connected to healthy.");
  assert.equal(calls().at(-1), "healthy");
});

test("node missing on the remote host fails at the node stage, after ssh connected", async () => {
  sshFails("nonode", 127, "bash: node: command not found\n");
  const result = await checkRemoteHealth("nonode", QUICK);
  assert.deepEqual(stages(result), ["ssh:true", "node:false"]);
  assert.equal(
    failedMessage(result),
    "Node is not available on nonode. Install Node or make it available over ssh.",
  );
});

test("aya missing on the remote host fails at the aya-remote stage", async () => {
  sshFails("noaya", 127, "zsh: command not found: aya\n");
  const result = await checkRemoteHealth("noaya", QUICK);
  assert.deepEqual(stages(result), ["ssh:true", "node:true", "aya-remote:false"]);
  assert.equal(
    failedMessage(result),
    "Aya is not installed on noaya. Install Aya there and make sure it has been started.",
  );
});

test("an ssh that fails with a message on stderr reports that message at the ssh stage", async () => {
  sshFails("denied", 255, "denied: Permission denied (publickey).\n");
  const result = await checkRemoteHealth("denied", QUICK);
  assert.deepEqual(stages(result), ["ssh:false"]);
  assert.equal(failedMessage(result), "denied: Permission denied (publickey).");
});

test("an ssh that exits cleanly without an answer is a connection closed before the response", async () => {
  sshPrints("silent", lineOf(HELLO) + lineOf(snapshot()));
  const result = await checkRemoteHealth("silent", QUICK);
  assert.deepEqual(stages(result), ["ssh:false"]);
  assert.equal(failedMessage(result), "Remote Aya connection closed before response (0).");
});

test("a remote error about the snapshot fails at the snapshot stage, after the first three passed", async (t) => {
  await serveRemote(t, "snapfail", {
    reply: (req) => [
      { type: "error", protocol: 1, id: req.id, code: "snapshot_failed", message: "Could not read the snapshot." },
    ],
  });
  const result = await checkRemoteHealth("snapfail", QUICK);
  assert.deepEqual(stages(result), ["ssh:true", "node:true", "aya-remote:true", "snapshot:false"]);
  assert.equal(failedMessage(result), "Could not read the snapshot.");
});

test("output over the 10 MiB cap is refused at once, not parsed and not waited out", async () => {
  // Lines of exactly 1 KiB so the cap falls on a line end: what was read is all valid JSON.
  const base = { ...HELLO, pad: "" };
  const line = lineOf({ ...base, pad: "x".repeat(1024 - lineOf(base).length) });
  assert.equal(Buffer.byteLength(line), 1024);
  sshPrints("flood", line.repeat(10 * 1024 + 64));
  const started = Date.now();
  const result = await checkRemoteHealth("flood", QUICK);
  assert.ok(Date.now() - started < QUICK.sshKillMs, "refused before the ssh kill");
  assert.deepEqual(stages(result), ["ssh:false"]);
  assert.equal(failedMessage(result), "stdout maxBuffer length exceeded");
});

// --- untrusted output ---------------------------------------------------------

test("one line of invalid JSON rejects the request, even with a valid response after it", async (t) => {
  await serveRemote(t, "garbled", {
    greet: [HELLO, "{not json", snapshot()],
    reply: (req) => [{ type: "fs:mkdir-result", protocol: 1, id: req.id, path: "/x" }],
  });
  await assert.rejects(createRemoteDirectory("garbled", "/x"), { message: "Remote Aya returned invalid JSON." });
});

test("a response that arrives before hello is refused", async (t) => {
  await serveRemote(t, "nohello", {
    greet: [snapshot()],
    reply: (req) => [{ type: "fs:mkdir-result", protocol: 1, id: req.id, path: "/x" }],
  });
  await assert.rejects(createRemoteDirectory("nohello", "/x"), {
    message: "Remote Aya response arrived before hello.",
  });
});

test("errors for another request, unknown types and messages without an id are skipped", async (t) => {
  await serveRemote(t, "noisy", {
    reply: (req) => [
      { type: "error", protocol: 1, id: "someone-else", code: "denied", message: "Not yours." },
      { type: "error", protocol: 1, code: "bad_json", message: "No id at all." },
      { type: "telemetry", protocol: 1, cpu: 3 },
      { type: "fs:mkdir-result", protocol: 1, path: "/no-id" },
      { type: "fs:mkdir-result", protocol: 1, id: req.id, path: "/mine" },
    ],
  });
  assert.equal(await createRemoteDirectory("noisy", "/mine"), "/mine");
});

test("an error addressed to another request is not taken as this request's failure", async () => {
  sshPrints(
    "foreign",
    lineOf(HELLO) +
      lineOf(snapshot()) +
      lineOf({ type: "error", protocol: 1, id: "someone-else", code: "denied", message: "Not yours." }),
  );
  await assert.rejects(createRemoteDirectory("foreign", "/x"), {
    message: "Remote Aya connection closed before response (0).",
  });
});

test("a response of the wrong type is refused by every request", async (t) => {
  await serveRemote(t, "wrongtype", {
    reply: (req) =>
      req.type === "fs:mkdir"
        ? [{ type: "fs:list-result", protocol: 1, id: req.id, path: "/", entries: [] }]
        : [{ type: "fs:mkdir-result", protocol: 1, id: req.id, path: "/" }],
  });
  const unexpected = { message: "Remote Aya returned an unexpected response." };
  await assert.rejects(listRemoteDirectory("wrongtype", "/"), unexpected);
  await assert.rejects(createRemoteDirectory("wrongtype", "/"), unexpected);
  await assert.rejects(createRemoteProjectOnHost("wrongtype", "/home/username/x"), unexpected);
});

test("a directory listing that is not a list of directories is refused", async (t) => {
  const rows = [
    ["entries not a list", { name: "x" }, "Remote directory list is invalid."],
    ["a file among directories", [{ name: "a", path: "/a", kind: "directory" }, { name: "f", path: "/f", kind: "file" }], "Remote directory entry is invalid."],
    ["an entry without a path", [{ name: "a", kind: "directory" }], "Remote directory entry is invalid."],
    ["an entry that is not an object", ["/a"], "Remote directory entry is invalid."],
  ];
  let entries;
  await serveRemote(t, "badlist", {
    reply: (req) => [{ type: "fs:list-result", protocol: 1, id: req.id, path: "/", entries }],
  });
  for (const [name, value, message] of rows) {
    entries = value;
    await assert.rejects(listRemoteDirectory("badlist", "/"), { message }, name);
  }
});

test("a created project without its tabs is refused", async (t) => {
  await serveRemote(t, "badproject", {
    reply: (req) => [
      { type: "project:create-result", protocol: 1, id: req.id, project: { slug: "p", name: "P", directory: "/p" } },
    ],
  });
  await assert.rejects(createRemoteProjectOnHost("badproject", "/p"), {
    message: "Remote project result is invalid.",
  });
});

test("malformed presets and projects in the snapshot are dropped, and unknown recent slugs fall back to all projects", async (t) => {
  await serveRemote(t, "messy", {
    greet: [
      HELLO,
      snapshot({
        presets: [PRESET, { id: "half", name: "Half" }, null, "shell"],
        projects: [AYA, { slug: "notabs", name: "N", directory: "/n" }, null, HOME],
        projectState: { recent: ["gone", 7] },
      }),
    ],
    reply: (req) => [{ type: "fs:list-result", protocol: 1, id: req.id, path: "/", entries: [] }],
  });
  const listing = await listRemoteDirectory("messy");
  assert.deepEqual(listing.presets, [PRESET]);
  assert.deepEqual(listing.recentProjects.map((project) => project.slug), ["aya", "home"]);
  assert.deepEqual(await listRemotePresets("messy"), [PRESET]);
});

// --- remote errors --------------------------------------------------------------

test("a remote error for this request rejects with its message, or its code when the message is empty", async (t) => {
  let message;
  await serveRemote(t, "refuses", {
    reply: (req) => [{ type: "error", protocol: 1, id: req.id, code: "forbidden", message }],
  });
  message = "Directory is outside the allowed roots.";
  await assert.rejects(createRemoteDirectory("refuses", "/etc/x"), { message });
  message = "";
  await assert.rejects(createRemoteDirectory("refuses", "/etc/x"), { message: "forbidden" });
});

test("an 'already exists' rejection opens the existing project from the snapshot that came with it", async (t) => {
  await serveRemote(t, "exists", {
    reply: (req) => [
      { type: "error", protocol: 1, id: req.id, code: "project_exists", message: 'Project "aya" already exists.' },
    ],
  });
  const result = await createRemoteProjectOnHost("exists", "/home/username/aya", "Aya");
  assert.deepEqual(result, { host: HOST, presets: [PRESET], project: AYA });
});

test("any other create error is rethrown unchanged", async (t) => {
  await serveRemote(t, "createfails", {
    reply: (req) => [
      { type: "error", protocol: 1, id: req.id, code: "bad_directory", message: "Directory does not exist: /nope" },
    ],
  });
  await assert.rejects(createRemoteProjectOnHost("createfails", "/nope"), {
    message: "Directory does not exist: /nope",
  });
});

test("an 'already exists' rejection without a hello is not recovered", async (t) => {
  await serveRemote(t, "existsnohello", {
    greet: [snapshot()],
    reply: (req) => [
      { type: "error", protocol: 1, id: req.id, code: "project_exists", message: 'Project "aya" already exists.' },
    ],
  });
  await assert.rejects(createRemoteProjectOnHost("existsnohello", "/home/username/aya"), {
    message: 'Project "aya" already exists.',
  });
});
