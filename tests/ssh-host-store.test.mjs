// Saved ssh hosts and their history in a temp Aya config home: first use saves, later uses update, the log stays bounded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const store = await import("../dist-electron/ssh-host-store.js");
const machines = await import("../dist-electron/machines.js");
const { recordHostUse, loadSavedHosts, readHostHistory, HOST_HISTORY_MAX_LINES, SSH_HOSTS_FILE_NAME, SSH_HOSTS_HISTORY_FILE_NAME } = store;

function home(t) {
  const root = mkdtempSync(join(tmpdir(), "aya-host-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ayaHome = join(root, "aya");
  const userHome = join(root, "home");
  mkdirSync(join(userHome, ".ssh"), { recursive: true });
  return { ayaHome, userHome };
}
const at = (min) => new Date(Date.UTC(2026, 9, 3, 12, min));
const historyLines = (ayaHome) => readFileSync(join(ayaHome, SSH_HOSTS_HISTORY_FILE_NAME), "utf8").trim().split("\n");

// origin x use: what the first use saves and what it logs.
const firstUses = [
  { origin: "open-project", use: { kind: "project", project: "libeval" }, lastUsedFor: "project", events: ["added", "connected"] },
  { origin: "settings", use: { kind: "check", ok: true }, lastUsedFor: "check", lastCheck: { ok: true }, events: ["added", "connected"] },
  { origin: "settings", use: { kind: "check", ok: false, why: "ssh: connect timeout" }, lastUsedFor: "check", lastCheck: { ok: false, why: "ssh: connect timeout" }, events: ["added", "check-failed"] },
  { origin: "cli", use: { kind: "machine-added", machine: "athena" }, lastUsedFor: undefined, events: ["added"] },
  { origin: "cli", use: { kind: "machine-removed", machine: "athena" }, saved: false, events: ["removed"] },
];
for (const c of firstUses) {
  test(`first use: ${c.origin} ${c.use.kind}${"ok" in c.use ? ` ok=${c.use.ok}` : ""}`, async (t) => {
    const { ayaHome } = home(t);
    await recordHostUse(ayaHome, " me@Athena ", c.origin, c.use, at(0));
    const saved = await loadSavedHosts(ayaHome);
    if (c.saved === false) {
      assert.deepEqual(saved, [], "a removal alone saves no host");
    } else {
      assert.equal(saved.length, 1);
      const h = saved[0];
      assert.equal(h.target, "me@Athena", "the name as typed, trimmed");
      assert.equal(h.addedFrom, c.origin);
      assert.equal(h.addedAt, at(0).toISOString());
      assert.equal(h.lastUsedFor, c.lastUsedFor);
      assert.equal(h.lastUsedAt, c.lastUsedFor ? at(0).toISOString() : undefined);
      if (c.lastCheck) assert.deepEqual(h.lastCheck, { ...c.lastCheck, at: at(0).toISOString() });
      else assert.equal(h.lastCheck, undefined);
      assert.equal(statSync(join(ayaHome, SSH_HOSTS_FILE_NAME)).mode & 0o777, 0o600);
    }
    const history = await readHostHistory(ayaHome);
    assert.deepEqual(history.map((e) => e.event), c.events);
    assert.ok(history.every((e) => e.target === "me@Athena" && e.from === c.origin));
  });
}

test("a later use in another spelling updates the one entry and keeps when and where it was added", async (t) => {
  const { ayaHome } = home(t);
  await recordHostUse(ayaHome, "Athena", "open-project", { kind: "project", project: "web" }, at(0));
  await recordHostUse(ayaHome, "athena", "settings", { kind: "check", ok: false, why: "ssh: Permission denied (publickey)." }, at(5));
  await recordHostUse(ayaHome, "ATHENA", "cli", { kind: "project", project: "api" }, at(9));
  const [h, ...rest] = await loadSavedHosts(ayaHome);
  assert.deepEqual(rest, []);
  assert.deepEqual(h, {
    target: "Athena",
    addedAt: at(0).toISOString(),
    addedFrom: "open-project",
    lastUsedAt: at(9).toISOString(),
    lastUsedFor: "project",
    lastCheck: { ok: false, at: at(5).toISOString(), why: "ssh: Permission denied (publickey)." },
  });
  assert.deepEqual((await readHostHistory(ayaHome)).map((e) => [e.event, e.project ?? e.why ?? ""]), [
    ["added", ""],
    ["connected", "web"],
    ["check-failed", "ssh: Permission denied (publickey)."],
    ["connected", "api"],
  ]);
});

test("a failed Check keeps one line of the reason, capped; a target ssh could not take is never saved", async (t) => {
  const { ayaHome } = home(t);
  await recordHostUse(ayaHome, "box", "settings", { kind: "check", ok: false, why: `line one\nline two ${"x".repeat(400)}` }, at(0));
  const [h] = await loadSavedHosts(ayaHome);
  assert.equal(h.lastCheck.why.includes("\n"), false);
  assert.equal(h.lastCheck.why.length, store.HOST_WHY_MAX_CHARS);
  await recordHostUse(ayaHome, "-oProxyCommand=x", "settings", { kind: "check", ok: true }, at(1));
  await recordHostUse(ayaHome, "host -p 22", "settings", { kind: "project", project: "p" }, at(1));
  assert.deepEqual((await loadSavedHosts(ayaHome)).map((x) => x.target), ["box"]);
});

// Existing lines x new lines: the log never passes the bound, keeps the newest, and the trim leaves no temp file.
const bounds = [
  { before: 0, add: 1, expect: 1 },
  { before: HOST_HISTORY_MAX_LINES - 2, add: 1, expect: HOST_HISTORY_MAX_LINES - 1 },
  { before: HOST_HISTORY_MAX_LINES - 1, add: 1, expect: HOST_HISTORY_MAX_LINES },
  { before: HOST_HISTORY_MAX_LINES, add: 1, expect: HOST_HISTORY_MAX_LINES },
  { before: HOST_HISTORY_MAX_LINES + 40, add: 2, expect: HOST_HISTORY_MAX_LINES },
];
for (const b of bounds) {
  test(`history bounded: ${b.before} lines + ${b.add} use(s) -> ${b.expect} lines, newest last`, async (t) => {
    const { ayaHome } = home(t);
    mkdirSync(ayaHome, { recursive: true });
    const old = Array.from({ length: b.before }, (_, i) => JSON.stringify({ at: at(0).toISOString(), target: `old${i}`, event: "connected" }));
    if (b.before) writeFileSync(join(ayaHome, SSH_HOSTS_HISTORY_FILE_NAME), old.map((l) => `${l}\n`).join(""));
    // The host is already saved, so each use is one line.
    writeFileSync(join(ayaHome, SSH_HOSTS_FILE_NAME), JSON.stringify({ version: 1, hosts: [{ target: "box", addedAt: at(0).toISOString(), addedFrom: "cli" }] }));
    for (let i = 0; i < b.add; i++) await recordHostUse(ayaHome, "box", "settings", { kind: "project", project: `p${i}` }, at(i + 1));
    const lines = historyLines(ayaHome);
    assert.equal(lines.length, b.expect);
    assert.equal(JSON.parse(lines.at(-1)).project, `p${b.add - 1}`);
    if (b.before + b.add > HOST_HISTORY_MAX_LINES) assert.equal(JSON.parse(lines[0]).target, `old${b.before + b.add - HOST_HISTORY_MAX_LINES}`);
    assert.deepEqual(readdirSync(ayaHome).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock")), []);
  });
}

test("twenty uses at once: one host, every line logged, none torn", async (t) => {
  const { ayaHome } = home(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => recordHostUse(ayaHome, "box", "settings", { kind: "project", project: `p${i}` }, at(i))));
  assert.equal((await loadSavedHosts(ayaHome)).length, 1);
  const history = await readHostHistory(ayaHome);
  assert.equal(history.filter((e) => e.event === "added").length, 1);
  assert.deepEqual(history.filter((e) => e.event === "connected").map((e) => e.project).sort(), Array.from({ length: 20 }, (_, i) => `p${i}`).sort());
});

test("a saved-hosts file Aya cannot read is never rewritten; listing still works without it", async (t) => {
  const { ayaHome, userHome } = home(t);
  mkdirSync(ayaHome, { recursive: true });
  const file = join(ayaHome, SSH_HOSTS_FILE_NAME);
  for (const text of ["{nope", JSON.stringify({ version: 9, hosts: [] }), JSON.stringify({ version: 1, hosts: [{ target: "box" }] })]) {
    writeFileSync(file, text);
    await assert.rejects(recordHostUse(ayaHome, "box", "settings", { kind: "check", ok: true }, at(0)));
    assert.equal(readFileSync(file, "utf8"), text);
  }
  writeFileSync(join(userHome, ".ssh", "config"), "Host box\n");
  assert.deepEqual(await machines.knownHosts({ ayaHome, userHome }), [{ target: "box", sources: ["ssh-config"] }]);
});

// Through `aya machines` with an origin: add saves, Check records, remove keeps the saved host and logs the removal.
test("add, Check and remove through aya machines: the host stays saved and the removal is a history line", async (t) => {
  const { ayaHome, userHome } = home(t);
  writeFileSync(join(userHome, ".ssh", "config"), "Host athena\n");
  machines.clearMachineStatusCache();
  const down = { reachable: false, checkedAt: at(0).toISOString(), error: "ssh: connect to host athena port 22: Operation timed out", probeMs: 5, cpus: null, load1: null, memUsedBytes: null, memTotalBytes: null, gpus: [], ollama: { up: false, version: null, loaded: null, modelsError: null } };
  let clock = 0;
  const deps = { ayaHome, userHome, origin: "cli", probe: async () => down, confirmAdd: async () => true, now: () => at(clock) };
  await machines.handleMachinesRequest({ argv: ["add", "--ssh", "athena"] }, deps);
  clock = 3;
  await machines.checkHost({ ssh: "athena" }, deps);
  clock = 7;
  await machines.handleMachinesRequest({ argv: ["remove", "athena"] }, deps);
  const [h] = await loadSavedHosts(ayaHome);
  assert.equal(h.target, "athena");
  assert.equal(h.addedFrom, "cli");
  assert.deepEqual(h.lastCheck, { ok: false, at: at(3).toISOString(), why: down.error });
  assert.deepEqual((await readHostHistory(ayaHome)).map((e) => [e.event, e.machine ?? e.why ?? ""]), [
    ["added", "athena"],
    ["check-failed", down.error],
    ["removed", "athena"],
  ]);
  const [listed] = await machines.knownHosts(deps);
  assert.deepEqual(listed.sources, ["ssh-config", "saved"]);
  assert.equal(listed.machineId, undefined);
  assert.deepEqual(listed.history.map((e) => e.event), ["added", "check-failed", "removed"]);
  const text = (await machines.handleMachinesRequest({ argv: ["hosts"] }, deps)).output;
  assert.match(text, /^athena {2}ssh-config, saved\n/);
  assert.match(text, /\n {8}used by: nothing in Aya now\n/);
  assert.match(text, /\n {8}added .* from aya machines; last used .* \(Check\)\n/);
  assert.match(text, /\n {8}last Check .*: not reachable, ssh: connect to host athena port 22: Operation timed out\n/);
  assert.match(text, /\n {8}.* removed machine athena from aya machines\n$/);
  const json = JSON.parse((await machines.handleMachinesRequest({ argv: ["hosts", "--json"] }, deps)).output);
  assert.equal(json.hosts[0].saved.addedFrom, "cli");
  assert.equal(json.hosts[0].history.length, 3);
});

test("without an origin nothing is recorded (tests and callers that do not say where they come from)", async (t) => {
  const { ayaHome, userHome } = home(t);
  machines.clearMachineStatusCache();
  const up = { reachable: true, checkedAt: at(0).toISOString(), error: null, probeMs: 5, cpus: 1, load1: 0, memUsedBytes: 1, memTotalBytes: 2, gpus: [], ollama: { up: false, version: null, loaded: null, modelsError: null } };
  await machines.checkHost({ ssh: "me@box" }, { ayaHome, userHome, probe: async () => up });
  assert.equal(existsSync(join(ayaHome, SSH_HOSTS_FILE_NAME)), false);
});
