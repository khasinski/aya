import { type ITheme } from "@xterm/xterm";
import type {
  TerminalState,
  ThemeColors
} from "../types";

// ASCII range/offset for the Ctrl+<letter> -> control-byte mapping below:
// 'a'(97)..'z'(122) minus 96 yields 0x01..0x1A.
export const ASCII_LOWER_A = 97;

export const ASCII_LOWER_Z = 122;

export const CTRL_BYTE_OFFSET = 96;

export const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`]+/i;

export const URL_TRAILING_PUNCTUATION_RE = /[),.;\]]+$/;

export const EXTERNAL_LINK_PROTOCOLS = new Set([
  "http:",
  "https:",
  "file:",
  "vscode:",
  "vscode-insiders:",
  "cursor:",
  "zed:",
  "jetbrains:",
]);


/** Our internal ThemeColors shape is a superset of xterm.js's ITheme. This
 *  just hands it through - separate function so the call site stays clean. */
export function toXtermTheme(c: ThemeColors): ITheme {
  return c;
}


// Last-activity age units; a "month" is 30 days.
export const MINUTE_MS = 60 * 1000;

export const HOUR_MS = 60 * MINUTE_MS;

export const DAY_MS = 24 * HOUR_MS;

export const MONTH_MS = 30 * DAY_MS;


export function formatLastActivity(timestamp: number): string | null {
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  if (elapsedMs < MINUTE_MS) return null;
  if (elapsedMs < HOUR_MS) {
    const minutes = Math.floor(elapsedMs / MINUTE_MS);
    return `${minutes} min ago`;
  }
  if (elapsedMs < DAY_MS) {
    const hours = Math.floor(elapsedMs / HOUR_MS);
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  if (elapsedMs < MONTH_MS) {
    const days = Math.floor(elapsedMs / DAY_MS);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }
  const months = Math.floor(elapsedMs / MONTH_MS);
  return `${months} ${months === 1 ? "month" : "months"} ago`;
}


export function lastActivityRenderBucket(timestamp: number | undefined): string {
  if (!timestamp) return "";
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  if (elapsedMs < MINUTE_MS) return "now";
  if (elapsedMs < HOUR_MS) return `m:${Math.floor(elapsedMs / MINUTE_MS)}`;
  if (elapsedMs < DAY_MS) return `h:${Math.floor(elapsedMs / HOUR_MS)}`;
  if (elapsedMs < MONTH_MS) return `d:${Math.floor(elapsedMs / DAY_MS)}`;
  return `mo:${Math.floor(elapsedMs / MONTH_MS)}`;
}


export function recoveryTitle(
  reason: NonNullable<TerminalState["spawnFailure"]>["reason"],
): string {
  if (reason === "command-not-found") return "Command not found";
  if (reason === "pane-limit-reached") return "Aya's terminal limit has been reached";
  if (reason === "preset-empty-command") return "Preset command is empty";
  if (reason === "cwd-missing") return "Project folder is missing";
  if (reason === "cwd-not-directory") return "Project path is not a folder";
  if (reason === "cwd-unreadable") return "Project folder is not readable";
  return "Terminal failed to start";
}


export function printableControlData(data: string): string {
  return data
    .replace(/\x1b/g, "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (ch) => {
      return `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
    })
    .slice(0, INPUT_LOG_MAX_CHARS);
}


export function firstHttpUrl(text: string): string | null {
  const match = text.match(URL_IN_TEXT_RE);
  if (!match) return null;
  return match[0].replace(URL_TRAILING_PUNCTUATION_RE, "");
}


export function anchorExternalUrl(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  try {
    const parsed = new URL(anchor.href);
    return EXTERNAL_LINK_PROTOCOLS.has(parsed.protocol) ? anchor.href : null;
  } catch {
    return null;
  }
}

const INPUT_LOG_MAX_CHARS = 240;
