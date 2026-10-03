// Codex's shared app-server daemon (0.159.2) runs every pane's commands with the env of the pane that
// STARTED it, in the same project too, so a pane id is proven by the caller's process ancestry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rpc } from "./helpers/control-rpc.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { startControlServerOn } = await import("../dist-electron/control.js");
const { MAX_DEPTH, PS_TABLE_MAX_BUFFER_BYTES, TABLE_SHARE_MS, paneAbove, parseProcesses, processTable, readProcessTable, unprovenIdentity } = await import(
  "../dist-electron/caller-proof.js"
);
const { parseControlCaller } = await import("../dist-electron/control-protocol.js");

// pane-a: 100 > 150 > 160 (aya). pane-b: 200 > 250 > 260. The daemon a started: 900 (parent 1) > 910.
const table = (parents, commands = {}) => new Map([...parents].map(([pid, ppid]) => [pid, { ppid, command: commands[pid] ?? "sh" }]));
// A TUI `codex` typed in pane-a (300) forks the shared daemon as its CHILD (320, measured
// on 0.159.2), so what the daemon runs for any pane sits under pane-a: 330 > 340 (aya).
// A hand-started `codex app-server &` in pane-a's shell (350) does the same (360 > 370).
const PARENTS = table(
  [[100, 1], [150, 100], [160, 150], [200, 1], [250, 200], [260, 250], [900, 1], [910, 900], [1, 0],
    [300, 100], [310, 300], [320, 310], [330, 320], [340, 330], [350, 100], [360, 350], [370, 360],
    [400, 300], [410, 400], [420, 410], [500, 100], [510, 500], [520, 510], [600, 100], [610, 600], [620, 610],
    [700, 100], [710, 700], [720, 100], [730, 720], [740, 100], [750, 740], [800, 1], [810, 800], [820, 810]],
  {
    300: "node /usr/local/bin/codex --no-alt-screen",
    310: "/opt/codex/vendor/bin/codex",
    320: "/opt/codex/vendor/bin/codex app-server --listen unix:// --managed-daemon",
    350: "codex app-server",
    400: "/opt/codex/vendor/bin/codex",
    500: "node /home/me/My Tools/bin/codex app-server --listen stdio://",
    600: "node /srv/app-server.js",
    710: "node - /tmp/s.sock team-send reviewer codex app-server reproduced",
    720: "zsh -c aya team send reviewer codex app-server reproduced",
    730: "node - /tmp/s.sock team-send reviewer hi",
    740: "codex --remote ws://host:1 app-server",
    800: "codex app-server --listen unix://",
  },
);
const PANE_PIDS = { "pane-a": 100, "pane-b": 200, "pane-c": 800 };
const DIR = "/proj";
const PROJECTS = [
  { slug: "p", name: "p", directory: DIR, tabs: [{ id: "pane-a", presetId: "codex", name: "a" }, { id: "pane-b", presetId: "codex", name: "b" }, { id: "pane-c", presetId: "codex", name: "c" }] },
];

const ACTIONS = [
  { type: "team-whoami" },
  { type: "team-inbox" },
  { type: "team-send", role: "reviewer", text: "hi" },
  { type: "team-pause", text: "borrowed" },
];

const UNPROVEN = /cannot be proven/;

// [name, caller, refusal pattern or null]. Two panes of ONE project: the cwd is always inside it.
const CELLS = [
  ["A's own process", { terminalId: "pane-a", pid: 160 }, null],
  ["B's own process", { terminalId: "pane-b", pid: 260 }, null],
  ["a command run by the daemon A started (A's id, B's or A's own request)", { terminalId: "pane-a", pid: 910 }, UNPROVEN],
  ["A's id typed in B's process tree", { terminalId: "pane-a", pid: 260 }, UNPROVEN],
  ["the pane's own root process", { terminalId: "pane-b", pid: 200 }, null],
  ["an older CLI sends no pid", { terminalId: "pane-a" }, null],
  ["a pid the process table does not know", { terminalId: "pane-a", pid: 4242 }, null],
  ["no pane id (outside Aya)", { pid: 910 }, null],
  ["a command the daemon pane-a's TUI started runs (TUI alive, pane-a's id)", { terminalId: "pane-a", pid: 340 }, UNPROVEN],
  ["the same command reaching for pane-b's id", { terminalId: "pane-b", pid: 340 }, UNPROVEN],
  ["a command of a `codex app-server &` typed in pane-a's shell", { terminalId: "pane-a", pid: 370 }, UNPROVEN],
  ["a command of a node-wrapped app-server under a path with spaces", { terminalId: "pane-a", pid: 520 }, UNPROVEN],
  ["a plain tool subprocess of the Codex TUI (no daemon)", { terminalId: "pane-a", pid: 420 }, null],
  ["a process under pane-a merely named like app-server.js", { terminalId: "pane-a", pid: 620 }, null],
  ["the aya CLI is the caller: only its ancestors are judged, never its own argv", { terminalId: "pane-a", pid: 320 }, null],
  ["aya whose own argv carries the words `codex app-server` (a message), run by the pane's shell", { terminalId: "pane-a", pid: 710 }, null],
  ["aya run by a shell whose -c text mentions `codex app-server`", { terminalId: "pane-a", pid: 730 }, null],
  ["a daemon started with a value option (--remote) before app-server", { terminalId: "pane-a", pid: 750 }, UNPROVEN],
  ["a command under a pane whose root process IS `exec codex app-server`", { terminalId: "pane-c", pid: 820 }, UNPROVEN],
];

async function withServer(options, body) {
  const sockDir = mkdtempSync(join(tmpdir(), "aya-proof-"));
  const socket = join(sockDir, "aya.sock");
  const stop = startControlServerOn(socket, { getWindow: () => null, openProject: () => {}, listProjects: async () => PROJECTS, ...options });
  try {
    return await body(socket);
  } finally {
    stop();
    rmSync(sockDir, { recursive: true, force: true });
  }
}

const proof = (overrides = {}) => ({
  panePid: async (id) => PANE_PIDS[id] ?? null,
  processTable: async () => PARENTS,
  ...overrides,
});

for (const [name, caller, refusal] of CELLS) {
  for (const action of ACTIONS) {
    test(`${action.type}: ${name} -> ${refusal ? "refused" : "allowed"}`, async () => {
      await withServer(proof(), async (socket) => {
        const reply = await rpc(socket, { ...action, caller: { ...caller, cwd: DIR } });
        if (refusal) assert.match(reply.error ?? "", refusal);
        else assert.doesNotMatch(reply.error ?? "", UNPROVEN);
      });
    });
  }
}

// What the refusal advises depends on what was found: Codex advice only for a Codex app-server ancestor.
const DAEMON_ADVICE = /Codex daemon|--no-daemon/;
const REFUSAL_TEXTS = [
  ["an ancestor that is a Codex app-server", { terminalId: "pane-a", pid: 340 }, DAEMON_ADVICE, null],
  ["a plain shell of another pane", { terminalId: "pane-a", pid: 260 }, /did not run under this pane's process/, DAEMON_ADVICE],
  ["a process outside every pane", { terminalId: "pane-a", pid: 910 }, /did not run under this pane's process/, DAEMON_ADVICE],
];
for (const [name, caller, names, never] of REFUSAL_TEXTS) {
  test(`the refusal for ${name} names the pane and advice that fits`, async () => {
    await withServer(proof(), async (socket) => {
      const reply = await rpc(socket, { type: "team-whoami", caller: { ...caller, cwd: DIR } });
      assert.match(reply.error, UNPROVEN);
      assert.match(reply.error, new RegExp(caller.terminalId));
      assert.match(reply.error, names);
      if (never) assert.doesNotMatch(reply.error, never);
    });
  });
}

test("a refusal for a job left running says so, whatever else it says", async () => {
  await withServer(proof(), async (socket) => {
    const reply = await rpc(socket, { type: "team-whoami", caller: { terminalId: "pane-a", pid: 910, cwd: DIR } });
    assert.match(reply.error, /job left running after its tool finished/);
  });
});

// The host answers null for a pane it has no process for; undefined when it cannot answer.
const NOT_RUNNING = /pane-a is not running; the command comes from a leftover daemon or job/;
const REMOTE = [{ slug: "r", name: "r", directory: DIR, tabs: [{ id: "pane-r", presetId: "codex", name: "r" }], remote: { hostId: "h", label: "h", sshTarget: "h", directory: "/srv" } }];

// [name, options, caller, refusal pattern or null]
const NOT_RUNNING_CELLS = [
  ["the tab exists, the host has no process for it, the caller has a pid", {}, { terminalId: "pane-a", pid: 910 }, NOT_RUNNING],
  ["the same for a command in pane-a's own old tree", {}, { terminalId: "pane-a", pid: 160 }, NOT_RUNNING],
  ["an older CLI sends no pid", {}, { terminalId: "pane-a" }, null],
  ["the caller's pid is not in the process table", {}, { terminalId: "pane-a", pid: 4242 }, null],
  ["the process table is unreadable", { processTable: async () => null }, { terminalId: "pane-a", pid: 910 }, null],
  ["the host cannot answer (older host)", { panePid: async () => undefined }, { terminalId: "pane-a", pid: 910 }, null],
  ["no project has a tab with that id", { panePid: async () => null }, { terminalId: "gone-1", pid: 910 }, null],
  ["a remote project's tab", { listProjects: async () => REMOTE, panePid: async () => null }, { terminalId: "pane-r", pid: 910 }, null],
];

for (const [name, options, caller, refusal] of NOT_RUNNING_CELLS) {
  for (const action of ACTIONS) {
    test(`pane not running, ${action.type}: ${name} -> ${refusal ? "refused" : "allowed"}`, async () => {
      await withServer(proof({ panePid: async () => null, ...options }), async (socket) => {
        const reply = await rpc(socket, { ...action, caller: { ...caller, cwd: DIR } });
        if (refusal) assert.match(reply.error ?? "", refusal);
        else assert.doesNotMatch(reply.error ?? "", /cannot be proven|is not running/);
      });
    });
  }
}

test("requests that do not speak as a role are not checked", async () => {
  await withServer(proof(), async (socket) => {
    for (const request of [{ type: "capabilities" }, { type: "pane-list" }, { type: "status", level: "active", text: "x" }, { type: "team-start", team: "t" }]) {
      const reply = await rpc(socket, { ...request, caller: { terminalId: "pane-a", pid: 910, cwd: DIR } });
      assert.doesNotMatch(reply.error ?? "", /cannot be proven/, request.type);
    }
  });
});

test("nothing is refused when the host cannot name the pane's process or the process table is unavailable, and nothing breaks", async () => {
  const caller = { terminalId: "pane-a", pid: 910, cwd: DIR };
  const answer = (options) => withServer(options, async (socket) => (await rpc(socket, { type: "team-whoami", caller })).error);
  const unchecked = await answer({});
  assert.doesNotMatch(unchecked ?? "", /cannot be proven/);
  for (const options of [proof({ panePid: async () => undefined }), proof({ processTable: async () => null })]) {
    assert.equal(await answer(options), unchecked);
  }
});

test("the process table is not read when the host cannot name the pane's process", async () => {
  let reads = 0;
  await withServer(proof({ panePid: async () => undefined, processTable: async () => (reads++, PARENTS) }), async (socket) => {
    await rpc(socket, { type: "team-whoami", caller: { terminalId: "pane-a", pid: 910, cwd: DIR } });
    assert.equal(reads, 0);
  });
});

test("only a positive integer pid is taken from the caller", () => {
  const pid = (value) => parseControlCaller({ caller: { terminalId: "x", pid: value } }).pid;
  assert.equal(pid(160), 160);
  for (const bad of [0, -3, 1.5, "160", null, undefined, NaN]) assert.equal(pid(bad), undefined, String(bad));
});

test("a deep process tree under the pane is still the pane's", () => {
  const chain = table([[1, 0], [100, 1]]);
  for (let pid = 101; pid < 140; pid += 1) chain.set(pid, { ppid: pid - 1, command: "sh" });
  assert.equal(unprovenIdentity({ terminalId: "x", pid: 139 }, 100, chain), null);
  assert.match(unprovenIdentity({ terminalId: "x", pid: 139 }, 5000, chain) ?? "", /cannot be proven/);
});

test("the process table is read once per checked request, and not at all for an unchecked one", async () => {
  let reads = 0;
  const options = proof({ processTable: async () => (reads++, PARENTS) });
  await withServer(options, async (socket) => {
    await rpc(socket, { type: "pane-list", caller: { terminalId: "pane-a", pid: 160, cwd: DIR } });
    await rpc(socket, { type: "team-whoami", caller: { terminalId: "pane-a", cwd: DIR } });
    assert.equal(reads, 0);
    await rpc(socket, { type: "team-whoami", caller: { terminalId: "pane-a", pid: 160, cwd: DIR } });
    assert.equal(reads, 1);
  });
});

test("parseProcesses reads ps pid/ppid/command lines and skips junk", () => {
  const parsed = parseProcesses("  1     0 /sbin/launchd\n 100   1 sh -c aya  team  \nnot a line\n 150 100 x\n");
  assert.deepEqual([...parsed], [[1, { ppid: 0, command: "/sbin/launchd" }], [100, { ppid: 1, command: "sh -c aya  team" }], [150, { ppid: 100, command: "x" }]]);
});

test("the walk up the tree stops below init: launchd is no pane's process", () => {
  assert.equal(paneAbove(160, PARENTS, new Map([[1, "pane-x"]])), null);
  assert.equal(paneAbove(160, PARENTS, new Map([[100, "pane-a"]])), "pane-a");
});

test("unprovenIdentity: a parent loop ends the walk instead of hanging", () => {
  const loop = table([[5, 6], [6, 5]]);
  assert.match(unprovenIdentity({ terminalId: "x", pid: 5 }, 100, loop) ?? "", /cannot be proven/);
});

test("the process table is what ps prints, and unknown when ps fails", async () => {
  const bin = mkdtempSync(join(tmpdir(), "aya-ps-"));
  const fakePs = (script) => writeFileSync(join(bin, "ps"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    fakePs('printf "  1     0 init\\n 100     1 sh -c x\\n"');
    assert.deepEqual([...(await readProcessTable())], [[1, { ppid: 0, command: "init" }], [100, { ppid: 1, command: "sh -c x" }]]);
    fakePs('printf "  1     0 init\\n 100     1 sh\\n"; exit 1');
    assert.equal(await readProcessTable(), null);
    fakePs("exit 0");
    assert.equal(await readProcessTable(), null);
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

// A fake `ps` on PATH that counts its runs and prints whatever `body` says.
async function withFakePs(body, run) {
  const bin = mkdtempSync(join(tmpdir(), "aya-ps-"));
  const count = join(bin, "count");
  // `ps -o ppid= -p N` (the one-pid probe) answers 1 and is not counted as a table read
  const write = (text) => writeFileSync(join(bin, "ps"), `#!/bin/sh\ncase "$*" in *-p*) echo 1; exit 0;; esac\necho x >> "${count}"\nprintf '${text}'\n`, { mode: 0o755 });
  const runs = () => (existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  await new Promise((r) => setTimeout(r, TABLE_SHARE_MS + 50)); // let an earlier test's cached read expire
  try {
    write(body);
    return await run({ write, runs });
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
}

const PS_100 = "  1     0 init\\n 100     1 sh\\n";

test("a burst of checks for one pid shares a single ps read", async () => {
  await withFakePs(PS_100, async ({ runs }) => {
    const tables = await Promise.all(Array.from({ length: 20 }, () => processTable(100)));
    assert.equal(runs(), 1);
    assert.ok(tables.every((t) => t.get(100)?.ppid === 1));
  });
});

test("a pid that appeared after the cached read is found by reading again", async () => {
  await withFakePs(PS_100, async ({ write, runs }) => {
    await processTable(100);
    write(`${PS_100}  777     1 sh\\n`);
    const table = await processTable(777);
    assert.equal(table.get(777)?.ppid, 1);
    assert.equal(runs(), 2);
  });
});

test("the cached table expires, and a failed read is not cached as an answer", async () => {
  await withFakePs(PS_100, async ({ write, runs }) => {
    await processTable(100);
    await processTable(100);
    assert.equal(runs(), 1);
    await new Promise((r) => setTimeout(r, TABLE_SHARE_MS + 50));
    await processTable(100);
    assert.equal(runs(), 2);
    write("");
    assert.equal(await processTable(555), null);
    write(PS_100);
    assert.equal((await processTable(100)).get(100)?.ppid, 1);
    assert.equal(runs(), 4);
  });
});

test("unprovenIdentity: a chain that breaks at a parent the table lacks is refused, not thrown", () => {
  const broken = table([[1, 0], [100, 1], [500, 4999]]);
  assert.match(unprovenIdentity({ terminalId: "x", pid: 500 }, 100, broken) ?? "", UNPROVEN);
});

test("unprovenIdentity: only a process whose argv is exactly `codex app-server` counts as the daemon", () => {
  const under = (command) => {
    const t = table([[1, 0], [100, 1], [200, 100], [300, 200]], { 200: command });
    return unprovenIdentity({ terminalId: "x", pid: 300 }, 100, t);
  };
  for (const command of [
    "/opt/bin/codex app-server", "codex app-server --listen unix://", "node /a/codex app-server",
    "codex -c x=y app-server", "codex --config a=b -m gpt-5 -p dev app-server", "codex -C /w --cd=/v app-server", "codex --search app-server",
    "npx @openai/codex app-server", "npx -y @openai/codex app-server --listen", "node /a/codex.js app-server",
  ]) {
    assert.match(under(command) ?? "", UNPROVEN, command);
  }
  for (const command of ["/opt/bin/notcodex app-server", "codex app-servers", "codex app-server-x", "codex exec", "codex", "vim app-server", "app-server codex",
    "codex exec app-server", "codex -c app-server", "codex -c x=y exec app-server", "zsh -c aya team send r codex app-server x", "codex.sh app-server", "node /a/mycodex.js app-server", "node /a/codex-x app-server"]) {
    assert.equal(under(command), null, command);
  }
});

test("the control server asks for the process table by the caller's own pid", async () => {
  const asked = [];
  await withServer(proof({ processTable: async (pid) => (asked.push(pid), PARENTS) }), async (socket) => {
    await rpc(socket, { type: "team-whoami", caller: { terminalId: "pane-a", pid: 160, cwd: DIR } });
    assert.deepEqual(asked, [160]);
  });
});

// A fake source for processTable: `tables` are handed out in order, `ppids` says what a one-pid read answers now.
let sources = 0;
function fakeSource(tables, ppids) {
  const log = { tables: 0, ppids: 0 };
  let clock = (sources += 1) * 100000; // apart from every other test's cached read
  return {
    log,
    advance: (ms) => (clock += ms),
    source: {
      now: () => clock,
      readTable: async () => tables[Math.min(log.tables++, tables.length - 1)],
      readPpid: async (pid) => (log.ppids++, ppids[pid] ?? null),
    },
  };
}

test("a cached table is not used for a caller whose parent changed since the read", async () => {
  const before = table([[1, 0], [100, 1], [160, 100]]);
  const after = table([[1, 0], [160, 1]]);
  const fake = fakeSource([before, after], { 160: 1 });
  assert.equal(await processTable(160, fake.source), before);
  fake.advance(10);
  assert.equal(await processTable(160, fake.source), after);
  assert.equal(fake.log.tables, 2);
});

test("a cached table whose caller still has the same parent is shared without another read", async () => {
  const before = table([[1, 0], [100, 1], [160, 100]]);
  const fake = fakeSource([before], { 160: 100 });
  await processTable(160, fake.source);
  fake.advance(10);
  assert.equal(await processTable(160, fake.source), before);
  assert.equal(fake.log.tables, 1);
  fake.advance(TABLE_SHARE_MS * 2);
  await processTable(160, fake.source);
  assert.equal(fake.log.tables, 2);
});

test("a caller that vanished after the cached read is read again", async () => {
  const fake = fakeSource([table([[1, 0], [160, 1]]), table([[1, 0]])], {});
  await processTable(160, fake.source);
  fake.advance(10);
  assert.equal((await processTable(160, fake.source)).has(160), false);
  assert.equal(fake.log.tables, 2);
});

test("a cached table is shared for TABLE_SHARE_MS after its read finished, not a millisecond longer", async () => {
  const before = table([[1, 0], [160, 1]]);
  const fake = fakeSource([before, table([[1, 0], [160, 1]])], { 160: 1 });
  await processTable(160, fake.source);
  fake.advance(TABLE_SHARE_MS - 1);
  assert.equal(await processTable(160, fake.source), before);
  assert.equal(fake.log.tables, 1);
  fake.advance(1);
  assert.notEqual(await processTable(160, fake.source), before);
  assert.equal(fake.log.tables, 2);
});

test("paneAbove walks MAX_DEPTH processes up the tree and no further", () => {
  // a chain 1 > 2 > ... > n: the pane at 2 sits n - 2 steps above n
  const chain = (n) => table(Array.from({ length: n }, (_, i) => [i + 1, i]));
  const panes = new Map([[2, "pane-a"]]);
  assert.equal(paneAbove(MAX_DEPTH + 1, chain(MAX_DEPTH + 1), panes), "pane-a");
  assert.equal(paneAbove(MAX_DEPTH + 2, chain(MAX_DEPTH + 2), panes), null);
});

test("the caller proof's bounds: 64 MB of ps output, 256 ancestors, a table shared for 200 ms", () => {
  assert.deepEqual([PS_TABLE_MAX_BUFFER_BYTES, MAX_DEPTH, TABLE_SHARE_MS], [64 * 1024 * 1024, 256, 200]);
});
