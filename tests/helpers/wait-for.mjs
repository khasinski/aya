/** Wait until predicate() returns truthy or ms elapses. */
export async function waitFor(predicate, ms = 4000, step = 25) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}
