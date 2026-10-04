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
