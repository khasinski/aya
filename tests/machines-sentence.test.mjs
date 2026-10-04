// aya machines add "<sentence>": deterministic matching against ~/.ssh/config aliases; an ambiguous word is asked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { draftFromSentence, sshHostAliases } = await import("../dist-electron/machines.js");

const ALIASES = ["athena", "Mini", "gpu-2.lan"];
const empty = { version: 1, machines: [] };
const withAthena = { version: 1, machines: [{ id: "athena", label: "athena", reach: { ssh: "athena" }, ollama: { port: 11434 } }] };
const withLocal = { version: 1, machines: [{ id: "laptop", label: "laptop", reach: "local", ollama: { port: 11434 } }] };

const cases = [
  { sentence: "athena is my 4090 box over ssh", expect: { machines: [{ id: "athena", reach: { ssh: "athena" }, port: 11434 }] } },
  { sentence: "athena, ollama on port 11435", expect: { machines: [{ id: "athena", reach: { ssh: "athena" }, port: 11435 }] } },
  { sentence: "MINI and gpu-2.lan.", expect: { machines: [{ id: "mini", reach: { ssh: "Mini" }, port: 11434 }, { id: "gpu-2-lan", reach: { ssh: "gpu-2.lan" }, port: 11434 }] } },
  { sentence: "this machine", expect: { machines: [{ id: "local", reach: "local", port: 11434 }] } },
  { sentence: "local", expect: { machines: [{ id: "local", reach: "local", port: 11434 }] } },
  { sentence: "the laptop", expect: { machines: [], unclear: ["laptop"] } },
  { sentence: "my mac and the desktop", expect: { machines: [], unclear: ["mac", "desktop"] } },
  { sentence: "athena and this machine is the laptop", expect: { machines: [{ reach: { ssh: "athena" } }, { reach: "local" }], unclear: ["laptop"] } },
  { sentence: "zeus is the big box over ssh", expect: { machines: [], unknown: ["zeus"] } },
  { sentence: "use ssh hermes", expect: { machines: [], unknown: ["hermes"] } },
  { sentence: "it is a box", expect: { machines: [], unknown: [] } },
  { sentence: "athena", registry: withAthena, expect: { machines: [], alreadyAdded: ["athena"] } },
  { sentence: "this machine", registry: withLocal, expect: { machines: [], alreadyAdded: ["this machine"] } },
  { sentence: "athena athena", expect: { machines: [{ reach: { ssh: "athena" } }] } },
  { sentence: "port 99 athena", expect: { machines: [{ port: 11434 }] } },
];

for (const c of cases) {
  test(`sentence draft: "${c.sentence}"`, () => {
    const draft = draftFromSentence(c.sentence, ALIASES, c.registry ?? empty);
    assert.equal(draft.machines.length, c.expect.machines.length, JSON.stringify(draft));
    c.expect.machines.forEach((m, i) => {
      for (const [k, v] of Object.entries(m)) assert.deepEqual(draft.machines[i][k], v, `machines[${i}].${k}`);
    });
    assert.deepEqual(draft.unclear, c.expect.unclear ?? []);
    assert.deepEqual(draft.unknown, c.expect.unknown ?? []);
    assert.deepEqual(draft.alreadyAdded, c.expect.alreadyAdded ?? []);
  });
}

test("ssh config aliases: Include followed (relative, ~ and glob), wildcards and negations skipped, cycles stop", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aya-sshcfg-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ssh = join(home, ".ssh");
  mkdirSync(join(ssh, "conf.d"), { recursive: true });
  writeFileSync(join(ssh, "config"), [
    "Include conf.d/*.conf",
    "Host athena",
    "  HostName 10.0.0.5",
    "Host *.internal !bad web1 web2 # trailing comment",
    "Host=eqform",
    "Match host foo",
    "  Include ~/.ssh/extra",
    "Include config",
  ].join("\n"));
  writeFileSync(join(ssh, "conf.d", "a.conf"), "Host fromglob\n");
  writeFileSync(join(ssh, "conf.d", "b.txt"), "Host notincluded\n");
  writeFileSync(join(ssh, "extra"), "host \"quoted\"\n");
  assert.deepEqual(await sshHostAliases(home), ["fromglob", "athena", "web1", "web2", "eqform", "quoted"]);
});

test("no ~/.ssh/config: no aliases, no error", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aya-sshcfg-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(await sshHostAliases(home), []);
});
