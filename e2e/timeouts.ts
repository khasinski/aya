// Every deadline the e2e suite runs under. Shared with the spec that pins
// them, so a retune cannot silently break the relations between them.

const MINUTE = 60_000;

/** One test, including its Electron launch. */
export const PER_TEST_TIMEOUT_MS = 45_000;

/** A single `expect` poll inside a test. */
export const EXPECT_TIMEOUT_MS = 10_000;

/** A test that boots the app and waits on a real program in a pane. */
export const AGENT_TEST_TIMEOUT_MS = 120_000;

/** That program, typically under a login shell, starting in its pane. */
export const AGENT_START_TIMEOUT_MS = 60_000;

/** Held team messages are retried this often; the value lives in
 *  electron/team-ipc.ts, and tests/e2e-timeouts-parity.test.mjs pins this copy to it. */
export const TEAM_REDELIVERY_MS = 15_000;

/** Suite ceiling, local doubles CI's: 10m cut CI at 194 of 204 tests, 5m before it (afcb072).
 *  An overrun fails tests mid-flight; PWDEBUG, --debug and UI mode run with no deadline. */
export function globalTimeout(env: NodeJS.ProcessEnv): number | undefined {
  if (env.PWDEBUG) return undefined;
  return env.CI ? 15 * MINUTE : 30 * MINUTE;
}
