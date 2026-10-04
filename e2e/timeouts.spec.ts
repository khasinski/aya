import { expect, test } from "@playwright/test";
import { SILENCE_REPEAT_MIN, STALL_AFTER_MIN } from "../dist-electron/team-times.js";
import { QUIET_MINUTE_MS, QUIET_NO_ROUND_MS, RHYTHM_MINUTE_MS, TEAM_AGENT_READY_TIMEOUT_MS } from "./helpers/team";
import { AGENT_START_TIMEOUT_MS, AGENT_TEST_TIMEOUT_MS, PER_TEST_TIMEOUT_MS, globalTimeout } from "./timeouts";

const CI_CEILING = 15 * 60_000;
const LOCAL_CEILING = 30 * 60_000;

test("the runner's effective deadline is the one this helper returns", () => {
  expect(test.info().config.globalTimeout).toBe(
    globalTimeout(process.env) ?? 0,
  );
});

test("CI gets the tighter ceiling", () => {
  expect(globalTimeout({ CI: "true" })).toBe(CI_CEILING);
});

test("local gets the looser one", () => {
  expect(globalTimeout({})).toBe(LOCAL_CEILING);
});

test("both ceilings outlast a single test, and local outlasts CI", () => {
  expect(globalTimeout({})!).toBeGreaterThan(globalTimeout({ CI: "1" })!);
  expect(globalTimeout({ CI: "1" })!).toBeGreaterThan(PER_TEST_TIMEOUT_MS);
});

test("an agent test outlasts a plain one, and its agent's start", () => {
  expect(AGENT_TEST_TIMEOUT_MS).toBeGreaterThan(PER_TEST_TIMEOUT_MS);
  expect(AGENT_TEST_TIMEOUT_MS).toBeGreaterThan(AGENT_START_TIMEOUT_MS);
});

test("CI is read for truthiness, like forbidOnly and retries beside it", () => {
  expect(globalTimeout({ CI: "" })).toBe(LOCAL_CEILING);
  expect(globalTimeout({ CI: "false" })).toBe(CI_CEILING);
});

test("PWDEBUG removes the deadline, and outranks CI", () => {
  expect(globalTimeout({ PWDEBUG: "1" }) ?? 0).toBe(0);
  expect(globalTimeout({ PWDEBUG: "1", CI: "true" }) ?? 0).toBe(0);
});

test("the config uses these constants, not its own copies", () => {
  expect(test.info().timeout).toBe(PER_TEST_TIMEOUT_MS);
});

test("a quiet-team spec stalls within the ready wait, and its no-round wait outlasts the repeat window", () => {
  expect(STALL_AFTER_MIN * QUIET_MINUTE_MS).toBeLessThan(TEAM_AGENT_READY_TIMEOUT_MS);
  expect(QUIET_NO_ROUND_MS).toBeGreaterThan(SILENCE_REPEAT_MIN * QUIET_MINUTE_MS);
});

test("a rhythm spec's stall comes after the test", () => {
  expect(STALL_AFTER_MIN * RHYTHM_MINUTE_MS).toBeGreaterThan(PER_TEST_TIMEOUT_MS);
});
