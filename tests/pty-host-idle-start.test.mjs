// A host that never gets a client (its app was killed while it booted) must exit on its own.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST_SCRIPT = join(process.cwd(), "dist-electron", "pty-host.js");
const IDLE_MS = 500;
const EXIT_DEADLINE_MS = 6000;

function startHost(ayaHome, idleMs) {
  return spawn(process.execPath, [HOST_SCRIPT], {
    env: { ...process.env, AYA_HOME: ayaHome, AYA_PTY_HOST_IDLE_MS: String(idleMs) },
    stdio: "ignore",
  });
}

const exited = (child, ms) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

// Every case starts its own host under its own temporary AYA_HOME (and socket).
describe("idle startup with isolated hosts", { concurrency: 4 }, () => {
  test("a host that never gets a client exits after its idle timeout", async () => {
    const home = mkdtempSync(join(tmpdir(), "aya-idle-start-"));
    const host = startHost(home, IDLE_MS);
    try {
      assert.equal(await exited(host, EXIT_DEADLINE_MS), true, "the host is still running");
    } finally {
      host.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the idle timeout is the default when the override is unset", async () => {
    const home = mkdtempSync(join(tmpdir(), "aya-idle-start-"));
    const host = spawn(process.execPath, [HOST_SCRIPT], { env: { ...process.env, AYA_HOME: home, AYA_PTY_HOST_IDLE_MS: "" }, stdio: "ignore" });
    try {
      assert.equal(await exited(host, EXIT_DEADLINE_MS), false, "the default idle wait is 30 s, not immediate");
    } finally {
      host.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a client that sits silent past the idle timeout, then leaves, still lets the host exit", async () => {
    const home = mkdtempSync(join(tmpdir(), "aya-idle-start-"));
    const sock = join(home, "pty-host.sock");
    const host = startHost(home, IDLE_MS * 2);
    try {
      while (!existsSync(sock)) await new Promise((r) => setTimeout(r, 25));
      const client = net.createConnection(sock);
      await new Promise((r) => client.once("connect", r));
      await new Promise((r) => setTimeout(r, IDLE_MS * 3));
      assert.equal(host.exitCode, null, "a host with a client must stay up");
      client.destroy();
      assert.equal(await exited(host, EXIT_DEADLINE_MS), true, "the host never exited after its last client left");
    } finally {
      host.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a client that connects and leaves without a request restarts the idle wait", async () => {
    const idle = 1500;
    const home = mkdtempSync(join(tmpdir(), "aya-idle-start-"));
    const sock = join(home, "pty-host.sock");
    const host = startHost(home, idle);
    const startedAt = Date.now();
    try {
      while (!existsSync(sock)) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, Math.max(0, idle * 0.6 - (Date.now() - startedAt))));
      const client = net.createConnection(sock);
      await new Promise((r) => client.once("connect", r));
      client.destroy();
      await new Promise((r) => setTimeout(r, idle * 0.6));
      assert.equal(host.exitCode, null, "the host exited on the timer armed before the client came");
      assert.equal(await exited(host, EXIT_DEADLINE_MS), true, "the host never exited after the client left");
    } finally {
      host.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  });
});
