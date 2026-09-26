// Every deadline the e2e suite runs under. Shared with the spec that pins
// them, so a retune cannot silently break the relations between them.

const MINUTE = 60_000;

/** One test, including its Electron launch. */
export const PER_TEST_TIMEOUT_MS = 45_000;

/** A single `expect` poll inside a test. */
export const EXPECT_TIMEOUT_MS = 10_000;

/** Suite ceiling. Local doubles CI's: a loaded laptop is slower, and an overrun
 *  kills tests mid-flight as content failures (5m did, afcb072). PWDEBUG covers
 *  `PWDEBUG=1 playwright test`; `--debug` and UI mode zero the deadline anyway. */
export function globalTimeout(env: NodeJS.ProcessEnv): number | undefined {
  if (env.PWDEBUG) return undefined;
  return env.CI ? 10 * MINUTE : 20 * MINUTE;
}
