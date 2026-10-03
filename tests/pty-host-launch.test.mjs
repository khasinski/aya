// A pane opened for a team role is launched in a mode that reaches Aya, and the
// host says how each live pane was launched. HOME, SHELL and PATH are fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-lm-")));
const cwd = join(root, "project");
mkdirSync(cwd);
const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "codex"),
  ["#!/bin/sh", 'if [ "$1" = --help ]; then echo "      --no-daemon"; exit 0; fi', 'echo "CODEX-ARGS:$*"', "sleep 30", ""].join("\n"),
);
chmodSync(join(bin, "codex"), 0o755);
writeFileSync(join(bin, "brief"), ["#!/bin/sh", "sleep 1", ""].join("\n"));
chmodSync(join(bin, "brief"), 0o755);
process.env.AYA_HOME = join(root, "aya-home");
process.env.HOME = join(root, "home");
process.env.PATH = "/usr/bin:/bin";
process.env.SHELL = "/bin/sh";
mkdirSync(process.env.HOME);
writeFileSync(join(process.env.HOME, ".profile"), `PATH='${bin}':$PATH\nexport PATH\n`);

// Env first, then the app's modules: paths.ts reads AYA_HOME once, at load.
const { PTY_HOST_SOCKET_PATH } = await import("../dist-electron/paths.js");
assert.ok(PTY_HOST_SOCKET_PATH.startsWith(root + "/"), `pty host socket outside the test's home: ${PTY_HOST_SOCKET_PATH}`);
const { LAUNCH_STARTING, LAUNCH_UNREACHABLE, LAUNCH_UNSUPPORTED, launchBlockOf, launchHoldOf, launchNoteOf } = await import("../dist-electron/launch-mode.js");
const { PTY_HOST_UNKNOWN_REQUEST, PTY_HOST_NOT_CONNECTED } = await import("../dist-electron/constants.js");
const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { HOST_EVENT_TIMEOUT_MS } = await import("./helpers/pty-host.mjs");

async function launched(t, ptyId, command, teamLaunch, dir = cwd) {
  const events = [];
  const client = new PtyHostClient(join(process.cwd(), "dist-electron", "pty-host.js"));
  client.attachWebContents({ isDestroyed: () => false, send: (channel, payload) => channel === "pty:event" && events.push(payload) });
  t.after(() => client.shutdown().catch(() => {}));
  await client.spawn({ ptyId, command, cwd: dir, cols: 80, rows: 24, ...(teamLaunch ? { teamLaunch: true } : {}) });
  const output = () => events.filter((e) => e.type === "data").map((e) => e.chunk).join("");
  const deadline = Date.now() + HOST_EVENT_TIMEOUT_MS;
  while (!/CODEX-ARGS:[^\r\n]*[\r\n]/.test(output()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return { output: output(), launch: await client.launch(ptyId), client };
}

test("a role's Codex pane gets full access and never asks, besides --no-daemon", async (t) => {
  const { output, launch } = await launched(t, "lm-1", "codex", true);
  assert.match(output, /CODEX-ARGS:-s danger-full-access -a never --no-daemon\s/);
  assert.deepEqual([launch.command, launch.cwd], ["codex -s danger-full-access -a never --no-daemon", cwd]);
  assert.deepEqual([launch.mode.reach, launch.added], ["reaches", ["-s", "danger-full-access", "-a", "never"]]);
  assert.equal(launchBlockOf(launch), null);
  assert.match(launchNoteOf(launch), /^Aya opened it with -s danger-full-access -a never so git and aya never wait for an approval/);
});

test("a role's Codex pane whose preset picks its approval policy keeps it, gets the network switch, and is noted", async (t) => {
  const { output, launch } = await launched(t, "lm-1b", "codex -a on-request", true);
  assert.match(output, /CODEX-ARGS:-c sandbox_workspace_write.network_access=true --no-daemon -a on-request\s/);
  assert.equal(launchBlockOf(launch), null);
  assert.match(launchNoteOf(launch), /network_access=true.*every network host.*as the preset sets them.*may stop for approvals/);
});

test("a normal Codex pane is launched as its preset says", async (t) => {
  const { output, launch } = await launched(t, "lm-2", "codex", false);
  assert.match(output, /CODEX-ARGS:--no-daemon\s/);
  assert.deepEqual([launch.command, launch.cwd, launch.added], ["codex --no-daemon", cwd, []]);
  assert.equal(launchNoteOf(launch), null);
});

test("a role's pane in read-only is not escalated: it launches as its preset says", async (t) => {
  const { output } = await launched(t, "lm-3", "codex -s read-only", true);
  assert.match(output, /CODEX-ARGS:--no-daemon -s read-only\s/);
});

test("a pane in its spawn preflight is starting, not unrecorded; once recorded it has its record", async (t) => {
  const client = new PtyHostClient(join(process.cwd(), "dist-electron", "pty-host.js"));
  client.attachWebContents({ isDestroyed: () => false, send: () => {} });
  t.after(() => client.shutdown().catch(() => {}));
  const spawned = client.spawn({ ptyId: "lm-starting", command: "codex", cwd, cols: 80, rows: 24 });
  const seen = [];
  const deadline = Date.now() + HOST_EVENT_TIMEOUT_MS;
  for (;;) {
    const answer = await client.launch("lm-starting");
    seen.push(typeof answer === "object" && answer ? "record" : answer);
    if (answer && answer !== LAUNCH_STARTING) break;
    assert.ok(Date.now() < deadline, `no record: ${seen}`);
    await new Promise((r) => setTimeout(r, 2));
  }
  await spawned;
  assert.ok(seen.includes(LAUNCH_STARTING), `never reported starting: ${seen}`);
  assert.equal(seen.lastIndexOf(null) > seen.indexOf(LAUNCH_STARTING), false, "null after starting");
});

test("a pane that is gone has no launch", async (t) => {
  const { client } = await launched(t, "lm-4", "codex", false);
  await client.kill("lm-4");
  assert.equal(await client.launch("lm-4"), null);
  assert.equal(await client.launch("never-spawned"), null);
});

const config = join(process.env.HOME, ".codex", "config.toml");
const setConfig = (text) => {
  mkdirSync(join(process.env.HOME, ".codex"), { recursive: true });
  writeFileSync(config, text);
};

test("the verdict is the one at spawn: a config edited later does not flip a running pane", async (t) => {
  setConfig('sandbox_mode = "danger-full-access"\n');
  const { launch: reaching } = await launched(t, "lm-5", "codex --no-daemon", false);
  assert.equal(reaching.mode.reach, "reaches");
  setConfig('sandbox_mode = "read-only"\n');
  assert.equal(launchBlockOf(reaching), null, "the edit does not block a pane that started with the old config");
  const { launch: blocked } = await launched(t, "lm-6", "codex --no-daemon", false);
  assert.equal(blocked.mode.reach, "blocked");
  setConfig('sandbox_mode = "danger-full-access"\n');
  assert.match(launchBlockOf(blocked), /read-only blocks the socket/, "the edit does not unblock a pane that started read-only");
  assert.match(launchHoldOf(blocked), /^can't reach Aya: .*read-only blocks the socket/, "a measured can't reach holds");
  assert.equal(launchBlockOf((await launched(t, "lm-7", "codex --no-daemon", false)).launch), null, "a pane started after the edit sees it");
});

test("a pane the host has no launch verdict for is reported as such, and never held: only a measured can't reach holds", () => {
  assert.match(launchBlockOf(null), /no record of how this pane was launched/);
  assert.match(launchBlockOf({ command: "codex --no-daemon", cwd }), /no record of how this pane was launched/);
  for (const answer of [null, { command: "codex --no-daemon", cwd }, LAUNCH_UNREACHABLE, LAUNCH_STARTING, LAUNCH_UNSUPPORTED]) {
    assert.equal(launchHoldOf(answer), null, JSON.stringify(answer));
  }
});

test("a host that cannot be reached is not 'no record'; an old host that lacks the request is", async () => {
  const client = new PtyHostClient(join(process.cwd(), "dist-electron", "pty-host.js"));
  client.request = async () => {
    throw new Error("PTY host disconnected");
  };
  const unreachable = await client.launch("x");
  assert.doesNotMatch(launchBlockOf(unreachable) ?? "", /no record/);
  assert.match(launchBlockOf(unreachable), /could not ask/);
  assert.equal(launchNoteOf(unreachable), null);
  client.request = async () => {
    throw new Error(PTY_HOST_UNKNOWN_REQUEST);
  };
  assert.equal(await client.launch("x"), LAUNCH_UNSUPPORTED);
});

test("an old host's unknown-request error keeps the exact words shipped hosts send", () => {
  assert.equal(PTY_HOST_UNKNOWN_REQUEST, "unknown request");
});

test("a pane's record goes with the pane when its process exits on its own", async (t) => {
  const client = new PtyHostClient(join(process.cwd(), "dist-electron", "pty-host.js"));
  client.attachWebContents({ isDestroyed: () => false, send: () => {} });
  t.after(() => client.shutdown().catch(() => {}));
  await client.spawn({ ptyId: "lm-8", command: "brief", cwd, cols: 80, rows: 24 });
  assert.equal((await client.launch("lm-8"))?.command, "brief", "recorded while it runs");
  const deadline = Date.now() + 10_000;
  while ((await client.launch("lm-8")) !== null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await client.launch("lm-8"), null, "the record outlived the process");
  assert.match(await client.holdReason("lm-8"), /not running/);
});

test("an Aya restart attaching to a running pane finds the record the host made at spawn", async (t) => {
  setConfig('sandbox_mode = "danger-full-access"\n');
  const { launch: before, client: first } = await launched(t, "lm-9", "codex --no-daemon", true);
  assert.equal(before.mode.reach, "reaches");
  first.dispose();
  setConfig('sandbox_mode = "read-only"\n');
  const second = new PtyHostClient(join(process.cwd(), "dist-electron", "pty-host.js"));
  second.attachWebContents({ isDestroyed: () => false, send: () => {} });
  t.after(() => second.shutdown().catch(() => {}));
  await second.spawn({ ptyId: "lm-9", command: "codex --no-daemon", cwd, cols: 80, rows: 24, attachOnly: true });
  const after = await second.launch("lm-9");
  assert.deepEqual(after, before, "the same record, with the verdict from the spawn, not the edited config");
  assert.equal(launchBlockOf(after), null);
});

const UNTRUSTED = "untrusted project config";

async function untrustedPane(t, ptyId, projectConfig) {
  const dir = join(root, ptyId);
  mkdirSync(join(dir, ".codex"), { recursive: true });
  writeFileSync(join(dir, ".codex", "config.toml"), projectConfig);
  setConfig("");
  const { launch, client } = await launched(t, ptyId, "codex --no-daemon", false, dir);
  assert.equal(launch.mode.mode, UNTRUSTED);
  assert.equal(launchHoldOf(launch), null, "unknown is never held");
  assert.match(launchNoteOf(launch), /^may not reach Aya: .*trust the project in Codex, then restart the pane/);
  return { dir, client };
}

test("a project trusted after the pane started stays noted until the pane is restarted", async (t) => {
  const { dir, client } = await untrustedPane(t, "lm-10", 'sandbox_mode = "danger-full-access"\n');
  setConfig(`[projects."${dir}"]\ntrust_level = "trusted"\n`);
  const still = await client.launch("lm-10");
  assert.equal(still.mode.mode, UNTRUSTED);
  assert.match(launchNoteOf(still), /restart the pane/);
  const { launch: restarted } = await launched(t, "lm-10b", "codex --no-daemon", false, dir);
  assert.equal(restarted.mode.reach, "reaches", "a restart records the pane under the config it now runs with");
});

test("the client's no-host error keeps its words: the renderer's buffer read matches them", () => {
  assert.equal(PTY_HOST_NOT_CONNECTED, "PTY host is not connected");
});
