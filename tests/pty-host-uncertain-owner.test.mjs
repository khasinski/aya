import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawnAuthenticatedHost} from "./helpers/pty-host-launch.cjs";
import { once } from "node:events";
import { connectWhenListening } from "./helpers/unix-socket.mjs";
import { cleanupNativeOwner } from "./helpers/pty-host.mjs";

test("an idle JS host never shuts down an owner with an unconfirmed spawn and empty known inventory", { timeout: 15000 }, async () => {
  fs.mkdirSync("test-results", { recursive: true });
  const home = fs.mkdtempSync(path.resolve("test-results/uncertain-idle-"));
  const host = spawnAuthenticatedHost(process.execPath, ["tests/helpers/pty-host-uncertain-owner.cjs"], {
    env: { ...process.env, AYA_HOME: home, AYA_PTY_HOST_IDLE_MS: "150" }, stdio: "ignore",
  });
  const closed = once(host, "exit");
  try {
    const socket = await connectWhenListening(path.join(home, "pty-host.sock"));
    socket.destroy();
    const before = JSON.parse(fs.readFileSync(path.join(home, "uncertain-child.json")));
    await new Promise(resolve => setTimeout(resolve, 1600));
    const events = fs.readFileSync(path.join(home, "pty-events.log"), "utf8");
    assert.doesNotMatch(events, /"ev":"host-shutdown"/, "idle cleanup must not start a destructive shutdown of uncertain work");
    assert.equal(host.exitCode, null, "idle cleanup cannot authorize killing uncertain work");
    assert.doesNotThrow(() => process.kill(before.owner, 0));
    assert.doesNotThrow(() => process.kill(before.child, 0));
    const record = JSON.parse(fs.readFileSync(path.join(home, "pty-owner/record.json")));
    assert.deepEqual(record.uncertain, ["uncertain"]); assert.deepEqual(record.panes, []);
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
    await closed; await cleanupNativeOwner(home); fs.rmSync(home, { recursive: true, force: true });
  }
});
