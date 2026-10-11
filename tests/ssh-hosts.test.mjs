// The ssh hosts Aya knows for `aya machines hosts` and Settings > Machines: ~/.ssh/config and remote projects, merged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { knownHosts } = await import("../dist-electron/machines.js");

test("knownHosts: ~/.ssh/config (with Include) and remote projects, merged case-insensitively, the added ones named", async (t) => {
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
    JSON.stringify({ version: 1, machines: [{ id: "athena", reach: { ssh: "athena" }, ollama: { port: 11434 } }, { id: "local", reach: "local", ollama: { port: 11434 } }] }),
  );
  const projects = [{ name: "web", sshTarget: "me@devbox" }, { name: "api", sshTarget: "MINI" }, { name: "bad", sshTarget: "-oProxyCommand=x" }];
  const hosts = await knownHosts({ ayaHome, userHome, listRemoteProjects: async () => projects });
  assert.deepEqual(hosts, [
    { target: "gpu-box", sources: ["ssh config"] },
    { target: "athena", sources: ["ssh config"], machine: "athena" },
    { target: "mini", sources: ["ssh config", "remote project"] },
    { target: "me@devbox", sources: ["remote project"] },
  ]);
});

test("knownHosts: a failing project list leaves the other sources", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aya-known-hosts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".ssh"), { recursive: true });
  writeFileSync(join(root, ".ssh", "config"), "Host athena\n");
  const hosts = await knownHosts({ ayaHome: join(root, "aya"), userHome: root, listRemoteProjects: async () => { throw new Error("boom"); } });
  assert.deepEqual(hosts, [{ target: "athena", sources: ["ssh config"] }]);
});

test("an Include of a device or a huge file is skipped, the other hosts still listed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aya-ssh-include-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userHome = join(root, "home");
  mkdirSync(join(userHome, ".ssh"), { recursive: true });
  writeFileSync(join(userHome, ".ssh", "big"), `Host hidden\n${"#".repeat(1024 * 1024)}\n`);
  writeFileSync(join(userHome, ".ssh", "config"), "Include /dev/zero\nInclude big\nHost athena\n");
  const hosts = await knownHosts({ ayaHome: join(root, "aya"), userHome });
  assert.deepEqual(hosts.map((h) => h.target), ["athena"]);
});
