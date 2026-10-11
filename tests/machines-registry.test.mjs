// machines.json: concurrent commands never lose an update, a file Aya cannot read is never overwritten, and only Aya's dialog adds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { handleMachinesRequest, mutateRegistry } = await import("../dist-electron/machines.js");

function setup(t, aliases = ["a1", "a2", "a3", "a4", "a5", "a6"]) {
  const root = mkdtempSync(join(tmpdir(), "aya-mreg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userHome = join(root, "home");
  mkdirSync(join(userHome, ".ssh"), { recursive: true });
  writeFileSync(join(userHome, ".ssh", "config"), aliases.map((a) => `Host ${a}\n`).join(""));
  const deps = { ayaHome: join(root, "aya"), userHome, confirmAdd: async () => true, confirmRemove: async () => true, probe: async () => ({ reachable: true }) };
  const file = join(deps.ayaHome, "machines.json");
  const run = (...argv) => handleMachinesRequest({ argv, user: "u" }, deps);
  return { deps, file, run, ids: () => JSON.parse(readFileSync(file, "utf8")).machines.map((m) => m.id) };
}

test("six adds at once: all six are saved", async (t) => {
  const { run, ids } = setup(t);
  await Promise.all(["a1", "a2", "a3", "a4", "a5", "a6"].map((a) => run("add", a)));
  assert.deepEqual(ids().sort(), ["a1", "a2", "a3", "a4", "a5", "a6"]);
});

test("add, remove and claim at once: the removed machine stays removed, the others keep their changes", async (t) => {
  const { run, ids, file } = setup(t);
  await run("add", "a1");
  await run("add", "a2");
  await Promise.all([run("remove", "a1"), run("add", "a3"), run("claim", "a2", "timed run")]);
  assert.deepEqual(ids().sort(), ["a2", "a3"]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).machines.find((m) => m.id === "a2").claim.purpose, "timed run");
});

const malformed = [
  { name: "machines is an object", text: '{"version":1,"machines":{"a":1}}', error: /machines is not a list/ },
  { name: "not JSON", text: "{oops", error: /not JSON/ },
  { name: "a machine without a reach", text: '{"version":1,"machines":[{"id":"a","ollama":{"port":11434}}]}', error: /machine 1: reach/ },
  { name: "a bad port", text: '{"version":1,"machines":[{"id":"a","reach":"local","ollama":{"port":0}}]}', error: /machine 1: ollama\.port/ },
  { name: "an alias that is an ssh option", text: '{"version":1,"machines":[{"id":"a","reach":{"ssh":"-oProxyCommand=x"},"ollama":{"port":1}}]}', error: /machine 1: reach/ },
  { name: "two machines with one id", text: '{"version":1,"machines":[{"id":"a","reach":"local","ollama":{"port":1}},{"id":"a","reach":"local","ollama":{"port":2}}]}', error: /machine 2: id "a" is used twice/ },
  { name: "a newer version", text: '{"version":2,"machines":[]}', error: /has version 2, this Aya reads version 1/ },
];
for (const c of malformed) {
  for (const argv of [["add", "a1"], ["remove", "a"], ["claim", "a", "x"], ["release", "a"]]) {
    test(`a registry with ${c.name}: ${argv[0]} is refused and the file is left as it is`, async (t) => {
      const { deps, file, run } = setup(t);
      mkdirSync(deps.ayaHome, { recursive: true });
      writeFileSync(file, c.text);
      await assert.rejects(run(...argv), c.error);
      assert.equal(readFileSync(file, "utf8"), c.text);
    });
  }
}

// Registration is the user's: every add waits for Aya's own dialog, never for the CLI caller.
const confirmCases = [
  { argv: ["add", "a1"], answer: true, drafted: ["a1"], saved: ["a1"] },
  { argv: ["add", "a1"], answer: false, drafted: ["a1"], saved: null, out: /Not added: cancelled in Aya/ },
  { argv: ["add", "a1 and this machine"], answer: true, drafted: ["a1", "local"], saved: ["a1", "local"] },
  { argv: ["add", "a1 and this machine"], answer: false, drafted: ["a1", "local"], saved: null, out: /Not added/ },
  { argv: ["add", "local"], answer: true, drafted: ["local"], saved: ["local"] },
];
for (const c of confirmCases) {
  test(`${c.argv.join(" ")}: the dialog says ${c.answer ? "Add" : "Cancel"}`, async (t) => {
    const { deps, file, run, ids } = setup(t);
    const asked = [];
    deps.confirmAdd = async (ask) => {
      asked.push(ask);
      return c.answer;
    };
    deps.probe = async (reach) => ({ reachable: reach === "local", error: reach === "local" ? null : "ssh: down" });
    const answer = await run(...c.argv);
    assert.equal(asked.length, 1, "asked once, in Aya");
    assert.deepEqual(asked[0].machines.map((m) => m.id), c.drafted, "the dialog shows exactly the drafted machines");
    assert.ok(asked[0].machines.every((m) => m.status && typeof m.status.reachable === "boolean"), "the dialog shows each probe");
    if (c.saved) assert.deepEqual(ids(), c.saved);
    else assert.throws(() => readFileSync(file), /ENOENT/);
    if (c.out) assert.match(answer.output, c.out);
    assert.equal(answer.confirm, undefined, "the CLI caller is never asked");
  });
}

test("without Aya's dialog (no confirmAdd) an add is refused and nothing is saved", async (t) => {
  const { deps, file, run } = setup(t);
  delete deps.confirmAdd;
  await assert.rejects(run("add", "a1"), /needs the user's yes in Aya/);
  assert.throws(() => readFileSync(file), /ENOENT/);
});

// A bare unknown name is likely a typo; user@host names its user and host, as a remote project's target does.
for (const target of ["203.0.113.10", "not-in-config", "@a1", "user@-a1"]) {
  test(`add "${target}": not a known host, nothing drafted, no dialog`, async (t) => {
    const { deps, file, run } = setup(t, ["a1", "a2"]);
    let asked = 0;
    deps.confirmAdd = async () => (asked++, true);
    const answer = await run("add", target);
    assert.match(answer.output, /^Nothing to add from that sentence\./);
    assert.equal(asked, 0);
    assert.throws(() => readFileSync(file), /ENOENT/);
  });
}

// One-sentence UX: options are refused with a pointer to the sentence, before the registry, a probe or the dialog.
const optionForms = [["add", "--ssh", "a1"], ["add", "--local"], ["add", "--ssh"], ["add", "--local", "--id", "laptop"], ["add", "a1", "--port", "1"], ["add", "--"]];
for (const argv of optionForms) {
  test(`${argv.join(" ")}: refused with the sentence form, nothing probed, asked or saved`, async (t) => {
    const { deps, file, run } = setup(t, ["a1", "a2"]);
    let asked = 0;
    let probed = 0;
    deps.confirmAdd = async () => (asked++, true);
    deps.probe = async () => (probed++, { reachable: true });
    await assert.rejects(run(...argv), /^Error: aya machines add takes one sentence, not options: for example aya machines add "athena", or "this machine, port 11435"; nothing was added$/);
    assert.deepEqual([asked, probed], [0, 0]);
    assert.throws(() => readFileSync(file), /ENOENT/);
  });
}

// Hosts a remote project reaches are known too: a bare name is taken once a remote project uses it.
const acceptedTargets = [
  { target: "user@a1", remote: [], reach: { ssh: "user@a1" }, id: "a1" },
  { target: "devbox", remote: [{ name: "web", sshTarget: "devbox" }], reach: { ssh: "devbox" }, id: "devbox" },
  { target: "me@devbox", remote: [{ name: "web", sshTarget: "me@devbox" }], reach: { ssh: "me@devbox" }, id: "devbox" },
  { target: "A1", remote: [], reach: { ssh: "a1" }, id: "a1" },
];
for (const c of acceptedTargets) {
  test(`add "${c.target}" with remote projects ${JSON.stringify(c.remote)}: asked in Aya, saved as ${JSON.stringify(c.reach)}`, async (t) => {
    const { deps, file, run } = setup(t, ["a1", "a2"]);
    deps.listRemoteProjects = async () => c.remote;
    let asked = 0;
    deps.confirmAdd = async () => (asked++, true);
    await run("add", c.target);
    assert.equal(asked, 1);
    const [m] = JSON.parse(readFileSync(file, "utf8")).machines;
    assert.deepEqual([m.id, m.reach], [c.id, c.reach]);
  });
}

test("a machine added by someone else while the dialog was open is not added twice", async (t) => {
  const { deps, run, ids } = setup(t);
  deps.confirmAdd = async () => {
    await handleMachinesRequest({ argv: ["add", "a1"] }, { ...deps, confirmAdd: async () => true });
    return true;
  };
  await assert.rejects(run("add", "a1"), /already added/);
  assert.deepEqual(ids(), ["a1"]);
});

test("aliases a.b and a_b in one sentence: saved as a-b and a-b-2, and the registry still reads", async (t) => {
  const { run, ids } = setup(t, ["a.b", "a_b"]);
  await run("add", "a.b and a_b");
  assert.deepEqual(ids(), ["a-b", "a-b-2"]);
  assert.match((await run("remove", "a-b-2")).output, /removed a-b-2/);
  assert.deepEqual(ids(), ["a-b"]);
});

test("a change that would leave two machines with one id is refused and the file is left as it is", async (t) => {
  const { deps, file } = setup(t);
  mkdirSync(deps.ayaHome, { recursive: true });
  const before = '{"version":1,"machines":[{"id":"a","reach":"local","ollama":{"port":1}}]}\n';
  writeFileSync(file, before);
  await assert.rejects(
    mutateRegistry(deps, (registry) => {
      registry.machines.push({ id: "a", reach: { ssh: "a1" }, ollama: { port: 2 } });
    }),
    /id "a" is used twice; nothing was saved/,
  );
  assert.equal(readFileSync(file, "utf8"), before);
});

test("Aya's dialog names each machine, what the probe found, and the pane that asked", async () => {
  const { addDialogText } = await import("../dist-electron/machines-dialog.js");
  const ok = { reachable: true, error: null, cpus: 32, gpus: [{ name: "RTX 4090" }], ollama: { up: true, version: "0.34.4", loaded: [{}] } };
  const mac = { reachable: true, error: null, cpuName: "Apple M2 Max", cpus: 12, gpus: [], ollama: { up: false, loaded: null } };
  const down = { reachable: false, error: "ssh: connect timeout", gpus: [], ollama: { up: false, loaded: null } };
  const text = addDialogText({
    pane: "collector",
    machines: [
      { id: "athena", reach: { ssh: "athena" }, port: 11434, status: ok },
      { id: "mini", reach: { ssh: "mini" }, port: 11435, status: down },
    ],
  });
  assert.equal(text.message, "Add 2 machines to Aya's machines?");
  assert.match(text.detail, /^Asked by pane "collector"\. Aya will only read their state over ssh; it never loads or unloads a model\./);
  const local = addDialogText({ machines: [{ id: "local", reach: "local", port: 11434, status: mac }] });
  assert.match(local.detail, /^Aya will only read its state; it never loads or unloads a model\./);
  assert.match(local.detail, /connected, 12 CPUs, Apple M2 Max, Ollama not answering/);
  const one = addDialogText({ machines: [{ id: "athena", reach: { ssh: "athena" }, port: 11434, status: ok }] });
  assert.match(one.detail, /^Aya will only read its state over ssh;/);
  assert.match(text.detail, /athena {2}\(ssh athena, Ollama port 11434\)\n {2}connected, 32 CPUs, RTX 4090, Ollama 0\.34\.4, 1 model\(s\) loaded/);
  assert.match(text.detail, /mini {2}\(ssh mini, Ollama port 11435\)\n {2}unreachable: ssh: connect timeout/);
});

test("remove asks in Aya: Cancel keeps the machine, no dialog refuses, Remove takes it out", async (t) => {
  const { deps, run } = await setup(t);
  await run("add", "a1");
  const asked = [];
  deps.confirmRemove = async (id) => (asked.push(id), false);
  assert.match((await run("remove", "a1")).output, /^Not removed: cancelled in Aya\./);
  assert.deepEqual(asked, ["a1"]);
  delete deps.confirmRemove;
  await assert.rejects(run("remove", "a1"), /needs the user's yes in Aya/);
  deps.confirmRemove = async () => true;
  assert.match((await run("remove", "a1")).output, /^removed a1/);
  await assert.rejects(run("remove", "a1"), /no machine "a1"/);
});

test("a machine replaced under the same id while Aya asks is not removed", async (t) => {
  const { deps, run, ids } = await setup(t);
  await run("add", "a1");
  deps.confirmRemove = async () => {
    await mutateRegistry(deps, (registry) => {
      registry.machines = [{ id: "a1", reach: { ssh: "a2" }, ollama: { port: 11434 } }];
    });
    return true;
  };
  await assert.rejects(run("remove", "a1"), /a1 changed while Aya asked; nothing was removed/);
  assert.deepEqual(ids(), ["a1"]);
});

// Claims: advisory, but never silently taken from someone else.
test("claim: refused while someone else holds it, kept for its holder, taken over only with --replace", async (t) => {
  const { deps, file, run } = setup(t);
  await run("add", "a1");
  const asPane = (pane, ...argv) => handleMachinesRequest({ argv, user: "u" }, deps, pane);
  assert.match((await asPane("lead", "claim", "a1", "run5", "timed")).output, /^a1 claimed: run5 timed\. Advisory: nothing is blocked\./);
  await assert.rejects(asPane("reviewer", "claim", "a1", "review pass"), /a1 is claimed by u \(pane "lead"\) since \d\d:\d\d: run5 timed\. Not changed; ask the user, or add --replace/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).machines[0].claim.pane, "lead");
  assert.match((await asPane("lead", "claim", "a1", "run6")).output, /^a1 claimed: run6\. /, "its holder may change it");
  assert.match((await asPane("reviewer", "claim", "a1", "--replace", "review pass")).output, /took it over from u \(pane "lead"\): run6/);
  assert.match((await asPane("lead", "release", "a1")).output, /^a1 released \(was: review pass, by u \(pane "reviewer"\)\)/);
  assert.match((await run("release", "a1")).output, /^a1 was not claimed/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).machines[0].claim, undefined);
  await assert.rejects(run("claim", "a1"), /say what it is for/);
  await assert.rejects(run("claim", "a1", "x".repeat(201)), /the most is 200/);
});
