// Shared by the tests that drive a real PTY host. Import it dynamically AFTER
// setting AYA_HOME: pty-host-client reads the socket path at module load.

const { PTY_HOST_SOCKET_WAIT_TIMEOUT_MS } = await import(
  "../../dist-electron/pty-host-client.js"
);

/** A cold host may take the client's whole socket wait, then a `-l -i` shell
 *  starts (2-3 s alone, past 4 s under load); this asks "does it happen at all". */
export const HOST_EVENT_TIMEOUT_MS = 3 * PTY_HOST_SOCKET_WAIT_TIMEOUT_MS;

/** Wait until predicate() returns truthy or ms elapses. */
export async function waitFor(predicate, ms = HOST_EVENT_TIMEOUT_MS, step = 25) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

export function fakeWebContents() {
  const events = [];
  return {
    isDestroyed: () => false,
    send: (channel, payload) => events.push({ channel, payload }),
    _events: events,
  };
}

/** A PTY event sink that records every event it is sent. */
export function fakeSink() {
  const events = [];
  return { events, sendPtyEvent: (e) => events.push(e), isDestroyed: () => false };
}

export function ptyEventsFor(wc, ptyId) {
  return wc._events
    .filter((e) => e.channel === "pty:event")
    .map((e) => e.payload)
    .filter((p) => p.ptyId === ptyId);
}

/** Stop only a disposable fixture's verified native owner after a JS crash. */
export async function cleanupNativeOwner(home) {
  const fs = await import("node:fs"), path = await import("node:path");
  const file = path.join(home, "pty-owner/record.json");
  if (!fs.existsSync(file)) return;
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  if (record.executable !== path.resolve("dist-electron/aya-pty-owner")) throw new Error("Unexpected fixture owner executable");
  const { ownerRecordIsLive, ownerReaderIsLive } = await import("../../dist-electron/pty-owner-registry.js");
  if (ownerRecordIsLive(record)) process.kill(record.pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (ownerRecordIsLive(record)) {
    if (Date.now() > deadline) throw new Error(`Fixture owner ${record.pid} did not stop`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const { ownerProcessGroupExists } = await import("../../dist-electron/pty-owner-client.js");
  if (!ownerReaderIsLive(record) && !record.uncertain?.length && record.panes.every(p => !ownerProcessGroupExists(p.pid))) {
    // This disposable fixture explicitly stopped the owner and verified all
    // retained groups gone. Product startup must never make this inference
    // from owner death alone; the next isolated test starts with a clean home.
    fs.rmSync(file, { force: true });
  }
}

/** Stop only child processes this fixture spawned; never signal a numeric PGID. */
export async function stopFixtureChildren(children) {
  for (const child of new Set(children)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try { child.kill("SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    if (await waitForChildExit(child, 5_000)) continue;
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (!(await waitForChildExit(child, 2_000))) {
      throw new Error(`Fixture child ${child.pid} did not exit during cleanup`);
    }
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs);
  });
}
