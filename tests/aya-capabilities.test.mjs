// The real CLI against the real control server on a tmp socket (#117), so the
// list an agent reads and the caller Aya counts are checked end to end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const { startControlServerOn } = await import("../dist-electron/control.js");
const { AYA_CAPABILITIES } = await import("../dist-electron/capabilities.js");

const cli = resolve("bin/aya");

/** Run the CLI against a live control server; resolve with its output and
 *  every (request, caller) the server saw. */
async function runAgainstServer(args, env, onRequest) {
  const dir = mkdtempSync(join(tmpdir(), "aya-caps-"));
  const socket = join(dir, "aya.sock");
  const seen = [];
  const stop = startControlServerOn(socket, {
    getWindow: () => null,
    openProject: () => {},
    listProjects: async () => [],
    onRequest: onRequest ?? ((request, caller) => seen.push({ request, caller })),
  });
  try {
    const result = await new Promise((done, fail) => {
      const child = spawn(cli, args, {
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("AYA_")),
          ),
          AYA_SOCKET: socket,
          ...env,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", fail);
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
    return { ...result, seen };
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("aya capabilities prints the command list as JSON, marked inside Aya", async () => {
  const { status, stdout, seen } = await runAgainstServer(["capabilities"], {
    AYA_TERMINAL_ID: "term-1",
    AYA_PRESET_ID: "claude",
  });
  assert.equal(status, 0);
  const doc = JSON.parse(stdout);
  assert.equal(doc.insideAya, true);
  assert.equal(doc.terminalId, "term-1");
  assert.deepEqual(
    doc.commands.map((c) => c.usage),
    AYA_CAPABILITIES.map((c) => c.usage),
  );
  assert.ok(doc.commands.find((c) => c.command === "pane send").notes.join(" ").includes("--no-submit"));
  assert.deepEqual(seen, [
    { request: { type: "capabilities" }, caller: { terminalId: "term-1", presetId: "claude" } },
  ]);
});

test("outside an Aya pane: still answers, insideAya false, no caller", async () => {
  const { status, stdout, seen } = await runAgainstServer(["capabilities"], {});
  assert.equal(status, 0);
  assert.equal(JSON.parse(stdout).insideAya, false);
  assert.deepEqual(seen[0].caller, {});
});

test("every command carries its pane, not just capabilities", async () => {
  const { seen } = await runAgainstServer(["status", "set", "Running tests"], {
    AYA_TERMINAL_ID: "term-2",
    AYA_PRESET_ID: "codex",
  });
  assert.equal(seen[0].request.type, "status");
  assert.deepEqual(seen[0].caller, { terminalId: "term-2", presetId: "codex" });
});

test("a throwing adoption hook never fails the command", async () => {
  const { status, stdout } = await runAgainstServer(["capabilities"], {}, () => {
    throw new Error("disk full");
  });
  assert.equal(status, 0);
  assert.equal(JSON.parse(stdout).insideAya, false);
});

function helpUsages() {
  const { stderr } = spawnSync(cli, ["help"], { encoding: "utf8" });
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("  aya "))
    .map((line) => line.trim().split(/\s{2,}/)[0]);
}

test("aya help and aya capabilities list exactly the same commands", () => {
  const help = helpUsages();
  // "aya [path]" is the bare-directory shorthand of `aya open`, not a command.
  const commands = help.filter((usage) => usage !== "aya [path]");
  assert.deepEqual(
    [...commands].sort(),
    AYA_CAPABILITIES.map((c) => c.usage).sort(),
  );
});
