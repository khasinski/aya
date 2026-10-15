import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { startOwner, shellSpec, readUntil, PtyOwnerClient, artifacts, require, sleep, frame } from "./helpers/pty-owner.mjs";

test("owner spawns, resizes and reaps while the JS client owns only a duplicate", async (t) => {
  const owner = await startOwner(); t.after(() => owner.close());
  const c = await owner.connect(), pane = await c.spawn(shellSpec(owner.home));
  assert.equal(pane.pid > 0, true); assert.match(c.buildId, /^[0-9a-f]{64}$/); assert.match(c.instanceId, /^[0-9a-f]{32}$/);
  await readUntil(c, pane.fd, `START:${pane.pid}`);
  await assert.rejects(c.spawn(shellSpec(owner.home)), /Pane already exists/);
  fs.writeSync(pane.fd, "hello\n"); await readUntil(c, pane.fd, `R:${pane.pid}:hello`);
  await c.resize(pane, 101, 39); fs.writeSync(pane.fd, "size\n");
  await readUntil(c, pane.fd, `SIZE:${pane.pid}:39 101`);
  await assert.rejects(c.resize({ ...pane, generation: pane.generation + 1 }, 80, 24), /Unknown pane generation/);
  fs.writeSync(pane.fd, "quit\n"); await readUntil(c, pane.fd, `EXIT:${pane.pid}`);
  const exit = await c.nextExit(); assert.equal(exit.exitCode, 23); assert.equal(exit.signal, 0);
  await c.ackExit(exit); await c.ackExit(exit);
  assert.equal((await c.list())[0].acknowledged, true); assert.deepEqual(c.takeExits(), []);
  c.release(pane.fd);
  const next = await c.spawn({ ...shellSpec(owner.home), command: "/bin/sleep", argv: ["sleep", "30"] });
  assert.notEqual(next.generation, pane.generation);
  await assert.rejects(c.ackExit(exit), /Unknown pane generation/);
  await assert.rejects(c.kill(exit, 9), /Unknown pane generation/);
  assert.doesNotThrow(() => process.kill(next.pid, 0));
  await c.kill(next, 15); assert.equal((await c.nextExit()).signal, 15);
  await c.shutdown(); assert.equal((await owner.closed).code, 0);
});

test("wrong authentication and invalid headers cannot take over the owner", async (t) => {
  const owner = await startOwner(); t.after(() => owner.close());
  await assert.rejects(PtyOwnerClient.connect(owner.socket, Buffer.alloc(32), artifacts.bridge), /Authentication failed/);
  const native = require(artifacts.bridge);
  for (const alter of [b => b.writeUInt32BE(0, 0), b => b.writeUInt16BE(2, 4), b => b.writeUInt32BE(256 * 1024 + 1, 12)]) {
    const fd = native.connect(owner.socket), b = frame(1); alter(b); native.send(fd, b);
    const reply = await native.receive(fd, 2000); assert.equal(reply.data.readUInt16BE(6), 0x8001); native.close(fd, true);
  }
  const c = await owner.connect(); assert.deepEqual(await c.list(), []);
});

test("owner refuses duplicate owners and overlapping or live detached reader processes", async (t) => {
  const owner = await startOwner(); t.after(() => owner.close());
  const duplicate = spawn(artifacts.executable, owner.args, { env: owner.env, stdio: ["ignore", "ignore", "ignore", "pipe"] });
  duplicate.stdio[3].on("error", () => {}); duplicate.stdio[3].end(owner.token);
  assert.notEqual((await once(duplicate, "exit"))[0], 0);
  const c = await owner.connect();
  await assert.rejects(owner.connect(), /Previous client still owns the lease/);
  c.close(); await sleep(10);
  await assert.rejects(owner.connect(), /Previous client still owns the lease/);
});

test("failed spawn and unknown operations leave the owner usable without new panes", async (t) => {
  const owner = await startOwner(); t.after(() => owner.close()); const c = await owner.connect();
  await assert.rejects(c.spawn({ ...shellSpec(owner.home), command: "/missing/aya-test-command" }), /No such file/);
  await assert.rejects(c.spawn({ ...shellSpec(owner.home), cwd: "/missing/aya-test-directory" }), /No such file/);
  await assert.rejects(c.spawn({ ...shellSpec(owner.home), cols: 0 }), /Invalid spawn data/);
  assert.deepEqual(await c.list(), []);
});

async function child(mode, owner) {
  const proc = spawn(process.execPath, [path.resolve("tests/helpers/pty-owner-client-child.cjs"), mode, owner.home, artifacts.bridge], {
    env: owner.env, stdio: ["ignore", "ignore", "pipe", "pipe", "ipc"],
  });
  proc.stdio[3].end(owner.token);
  let stderr = ""; proc.stderr.on("data", data => { stderr += data; });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 6000);
  try {
    const done = once(proc, "exit");
    const [message] = await Promise.race([once(proc, "message"), done.then(() => { throw new Error(`Client exited without a result: ${stderr}`); })]);
    assert.equal((await done)[0], 0, stderr); return message;
  } finally { clearTimeout(timer); }
}
test("a child exiting with no JS client retains its real status through reconnect and acknowledgement", async (t) => {
  const owner = await startOwner(); t.after(() => owner.close());
  const first = await child("gap-exit", owner);
  await sleep(300);
  const next = await child("ack-gap", owner);
  assert.equal(next.events[0].pid, first.pane.pid); assert.equal(next.events[0].generation, first.pane.generation);
  assert.equal(next.events[0].exitCode, 23); assert.equal(next.events[0].signal, 0);
  const last = await child("post-ack", owner); assert.deepEqual(last.events, []);
});

test("SIGKILL of the JS reader preserves a preexisting unread reply and the original child", async (t) => {
  const owner = await startOwner(); t.after(() => owner.close());
  const proc = spawn(process.execPath, [path.resolve("tests/helpers/pty-owner-client-child.cjs"), "crash-queued", owner.home, artifacts.bridge], {
    env: owner.env, stdio: ["ignore", "ignore", "pipe", "pipe", "ipc"],
  });
  proc.stdio[3].end(owner.token);
  const done = once(proc, "exit");
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); });
  const [before] = await Promise.race([once(proc, "message"), done.then(() => { throw new Error("Crash client exited early"); })]);
  assert.equal(before.readReady, 1); proc.kill("SIGKILL"); assert.equal((await done)[1], "SIGKILL");
  const c = await owner.connect(), panes = await c.list();
  assert.equal(panes.length, 1); assert.equal(panes[0].pid, before.pane.pid);
  const pane = await c.attach(panes[0]); assert.equal(c.readReady(pane.fd), 1);
  assert.equal(Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pane.pid)], { encoding: "utf8" }).trim()), owner.owner.pid);
  await readUntil(c, pane.fd, `R:${pane.pid}:pending-before-crash`);
  fs.writeSync(pane.fd, "after\n"); await readUntil(c, pane.fd, `R:${pane.pid}:after`);
  await c.resize(pane, 99, 35); fs.writeSync(pane.fd, "size\n"); await readUntil(c, pane.fd, `SIZE:${pane.pid}:35 99`);
  fs.writeSync(pane.fd, "quit\n"); await readUntil(c, pane.fd, `EXIT:${pane.pid}`);
  const exit = await c.nextExit(); assert.equal(exit.exitCode, 23); await c.ackExit(exit);
});

test("fragmented frames and an unknown operation get bounded clean responses", async (t) => {
  const owner = await startOwner(); t.after(() => owner.close());
  const native = require(artifacts.bridge), fd = native.connect(owner.socket), hello = frame(1, owner.token);
  t.after(() => native.close(fd, true));
  native.send(fd, hello.subarray(0, 7)); await sleep(5); native.send(fd, hello.subarray(7));
  assert.equal((await native.receive(fd, 2000)).data.readUInt16BE(6), 0x8000);
  native.send(fd, frame(65535, Buffer.alloc(0), 2));
  const response = await native.receive(fd, 2000);
  assert.equal(response.data.readUInt16BE(6), 0x8001); assert.match(response.data.toString(), /Unknown operation/);
});

test("owner escalates an ignored graceful kill without leaving the child alive", async (t) => {
  const owner = await startOwner(); t.after(() => owner.close()); const c = await owner.connect();
  const pane = await c.spawn({ ...shellSpec(owner.home), argv: ["sh", "-c", "trap '' HUP TERM; sleep 30 & descendant=$!; printf 'READY:%s\\n' \"$descendant\"; wait \"$descendant\""] });
  const ready = await readUntil(c, pane.fd, "\n");
  const descendant = Number(/READY:(\d+)/.exec(ready)?.[1]); assert.ok(descendant > 0);
  await c.kill(pane, 1); const exit = await c.nextExit(); assert.equal(exit.signal, 9); await c.ackExit(exit);
  await waitGone(descendant);
  assert.throws(() => process.kill(pane.pid, 0), /ESRCH/);
});

test("explicit owner shutdown completes even if a JS client retains an unread master duplicate", async (t) => {
  const owner = await startOwner(); t.after(() => owner.close()); const c = await owner.connect();
  const pane = await c.spawn({ ...shellSpec(owner.home), argv: ["sh", "-c", "printf 'unread-before-exit\\n'; exit 23"] });
  await sleep(20); assert.ok(c.readReady(pane.fd));
  owner.owner.kill("SIGTERM");
  const timer = setTimeout(() => owner.owner.kill("SIGKILL"), 1800);
  const result = await owner.closed; clearTimeout(timer);
  assert.equal(result.code, 0, "shutdown must not hang in a macOS PTY drain");
  c.close(); assert.throws(() => process.kill(pane.pid, 0), /ESRCH/);
});

test("lease identifies a process instance, releases a reused PID and fails closed on unreadable identity", () => {
  const dir = fs.mkdtempSync(path.resolve("test-results/owner-identity-"));
  try {
    const executable = path.join(dir, "identity");
    execFileSync(process.env.CC || "cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "tests/helpers/pty-owner-identity.c", "-o", executable, ...(process.platform === "linux" ? ["-lutil"] : [])]);
    execFileSync(executable);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Linux received masters have CLOEXEC before the worker reaches its fcntl fault window", { skip: process.platform !== "linux" }, async (t) => {
  const dir = fs.mkdtempSync(path.resolve("test-results/owner-atomic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const headers = [process.env.AYA_NODE_HEADERS, path.resolve(path.dirname(process.execPath), "../include/node"), "/usr/include/node", "/usr/local/include/node"].find(p => p && fs.existsSync(path.join(p, "node_api.h")));
  assert.ok(headers, "Prepared local Node headers are required; no download");
  const bridge = path.join(dir, "checked.node");
  execFileSync(process.env.CC || "cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", "-I", headers,
    "tests/helpers/pty-owner-atomic-receive.c", "-o", bridge]);
  const owner = await startOwner(); t.after(() => owner.close());
  const c = await PtyOwnerClient.connect(owner.socket, owner.token, bridge); t.after(() => c.close());
  const pane = await c.spawn(shellSpec(owner.home));
  await readUntil(c, pane.fd, `START:${pane.pid}`);
  await c.kill(pane, 9); assert.equal((await c.nextExit()).signal, 9);
});

function compileOwnerFixture(name) {
  const dir = fs.mkdtempSync(path.resolve("test-results/owner-native-")), executable = path.join(dir, name);
  execFileSync(process.env.CC || "cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", `tests/helpers/${name}.c`, "-o", executable, ...(process.platform === "linux" ? ["-lutil"] : [])]);
  return { dir, executable };
}
test("reply writes retry interrupted POLLOUT and interrupted/backpressured descriptor sends without losing the lease", () => {
  const fixture = compileOwnerFixture("pty-owner-reply-retries");
  try { execFileSync(fixture.executable); } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});
test("an exit-wait timeout leaves the connection usable for a later real exit", async (t) => {
  const owner = await startOwner(); t.after(() => owner.close()); const c = await owner.connect();
  const pane = await c.spawn({ ...shellSpec(owner.home), argv: ["sh", "-c", "sleep 0.2; exit 23"] });
  await assert.rejects(c.nextExit(25), { code: "ETIMEDOUT" });
  assert.equal((await c.list())[0].pid, pane.pid);
  assert.equal((await c.nextExit()).exitCode, 23);
});
test("signal wake and child exec-error pipes retry EINTR and preserve the real spawn error", async (t) => {
  const fixture = compileOwnerFixture("pty-owner-pipe-interruptions");
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const owner = await startOwner(fixture.executable); t.after(() => owner.close());
  const c = await owner.connect();
  await assert.rejects(c.spawn({ ...shellSpec(owner.home), command: "/aya-no-such-owner-command" }), /No such file/);
  assert.deepEqual(await c.list(), [], "an interrupted error write must never look like successful exec");
});
test("an exec acknowledgement that never arrives times out and reaps its child", async (t) => {
  const fixture = compileOwnerFixture("pty-owner-exec-stall");
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const owner = await startOwner(fixture.executable); t.after(() => owner.close()); const c = await owner.connect();
  await assert.rejects(c.spawn(shellSpec(owner.home)), /Spawn exec timed out/);
  const pid = Number(fs.readFileSync(path.join(owner.home, "stalled-child"), "utf8"));
  assert.ok(pid > 0); assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.deepEqual(await c.list(), []);
});
async function waitGone(pid) {
  for (let i = 0; i < 300; i++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    await sleep(10);
  }
  assert.fail(`Descendant ${pid} still exists after group cleanup and init reaping`);
}
test("natural leader exit kills its HUP-ignoring group descendant before reaping and shutdown", async (t) => {
  const owner = await startOwner(); t.after(() => owner.close()); const c = await owner.connect();
  const pane = await c.spawn({ ...shellSpec(owner.home), argv: ["sh", "-c", "stty -echo; trap '' HUP; sleep 30 & descendant=$!; printf 'DESC:%s\\n' \"$descendant\"; read line; exit 23"] });
  const output = await readUntil(c, pane.fd, "\n"); const match = /DESC:(\d+)/.exec(output); assert.ok(match);
  const descendant = Number(match[1]); fs.writeSync(pane.fd, "exit\n");
  assert.equal((await c.nextExit()).exitCode, 23);
  await c.shutdown(); assert.equal((await owner.closed).code, 0); await waitGone(descendant);
});
test("owner startup accepts a private inherited token channel and leaves no token file", async (t) => {
  const owner = await startOwner(); t.after(() => owner.close());
  assert.deepEqual(fs.readdirSync(owner.home).filter(name => /token/.test(name)), []);
  const c = await owner.connect(); assert.deepEqual(await c.list(), []);
});

test("owner refuses a regular token file even when passed as an inherited descriptor", async () => {
  const dir = fs.mkdtempSync(path.resolve("test-results/owner-secret-"));
  const file = path.join(dir, "negative-token"); fs.writeFileSync(file, Buffer.alloc(32), { mode: 0o600 });
  const fd = fs.openSync(file, "r");
  try {
    const owner = spawn(artifacts.executable, ["--socket", path.relative(process.cwd(), path.join(dir, "o")), "--token-fd", "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
    let stderr = ""; owner.stderr.on("data", b => { stderr += b; });
    assert.notEqual((await once(owner, "close"))[0], 0);
    assert.match(stderr, /token must arrive through an inherited pipe/);
  } finally { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("protocol shutdown terminates and reaps a proven live leader and its HUP-ignoring group", async (t) => {
  const owner = await startOwner(); t.after(() => owner.close()); const c = await owner.connect();
  const pane = await c.spawn({ ...shellSpec(owner.home), argv: ["sh", "-c", "trap '' HUP TERM; sleep 30 & descendant=$!; printf 'LIVE:%s\\n' \"$descendant\"; wait \"$descendant\""] });
  const output = await readUntil(c, pane.fd, "\n"), descendant = Number(/LIVE:(\d+)/.exec(output)?.[1]);
  assert.ok(descendant > 0); assert.doesNotThrow(() => process.kill(pane.pid, 0));
  assert.doesNotThrow(() => process.kill(descendant, 0)); assert.equal((await c.list())[0].exited, false);
  await c.shutdown(); assert.equal((await owner.closed).code, 0);
  assert.throws(() => process.kill(pane.pid, 0), /ESRCH/); await waitGone(descendant);
});
test("kernel PTY queue backpressures an unread continuous writer then drains every byte and resumes the child", async (t) => {
  const fixture = compileOwnerFixture("pty-owner-backpressure"); t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const owner = await startOwner(); t.after(() => owner.close()); const c = await owner.connect();
  const pane = await c.spawn({ ...shellSpec(owner.home), command: fixture.executable, argv: [fixture.executable] });
  const blocked = path.join(owner.home, "backpressured"), done = path.join(owner.home, "output-complete");
  const deadline = Date.now() + 6000;
  while (!fs.existsSync(blocked) || fs.statSync(blocked).size === 0) { assert.ok(Date.now() < deadline, "writer must encounter EAGAIN without a reader"); await sleep(2); }
  const queued = Number(fs.readFileSync(blocked, "utf8")); assert.ok(queued > 0 && queued < 2 * 1024 * 1024);
  assert.ok(c.readReady(pane.fd)); await sleep(100); assert.equal(fs.existsSync(done), false, "writer must remain backpressured until we drain");
  const received = [], buffer = Buffer.alloc(65536); let total = 0;
  while (total < 2 * 1024 * 1024) {
    assert.ok(Date.now() < deadline + 6000, "continuous output must resume after draining");
    if (c.readReady(pane.fd)) {
      const size = fs.readSync(pane.fd, buffer); assert.ok(size > 0, `Unexpected EOF after ${total} bytes`); received.push(Buffer.from(buffer.subarray(0, size))); total += size;
    } else await sleep(1);
  }
  const expected = Buffer.alloc(total); for (let i = 0; i < expected.length; i++) expected[i] = i % 251;
  assert.equal(total, 2 * 1024 * 1024); assert.deepEqual(Buffer.concat(received), expected);
  while (!fs.existsSync(done) || fs.statSync(done).size === 0) { assert.ok(Date.now() < deadline + 6000); await sleep(1); }
  assert.equal(Number(fs.readFileSync(done, "utf8")), total);
  fs.writeSync(pane.fd, "drained\n"); assert.equal((await c.nextExit()).exitCode, 23);
});
