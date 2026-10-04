// Finding 17: agents on small models wrote `aya team send lead "..."` as text instead of running it, then said "I sent
// the findings earlier"; the team log had nothing from them. Aya reads the reply on the pane's screen against the log,
// and the Teams window and the lead's round say "<role> says it sent to <role>, nothing arrived".

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { teamProject } from "./helpers/team.mjs";

const { renderPaneText } = await import("../dist-electron/pane-render.js");
const { claimedRecipients, lookForClaims, readClaims, unsentClaims, withUnsentSection } = await import("../dist-electron/unsent-claims.js");
const { typedTeamMessage } = await import("../dist-electron/team-control.js");
const { digestOneLine } = await import("../dist-electron/team-digest.js");
const { listTeams } = await import("../dist-electron/team-admin.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { unsentLine } = await import("../dist-test/team-view.js");

const TEAM = (cadence = "") => `# ux-review

## Role: lead
Sends to: tester (work)
Must not: edit code

## Role: tester
Sends to: lead (findings)
Must not: skip a report

## Lead
lead
${cadence}`;
const ROLES = ["lead", "tester"];
const TURN_TEXT = 'Run the parser suite and send your findings: aya team send lead "<findings>"';
const FINDINGS = "findings: 3 failing tests in the parser";

/** Hard-wrapped as a CLI echoes a typed line: `first` before the first row, `rest` before the others. */
function wrapped(line, first, rest, width = 80) {
  const rows = [];
  for (let at = 0; at < line.length; at += width) rows.push((at ? rest : first) + line.slice(at, at + width).trim());
  return rows;
}

// Recorded Claude composer and footer (own-screens/claude-idle); the rows above it are built from what Claude draws.
const CLAUDE_COMPOSER = (await (async () => {
  const dir = new URL("./fixtures/own-screens/", import.meta.url);
  const meta = JSON.parse(readFileSync(new URL("claude-idle.meta.json", dir), "utf8"));
  return renderPaneText(readFileSync(new URL("claude-idle.raw", dir), "utf8"), meta.cols, meta.rows);
})()).split("\n").slice(-4);
const CODEX_COMPOSER = ["› Ask Codex to do anything", "  GPT-6-Luna medium · ~/Projects/game"];
const OPENCODE_COMPOSER = ["┃", "┃  Ask anything…", "┃  Build · qwen36 ollama", "╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀"];

// How each CLI draws the typed message, its own text and a tool call (OpenCode's tool rows are not recorded).
const AGENTS = {
  claude: {
    message: (line) => wrapped(line, "❯ ", "  "),
    say: (...lines) => lines.map((l, i) => (i ? `  ${l}` : `⏺ ${l}`)),
    tool: (cmd, out) => [`⏺ Bash(${cmd})`, `  ⎿  ${out}`],
    composer: CLAUDE_COMPOSER,
  },
  codex: {
    message: (line) => wrapped(line, "› ", "  "),
    say: (...lines) => lines.map((l, i) => (i ? `  ${l}` : `• ${l}`)),
    tool: (cmd, out) => [`• Ran ${cmd}`, `  └ ${out}`],
    composer: CODEX_COMPOSER,
  },
  opencode: {
    message: (line) => wrapped(line, "┃  ", "┃  "),
    say: (...lines) => lines.map((l) => `  ${l}`),
    tool: (cmd, out) => [`  $ ${cmd}`, `  ${out}`],
    composer: OPENCODE_COMPOSER,
  },
};

const SEND = `aya team send lead "${FINDINGS}"`;
// [case, the reply as an agent draws it, a real send logged, a refused send, a claim expected]
const REPLIES = [
  ["the command written as text, then 'I sent the findings earlier' (finding 17)", (a) => [...a.say("Here is the command to send them:"), "", `  ${SEND}`, "", ...a.say("I sent the findings earlier.")], false, false, true],
  ["a send told in words, naming the role", (a) => a.say("I sent the findings to lead."), false, false, true],
  ["a send told in Polish, naming the role", (a) => a.say("Wysłałem wyniki do lead."), false, false, true],
  ["the command run as a tool, the message logged", (a) => [...a.tool(SEND, "sent #3 to lead"), ...a.say("Sent the findings to lead.")], true, false, false],
  ["the command run and refused: it ran, the refusal says the rest", (a) => [...a.tool(SEND, "aya: lead refused"), ...a.say("I sent the findings to lead.")], false, true, false],
  ["the command run as a tool that failed before Aya logged it, no words: a tool call is no claim", (a) => a.tool(SEND, "aya: Aya is not running"), false, false, false],
  ["no claim", (a) => a.say("Found 3 failing tests in the parser; fixing them now."), false, false, false],
  ["a send not done yet", (a) => a.say("I haven't sent anything to lead yet; I will send the findings to lead after the rerun."), false, false, false],
  ["a negative subject: 'No report was sent to lead'", (a) => a.say("No report was sent to lead."), false, false, false],
  ["a negative subject: 'Nothing was sent to lead yet'", (a) => a.say("Nothing was sent to lead yet."), false, false, false],
  ["a negative object: 'I sent nothing to lead'", (a) => a.say("I sent nothing to lead."), false, false, false],
  ["a negative object: 'I sent no report to the lead'", (a) => a.say("I sent no report to the lead."), false, false, false],
  ["a negative in Polish: 'Nie wysłałem nic do lead'", (a) => a.say("Nie wysłałem nic do lead."), false, false, false],
  ["a negative in Polish: 'Nic nie wysłałem do lead'", (a) => a.say("Nic nie wysłałem do lead."), false, false, false],
  ["a negative in Polish: 'Wysłałem nic do lead'", (a) => a.say("Wysłałem nic do lead."), false, false, false],
  ["a claim after a negative clause: 'No blockers, so I sent the findings to lead'", (a) => a.say("No blockers, so I sent the findings to lead."), false, false, true],
  ["a claim after 'no' with no passive verb: 'No worries I sent the findings to lead'", (a) => a.say("No worries I sent the findings to lead."), false, false, true],
  ["a claim whose object starts with 'no': 'I sent notes to lead'", (a) => a.say("I sent notes to lead."), false, false, true],
  ["a claim in Polish after a negative clause: 'Nic nie blokuje, wysłałem wyniki do lead'", (a) => a.say("Nic nie blokuje, wysłałem wyniki do lead."), false, false, true],
  ["'I sent the findings earlier' alone names no role", (a) => a.say("I sent the findings earlier."), false, false, false],
];

const reply = (start) => REPLIES.find(([name]) => name.startsWith(start))[1];
const AS_TEXT = reply("the command written as text");
const IN_WORDS = reply("a send told in words");
const NO_CLAIM = reply("no claim");
const EARLIER = reply("'I sent the findings earlier' alone");

async function setup(cadence = "") {
  const t = teamProject("aya-unsent-", { teamFile: TEAM(cadence), tabs: [{ id: "pane-lead" }, { id: "pane-tester" }] });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("lead", "pane-lead");
  await store.assign("tester", "pane-tester");
  return { ...t, store };
}

/** The tester's screen: the lead's message as typed, then `reply`, then the composer. */
const screenOf = (agent, turn, reply) => {
  const a = AGENTS[agent];
  return ["", ...a.message(typedTeamMessage("ux-review", turn.from, turn.time, turn.commit, turn.text)), ...reply(a), "", ...a.composer].join("\n");
};

const look = (screen, agent, extra = {}) => ({
  team: "ux-review",
  roles: ROLES,
  holds: { lead: null, tester: null },
  pane: async (role) => `pane-${role}`,
  busy: async () => false,
  screen: async (pane) => (pane === "pane-tester" ? screen : null),
  agentOf: async () => agent,
  ...extra,
});

/** What the window and the lead's round show for the team now. */
async function shown(t) {
  const [summary] = await listTeams(t.teamHome, t.project);
  const window = unsentLine(summary, "tester");
  const unsent = unsentClaims(await readClaims(t.store), await t.store.annotatedLog(), await t.store.refusals(), ROLES);
  const round = digestOneLine(withUnsentSection({ header: "Since 19:30: no messages", sections: [] }, unsent));
  return { window, round };
}

const NOTE = "tester says it sent to lead, nothing arrived";

describe("a reply that claims a send, against the log", () => {
  for (const [name, reply, sent, refused, claimed] of REPLIES) {
    for (const agent of Object.keys(AGENTS)) {
      test(`${name} (${agent})`, async () => {
        const t = await setup();
        try {
          const turn = await t.store.append({ from: "lead", to: "tester", commit: "0aa04db", text: TURN_TEXT, delivered: true });
          if (sent) await t.store.append({ from: "tester", to: "lead", commit: null, text: FINDINGS, delivered: true });
          if (refused) await t.store.recordRefusal({ from: "tester", to: "lead", reason: "the team is paused", text: FINDINGS });
          await lookForClaims(t.store, look(screenOf(agent, turn, reply), agent));
          const { window, round } = await shown(t);
          assert.equal(window, claimed ? NOTE : null);
          assert.equal(round, claimed ? `Since 19:30: no messages. Said it sent: ${NOTE}.` : "Since 19:30: no messages.");
        } finally {
          t.cleanup();
        }
      });
    }
  }
});

// [case, the look's state, read now?]
const LOOKS = [
  ["the pane is free and idle", {}, true],
  ["the agent is still working", { busy: async () => true }, false],
  ["a dialog holds the pane", { holds: { lead: null, tester: "shows an approval prompt" } }, false],
  ["the pane is not running", { screen: async () => null }, false],
];

describe("when a reply is read", () => {
  for (const [name, extra, read] of LOOKS) {
    test(name, async () => {
      const t = await setup();
      try {
        const turn = await t.store.append({ from: "lead", to: "tester", commit: null, text: TURN_TEXT, delivered: true });
        await lookForClaims(t.store, look(screenOf("claude", turn, AS_TEXT), "claude", extra));
        assert.equal((await shown(t)).window, read ? NOTE : null);
      } finally {
        t.cleanup();
      }
    });
  }

  for (const agent of ["claude", "codex"]) {
    test(`the user's draft of the command in the composer is not the reply (${agent})`, async () => {
      const t = await setup();
      try {
        const turn = await t.store.append({ from: "lead", to: "tester", commit: null, text: TURN_TEXT, delivered: true });
        const a = AGENTS[agent];
        const draft = a.composer.map((row) => row.replace(/^([❯›])\s.*/, `$1 ${SEND}`));
        const screen = ["", ...a.message(typedTeamMessage("ux-review", turn.from, turn.time, null, turn.text)), ...NO_CLAIM(a), "", ...draft].join("\n");
        assert.ok(screen.includes(`${agent === "claude" ? "❯" : "›"} ${SEND}`), "the draft is drawn");
        await lookForClaims(t.store, look(screen, agent));
        assert.equal((await shown(t)).window, null);
      } finally {
        t.cleanup();
      }
    });
  }

  test("a turn not answered yet is read again; the claim lasts into the next turn until a message arrives", async () => {
    const t = await setup();
    try {
      const turn = await t.store.append({ from: "lead", to: "tester", commit: null, text: TURN_TEXT, delivered: true });
      await lookForClaims(t.store, look(screenOf("opencode", turn, () => []), "opencode"));
      assert.equal((await readClaims(t.store)).tester, undefined, "nothing drawn under the message yet: not settled");
      await lookForClaims(t.store, look(screenOf("opencode", turn, AS_TEXT), "opencode"));
      assert.equal((await shown(t)).window, NOTE);
      // The lead asks again; the tester answers without naming a role: the claim stands.
      const again = await t.store.append({ from: "lead", to: "tester", commit: null, text: "Where are the findings?", delivered: true });
      await lookForClaims(t.store, look(screenOf("opencode", again, EARLIER), "opencode"));
      assert.equal((await shown(t)).window, NOTE);
      // The tester finally runs it.
      await t.store.append({ from: "tester", to: "lead", commit: null, text: FINDINGS, delivered: true });
      assert.equal((await shown(t)).window, null);
      const third = await t.store.append({ from: "lead", to: "tester", commit: null, text: "Thanks.", delivered: true });
      await lookForClaims(t.store, look(screenOf("opencode", third, NO_CLAIM), "opencode"));
      assert.deepEqual((await readClaims(t.store)).tester.claims, [], "an answered claim is dropped from the file");
    } finally {
      t.cleanup();
    }
  });

  test("an answered claim to a role does not hide a new claim to the same role", async () => {
    const t = await setup();
    try {
      const turn = await t.store.append({ from: "lead", to: "tester", commit: null, text: TURN_TEXT, delivered: true });
      await lookForClaims(t.store, look(screenOf("claude", turn, IN_WORDS), "claude"));
      assert.equal((await shown(t)).window, NOTE);
      const repeat = await t.store.append({ from: "lead", to: "tester", commit: null, text: "Where are they?", delivered: true });
      await lookForClaims(t.store, look(screenOf("claude", repeat, IN_WORDS), "claude"));
      assert.deepEqual((await readClaims(t.store)).tester.claims.map((c) => c.turn), [turn.id], "an open claim repeated stays the first one");
      // The tester then really sends; the old claim is answered but still in the file until the next look.
      await t.store.append({ from: "tester", to: "lead", commit: null, text: FINDINGS, delivered: true });
      assert.equal((await shown(t)).window, null);
      const again = await t.store.append({ from: "lead", to: "tester", commit: null, text: "Send the rerun too.", delivered: true });
      await lookForClaims(t.store, look(screenOf("claude", again, IN_WORDS), "claude"));
      assert.equal((await shown(t)).window, NOTE, "the new turn's claim stands");
      assert.deepEqual((await readClaims(t.store)).tester.claims.map((c) => c.turn), [again.id]);
    } finally {
      t.cleanup();
    }
  });

  test("the message's own command text is not the agent's claim; a message not on screen yet is read once it is", async () => {
    const t = await setup();
    try {
      const turn = await t.store.append({ from: "lead", to: "tester", commit: null, text: TURN_TEXT, delivered: true });
      await lookForClaims(t.store, look(screenOf("claude", turn, NO_CLAIM), "claude"));
      assert.equal((await shown(t)).window, null);
      assert.equal((await readClaims(t.store)).tester.checked, turn.id, "settled");
      let reads = 0;
      await lookForClaims(t.store, look("", "claude", { screen: async () => (reads++, "") }));
      assert.equal(reads, 0, "a settled turn's screen is not rendered again each look");
      // Logged after its Enter, before the pane draws it: the screen still shows the previous turn, whose claim is not this one's.
      const next = await t.store.append({ from: "lead", to: "tester", commit: null, text: "Next task", delivered: true });
      await lookForClaims(t.store, look(screenOf("claude", turn, IN_WORDS), "claude"));
      assert.equal((await shown(t)).window, null);
      assert.equal((await readClaims(t.store)).tester.checked, turn.id, "not settled while its message is not drawn");
      await lookForClaims(t.store, look(screenOf("claude", next, IN_WORDS), "claude"));
      assert.equal((await shown(t)).window, NOTE, "its reply, drawn later, is read");
      assert.equal((await readClaims(t.store)).tester.checked, next.id);
    } finally {
      t.cleanup();
    }
  });
});

test("a recipient must be another role of the team", () => {
  assert.deepEqual(claimedRecipients('aya team send tester "x"; I sent it to reviewer; sent to lead', ROLES, "tester"), ["lead"]);
  assert.deepEqual(claimedRecipients("./aya team send lead x; my-aya team send lead x", ROLES, "tester"), []);
});

test("the lead's rhythm round carries the claim (the runner reads the screens)", async () => {
  const t = await setup("\n## Cadence\nlead every 30 min\n");
  try {
    let now = Date.parse("2026-10-03T19:00:00Z");
    const typed = [];
    const jobs = [];
    const screens = {};
    const deps = {
      teamHome: t.teamHome,
      listProjects: async () => [t.project],
      deliver: async (pane, text, _c, entered) => (typed.push({ pane, text }), await entered?.()),
      holdReason: async () => null,
      headCommit: async () => null,
      busy: async () => false,
      screen: async (pane) => screens[pane] ?? null,
      agentOf: async () => "opencode",
    };
    const runner = new TeamRunner(deps, (fn) => (jobs.push(fn), () => {}), () => now, () => {});
    await runner.start("game", "ux-review");
    const turn = await t.store.append({ from: "lead", to: "tester", commit: null, text: TURN_TEXT, delivered: true });
    screens["pane-tester"] = screenOf("opencode", turn, AS_TEXT);
    now += 31 * 60_000;
    await jobs.at(-1)();
    const round = typed.filter((x) => x.pane === "pane-lead").at(-1).text;
    assert.match(round, /Aya round 1: run your round as the team protocol says\..* Said it sent: tester says it sent to lead, nothing arrived\.$/);
  } finally {
    t.cleanup();
  }
});
