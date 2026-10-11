// Lines of React's component stack under the error: enough to name the panel that failed.
const COMPONENT_STACK_LINES = 6;

/** What the error screen shows and lets the user copy: the error, then where in the window it happened. */
export function errorDetails(error: unknown, componentStack?: string | null): string {
  const head = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = (componentStack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, COMPONENT_STACK_LINES);
  return [head, ...stack].join("\n");
}
