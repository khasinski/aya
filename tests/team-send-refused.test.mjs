// `aya team send` refusals are recorded in the team's refused.jsonl (append-only, bounded) for the lead's round
// digest. Table: why it was refused x what is recorded and what reaches log.jsonl; then the bound and the digest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isolateHome } from "./helpers/isolate-home.mjs";
import { teamProject } from "./helpers/team.mjs";

const home = teamProject("aya-refused-home-");
isolateHome(home.root);
process.on("exit", () => home.cleanup());

const { TeamStore, teamDir, REFUSED_MAX_ENTRIES, REFUSED_KEEP_ENTRIES } = await import("../dist-electron/team-store.js");
const { handleTeamRequest, oneLine, TEAM_SENDS_PER_MINUTE } = await import("../dist-electron/team-control.js");
const { digestFromFiles, readTeamFiles } = await import("../dist-electron/team-stats.js");
const { MESSAGE_CHARS } = await import("../dist-electron/team-debug.js");

const TEAM = `# ux-review

## Role: lead
Sends to: worker (the next step), tester (what to test)
Must not: edit code

## Role: worker
Sends to: lead (the result)
Must not: skip a report

## Role: tester
Sends to: lead (numbers)
Must not: edit code

## Lead
lead
`;

async function setup() {
  const t = teamProject("aya-refused-", { teamFile: TEAM, tabs: [{ id: "pane-l" }, { id: "pane-w" }] });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("lead", "pane-l");
  await store.assign("worker", "pane-w");
  await store.setPaused(false);
  const deps = { teamHome: t.teamHome, listProjects: async () => [t.project], deliver: async () => {}, headCommit: async () => null, holdReason: async () => null };
  const send = (pane, role, text) => handleTeamRequest({ type: "team-send", role, text }, pane, deps).then((r) => r.output, (e) => `refused: ${e.message}`);
  return { ...t, store, send };
}

const LONG = "8651809: Found a bug in the parser that loses errors on an empty line; see parse.py:42 and the failing test below";

// [label, prepare(t), pane, to, text, recorded reason (null: none), the sender's answer, messages from the sender in log.jsonl]
const TABLE = [
  ["an allowed send records nothing", async () => {}, "pane-l", "worker", "go", null, /^written to worker's pane/, 1],
  ["no such role", async () => {}, "pane-l", "author", LONG, "no such role", /does not send to author/, 0],
  ["a text of several lines is recorded as one line", async () => {}, "pane-l", "author", "first\n\nsecond", "no such role", /does not send to author/, 0],
  ["a role it does not send to", async () => {}, "pane-w", "tester", "numbers?", "not in its sends-to", /worker does not send to tester/, 0],
  ["the team is paused", (t) => t.store.setPaused(true), "pane-l", "worker", "go", "team paused", /is paused; nothing was sent/, 0],
  ["a receiver without a pane: kept for its inbox, and recorded", async () => {}, "pane-l", "tester", "measure", /^no pane, kept as #\d+$/, /no pane assigned; nothing was typed, message \d+ is kept/, 1],
  [
    "the send cap",
    async (t) => {
      for (let i = 0; i < TEAM_SENDS_PER_MINUTE; i++) await t.send("pane-l", "worker", `step ${i}`);
    },
    "pane-l",
    "worker",
    "one more",
    `${TEAM_SENDS_PER_MINUTE} sends in a minute`,
    new RegExp(`sent ${TEAM_SENDS_PER_MINUTE} messages in the last minute`),
    TEAM_SENDS_PER_MINUTE,
  ],
];

for (const [label, prepare, pane, to, text, reason, answer, logged] of TABLE) {
  test(`refused send | ${label}`, async () => {
    const t = await setup();
    try {
      await prepare(t);
      assert.match(await t.send(pane, to, text), answer);
      const recorded = await t.store.refusals();
      const from = pane === "pane-l" ? "lead" : "worker";
      if (reason === null) assert.deepEqual(recorded, []);
      else {
        assert.equal(recorded.length, 1);
        const [r] = recorded;
        assert.deepEqual([r.from, r.to, r.text], [from, to, oneLine(text).slice(0, MESSAGE_CHARS)]);
        assert.doesNotMatch(r.text, /\n/);
        if (reason instanceof RegExp) assert.match(r.reason, reason);
        else assert.equal(r.reason, reason);
      }
      assert.equal((await t.store.log()).filter((m) => m.from === from).length, logged, "what reached log.jsonl as the sender's");
    } finally {
      t.cleanup();
    }
  });
}

test("a refusal that cannot be recorded still refuses with the same answer", async () => {
  const t = await setup();
  try {
    mkdirSync(join(t.store.dir, "refused.jsonl"), { recursive: true });
    assert.match(await t.send("pane-l", "author", "hi"), /^refused: lead does not send to author/);
  } finally {
    t.cleanup();
  }
});

test("refused.jsonl is bounded: past the max the newest are kept, oldest first", async () => {
  assert.deepEqual([REFUSED_MAX_ENTRIES, REFUSED_KEEP_ENTRIES], [200, 100]);
  const t = await setup();
  try {
    for (let i = 0; i < REFUSED_MAX_ENTRIES + 3; i++) await t.store.recordRefusal({ from: "lead", to: "author", reason: "no such role", text: `n${i}` });
    const lines = readFileSync(join(t.store.dir, "refused.jsonl"), "utf8").trim().split("\n");
    // The write past the max leaves the newest REFUSED_KEEP_ENTRIES; the two after it are appended.
    assert.equal(lines.length, REFUSED_KEEP_ENTRIES + 2);
    const texts = (await t.store.refusals()).map((r) => r.text);
    assert.equal(texts.at(-1), `n${REFUSED_MAX_ENTRIES + 2}`);
    assert.equal(texts[0], `n${REFUSED_MAX_ENTRIES + 3 - texts.length}`);
    assert.deepEqual(readdirSync(t.store.dir).filter((f) => f.endsWith(".tmp")), [], "the trim's temp file is renamed over the file");
  } finally {
    t.cleanup();
  }
});

test("a recorded refusal reaches the digest read from the files (aya team stats --now)", async () => {
  const t = await setup();
  try {
    await t.send("pane-l", "author", LONG);
    const d = digestFromFiles("ux-review", readTeamFiles(t.store.dir), Date.now() + 1000);
    assert.deepEqual(d.sections.find((s) => s.title === "Refused sends")?.items, ['lead -> "author" (no such role): "8651809: Found a bug in the parser that ..."']);
  } finally {
    t.cleanup();
  }
});
