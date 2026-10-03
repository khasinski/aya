// Every deadline the e2e suite runs under. Shared with the spec that pins
// them, so a retune cannot silently break the relations between them.

const MINUTE = 60_000;

/** One test, including its Electron launch. */
export const PER_TEST_TIMEOUT_MS = 45_000;

/** A single `expect` poll inside a test. */
export const EXPECT_TIMEOUT_MS = 10_000;

/** A wait on something behind a login shell or a program in a pane (a stand-in CLI, an env dump). */
export const SLOW_EXPECT_TIMEOUT_MS = 3 * EXPECT_TIMEOUT_MS;

/** A test that boots the app and waits on a real program in a pane. */
export const AGENT_TEST_TIMEOUT_MS = 120_000;

/** That program, typically under a login shell, starting in its pane. */
export const AGENT_START_TIMEOUT_MS = 60_000;

/** Held team messages are retried this often; the value lives in
 *  electron/team-ipc.ts, and tests/e2e-timeouts-parity.test.mjs pins this copy to it. */
export const TEAM_REDELIVERY_MS = 15_000;

/** The period team specs run held-message redelivery at (AYA_E2E_TEAM_REDELIVERY_MS); TEAM_REDELIVERY_MS stays the ceiling for a spec that does not set it. */
export const E2E_REDELIVERY_MS = 3_000;

/** A team test that quits and relaunches the app: two boots, a redelivery pass and a few rounds. */
export const TEAM_RELAUNCH_TEST_TIMEOUT_MS = 2 * MINUTE;

/** Suite ceiling with isolated specs running in parallel; local doubles CI's.
 *  An overrun fails tests mid-flight; PWDEBUG, --debug and UI mode run with no deadline. */
export function globalTimeout(env: NodeJS.ProcessEnv): number | undefined {
  if (env.PWDEBUG) return undefined;
  return env.CI ? 15 * MINUTE : 30 * MINUTE;
}
