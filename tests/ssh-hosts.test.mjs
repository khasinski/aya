// The one store of known ssh hosts: ~/.ssh/config aliases + remote project targets + added machines, each with its sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mergeKnownHosts } = await import("../dist-electron/ssh-hosts.js");
const { knownHosts } = await import("../dist-electron/machines.js");

const none = { aliases: [], remoteProjects: [], machines: [] };
const rp = (sshTarget, name = "web") => ({ name, sshTarget });

const cases = [
  { name: "nothing known", input: none, expect: [] },
  {
    name: "aliases only, in config order",
    input: { ...none, aliases: ["athena", "mini"] },
    expect: [{ target: "athena", sources: ["ssh-config"] }, { target: "mini", sources: ["ssh-config"] }],
  },
  {
    name: "an alias also used by a remote project and added as a machine: one entry, three sources",
    input: { aliases: ["athena"], remoteProjects: [rp("athena")], machines: [{ id: "athena", ssh: "athena" }] },
    expect: [{ target: "athena", sources: ["ssh-config", "remote-project", "machine"], projects: ["web"], machineId: "athena" }],
  },
  {
    name: "user@host and the alias host stay two entries (the alias may set another user)",
    input: { ...none, aliases: ["devbox"], remoteProjects: [rp("me@devbox")] },
    expect: [{ target: "devbox", sources: ["ssh-config"] }, { target: "me@devbox", sources: ["remote-project"], projects: ["web"] }],
  },
  {
    name: "the same target in another case merges, the first spelling kept",
    input: { ...none, aliases: ["Athena"], machines: [{ id: "athena", ssh: "athena" }] },
    expect: [{ target: "Athena", sources: ["ssh-config", "machine"], machineId: "athena" }],
  },
  {
    name: "two remote projects on one host: one entry, both names, no duplicate name",
    input: { ...none, remoteProjects: [rp("me@devbox", "web"), rp("me@devbox", "api"), rp(" me@devbox ", "web")] },
    expect: [{ target: "me@devbox", sources: ["remote-project"], projects: ["web", "api"] }],
  },
  {
    name: "a machine only (added from user@host): listed with its id",
    input: { ...none, machines: [{ id: "gpu", ssh: "me@gpu" }] },
    expect: [{ target: "me@gpu", sources: ["machine"], machineId: "gpu" }],
  },
  {
    name: "sources sorted whatever order they arrive in",
    input: { aliases: ["x"], remoteProjects: [rp("x")], machines: [{ id: "x", ssh: "x" }] },
    expect: [{ target: "x", sources: ["ssh-config", "remote-project", "machine"], projects: ["web"], machineId: "x" }],
  },
  {
    name: "a remote project target ssh could not take is left out",
    input: { ...none, remoteProjects: [rp("-oProxyCommand=x"), rp("host -p 2222"), rp("")] },
    expect: [],
  },
];
for (const c of cases) {
  test(`mergeKnownHosts: ${c.name}`, () => {
    assert.deepEqual(mergeKnownHosts(c.input), c.expect);
  });
}

test("knownHosts reads the three sources: ~/.ssh/config (with Include), remote projects and machines.json", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aya-known-hosts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userHome = join(root, "home");
  const ayaHome = join(root, "aya");
  mkdirSync(join(userHome, ".ssh", "conf.d"), { recursive: true });
  mkdirSync(ayaHome, { recursive: true });
  writeFileSync(join(userHome, ".ssh", "config"), "Include conf.d/*\nHost athena mini *.lan\n");
  writeFileSync(join(userHome, ".ssh", "conf.d", "gpu"), "Host gpu-box\n");
  writeFileSync(
    join(ayaHome, "machines.json"),
    JSON.stringify({ version: 1, machines: [{ id: "athena", label: "athena", reach: { ssh: "athena" }, ollama: { port: 11434 } }, { id: "local", label: "local", reach: "local", ollama: { port: 11434 } }] }),
  );
  const hosts = await knownHosts({ ayaHome, userHome, listRemoteProjects: async () => [rp("me@devbox")] });
  assert.deepEqual(hosts, [
    { target: "gpu-box", sources: ["ssh-config"] },
    { target: "athena", sources: ["ssh-config", "machine"], machineId: "athena" },
    { target: "mini", sources: ["ssh-config"] },
    { target: "me@devbox", sources: ["remote-project"], projects: ["web"] },
  ]);
});

test("knownHosts: a failing project list leaves the other sources", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aya-known-hosts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".ssh"), { recursive: true });
  writeFileSync(join(root, ".ssh", "config"), "Host athena\n");
  const hosts = await knownHosts({ ayaHome: join(root, "aya"), userHome: root, listRemoteProjects: async () => { throw new Error("boom"); } });
  assert.deepEqual(hosts, [{ target: "athena", sources: ["ssh-config"] }]);
});
