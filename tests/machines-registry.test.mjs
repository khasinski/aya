// machines.json transactions: concurrent commands never lose an update, and a file Aya cannot read is never overwritten.

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
  const deps = { ayaHome: join(root, "aya"), userHome, confirmAdd: async () => true, probe: async () => ({ reachable: true }) };
  const file = join(deps.ayaHome, "machines.json");
  const run = (...argv) => handleMachinesRequest({ argv, tty: false, user: "u" }, deps);
  return { deps, file, run, ids: () => JSON.parse(readFileSync(file, "utf8")).machines.map((m) => m.id) };
}

test("six adds at once: all six are saved", async (t) => {
  const { run, ids } = setup(t);
  await Promise.all(["a1", "a2", "a3", "a4", "a5", "a6"].map((a) => run("add", "--ssh", a)));
  assert.deepEqual(ids().sort(), ["a1", "a2", "a3", "a4", "a5", "a6"]);
});

test("add, remove and occupy at once: the removed machine stays removed, the others keep their changes", async (t) => {
  const { run, ids, file } = setup(t);
  await run("add", "--ssh", "a1");
  await run("add", "--ssh", "a2");
  await Promise.all([run("remove", "a1"), run("add", "--ssh", "a3"), run("occupy", "a2", "timed run")]);
  assert.deepEqual(ids().sort(), ["a2", "a3"]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).machines.find((m) => m.id === "a2").occupancy.purpose, "timed run");
});

test("a file changed by someone else during a transaction is not overwritten", async (t) => {
  const { deps, file } = setup(t);
  mkdirSync(deps.ayaHome, { recursive: true });
  writeFileSync(file, '{"version":1,"machines":[]}\n');
  const theirs = '{"version":2,"machines":[],"leases":[]}\n';
  await assert.rejects(
    mutateRegistry(deps, async (registry) => {
      writeFileSync(file, theirs);
      registry.machines.push({ id: "x", label: "x", reach: "local", ollama: { port: 11434 } });
    }),
    /changed while this command ran; nothing was saved/,
  );
  assert.equal(readFileSync(file, "utf8"), theirs);
});

test("another process changing the registry during a transaction waits for it, and both changes are saved", async (t) => {
  const { deps, file, ids } = setup(t);
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const other = `
    const { mutateRegistry } = await import(${JSON.stringify(pathToFileURL(resolve("dist-electron/machines.js")).href)});
    console.log("started");
    await mutateRegistry(${JSON.stringify({ ayaHome: deps.ayaHome, userHome: deps.userHome })}, (r) => {
      r.machines.push({ id: "theirs", label: "theirs", reach: { ssh: "a2" }, ollama: { port: 11434 } });
    });
    console.log("saved");`;
  let child;
  const otherDone = new Promise((done) => {
    child = spawn(process.execPath, ["--input-type=module", "-e", other], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", (code) => done({ code, out }));
  });
  t.after(() => child.kill());
  await mutateRegistry(deps, async (registry) => {
    await new Promise((r) => child.stdout.once("data", r));
    // Long enough for the other process to read, change and try to write while this one holds the registry.
    await new Promise((r) => setTimeout(r, 500));
    registry.machines.push({ id: "mine", label: "mine", reach: "local", ollama: { port: 11434 } });
  });
  const result = await otherDone;
  assert.equal(result.code, 0);
  assert.match(result.out, /saved/);
  assert.deepEqual(ids(), ["mine", "theirs"]);
  assert.throws(() => readFileSync(`${file}.lock`), /ENOENT/, "the lock is gone after both");
});

test("a file replaced by someone else between the last check and the rename is not overwritten", async (t) => {
  const { deps, file } = setup(t);
  mkdirSync(deps.ayaHome, { recursive: true });
  writeFileSync(file, '{"version":1,"machines":[]}\n');
  const theirs = '{"version":2,"machines":[]}\n';
  deps.beforeCommit = async () => writeFileSync(file, theirs);
  await assert.rejects(
    mutateRegistry(deps, (registry) => {
      registry.machines.push({ id: "x", label: "x", reach: "local", ollama: { port: 11434 } });
    }),
    /changed while this command ran; nothing was saved/,
  );
  assert.equal(readFileSync(file, "utf8"), theirs);
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(deps.ayaHome).sort(), ["machines.json"], "no temp file or lock left behind");
});

const malformed = [
  { name: "machines is an object", text: '{"version":1,"machines":{"a":1}}', error: /machines is not a list/ },
  { name: "not JSON", text: "{oops", error: /not JSON/ },
  { name: "a machine without a reach", text: '{"version":1,"machines":[{"id":"a","label":"a","ollama":{"port":11434}}]}', error: /machine 1: reach/ },
  { name: "a bad port", text: '{"version":1,"machines":[{"id":"a","label":"a","reach":"local","ollama":{"port":0}}]}', error: /machine 1: ollama\.port/ },
  { name: "an alias that is an ssh option", text: '{"version":1,"machines":[{"id":"a","label":"a","reach":{"ssh":"-oProxyCommand=x"},"ollama":{"port":1}}]}', error: /machine 1: reach/ },
  { name: "two machines with one id", text: '{"version":1,"machines":[{"id":"a","label":"a","reach":"local","ollama":{"port":1}},{"id":"a","label":"a","reach":"local","ollama":{"port":2}}]}', error: /machine 2: id "a" is used twice/ },
  { name: "a newer version", text: '{"version":2,"machines":[]}', error: /has version 2, this Aya reads version 1/ },
];
for (const c of malformed) {
  for (const argv of [["add", "--ssh", "a1"], ["remove", "a"], ["occupy", "a", "x"], ["free", "a"]]) {
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
  { argv: ["add", "--ssh", "a1"], answer: true, drafted: ["a1"], saved: ["a1"] },
  { argv: ["add", "--ssh", "a1"], answer: false, drafted: ["a1"], saved: null, out: /Not added: cancelled in Aya/ },
  { argv: ["add", "a1 and this machine"], answer: true, drafted: ["a1", "local"], saved: ["a1", "local"] },
  { argv: ["add", "a1 and this machine"], answer: false, drafted: ["a1", "local"], saved: null, out: /Not added/ },
  { argv: ["add", "--local", "--id", "laptop"], answer: true, drafted: ["laptop"], saved: ["laptop"] },
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
  await assert.rejects(run("add", "--ssh", "a1"), /needs the user's yes in Aya/);
  assert.throws(() => readFileSync(file), /ENOENT/);
});

for (const target of ["203.0.113.10", "not-in-config", "user@a1"]) {
  test(`--ssh ${target}: not an alias in ~/.ssh/config, refused with the list, no dialog`, async (t) => {
    const { deps, file, run } = setup(t, ["a1", "a2"]);
    let asked = 0;
    deps.confirmAdd = async () => (asked++, true);
    await assert.rejects(run("add", "--ssh", target), /not a Host alias in ~\/\.ssh\/config.*a1, a2/);
    assert.equal(asked, 0);
    assert.throws(() => readFileSync(file), /ENOENT/);
  });
}

test("a machine added by someone else while the dialog was open is not added twice", async (t) => {
  const { deps, run, ids } = setup(t);
  deps.confirmAdd = async () => {
    await handleMachinesRequest({ argv: ["add", "--ssh", "a1"], tty: false }, { ...deps, confirmAdd: async () => true });
    return true;
  };
  await assert.rejects(run("add", "--ssh", "a1"), /already added/);
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
  const before = '{"version":1,"machines":[{"id":"a","label":"a","reach":"local","ollama":{"port":1}}]}\n';
  writeFileSync(file, before);
  await assert.rejects(
    mutateRegistry(deps, (registry) => {
      registry.machines.push({ id: "a", label: "a", reach: { ssh: "a1" }, ollama: { port: 2 } });
    }),
    /id "a" is used twice; nothing was saved/,
  );
  assert.equal(readFileSync(file, "utf8"), before);
});

test("Aya's dialog names each machine, what the probe found, and the pane that asked", async () => {
  const { addDialogText } = await import("../dist-electron/machines-dialog.js");
  const ok = { reachable: true, error: null, cpus: 32, gpus: [{ name: "RTX 4090" }], ollama: { up: true, version: "0.34.4", loaded: [{}] } };
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
  assert.match(text.detail, /athena {2}\(ssh athena, Ollama port 11434\)\n {2}connected, 32 CPUs, RTX 4090, Ollama 0\.34\.4, 1 model\(s\) loaded/);
  assert.match(text.detail, /mini {2}\(ssh mini, Ollama port 11435\)\n {2}unreachable: ssh: connect timeout/);
});
