import { PaneHeldError, TextPastedError } from "./team-control";
import { PTY_HOST_INPUT_UNCERTAIN } from "./pty-core-constants";

/** Unknown host receipts must be treated like a paste that may already exist. */
export function inputMayHaveBeenWritten(error: unknown): boolean {
  return error instanceof TextPastedError || error instanceof PaneHeldError && error.typed ||
    !!error && typeof error === "object" && "code" in error && error.code === PTY_HOST_INPUT_UNCERTAIN;
}
