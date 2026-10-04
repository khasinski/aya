// The lead's round digest (electron/team-digest.ts): table of team states x the line or section the round shows,
// then the two formats. Pure: no files, no panes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolateHome } from "./helpers/isolate-home.mjs";

const root = mkdtempSync(join(tmpdir(), "aya-team-digest-"));
isolateHome(root);
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const { roundDigest, digestLines, digestOneLine, DIGEST_BLOCKED_MIN, DIGEST_IDLE_MIN, DIGEST_WAIT_MIN, REFUSED_TEXT_CHARS, SECTION_ITEMS_SHOWN, COMMITS_SHOWN } = await import("../dist-electron/team-digest.js");
const { clock, WALL_MINUTE_MS } = await import("../dist-electron/team-times.js");
const H = await import("../dist-electron/pane-holds.js");
const { betweenRoles } = await import("../dist-electron/team-supervision.js");

const ROLES = ["lead", "tester", "implementer", "reviewer"];
const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const ago = (min) => new Date(NOW - min * WALL_MINUTE_MS).toISOString();
let next = 1;
const msg = (from, to, min, extra = {}) => ({ id: next++, time: ago(min), from, to, commit: "c0", text: "x", delivered: true, ...extra });
const round = (min, n = 1) => msg("aya", "lead", min, { text: `Round ${n}: run your round as the team protocol says.` });
// Every role reported and got the lead's answer 2 min ago, so nobody waits on the lead: the baseline rows change.
const busyTeam = () => ["tester", "implementer", "reviewer"].flatMap((r) => [msg(r, "lead", 3), msg("lead", r, 2)]);
const input = (over = {}) => ({ roles: ROLES, lead: "lead", log: [], progress: null, refused: [], turns: null, busy: [], nowMs: NOW, ...over });
const titles = (d) => d.sections.map((s) => s.title);
const section = (d, prefix) => d.sections.find((s) => s.title.startsWith(prefix));

const TABLE = [
  [
    "nothing happened since the last round: the header says so and no section shows",
    () => input({ log: [...busyTeam(), round(1)] }),
    (d) => {
      assert.equal(d.header, `Since ${clock(ago(1))}: no messages, no commits`);
      assert.deepEqual(d.sections, []);
    },
  ],
  [
    "an empty log: no messages yet, and a refusal made before any message still shows",
    () => input({ refused: [{ time: ago(5), from: "lead", to: "qa", reason: "no such role", text: "hi" }] }),
    (d) => {
      assert.equal(d.header, "No messages yet");
      assert.deepEqual(titles(d), ["Refused sends"]);
    },
  ],
  [
    "deltas count only after the previous round; a HEAD from before it is no new commit",
    () => {
      const log = [...busyTeam(), msg("tester", "lead", 50, { commit: "old1" }), round(30), msg("tester", "lead", 20, { commit: "old1" }), msg("implementer", "lead", 10, { commit: "new1" }), msg("aya", "tester", 9)];
      return input({ log, progress: { commit: "new2" } });
    },
    (d) => assert.equal(d.header, `Since ${clock(ago(30))}: +2 messages, +2 commits (new1, new2)`),
  ],
  [
    "without a previous round the deltas run from the first message (its HEAD the base) and say so",
    () => input({ log: [msg("lead", "tester", 40, { commit: "a1" }), msg("tester", "lead", 39, { commit: "b2" })] }),
    (d) => assert.equal(d.header, `Since ${clock(ago(40))} (no round before): +2 messages, +1 commit (b2)`),
  ],
  [
    "held messages and skipped rounds since the last round are in the header",
    () => {
      const log = [...busyTeam(), round(30), msg("aya", "lead", 20, { text: "round 2 skipped: is busy working" }), msg("tester", "implementer", 2, { delivered: false, held: H.HOLD_APPROVAL })];
      return input({ log });
    },
    (d) => assert.match(d.header, /: \+1 message, no commits, 1 held, 1 round skipped$/),
  ],
  ...[
    ["typed only, its Enter withheld", { typedOnly: true, held: "Enter withheld: a draft" }],
    ["held, never typed", { delivered: false, held: H.HOLD_APPROVAL }],
  ].map(([how, extra]) => [
    `a round the lead never got (${how}) is no baseline: the sends refused before it stay news`,
    () => {
      const refused = [{ time: ago(20), from: "tester", to: "qa", reason: "no such role", text: "a finding" }];
      return input({ log: [...busyTeam(), round(30, 1), msg("tester", "lead", 25), msg("aya", "lead", 10, { text: "Round 2: run your round as the team protocol says.", ...extra })], refused });
    },
    (d) => {
      assert.equal(d.header, `Since ${clock(ago(30))}: +1 message, no commits`);
      assert.deepEqual(section(d, "Refused sends").items, ['tester -> "qa" (no such role): "a finding"']);
    },
  ]),
  [
    "a screen the clock saw for 12 min, a dialog: only the user",
    () => input({ log: [...busyTeam(), round(1)], progress: { blocked: { tester: { reason: H.HOLD_APPROVAL, since: ago(12) } } } }),
    (d) => assert.deepEqual(section(d, "Needs action").items, ["tester  stuck 12 min: approval prompt (only the user)"]),
  ],
  [
    `a screen just under ${DIGEST_BLOCKED_MIN} min is no block yet; at ${DIGEST_BLOCKED_MIN} it is`,
    () => input({ log: [...busyTeam(), round(1)], progress: { blocked: { tester: { reason: H.HOLD_CHOICE, since: ago(DIGEST_BLOCKED_MIN - 0.1) }, reviewer: { reason: H.HOLD_CHOICE, since: ago(DIGEST_BLOCKED_MIN) } } } }),
    (d) => assert.deepEqual(section(d, "Needs action").items, [`reviewer  stuck ${DIGEST_BLOCKED_MIN} min: numbered choice (only the user)`]),
  ],
  [
    `a message held just under ${DIGEST_BLOCKED_MIN} min is no block yet; at ${DIGEST_BLOCKED_MIN} it is`,
    () => {
      const log = [...busyTeam(), round(20), msg("lead", "tester", DIGEST_BLOCKED_MIN - 0.1, { delivered: false, held: H.HOLD_APPROVAL }), msg("lead", "reviewer", DIGEST_BLOCKED_MIN, { delivered: false, held: H.HOLD_APPROVAL })];
      return input({ log, busy: ["tester", "reviewer"] });
    },
    (d) => assert.deepEqual(section(d, "Needs action").items, [`reviewer  message #${next - 1} held ${DIGEST_BLOCKED_MIN} min: approval prompt (only the user)`]),
  ],
  [
    "a screen read free since (freeReads) is being answered: not shown",
    () => input({ log: [...busyTeam(), round(1)], progress: { blocked: { tester: { reason: H.HOLD_APPROVAL, since: ago(30), freeReads: 1 } } } }),
    (d) => assert.equal(section(d, "Needs action"), undefined),
  ],
  [
    "a message held on the user's draft for 15 min: only the user, with its number",
    () => {
      const log = [...busyTeam(), round(20), msg("reviewer", "implementer", 15, { delivered: false, held: `${H.HOLD_DRAFT}; it may be message #3 from lead` })];
      return input({ log, busy: ["reviewer"] });
    },
    (d) => assert.deepEqual(section(d, "Needs action").items, [`implementer  message #${next - 1} held 15 min: user typing (only the user)`]),
  ],
  [
    "a message held for a reason no dialog explains (the Enter not taken): the team",
    () => {
      const log = [...busyTeam(), round(20), msg("reviewer", "tester", 8, { delivered: false, held: "did not take the text (it may have exited)" })];
      return input({ log, busy: ["reviewer"] });
    },
    (d) => assert.match(section(d, "Needs action").items[0], /^tester  message #\d+ held 8 min: did not take the text \(it may have exited\) \(the team\)$/),
  ],
  [
    "a message queued behind another names the first one's reason; Aya's own held rounds are not blocks",
    () => {
      const log = [...busyTeam(), round(20), msg("aya", "tester", 30, { delivered: false, held: H.HOLD_SHELL }), msg("lead", "tester", 10, { delivered: false, held: H.HOLD_NOT_RUNNING }), msg("reviewer", "tester", 9, { delivered: false, held: "earlier message #9 for it is still waiting; this one follows it" })];
      return input({ log, busy: ["reviewer"] });
    },
    (d) => assert.match(section(d, "Needs action").items[0], /^tester  message #\d+ held 10 min: pane not running \(only the user\)$/),
  ],
  [
    "a held message queued first behind one since read is passed over for the next one's own reason",
    () => {
      const log = [...busyTeam(), round(20), msg("lead", "tester", 12, { delivered: false, held: "earlier message #1 for it is still waiting; this one follows it" }), msg("reviewer", "tester", 8, { delivered: false, held: H.HOLD_APPROVAL })];
      return input({ log, busy: ["reviewer"] });
    },
    (d) => assert.deepEqual(section(d, "Needs action").items, [`tester  message #${next - 1} held 8 min: approval prompt (only the user)`]),
  ],
  [
    "only queued messages held: the team's to clear",
    () => {
      const log = [...busyTeam(), round(20), msg("lead", "tester", 12, { delivered: false, held: "earlier message #1 for it is still waiting; this one follows it" })];
      return input({ log });
    },
    (d) => assert.deepEqual(section(d, "Needs action").items, [`tester  message #${next - 1} held 12 min: queued behind an earlier message (the team)`]),
  ],
  [
    "the lead is never idle in its own round, however quiet",
    () => input({ log: [round(71), msg("lead", "tester", 50), msg("tester", "lead", 40)], roles: ["lead", "tester", "reviewer"], busy: [] }),
    (d) => assert.deepEqual(section(d, "Idle over").items, ["reviewer"]),
  ],
  [
    "every unanswered message to the lead, with its number and wait",
    () => {
      const log = [...busyTeam(), round(200), msg("tester", "lead", 103)];
      return input({ log, busy: ["tester"] });
    },
    (d) => assert.deepEqual(section(d, "Waiting on you").items, [`tester #${next - 1} for 1 h 43 min`]),
  ],
  [
    `a wait between other roles shows from ${DIGEST_WAIT_MIN} min, not before`,
    () => {
      const log = [...busyTeam(), round(60), msg("tester", "implementer", DIGEST_WAIT_MIN), msg("reviewer", "implementer", DIGEST_WAIT_MIN - 1)];
      return input({ log, busy: ["implementer"] });
    },
    (d) => {
      assert.deepEqual(section(d, "Waiting over").items, [`tester on implementer #${next - 2} for ${DIGEST_WAIT_MIN} min`]);
      assert.equal(section(d, "Waiting on you"), undefined);
    },
  ],
  [
    `a refused text of ${REFUSED_TEXT_CHARS} chars is shown whole; one more char and it is cut`,
    () => {
      const refusal = (to, text) => ({ time: ago(5), from: "lead", to, reason: "no such role", text });
      return input({ log: [...busyTeam(), round(10)], refused: [refusal("a", "x".repeat(REFUSED_TEXT_CHARS)), refusal("b", "y".repeat(REFUSED_TEXT_CHARS + 1))] });
    },
    (d) => assert.deepEqual(section(d, "Refused sends").items, [`lead -> "a" (no such role): "${"x".repeat(REFUSED_TEXT_CHARS)}"`, `lead -> "b" (no such role): "${"y".repeat(REFUSED_TEXT_CHARS)} ..."`]),
  ],
  [
    "a refused send since the last round, its text cut; one from before the round is not repeated",
    () =>
      input({
        log: [...busyTeam(), round(10)],
        refused: [
          { time: ago(20), from: "tester", to: "qa", reason: "no such role", text: "old" },
          { time: ago(5), from: "reviewer", to: "author", reason: "no such role", text: "8651809: Found a bug in the parser that loses errors" },
        ],
      }),
    (d) => assert.deepEqual(section(d, "Refused sends").items, ['reviewer -> "author" (no such role): "8651809: Found a bug in the parser that ..."']),
  ],
  [
    `idle from ${DIGEST_IDLE_MIN} min: not at ${DIGEST_IDLE_MIN - 1}, not the lead, not one a message was typed to since`,
    () => {
      const log = [
        round(61),
        ...["tester", "implementer", "reviewer"].map((r) => msg(r, "lead", 60)),
        msg("lead", "reviewer", DIGEST_IDLE_MIN),
        msg("lead", "implementer", DIGEST_IDLE_MIN - 1),
        msg("lead", "tester", 40),
        msg("lead", "tester", 1),
        msg("lead", "reviewer", 1, { delivered: false, held: H.HOLD_BUSY }),
      ];
      return input({ log, busy: [] });
    },
    (d) => assert.deepEqual(section(d, "Idle over").items, ["reviewer"]),
  ],
  [
    "a busy role is not idle; a turn seen in the debug log is activity; without busy news the title says so",
    () => {
      const log = [round(61), ...["tester", "implementer", "reviewer"].flatMap((r) => [msg(r, "lead", 60), msg("lead", r, 50)])];
      return input({ log, busy: null, turns: [{ role: "implementer", time: ago(3) }] });
    },
    (d) => {
      assert.equal(section(d, "Idle over").title, `Idle over ${DIGEST_IDLE_MIN} min (not known whether busy now)`);
      assert.deepEqual(section(d, "Idle over").items, ["tester, reviewer"]);
      const log = [round(61), msg("tester", "lead", 60), msg("lead", "tester", 50)];
      const two = (busy) => section(roundDigest(input({ log, roles: ["lead", "tester"], busy })), "Idle over");
      assert.deepEqual(two([]).items, ["tester"]);
      assert.equal(two(["tester"]), undefined);
    },
  ],
  [
    "a role waiting on a reply or blocked is not idle",
    () => {
      const log = [round(61), ...["tester", "implementer", "reviewer"].flatMap((r) => [msg(r, "lead", 60), msg("lead", r, 50)]), msg("tester", "implementer", 45)];
      return input({ log, busy: [], progress: { blocked: { reviewer: { reason: H.HOLD_APPROVAL, since: ago(30) } } } });
    },
    (d) => assert.deepEqual(section(d, "Idle over").items, ["implementer"]),
  ],
  [
    `past ${COMMITS_SHOWN} new commits the header shows the newest ${COMMITS_SHOWN} after "..."`,
    () => {
      const log = [...busyTeam(), round(30), ...Array.from({ length: COMMITS_SHOWN + 1 }, (_, i) => msg("tester", "lead", 20 - i, { commit: `k${i}` }))];
      return input({ log, busy: ["tester"] });
    },
    (d) => {
      const newest = Array.from({ length: COMMITS_SHOWN }, (_, i) => `k${i + 1}`).join(", ");
      assert.match(d.header, new RegExp(`\\+${COMMITS_SHOWN + 1} commits \\(\\.\\.\\., ${newest}\\)$`));
    },
  ],
  [
    `exactly ${COMMITS_SHOWN} new commits are all shown, without "..."`,
    () => {
      const log = [...busyTeam(), round(30), ...Array.from({ length: COMMITS_SHOWN }, (_, i) => msg("tester", "lead", 20 - i, { commit: `k${i}` }))];
      return input({ log, busy: ["tester"] });
    },
    (d) => assert.match(d.header, new RegExp(`\\+${COMMITS_SHOWN} commits \\(k0, `)),
  ],
  [
    `a section lists ${SECTION_ITEMS_SHOWN} items, then how many more`,
    () => {
      const refused = Array.from({ length: SECTION_ITEMS_SHOWN + 2 }, (_, i) => ({ time: ago(5), from: "lead", to: `r${i}`, reason: "no such role", text: "x" }));
      return input({ log: [...busyTeam(), round(10)], refused });
    },
    (d) => {
      const items = section(d, "Refused sends").items;
      assert.equal(items.length, SECTION_ITEMS_SHOWN + 1);
      assert.equal(items.at(-1), "and 2 more");
    },
  ],
  [
    `a section of exactly ${SECTION_ITEMS_SHOWN} items is not cut`,
    () => {
      const refused = Array.from({ length: SECTION_ITEMS_SHOWN }, (_, i) => ({ time: ago(5), from: "lead", to: `r${i}`, reason: "no such role", text: "x" }));
      return input({ log: [...busyTeam(), round(10)], refused });
    },
    (d) => assert.equal(section(d, "Refused sends").items.length, SECTION_ITEMS_SHOWN),
  ],
  [
    "empty sections are omitted, the rest keep their order",
    () => input({ log: [...busyTeam(), round(30), msg("tester", "lead", 10)], busy: ["tester"] }),
    (d) => assert.deepEqual(titles(d), ["Waiting on you"]),
  ],
];

test("the digest's numbers are the product's: wall-clock minutes, 5 min blocked, 30 min wait, 20 min idle, 40 chars, 8 items, 5 commits", () => {
  assert.deepEqual([WALL_MINUTE_MS, DIGEST_BLOCKED_MIN, DIGEST_WAIT_MIN, DIGEST_IDLE_MIN, REFUSED_TEXT_CHARS, SECTION_ITEMS_SHOWN, COMMITS_SHOWN], [60_000, 5, 30, 20, 40, 8, 5]);
});

for (const [label, make, check] of TABLE) {
  test(`roundDigest | ${label}`, () => {
    next = 1;
    check(roundDigest(make()));
  });
}

test("betweenRoles: talk between the team's roles only, never a role's note to itself", () => {
  const log = [msg("tester", "lead", 3), msg("tester", "tester", 2), msg("aya", "lead", 1), msg("tester", "qa", 1)];
  assert.deepEqual(betweenRoles(log, ROLES), [log[0]]);
});

test("digestLines: one item stays on its title's line, more go below it; digestOneLine is one ASCII line", () => {
  const d = { header: "Since 10:00: +1 message, no commits", sections: [{ title: "Waiting on you", items: ["tester #3 for 5 min"] }, { title: "Needs action", items: ["a   stuck 6 min: x (only the user)", "bb  stuck 7 min: y (the team)"] }] };
  assert.equal(digestLines(d), "Since 10:00: +1 message, no commits\nWaiting on you: tester #3 for 5 min\nNeeds action:\n  a   stuck 6 min: x (only the user)\n  bb  stuck 7 min: y (the team)\n");
  assert.equal(digestOneLine(d), "Since 10:00: +1 message, no commits. Waiting on you: tester #3 for 5 min. Needs action: a stuck 6 min: x (only the user); bb stuck 7 min: y (the team).");
});
