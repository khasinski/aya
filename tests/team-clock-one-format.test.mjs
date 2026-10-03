// The team's times read the same everywhere: one HH:MM format for the window, as main's, never a 12-hour locale one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const view = await import("../dist-test/team-view.js");
const { clock: mainClock, ROUND_CHECK_MIN_MS } = await import("../dist-electron/team-times.js");

const local = (h, m) => new Date(2026, 8, 30, h, m).toISOString();
const ROWS = [
  [local(0, 5), "00:05"],
  [local(9, 30), "09:30"],
  [local(13, 5), "13:05"],
  [local(23, 59), "23:59"],
];
for (const [iso, want] of ROWS) {
  test(`team clock | ${want} -> the window and main write ${want}`, () => {
    assert.equal(view.clock(iso), want);
    assert.equal(mainClock(iso), want);
  });
}

test("team clock | the chat shows its times with the window's clock, not its own format", () => {
  const chat = readFileSync(new URL("../src/components/TeamChat.tsx", import.meta.url), "utf-8");
  assert.match(chat, /import \{[^}]*\bclock\b[^}]*\} from "\.\.\/team-view"/);
  assert.doesNotMatch(chat, /toLocaleTimeString|const clock\s*=/);
});

test("round clock | it looks every tenth of the repeat silence, never more often than every 50 ms", () => {
  const url = new URL("../dist-electron/team-times.js", import.meta.url).href;
  const roundCheck = (minuteMs) =>
    Number(execFileSync(process.execPath, ["--input-type=module", "-e", `console.log((await import("${url}")).ROUND_CHECK_MS)`], { env: { ...process.env, AYA_E2E_TEAM_MINUTE_MS: minuteMs } }));
  assert.equal(roundCheck(""), 60_000);
  assert.equal(roundCheck("3000"), 3_000);
  assert.equal(roundCheck("1"), ROUND_CHECK_MIN_MS);
  assert.equal(ROUND_CHECK_MIN_MS, 50);
});

test("blocked screen | it counts after 2 wall-clock minutes, whatever the cadence minute; the e2e override shortens it", () => {
  const url = new URL("../dist-electron/team-times.js", import.meta.url).href;
  const blockedAfter = (env) =>
    Number(execFileSync(process.execPath, ["--input-type=module", "-e", `console.log((await import("${url}")).BLOCKED_AFTER_MS)`], { env: { ...process.env, AYA_E2E_TEAM_BLOCKED_MS: "", AYA_E2E_TEAM_MINUTE_MS: "", ...env } }));
  assert.equal(blockedAfter({}), 120_000);
  assert.equal(blockedAfter({ AYA_E2E_TEAM_MINUTE_MS: "1000" }), 120_000);
  assert.equal(blockedAfter({ AYA_E2E_TEAM_BLOCKED_MS: "6000" }), 6_000);
});
