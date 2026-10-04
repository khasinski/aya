// The composer holds the peer's pasted words: Enter still goes out when they merely quote approval wording, and
// is withheld when a real prompt appeared after the paste.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/vt-screens.mjs";
import { deliverTeamMessage } from "../dist-electron/control.js";
import { PaneHeldError } from "../dist-electron/team-control.js";
import { closeVtPane, openVtPane, paneHold, writeVtPane } from "../dist-electron/vt-state.js";

const settle = () => new Promise((r) => setTimeout(r, 30));
const HEAD = "[team t | from reviewer | 10:00 | abc1234]";
const RULE = "─".repeat(60);

const TEXTS = {
  plain: `${HEAD} The tests pass.`,
  "quotes Do you want me to": `${HEAD} Do you want me to run the tests now?`,
  "quotes Do you want to proceed": `${HEAD} Do you want to proceed?`,
  "ends with [y/n]": `${HEAD} Ship the change? [y/n]`,
  "ends with (y/N)": `${HEAD} Ship the change? (y/N)`,
  "quotes Allow this command": `${HEAD} Allow this command?`,
  "numbered list": `${HEAD} Pick one:\n1. Yes\n2. No`,
  "long, wraps": `${HEAD} ${"Do you want me to look at this again? ".repeat(6)}[y/n]`,
};

const wrap = (text, width, indent) => {
  const out = [];
  let rest = text;
  while (rest.length > width) {
    const cut = rest.lastIndexOf(" ", width);
    const at = cut > 0 ? cut : width;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  return [...out, rest].map((row, i) => (i ? indent : "") + row);
};

// Each CLI: its composer with the given text, and the dialog it draws for a real approval.
const CLIS = {
  claude: {
    composer: (text, footer = "  ⏵⏵ accept edits on (shift+tab to cycle)") => [
      "● Done.", RULE, ...wrap(text, 70, "  ").map((r, i) => (i ? r : `❯ ${r}`)), RULE, footer,
    ],
    footerRows: 1,
    // Synthetic - to record: no non-aya approval of either CLI is captured yet.
    dialog: fixture("approval-screens/synthetic-claude-git-status.txt"),
  },
  codex: {
    composer: (text) => ["• Sent.", "", ...wrap(text, 70, "  ").map((r, i) => (i ? r : `› ${r}`)), "", "  gpt-6 medium"],
    footerRows: 2,
    dialog: fixture("approval-screens/synthetic-codex-git-status.txt"),
  },
  opencode: {
    composer: (text) => ["     ▣  Build", "  ┃", ...wrap(text, 70, "").map((r) => `  ┃  ${r}`), "  ┃", "  ╹▀▀▀▀▀▀▀▀▀▀", "   ctrl+p commands    • OpenCode 1.18.30"],
    footerRows: 1,
    dialog: fixture("opencode-plan-question.screen.txt"),
  },
};

const SCREENS = {
  "free composer": () => [],
  "approval drawn below the composer": (cli) => ["", ...cli.dialog],
  "a y/n question drawn below the composer": () => ["", "Run the migration now? [y/n]"],
  "approval replaces the composer": (cli) => ["REPLACE", ...cli.dialog],
};

let nextPane = 0;

async function deliver(agent, text, screen, bare = false) {
  const id = `quoting-${++nextPane}`;
  const base = CLIS[agent];
  // Bare: the composer row is the last row on screen, where the [y/n] and Allow rules look.
  const cli = bare ? { ...base, composer: (...args) => base.composer(...args).slice(0, -base.footerRows) } : base;
  openVtPane(id, 100, 60, () => {}, agent);
  const draw = (rows) => writeVtPane(id, `\x1b[2J\x1b[H${rows.join("\r\n")}`);
  draw(cli.composer("", agent === "claude" ? "  ? for shortcuts" : undefined).map((r) => r.replace(/^(❯|›) $/, "$1 ")));
  await settle();
  const events = [];
  const write = async (_id, data) => {
    if (data === "\r") return void events.push("enter");
    events.push("paste");
    const extra = SCREENS[screen](cli);
    const typed = data.replace(/\x1b\[20[01]~/g, "");
    draw(extra[0] === "REPLACE" ? ["● Done.", ...extra.slice(1)] : [...cli.composer(typed), ...extra]);
    await settle();
  };
  let held = null;
  try {
    await deliverTeamMessage(write, id, text, (id, pasted) => paneHold(id, pasted)).catch((err) => {
      if (!(err instanceof PaneHeldError)) throw err;
      held = err.reason;
    });
  } finally {
    closeVtPane(id);
  }
  return { events, held };
}

// Each case owns its screen mirror and pane lock. Keep the real paste/Enter gap,
// but let independent panes wait together. No test shares a composer with another.
describe("message quoting on independent panes", { concurrency: 16 }, () => {
  for (const agent of Object.keys(CLIS)) {
    for (const [name, text] of Object.entries(TEXTS)) {
      for (const [where, bare] of [["on a free composer", false], ["in the last row of the screen", true]]) {
        test(`${agent}: "${name}" ${where} is pasted and submitted`, async () => {
          const { events, held } = await deliver(agent, text, "free composer", bare);
          assert.equal(held, null);
          assert.deepEqual(events, ["paste", "enter"]);
        });
      }

      for (const screen of ["approval drawn below the composer", "a y/n question drawn below the composer", "approval replaces the composer"]) {
        test(`${agent}: "${name}" then ${screen}: Enter is withheld`, async () => {
          const { events, held } = await deliver(agent, text, screen);
          assert.match(held ?? "", /appeared after the text was typed/);
          assert.deepEqual(events, ["paste"]);
        });
      }
    }
  }
});
