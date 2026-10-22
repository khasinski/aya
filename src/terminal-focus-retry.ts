/**
 * A scheduled terminal-focus retry may run only while the element that owned
 * focus when the retry was scheduled still owns it. This lets retries recover
 * a terminal that was not measurable yet without stealing focus after the user
 * has moved to a control.
 */
export function terminalFocusRetryStillOwned(
  expectedActiveElement: Element | null,
  activeElement: Element | null,
): boolean {
  return activeElement === expectedActiveElement;
}
