import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { cleanupNativeOwner } from "./helpers/pty-host.mjs";
import { recoverOwnerProcessGroup } from "../dist-electron/pty-owner-client.js";
const run = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a dead owner's real HUP-ignoring survivor stays inventoried through Cancel, rejects reused identity, and stops on confirmed recovery", { timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.resolve("test-results/dead-owner-"));
  const env = { ...process.env, AYA_HOME: home, HOME: home, SHELL: "/bin/sh", CODEX_HOME: path.join(home, "codex") };
  const host = spawn(process.execPath, ["tests/helpers/pty-owner-survivor-host.cjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let saved;
  const closed = once(host, "exit"), file = path.join(home, "pty-owner/record.json");
  const recover = async mode => {
    const { stdout } = await run(process.execPath, ["tests/helpers/pty-owner-recover-child.cjs", mode], { env, timeout: 12000 });
    return JSON.parse(stdout.trim().split("\n").at(-1));
  };
  try {
    const [data] = await once(host.stdout, "data"); saved = JSON.parse(String(data));
    const pane = saved.panes[0]; assert.match(pane.startIdentity, /^\d+:\d+$/);
    process.kill(saved.pid, "SIGKILL");
    while (alive(saved.pid)) await sleep(10);
    host.kill("SIGKILL"); await closed; await sleep(50);
    assert.equal(alive(pane.pid), true);
    assert.equal((await recover("cancel")).cancelled, true);
    assert.equal(alive(pane.pid), true); assert.equal(JSON.parse(fs.readFileSync(file)).panes[0].pid, pane.pid);
    const record = JSON.parse(fs.readFileSync(file)); record.panes[0].startIdentity = "0:0"; fs.writeFileSync(file, JSON.stringify(record));
    assert.throws(() => recoverOwnerProcessGroup(2 ** 32 + pane.pid, pane.startIdentity), /Invalid recovery PID/);
    const refused = await recover("recover"); assert.match(refused.refused, /Not stopped.*inventory was kept/s);
    assert.equal(alive(pane.pid), true); assert.equal(refused.kept[0].pid, pane.pid);
    const corrected = JSON.parse(fs.readFileSync(file)); corrected.panes[0].startIdentity = pane.startIdentity;
    fs.writeFileSync(file, JSON.stringify(corrected));
    const recovered = await recover("recover"); assert.equal(recovered.stopped, pane.pid);
    assert.equal(alive(pane.pid), false); assert.notEqual(recovered.replacement, pane.pid);
  } finally {
    if (host.exitCode === null && host.signalCode === null) { host.kill("SIGKILL"); await closed; }
    if (saved?.panes[0]?.startIdentity) recoverOwnerProcessGroup(saved.panes[0].pid, saved.panes[0].startIdentity);
    await cleanupNativeOwner(home); fs.rmSync(home, { recursive: true, force: true });
  }
});
