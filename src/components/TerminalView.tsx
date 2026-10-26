import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { createRendererVt,restoreRendererVt,type RendererVtCheckpoint } from "../terminal-vt-checkpoint";
import {registerCheckpointTerminal} from "../terminal-checkpoint-registry";
import {registerPendingTerminalAttach} from "../pending-terminal-attach";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import type {
  HarnessSearchHit,
  HarnessSearchResult,
  Preset,
  Snippet,
  TerminalState,
  ThemeColors,
} from "../types";
import { formatHarnessSearchCoverage } from "../harness-search-coverage";
import { beginHistorySearch } from "../harness-search-sequence";
import { FindBarCoverageLine } from "./FindBarCoverageLine";
import { effectiveAgent } from "../agentPreset";
import { ptyEventBus } from "../ptyEventBus";
import type { SettingsTab } from "../settings-tabs";
import { focusReportingState } from "../focus-reporting";
import { enterKeyAction, META_ENTER } from "../terminal-keys";
import {
  leftOptionMetaSequence,
  optionSideFromCode,
  shouldUseXtermOptionAsMeta,
  type MacOptionKeyMode,
  type OptionSide,
} from "../terminal-option-key";
import {
  normalizeTerminalLinkUnderline,
  shouldPreserveTerminalScrollback,
  shouldUseTerminalWebgl,
  stripScrollbackErase,
} from "../terminal-rendering";
import { snippetPtyPayload } from "../snippet-payload";
import { DEBUG_TERMINAL_INPUT_STORAGE_KEY } from "../storage-keys";
import { GPU_RELAUNCHED_EVENT } from "../window-events";
import {
  hadNoSession,
  markNoSession,
  markMountDecided,
  wasMountDecided,
  wasSpawned,
} from "../spawnSession";
import { SnippetBar } from "./SnippetBar";
import { terminalFocusRetryStillOwned } from "../terminal-focus-retry";
import { displayIpcError, UPDATE_SPAWN_REFUSAL } from "../update-spawn";
import { ipcMessage } from "./use-async-action";

// Terminal sizing + timing constants. The fallback cols/rows are the standard
// 80x24 a PTY gets before xterm has measured the pane (used at every spawn).
const TERMINAL_FALLBACK_COLS = 80;
const TERMINAL_FALLBACK_ROWS = 24;
const DEFAULT_TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace';
// Lines of scrollback xterm keeps in memory per terminal.
const SCROLLBACK_LINES = 10_000;
// Wheel-scroll easing: ~8 frames at 60Hz - smooth without feeling sluggish.
const SMOOTH_SCROLL_DURATION_MS = 125;
// Delay before re-fitting/repainting a freshly-shown terminal, giving xterm a
// beat to finish measuring after a visibility/layout change.
const RENDER_REPAIR_DELAY_MS = 80;
// Retry delay for focusing the active terminal once it's done measuring.
const FOCUS_RETRY_DELAY_MS = 60;
// How long to keep showing "Restoring sessions…" before assuming the replay
// arrived (or there was nothing to replay).
// ASCII range/offset for the Ctrl+<letter> -> control-byte mapping below:
// 'a'(97)..'z'(122) minus 96 yields 0x01..0x1A.
const ASCII_LOWER_A = 97;
const ASCII_LOWER_Z = 122;
const CTRL_BYTE_OFFSET = 96;

const RESTORE_FALLBACK_MS = 2_500;
const INPUT_LOG_MAX_CHARS = 240;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`]+/i;
const URL_TRAILING_PUNCTUATION_RE = /[),.;\]]+$/;
const EXTERNAL_LINK_PROTOCOLS = new Set([
  "http:",
  "https:",
  "file:",
  "vscode:",
  "vscode-insiders:",
  "cursor:",
  "zed:",
  "jetbrains:",
]);
const TERMINAL_CONTEXT_MENU_WIDTH = 170;
const TERMINAL_CONTEXT_MENU_MAX_HEIGHT = 132;
const TERMINAL_CONTEXT_MENU_VIEWPORT_MARGIN = 8;

interface TerminalContextMenuState {
  x: number;
  y: number;
  selectedText: string;
  link: string | null;
}

interface Props {
  terminal: TerminalState;
  preset: Preset;
  command: string;
  /** What to spawn instead when a peer pane runs in the same folder. */
  sharedDirCommand?: string;
  peerCwds?: string[];
  /** Saved snippets the user can inject into this terminal via the drawer. */
  snippets: Snippet[];
  snippetsOpen: boolean;
  onSnippetsOpenChange: (open: boolean) => void;
  isVisible: boolean;
  cwd: string;
  lastActivity?: number;
  fontFamily?: string;
  fontSize: number;
  themeColors: ThemeColors;
  /** When true, render the in-pane search bar (Cmd+F target). */
  findOpen: boolean;
  /** Called when the user closes the search bar (Esc / ✕). */
  onCloseFind: () => void;
  /** Experimental "Harness-aware search": offer a History mode in the find
   *  bar for Claude/Codex tabs, searching the agent's on-disk session
   *  transcripts for this cwd. Off for remote projects (transcripts live on
   *  the remote host). */
  historySearchEnabled?: boolean;
  onOpenSettings: (tab?: SettingsTab) => void;
  onCloseProject: (slug: string) => void;
  onPtyData?: (chunk: string) => void;
  macOptionKeyMode: MacOptionKeyMode;
  /** Called when the user requests a restart of an exited PTY via the
   *  Shift+Enter hint. The host resets the terminal's exitCode/status so the
   *  PTY event loop can flow again. */
  onRequestRestart?: () => void;
  /** Marks a rejected spawn as stopped so the pane never claims to be running without a PTY. */
  onSpawnFailure?: (terminalId: string) => void;
  /** Bumped by App when the user right-clicks → Restart on this terminal.
   *  The component reuses its xterm instance and spawns a fresh PTY. */
  restartTrigger: number;
  isActivePane?: boolean;
  /** Absolute position within the pane container, from the layout tree.
   *  Undefined in single-pane view, where the pane simply fills its parent. */
  paneStyle?: { left: string; top: string; width: string; height: string };
  /** True when this is THE terminal the user is interacting with right now:
   *  active project + active tab + active split cell, and no overlay/modal is
   *  open. Drives deterministic keyboard focus (see the focus effect below). */
  isActive?: boolean;
  onActivatePane?: () => void;
  enableWebgl?: boolean;
}

/** Our internal ThemeColors shape is a superset of xterm.js's ITheme. This
 *  just hands it through - separate function so the call site stays clean. */
function toXtermTheme(c: ThemeColors): ITheme {
  return c;
}

// Last-activity age units; a "month" is 30 days.
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

function formatLastActivity(timestamp: number): string | null {
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

function lastActivityRenderBucket(timestamp: number | undefined): string {
  if (!timestamp) return "";
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  if (elapsedMs < MINUTE_MS) return "now";
  if (elapsedMs < HOUR_MS) return `m:${Math.floor(elapsedMs / MINUTE_MS)}`;
  if (elapsedMs < DAY_MS) return `h:${Math.floor(elapsedMs / HOUR_MS)}`;
  if (elapsedMs < MONTH_MS) return `d:${Math.floor(elapsedMs / DAY_MS)}`;
  return `mo:${Math.floor(elapsedMs / MONTH_MS)}`;
}

function recoveryTitle(
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

function terminalRenderStateEqual(a: TerminalState, b: TerminalState): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.projectSlug === b.projectSlug &&
      a.presetId === b.presetId &&
      a.name === b.name &&
      a.exitCode === b.exitCode &&
      a.stopped === b.stopped &&
      a.disconnected === b.disconnected &&
      a.disconnectedReason === b.disconnectedReason &&
      a.remoteReconnectDelayMs === b.remoteReconnectDelayMs &&
      a.remoteDisconnected === b.remoteDisconnected &&
      a.remoteReplayTruncated === b.remoteReplayTruncated &&
      a.recoveryGeneration === b.recoveryGeneration &&
      a.recoveryNotice === b.recoveryNotice &&
      a.recoveryScreenUnknown === b.recoveryScreenUnknown &&
      a.recoveryBlocked === b.recoveryBlocked &&
      a.recoveryRetryable === b.recoveryRetryable &&
      a.spawnDeferred === b.spawnDeferred &&
      a.spawnFailure?.reason === b.spawnFailure?.reason &&
      a.spawnFailure?.detail === b.spawnFailure?.detail &&
      a.externalStatus?.text === b.externalStatus?.text &&
      a.externalStatus?.level === b.externalStatus?.level &&
      a.externalStatus?.updatedAt === b.externalStatus?.updatedAt)
  );
}

function presetRenderStateEqual(a: Preset, b: Preset): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.icon === b.icon &&
      a.color === b.color &&
      a.themeId === b.themeId)
  );
}

function terminalViewPropsEqual(a: Props, b: Props): boolean {
  return (
    terminalRenderStateEqual(a.terminal, b.terminal) &&
    presetRenderStateEqual(a.preset, b.preset) &&
    a.command === b.command &&
    a.sharedDirCommand === b.sharedDirCommand &&
    (a.peerCwds ?? []).join("\0") === (b.peerCwds ?? []).join("\0") &&
    a.snippets === b.snippets &&
    a.snippetsOpen === b.snippetsOpen &&
    a.isVisible === b.isVisible &&
    a.cwd === b.cwd &&
    lastActivityRenderBucket(a.lastActivity) ===
      lastActivityRenderBucket(b.lastActivity) &&
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.themeColors === b.themeColors &&
    a.findOpen === b.findOpen &&
    a.historySearchEnabled === b.historySearchEnabled &&
    a.restartTrigger === b.restartTrigger &&
    a.isActivePane === b.isActivePane &&
    a.paneStyle?.left === b.paneStyle?.left &&
    a.paneStyle?.top === b.paneStyle?.top &&
    a.paneStyle?.width === b.paneStyle?.width &&
    a.paneStyle?.height === b.paneStyle?.height &&
    a.isActive === b.isActive &&
    a.enableWebgl === b.enableWebgl &&
    a.macOptionKeyMode === b.macOptionKeyMode
  );
}

function printableControlData(data: string): string {
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

function firstHttpUrl(text: string): string | null {
  const match = text.match(URL_IN_TEXT_RE);
  if (!match) return null;
  return match[0].replace(URL_TRAILING_PUNCTUATION_RE, "");
}

function anchorExternalUrl(target: EventTarget | null): string | null {
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

function TerminalViewComponent({
  terminal,
  preset,
  command,
  sharedDirCommand,
  peerCwds,
  snippets,
  snippetsOpen,
  onSnippetsOpenChange,
  isVisible,
  cwd,
  lastActivity,
  fontFamily,
  fontSize,
  themeColors,
  findOpen,
  onCloseFind,
  historySearchEnabled = false,
  onOpenSettings,
  onCloseProject,
  onPtyData,
  onRequestRestart,
  onSpawnFailure,
  restartTrigger,
  isActivePane = false,
  paneStyle,
  isActive = false,
  onActivatePane,
  enableWebgl = true,
  macOptionKeyMode,
}: Props) {
  const shouldUseWebgl =
    shouldUseTerminalWebgl(enableWebgl, preset.id) &&
    // Under test automation (Playwright/WebDriver) force xterm's DOM renderer:
    // the e2e tests read rendered text from `.xterm-rows`, which the WebGL
    // renderer paints to a canvas instead. Real users never set this flag.
    !navigator.webdriver;
  const shouldPreserveScrollback =
    shouldPreserveTerminalScrollback(preset.id);
  // History (transcript) search is only meaningful for tabs running a
  // harness that persists sessions we know how to read.
  const presetAgent = effectiveAgent(preset);
  const findHistoryAgent =
    historySearchEnabled && (presetAgent === "claude" || presetAgent === "codex")
      ? presetAgent
      : null;
  const lastActivityLabel = lastActivity ? formatLastActivity(lastActivity) : null;
  const reported = terminal.externalStatus;
  const headerStatusText = reported ? `${reported.on ? `waiting on ${reported.on}: ` : ""}${reported.text}` : lastActivityLabel;
  const headerStatusTitle = terminal.externalStatus
    ? new Date(terminal.externalStatus.updatedAt).toLocaleString()
    : lastActivity
      ? new Date(lastActivity).toLocaleString()
      : undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const visibleRef=useRef(isVisible);visibleRef.current=isVisible;
  const deferredHandoverAttachRef=useRef<(()=>void)|null>(null);
  useEffect(()=>{if(isVisible)deferredHandoverAttachRef.current?.();},[isVisible]);
  const handoverInputPausedRef = useRef(false);
  const retireHandoverForRestartRef=useRef<(()=>void)|null>(null);
  const [historyNotice,setHistoryNotice]=useState<string|null>(null);
  const recoveryNoticeRef=useRef(terminal.recoveryNotice);recoveryNoticeRef.current=terminal.recoveryNotice;
  const recoveryGenerationRef=useRef(terminal.recoveryGeneration);
  useEffect(()=>{recoveryGenerationRef.current=terminal.recoveryGeneration;},[terminal.recoveryGeneration]);
  const disconnectedRef = useRef(!!terminal.disconnected);
  disconnectedRef.current = !!terminal.disconnected;
  const remoteReadOnlyRef = useRef(!!terminal.remoteReadOnly);
  remoteReadOnlyRef.current = !!terminal.remoteReadOnly;
  useEffect(() => {
    if (xtermRef.current) xtermRef.current.options.disableStdin = !!terminal.disconnected || !!terminal.remoteReadOnly || handoverInputPausedRef.current;
  }, [terminal.disconnected, terminal.remoteReadOnly]);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  // Guards the construction->loadAddon window so a synchronously-delivered
  // context loss can't re-enter attachWebgl mid-attach.
  const attachingWebglRef = useRef(false);
  const spawnedRef = useRef(false);
  // True while a full-screen/rich TUI (claude, codex, vim…) is running, detected
  // via focus-reporting mode (DECSET 1004). Gates the Shift+Enter soft newline.
  const richInputRef = useRef(false);
  const fitFrameRef = useRef<number | null>(null);
  // Set once we have emitted the first real (non-replay) PTY data chunk for a
  // freshly-started terminal. Lets us issue one post-load PTY reassert exactly
  // once so harnesses like grok pick up the real geometry via SIGWINCH.
  const didPostLoadResizeRef = useRef(false);
  const replayingOutputRef = useRef(0);
  const optionSideRef = useRef<OptionSide>("unknown");
  const macOptionKeyModeRef = useRef(macOptionKeyMode);
  macOptionKeyModeRef.current = macOptionKeyMode;
  const [findQuery, setFindQuery] = useState("");
  const [isScrollbarHidden, setIsScrollbarHidden] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);
  // Ref mirror so the per-chunk PTY handler can check-and-clear without
  // dispatching a React state update on every data chunk (the value flips
  // once per restore, but the handler runs hundreds of times per second
  // under busy agent output).
  const isRestoringRef = useRef(true);
  const markRestoring = useCallback((value: boolean) => {
    isRestoringRef.current = value;
    setIsRestoring(value);
  }, []);
  const handleAttachmentFailure = useCallback((term: XTerm, error: unknown) => {
    if(xtermRef.current!==term)return;
    handoverInputPausedRef.current=false;
    if(disconnectedRef.current||String(error).includes("The terminal host is disconnected or recovering. This request was not sent.")){
      disconnectedRef.current=true;term.options.disableStdin=true;
      setHistoryNotice(notice=>notice??"The terminal host is disconnected. The process may still be running; input remains disabled.");
    }else{
      term.options.disableStdin=remoteReadOnlyRef.current;
      // The host can refuse a spawn before it emits the usual no-session
      // event (for example while preparing an update). Remember that this
      // pane has no live session so a later view remount does not silently
      // turn into an automatic retry. An explicit Restart clears the marker.
      markNoSession(terminal.id);
      onSpawnFailure?.(terminal.id);
      const message = displayIpcError(error).replace(/[\x00-\x1f\x7f]/g, " ");
      if (message === UPDATE_SPAWN_REFUSAL) setHistoryNotice(message);
      else term.write(`\r\n[Terminal attachment failed: ${message}]\r\n`);
    }
    markRestoring(false);
  },[markRestoring, onSpawnFailure, terminal.id]);
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState | null>(
    null,
  );
  const [attachmentNotice, setAttachmentNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [copiedAttachmentPath, setCopiedAttachmentPath] = useState<string | null>(null);
  useEffect(() => {
    const onAttachmentResult = (event: Event) => {
      const detail = (event as CustomEvent<{
        terminalId: string;
        kind: "files" | "image";
        count: number;
        phase: "started" | "finished";
        result?: { status: string; message?: string; copyText?: string };
        error?: string;
      }>).detail;
      if (!detail || detail.terminalId !== terminal.id) return;
      if (detail.phase === "started") {
        setCopiedAttachmentPath(null);
        setAttachmentNotice({ text: detail.kind === "image" ? "Saving the clipboard image..." : "Adding file paths...", error: false });
        return;
      }
      if (detail.error) {
        setAttachmentNotice({ text: detail.error.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), error: true });
      } else if (detail.result?.status === "not-image") {
        setAttachmentNotice(null);
      } else if (detail.result?.status === "copied-not-added") {
        setAttachmentNotice({ text: detail.result.message ?? "The path was not added. Nothing was typed.", error: true });
        setCopiedAttachmentPath(detail.result.copyText ?? null);
      } else {
        setAttachmentNotice({ text: detail.kind === "image" ? "Image saved and its path added. Nothing was submitted." : `${detail.count === 1 ? "File path added" : `${detail.count} file paths added`}. Nothing was submitted.`, error: false });
      }
    };
    document.addEventListener("aya:prompt-attachment-result", onAttachmentResult);
    return () => document.removeEventListener("aya:prompt-attachment-result", onAttachmentResult);
  }, [terminal.id]);
  const sendInput = useCallback((data: string) => {
    if(handoverInputPausedRef.current)return;
    const showFailure = (detail: string) => xtermRef.current?.write(`\r\n[${detail}]\r\n`);
    void window.aya.ptyWrite(terminal.id, data).then(delivered => {
      if (delivered === false) showFailure("Input was not delivered. Check the pane before retrying. Aya did not resend it.");
    }).catch(error => {
      const reason = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]/g, " ");
      showFailure(`Input may have been only partly delivered. Check the pane before retrying. Aya did not resend it. ${reason}`);
    });
  }, [terminal.id]);

  // Write a saved snippet's text into this terminal's PTY. autoRun appends a
  // carriage return so it executes immediately; otherwise we only type the
  // text and leave the cursor for the user to edit/extend. Either way we
  // return focus to the terminal so the user can keep working.
  const sendSnippet = useCallback(
    (snippet: Snippet) => {
      if (terminal.disconnected) {
        xtermRef.current?.write("\r\n[Input was not sent: the terminal host is disconnected.]\r\n");
        onSnippetsOpenChange(false);
        return;
      }
      // A dead PTY (exited / spawn-failed / killed by a host restart) silently
      // swallows ptyWrite, so the snippet would vanish with no feedback. Tell
      // the user in the terminal itself and skip the no-op write. exitCode is
      // non-null once the PTY has exited, and `stopped` marks a host-restart
      // kill; restarting (Shift+Enter) clears both.
      if (terminal.exitCode !== null || terminal.stopped) {
        try {
          xtermRef.current?.write(
            "\r\n\x1b[2maya: terminal has exited — press Shift+Enter to restart, then send the snippet again\x1b[0m\r\n",
          );
        } catch {
          /* ignore - terminal may be mid-dispose */
        }
        onSnippetsOpenChange(false);
        return;
      }
      sendInput(snippetPtyPayload(snippet));
      // Collapse the drawer so the result (and the typed text) is visible -
      // an open drawer covers the bottom of the terminal - and return focus
      // so the user can keep typing / press Enter on a held snippet.
      onSnippetsOpenChange(false);
      try {
        xtermRef.current?.focus();
      } catch {
        /* ignore - terminal may be mid-dispose */
      }
    },
    [terminal.exitCode, terminal.stopped, terminal.disconnected, onSnippetsOpenChange, sendInput],
  );
  // Current foreground-process title, fed by OSC 0/2 from the inner shell.
  // macOS zsh's default config emits this in preexec/precmd, so we get the
  // running command for free in shell tabs. Claude/Codex don't emit titles,
  // so the value stays whatever the shell last set (usually empty there).
  const [processTitle, setProcessTitle] = useState("");
  // Tracks whether the PTY has exited cleanly (code 0). When true, the
  // custom key handler honors Shift+Enter as "restart this terminal".
  // Stored in a ref so the long-lived xterm key handler always reads the
  // current value without re-attaching on every render.
  const canRestartRef = useRef(false);
  canRestartRef.current = terminal.exitCode === 0 || !!terminal.stopped;
  const commandRef = useRef(command);
  commandRef.current = command;
  const sharedRef = useRef({ sharedDirCommand, peerCwds });
  sharedRef.current = { sharedDirCommand, peerCwds };
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  // Restart the terminal in place: clear the host-side failed/exited state AND
  // actually spawn a new PTY (same xterm + scrollback). Used by the recovery
  // banner's "Restart" - without the spawn it would only clear the banner and
  // leave a "running" terminal with no process.
  const respawnInPlace = useCallback(() => {
    // Delegate to the restartTrigger path: onRequestRestart clears the failed
    // state AND bumps the trigger, whose effect spawns after the re-render
    // (with the resume-aware command) and resets didPostLoadResizeRef itself.
    onRequestRestart?.();
  }, [onRequestRestart]);

  const fitTerminal = useCallback((shouldFocus = false) => {
    if (fitFrameRef.current !== null) {
      cancelAnimationFrame(fitFrameRef.current);
    }
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      const host = containerRef.current;
      const term = xtermRef.current;
      const fit = fitRef.current;
      if (!host || !term || !fit) return;
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fit.fit();
        term.refresh(0, Math.max(term.rows - 1, 0));
        if (shouldFocus) term.focus();
      } catch {
        /* ignore - xterm may be mid-dispose or still measuring fonts */
      }
    });
  }, []);

  /**
   * Force the PTY/child to re-know the terminal size by emitting a SIGWINCH.
   * - For ordinary shells: re-send the current size (harmless idempotent SIGWINCH).
   * - For rich TUIs (richInputRef via DECSET 1004): nudge size by one row then
   *   restore so the harness perceives a size *change* and redraws its
   *   static/fullscreen layout from its internal model.
   *
   * We never call term.resize() / fitTerminal() here so the xterm-side state
   * is untouched (preserves the "no reflow on re-show" contract for scrollback).
   * We never synthesize keyboard input like ^L either, since several harnesses
   * (grok) use ^L for their own features.
   */
  const forcePtyReassert = useCallback(() => {
    const t = xtermRef.current;
    if (!t || t.cols <= 0 || t.rows <= 0 || handoverInputPausedRef.current) return;
    const c = t.cols;
    const r = t.rows;
    if (richInputRef.current) {
      void window.aya.ptyResize(terminal.id, c, r + 1).catch(()=>{});
      setTimeout(() => {
        const tt = xtermRef.current;
        if (tt && tt.cols === c && tt.rows === r) {
          void window.aya.ptyResize(terminal.id, c, r).catch(()=>{});
        }
      }, 0);
    } else {
      void window.aya.ptyResize(terminal.id, c, r).catch(()=>{});
    }
  }, [terminal.id]);

  // RECOVER: the expensive path. clearTextureAtlas() throws away the whole
  // glyph cache and forces every visible cell to re-rasterize - that full
  // re-raster is the visible "flash". Reserve it for the moments the atlas is
  // genuinely suspect (a lost/rebuilt GL context), NOT ordinary focus/resize.
  const recoverTerminalRender = useCallback(
    (shouldFocus = false) => {
      const refresh = () => {
        const term = xtermRef.current;
        if (!term) return;
        try {
          webglRef.current?.clearTextureAtlas();
          term.refresh(0, Math.max(term.rows - 1, 0));
        } catch {
          /* ignore - renderer may be recreating after sleep/wake */
        }
      };
      refresh();
      fitTerminal(shouldFocus);
      requestAnimationFrame(refresh);
      window.setTimeout(() => {
        refresh();
        fitTerminal(shouldFocus);
      }, RENDER_REPAIR_DELAY_MS);
    },
    [fitTerminal],
  );

  // REPAINT: the cheap path. Just re-runs the render from the EXISTING atlas
  // (no glyph re-raster, so no flash) and re-fits. Used by the high-frequency
  // lifecycle events (visibility, window focus, resume, resize) where the GL
  // context is intact and only a redraw/measure is needed. healWebgl() runs
  // ahead of these and handles the dead-context case with a real recover, so a
  // plain repaint here is sufficient. Coalesced via a scheduled flag so an
  // overlapping burst (focus + visibilitychange + isVisible firing together)
  // collapses to one rAF + one delayed pass instead of a storm.
  const repaintScheduledRef = useRef(false);
  // Coalesces the full-refresh triggered by an atlas page add/merge (see the
  // onAddTextureAtlasCanvas handler in attachWebgl) so a warm-up burst of page
  // creations collapses to a single rAF repaint.
  const atlasRefreshScheduledRef = useRef(false);
  const repaintTerminal = useCallback(
    (shouldFocus = false) => {
      const refresh = () => {
        const term = xtermRef.current;
        if (!term) return;
        try {
          term.refresh(0, Math.max(term.rows - 1, 0));
        } catch {
          /* ignore - xterm may be mid-dispose or still measuring */
        }
      };
      refresh();
      fitTerminal(shouldFocus);
      if (repaintScheduledRef.current) return;
      repaintScheduledRef.current = true;
      requestAnimationFrame(refresh);
      window.setTimeout(() => {
        repaintScheduledRef.current = false;
        refresh();
        fitTerminal(shouldFocus);
      }, RENDER_REPAIR_DELAY_MS);
    },
    [fitTerminal],
  );

  const attachWebgl = useCallback(
    (term: XTerm) => {
      if (!shouldUseWebgl || webglRef.current || attachingWebglRef.current) return;
      // Never hold a WebGL context in a hidden/occluded window - it's exactly
      // what the GPU evicts into a white quad. The visibility flip re-attaches.
      if (document.visibilityState === "hidden") return;
      attachingWebglRef.current = true;
      try {
        const webgl = new WebglAddon();
        // A context loss can be delivered SYNCHRONOUSLY inside loadAddon; the
        // handler below then disposes this very addon while the attaching
        // guard still blocks its retry. Without this flag we would assign the
        // already-disposed addon to webglRef right after loadAddon returns.
        let disposedDuringAttach = false;
        webgl.onContextLoss(() => {
          disposedDuringAttach = true;
          try {
            webgl.dispose();
          } catch {
            /* ignore */
          }
          if (webglRef.current === webgl) webglRef.current = null;
          recoverTerminalRender(false);
          // Come back on a FRESH context right away when we're visible (a lost
          // context is unusable forever - without this the terminal silently
          // degrades to the DOM renderer until remount). If the GPU is still
          // under pressure the attach throws -> caught -> DOM fallback stays
          // and the next resume retries via healWebgl.
          if (document.visibilityState === "visible") {
            const t = xtermRef.current;
            if (t) attachWebgl(t);
          }
        });
        term.loadAddon(webgl);
        if (disposedDuringAttach) {
          // The loss fired mid-load and the handler already disposed the
          // addon - leave the ref null; the next resume/heal attaches fresh.
          return;
        }
        webglRef.current = webgl;
        // STALE-GLYPH FIX: when the atlas overflows its page budget it
        // merges/repacks pages, relocating glyphs that the renderer has
        // already baked into vertex buffers for cells whose logical content
        // (code/fg/bg) hasn't changed. Those cells keep sampling the OLD atlas
        // slot -> a wrong character on screen. The addon arms an internal
        // "clear model" flag on merge, but nothing SCHEDULES the corrective
        // frame, so once output goes idle the wrong glyphs persist until an
        // unrelated redraw (classically: a mouse selection) fires. This event
        // fires on every page add/merge; force one coalesced full refresh to
        // consume that armed flag and repaint the relocated glyphs at once.
        webgl.onAddTextureAtlasCanvas(() => {
          if (atlasRefreshScheduledRef.current) return;
          atlasRefreshScheduledRef.current = true;
          requestAnimationFrame(() => {
            atlasRefreshScheduledRef.current = false;
            const t = xtermRef.current;
            if (!t) return;
            try {
              t.refresh(0, Math.max(t.rows - 1, 0));
            } catch {
              /* ignore - terminal may be mid-dispose */
            }
          });
        });
        recoverTerminalRender(false);
      } catch {
        // WebGL unavailable; DOM renderer is fine, just drifty. A failed attach
        // also STOPS any loss->retry chain (nothing new to lose) - and xterm
        // itself debounces onContextLoss by ~3s, so retries can't hot-spin.
      } finally {
        attachingWebglRef.current = false;
      }
    },
    [recoverTerminalRender, shouldUseWebgl],
  );

  // PREVENTION: a WebGL context held by a hidden/occluded window is what the
  // GPU evicts under memory pressure (e.g. a headless-Chrome PDF render in a
  // terminal); the compositor then paints the missing canvas texture as a
  // WHITE quad, the throttled renderer can't react, and the user returns to a
  // white terminal area for seconds (panels intact - only the canvas layer is
  // gone). Instead of racing that, drop WebGL the moment the document goes
  // hidden (the DOM renderer's layers survive eviction) and come back on a
  // FRESH context when it becomes visible again - nothing evictable exists
  // while we're in the background, so the white quad can't happen.
  useEffect(() => {
    if (!shouldUseWebgl) return;
    const onDocVisibility = () => {
      const term = xtermRef.current;
      if (!term) return;
      if (document.visibilityState === "hidden") {
        if (webglRef.current) {
          try {
            webglRef.current.dispose();
          } catch {
            /* ignore */
          }
          webglRef.current = null;
        }
        return;
      }
      attachWebgl(term); // fresh context + full repaint (no-op if attached)
      repaintTerminal(false);
    };
    document.addEventListener("visibilitychange", onDocVisibility);
    return () => document.removeEventListener("visibilitychange", onDocVisibility);
  }, [shouldUseWebgl, attachWebgl, repaintTerminal]);

  // BELT for paths with no visibility flip (focus regained without occlusion,
  // wake from sleep, a foreground driver reset whose event got coalesced): ask
  // the context itself (isContextLost()) instead of waiting for the throttled
  // webglcontextlost event, dispose the dead addon, and attach a fresh one
  // (which also repaints).
  const healWebgl = useCallback(() => {
    const term = xtermRef.current;
    if (!term || !shouldUseWebgl) return;
    if (webglRef.current) {
      const host = containerRef.current;
      let found = false;
      let lost = false;
      for (const c of Array.from(host?.querySelectorAll("canvas") ?? [])) {
        const gl = (c.getContext("webgl2") ||
          c.getContext("webgl")) as WebGLRenderingContext | null;
        if (gl) {
          found = true;
          lost = gl.isContextLost();
          break;
        }
      }
      // "Ref set but no WebGL canvas in the DOM" is a desync (partial dispose)
      // - treat it as unhealthy rather than returning and staying degraded.
      if (found && !lost) return; // healthy - nothing to heal
      try {
        webglRef.current.dispose();
      } catch {
        /* ignore */
      }
      webglRef.current = null;
    }
    attachWebgl(term); // fresh context + full repaint
  }, [attachWebgl, shouldUseWebgl]);

  // Create the xterm instance + spawn the PTY once.
  useEffect(() => {
    if (!containerRef.current || xtermRef.current) return;
    const term = createRendererVt({
      disableStdin: disconnectedRef.current || remoteReadOnlyRef.current,
      theme: toXtermTheme(themeColors),
      fontSize,
      fontFamily: fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: SCROLLBACK_LINES,
      // Animate between row positions on wheel scroll instead of snapping
      // one row at a time per tick. Terminal grids are inherently row-
      // quantized, but the snap is what reads as "choppy" when you flick
      // the trackpad. 125ms is about 8 frames at 60Hz: noticeable easing
      // without feeling sluggish.
      smoothScrollDuration: SMOOTH_SCROLL_DURATION_MS,
      scrollOnEraseInDisplay: true,
      // OSC 8 links (used for Markdown labels such as [OpenAI](...)) have a
      // separate activation path from URLs detected by WebLinksAddon. Without
      // this handler xterm shows its security warning and calls window.open,
      // which targets Aya's Electron window instead of the system browser.
      linkHandler: {
        activate: (event, uri) => {
          event.preventDefault();
          event.stopPropagation();
          void window.aya.openUrl(uri);
        },
      },
      // In iTerm-style mode, xterm must not globally convert Option+letter to
      // Meta: right Option needs to remain available for macOS compose/dead-key
      // input (Polish characters, accents). TerminalView reimplements left
      // Option+letter as Meta below.
      macOptionIsMeta: shouldUseXtermOptionAsMeta(macOptionKeyModeRef.current),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    const webLinks = new WebLinksAddon((event, uri) => {
      event.preventDefault();
      event.stopPropagation();
      void window.aya.openUrl(uri);
    });
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(webLinks);
    term.open(containerRef.current);
    if (disconnectedRef.current) {
      if(terminal.disconnectedReason)setHistoryNotice(terminal.disconnectedReason);
      term.write("\r\n\x1b[1;33m[terminal host disconnected - the process may still be running. Input is disabled while disconnected. Use Settings > Diagnostics > PTY host > Restart to review stopping it.]\x1b[0m\r\n");
    }

    const onTerminalLinkClick = (event: globalThis.MouseEvent) => {
      const url = anchorExternalUrl(event.target);
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      void window.aya.openUrl(url);
    };
    // The cleanup removes it from this node: by then the ref may point elsewhere.
    const container = containerRef.current;
    container.addEventListener("click", onTerminalLinkClick, true);

    // GPU-accelerated renderer - eliminates the column-drift you get with
    // the default DOM renderer when fonts (especially JetBrains Mono with
    // ligatures, or unicode box-drawing chars that fall back to a non-
    // monospace family) don't render at exact integer cell widths. WebGL
    // renders into a fixed-cell texture grid, so even slightly variable
    // glyph widths can't accumulate drift across a wide table.
    //
    // The addon can throw on contexts without a usable WebGL2 (rare on
    // Electron, but possible if the user disabled hardware acceleration).
    // We catch and fall through to the DOM renderer in that case.
    attachWebgl(term);

    xtermRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    fitTerminal();
    let releaseDeferred:(()=>void)|null=null;
    let disposed=false,awaitingReplay=typeof window.aya.handoverDisplay==='function';
    let initialPromptTimer: number | null = null;
    let attachCancelled=false,attachRetiredByRestart=false;
    const unregisterPendingAttach=registerPendingTerminalAttach(terminal.id,()=>{attachCancelled=true;releaseDeferred?.();});
    const attachmentWasCancelled=()=>{
      if(!attachCancelled)return false;
      if(attachRetiredByRestart)return true;
      term.options.disableStdin=true;
      setHistoryNotice("Terminal attachment cancelled by a stop request.");
      markRestoring(false);
      return true;
    };
    let displayGeneration:string|null=null,replayToken:string|null=null,appliedToken=false,displayEpoch=0;
    let waitingForPrincipal=terminal.disconnectedReason?.startsWith("The previous Aya process is still closing.")??false;
    const retireHandoverForRestart=()=>{
      displayEpoch++;attachRetiredByRestart=true;attachCancelled=true;releaseDeferred?.();unregisterPendingAttach();
      awaitingReplay=false;displayGeneration=null;replayToken=null;appliedToken=false;
      handoverInputPausedRef.current=false;term.options.disableStdin=disconnectedRef.current || remoteReadOnlyRef.current;
      setHistoryNotice(null);
    };
    retireHandoverForRestartRef.current=retireHandoverForRestart;
    const unregisterCheckpoint=registerCheckpointTerminal(terminal.id,term,()=>!awaitingReplay&&!handoverInputPausedRef.current);
    handoverInputPausedRef.current=awaitingReplay;
    if(awaitingReplay)term.options.disableStdin=true;

    // Per-id subscription via the shared bus: one chunk wakes THIS pane only,
    // not every mounted TerminalView (visible + warm pool) as a raw
    // window.aya.onPtyEvent listener would.
    const unsubscribe = ptyEventBus.onFor(terminal.id, (event) => {
      if (isRestoringRef.current) markRestoring(false);
      if(event.type === "host-connection"){
        if(!event.connected){waitingForPrincipal=true;disconnectedRef.current=true;term.options.disableStdin=true;setHistoryNotice(event.reason);}
        else if(waitingForPrincipal){waitingForPrincipal=false;disconnectedRef.current=false;term.options.disableStdin=handoverInputPausedRef.current || remoteReadOnlyRef.current;setHistoryNotice(notice=>notice===event.reason?null:notice);}
      } else if (event.type === "remote-control") {
        remoteReadOnlyRef.current = !!event.readOnly;
        term.options.disableStdin = disconnectedRef.current || remoteReadOnlyRef.current || handoverInputPausedRef.current;
      } else if (event.type === "remote-connection") {
        if (event.connected) {
          disconnectedRef.current = false;
          term.options.disableStdin = remoteReadOnlyRef.current || handoverInputPausedRef.current;
          setHistoryNotice(null);
        } else {
          disconnectedRef.current = true;
          term.options.disableStdin = true;
          setHistoryNotice(`Disconnected from ${event.host}`);
        }
      } else if (event.type === "remote-replay-truncated") {
        term.reset();
        term.write("\x1bc");
        richInputRef.current = false;
        setHistoryNotice("Earlier terminal output is no longer available; showing the most recent output.");
      } else if(event.type === "recovered") {
        displayEpoch++;attachRetiredByRestart=true;attachCancelled=true;releaseDeferred?.();unregisterPendingAttach();
        // Also queue RIS behind already-buffered parser writes: an old async
        // write cannot repaint consumed output after this synchronous reset.
        term.reset();term.write("\x1bc");richInputRef.current=false;disconnectedRef.current=false;
        recoveryNoticeRef.current=event.notice;recoveryGenerationRef.current=event.generation;setHistoryNotice(event.notice);
        displayGeneration=event.generation;replayToken=event.replayToken;appliedToken=false;awaitingReplay=true;
        handoverInputPausedRef.current=true;term.options.disableStdin=true;
      } else if(event.type === "recovery-unavailable") {
        if(!disconnectedRef.current)setHistoryNotice(event.reason);
      } else if(event.type === "recovery-state") {
        if(disconnectedRef.current||(recoveryGenerationRef.current&&recoveryGenerationRef.current!==event.generation))return;
        recoveryGenerationRef.current=event.generation;
        recoveryNoticeRef.current=event.notice;setHistoryNotice(event.notice);
      } else if (event.type === "data") {
        // Startup output is retained by the host. Discard broadcasts until the
        // replay fence, then append exactly the suffix after captured B once.
        if(event.replayToken){if(event.replayToken!==replayToken||appliedToken)return;appliedToken=true;}
        if(awaitingReplay&&!event.replay)return;
        if(event.reset){term.reset();setHistoryNotice(recoveryNoticeRef.current ?? "History from replay after the update; earlier captured history was no longer retained.");}
        if (event.replayModeUnknown) setHistoryNotice("The retained output's terminal mode is unknown; its previous screen layout may not be preserved.");
        if(event.replay&&awaitingReplay)awaitingReplay=false;
        // Track whether a full-screen / rich TUI (claude, codex, vim…) is
        // running via focus-reporting mode (DECSET 1004). It gates Shift+Enter:
        // soft newline inside the TUI, plain Enter (submit) at the shell prompt.
        richInputRef.current = focusReportingState(event.chunk, richInputRef.current);
        const scrollbackSafeChunk = shouldPreserveScrollback
          ? stripScrollbackErase(event.chunk)
          : event.chunk;
        const displayChunk = normalizeTerminalLinkUnderline(scrollbackSafeChunk);
        if (event.replay) {
          replayingOutputRef.current += 1;
          const applyingEpoch=displayEpoch;
          term.write(displayChunk, () => {
            if(disposed)return;
            if(applyingEpoch!==displayEpoch){replayingOutputRef.current=Math.max(0,replayingOutputRef.current-1);return;}
            replayingOutputRef.current = Math.max(0, replayingOutputRef.current - 1);
            handoverInputPausedRef.current=false;term.options.disableStdin=disconnectedRef.current || remoteReadOnlyRef.current;
            if(displayGeneration){void window.aya.acknowledgeHandoverDisplay(terminal.id,displayGeneration,event.replayToken).catch(()=>{});displayGeneration=null;}
          });
        } else {
          term.write(displayChunk);
        }
        if (!event.replay && !didPostLoadResizeRef.current) {
          didPostLoadResizeRef.current = true;
          // After the first non-replay chunk arrives, force a SIGWINCH so
          // harnesses like grok that lay out their fullscreen UI on start or
          // on SIGWINCH observe the real pane size rather than the 80x24
          // fallback present at ptySpawn time.
          forcePtyReassert();
        }
        if (onPtyData) onPtyData(event.chunk);
      } else if (event.type === "exit") {
        awaitingReplay=false;handoverInputPausedRef.current=false;term.options.disableStdin=disconnectedRef.current || remoteReadOnlyRef.current;
        const restartHint =
          event.exitCode === 0
            ? " — press Shift+Enter to restart"
            : "";
        term.write(
          `\r\n\x1b[2m[process exited with code ${event.exitCode}${restartHint}]\x1b[0m\r\n`,
        );
      } else if (event.type === "disconnected") {
        disconnectedRef.current = true; term.options.disableStdin = true;
        if(event.reason)setHistoryNotice(event.reason);
        term.write("\r\n\x1b[1;33m[terminal host disconnected - the process may still be running. Input is disabled while disconnected. Use Settings > Diagnostics > PTY host > Restart to review stopping it.]\x1b[0m\r\n");
      } else if (event.type === "no-session") {
        awaitingReplay=false;handoverInputPausedRef.current=false;term.options.disableStdin=disconnectedRef.current || remoteReadOnlyRef.current;
        // Attach-only re-mount with no live PTY: the process ended while we were
        // away. Show a restartable hint instead of a fresh, contextless session.
        term.write(
          `\r\n\x1b[2m[session ended - press Shift+Enter to restart]\x1b[0m\r\n`,
        );
      }
    });

    term.attachCustomKeyEventHandler((ev) => {
      if (disconnectedRef.current) return true; // xterm keeps copy/navigation; disableStdin blocks typing/paste
      if (ev.key === "Alt") {
        optionSideRef.current =
          ev.type === "keydown" ? optionSideFromCode(ev.code) : "unknown";
        return true;
      }
      if (ev.type !== "keydown") return true;

      // Enter handling (restart / soft newline / submit) - see enterKeyAction.
      // Returning false stops xterm from also forwarding its default CR.
      if (ev.key === "Enter") {
        const action = enterKeyAction({
          shift: ev.shiftKey,
          meta: ev.metaKey,
          ctrl: ev.ctrlKey,
          alt: ev.altKey,
          canRestart: canRestartRef.current,
          richInput: richInputRef.current,
        });
        if (action === "restart") {
          // Shift+Enter on a cleanly-exited terminal: restart in the same pane.
          ev.preventDefault();
          // No local spawn: onRequestRestart bumps the restartTrigger and its
          // effect spawns AFTER the state re-render - so the command already
          // carries the resume arg for a tab that had a session. Spawning here
          // read the pre-render command and lost the -c.
          onRequestRestart?.();
          canRestartRef.current = false;
          return false;
        }
        if (action === "soft-newline" || action === "submit") {
          // Shift/Option+Enter: a newline inside a running rich TUI (focus-
          // reporting on), a plain submit at the shell - xterm's default is
          // wrong for both (it submits Shift+Enter; macOptionIsMeta turns
          // Option+Enter into a zsh multiline edit).
          ev.preventDefault();
          sendInput(
            action === "soft-newline" ? META_ENTER : "\r",
          );
          return false;
        }
        // "default" → fall through to xterm's normal Enter.
      }

      const leftOptionSeq = leftOptionMetaSequence(
        ev.key,
        ev.code,
        ev.shiftKey,
        optionSideRef.current,
        macOptionKeyModeRef.current,
      );
      if (leftOptionSeq && ev.altKey && !ev.metaKey && !ev.ctrlKey) {
        ev.preventDefault();
        sendInput(leftOptionSeq);
        return false;
      }

      // Option+Arrow / Option+Backspace word navigation. xterm.js's default
      // encoding for these is CSI with an Alt modifier (`\x1b[1;3D` etc.),
      // which is NOT bound in vanilla zsh and which some shell configs
      // misinterpret as a delete command (user-visible symptom: text
      // disappears instead of cursor moving). Send the iTerm2-style
      // ESC-prefixed sequences instead - those are what readline, zsh's
      // default zle, claude, and codex all expect for word ops on macOS.
      if (
        ev.altKey &&
        !ev.metaKey &&
        !ev.ctrlKey &&
        (ev.key === "ArrowLeft" ||
          ev.key === "ArrowRight" ||
          ev.key === "Backspace" ||
          ev.key === "Delete")
      ) {
        let seq: string | null = null;
        if (ev.key === "ArrowLeft") seq = "\x1bb";
        else if (ev.key === "ArrowRight") seq = "\x1bf";
        else if (ev.key === "Backspace") seq = "\x1b\x7f";
        else if (ev.key === "Delete") seq = "\x1bd";
        if (seq) {
          ev.preventDefault();
          sendInput(seq);
          return false;
        }
      }

      // Bare control + letter combos (no Cmd/Shift/Alt) are shell-level
      // control characters. Chromium intercepts several of them at the
      // WebContents level - Ctrl+R as page-reload is the headline one,
      // and that's what stops reverse-i-search from working in shells
      // running inside aya. Forward the control byte to the PTY ourselves
      // and preventDefault so Chromium's reload doesn't fire. Limited to
      // letter keys so we don't intercept Ctrl+[, Ctrl+], Ctrl+0..9 or
      // other already-bound combinations.
      if (
        ev.ctrlKey &&
        !ev.metaKey &&
        !ev.shiftKey &&
        !ev.altKey &&
        ev.key.length === 1
      ) {
        const code = ev.key.toLowerCase().charCodeAt(0);
        if (code >= ASCII_LOWER_A && code <= ASCII_LOWER_Z) {
          // a–z → control byte 0x01–0x1A
          ev.preventDefault();
          const ctrlByte = String.fromCharCode(code - CTRL_BYTE_OFFSET);
          sendInput(ctrlByte);
          return false;
        }
      }

      return true;
    });

    const onDataDisposable = term.onData((data) => {
      if (disconnectedRef.current) return;
      if (replayingOutputRef.current > 0) return;
      if (data.length > 0) setIsScrollbarHidden(true);
      if (localStorage.getItem(DEBUG_TERMINAL_INPUT_STORAGE_KEY) === "1") {
        console.debug(
          `[aya terminal input] ${terminal.id} ${preset.id}: ${printableControlData(data)}`,
        );
      }
      sendInput(data);
    });

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      if(!handoverInputPausedRef.current)void window.aya.ptyResize(terminal.id, cols, rows).catch(()=>{});
    });

    // Track the current foreground process via OSC 0/2 title sequences.
    // macOS zsh's default config emits these via preexec/precmd hooks, so
    // running `git log` in a shell tab updates the title to "git log".
    const onTitleDisposable = term.onTitleChange((title) => {
      setProcessTitle(title);
    });

    {
      void (async()=>{
      const display=typeof window.aya.handoverDisplay==='function' ? await window.aya.handoverDisplay(terminal.id).catch(()=>null) : null;
      if(disposed)return;
      if(attachmentWasCancelled())return;
      // A hidden boot-warm view must not consume the first attach/exit or ACK
      // and then discard its display before the user ever visits the pane.
      // Native reads continue immediately in the successor throughout this wait.
      if(display&&!visibleRef.current){
        await new Promise<void>(resolve=>{
          const ready=()=>{if(deferredHandoverAttachRef.current===ready)deferredHandoverAttachRef.current=null;resolve();};
          releaseDeferred=ready;deferredHandoverAttachRef.current=ready;
        });
        if(disposed)return;
        if(attachmentWasCancelled())return;
      }
      if(display){
        displayGeneration=display.generation;setHistoryNotice(display.notice);
        if(display.json){
          try{restoreRendererVt(term,JSON.parse(display.json) as RendererVtCheckpoint);richInputRef.current=term.modes.sendFocusMode;}
          catch{display.json=null;display.offset=0;setHistoryNotice("History from replay after the update; the display could not be restored.");}
        }
      }else{awaitingReplay=false;handoverInputPausedRef.current=false;term.options.disableStdin=disconnectedRef.current || remoteReadOnlyRef.current;}
      const previouslyRequested=spawnedRef.current;spawnedRef.current = true;
      if(display)replayToken=crypto.randomUUID();
      // First mount this session -> normal spawn (boot auto-start). A re-mount
      // of an id that already produced a confirmed session - or that the host
      // already declared no-session for (the tab is deliberately stopped) ->
      // attach-only, so a tab whose PTY died shows a stopped state rather
      // than a silent fresh process. Keyed on confirmed output (not the
      // request), so an in-flight first spawn that re-mounts is not mistaken
      // for a dead session.
      const attachOnly = previouslyRequested || wasSpawned(terminal.id) || hadNoSession(terminal.id);
      // Boot-restored tab, FIRST mount decision only: if the app reconnected
      // to a host that predates this session, attach instead of spawning -
      // the session either still lives there (replay) or the tab becomes
      // stopped/restartable, the same behavior the manual host-restart path
      // settled on. Resolved by the main-process client; a fresh host
      // ignores it (boot auto-start). One-shot per renderer session so a
      // re-mount after an explicit restart (forgetSpawn) spawns fresh.
      const attachIfReused = terminal.restored && !wasMountDecided(terminal.id);
      markMountDecided(terminal.id);
      const { cols, rows } = term;
      // No await between releasing this hook and sending the request: a later
      // close reaches main after its spawn flight has been registered.
      unregisterPendingAttach();
      await window.aya.ptySpawn({
        ...(display ? {replayAfter:{generation:display.generation,offset:display.offset,token:replayToken!}} : {}),
        ptyId: terminal.id,
        projectSlug: terminal.projectSlug,
        presetId: terminal.presetId,
        // The host uses this to pick the agent's own screen-detection rules.
        agent: presetAgent,
        agentConfigDir: preset.configDir,
        command,
        ...sharedRef.current,
        cwd,
        cols: Math.max(cols, TERMINAL_FALLBACK_COLS),
        rows: Math.max(rows, TERMINAL_FALLBACK_ROWS),
        attachOnly,
        attachIfReused,
        ...(terminal.teamLaunch ? { teamLaunch: true } : {}),
      });
      // Worktree batches start the same task in each new agent pane. The PTY
      // process is already spawned here; a short startup grace lets the
      // launcher hand control to its interactive agent before the prompt is
      // entered. This is deliberately one-shot and only exists on the fresh
      // pane state; restored tabs never replay it.
      if (terminal.initialPrompt) {
        initialPromptTimer = window.setTimeout(() => {
          if (disposed || attachCancelled) return;
          void window.aya.ptyWrite(terminal.id, `${terminal.initialPrompt}\r`).catch(() => {});
        }, 1200);
      }
      })().catch(error=>{
        if(disposed||attachCancelled)return;
        awaitingReplay=false;handleAttachmentFailure(term,error);
      });
    }

    return () => {
      disposed=true;if(initialPromptTimer!==null)window.clearTimeout(initialPromptTimer);releaseDeferred?.();unregisterCheckpoint();unregisterPendingAttach();
      if(retireHandoverForRestartRef.current===retireHandoverForRestart)retireHandoverForRestartRef.current=null;
      container.removeEventListener("click", onTerminalLinkClick, true);
      unsubscribe();
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      onTitleDisposable.dispose();
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
      xtermRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      webglRef.current = null;
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
      didPostLoadResizeRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.macOptionIsMeta = shouldUseXtermOptionAsMeta(macOptionKeyMode);
  }, [macOptionKeyMode]);

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (shouldUseWebgl) {
      attachWebgl(term);
      repaintTerminal(false);
      return;
    }
    if (webglRef.current) {
      try {
        webglRef.current.dispose();
      } catch {
        /* ignore */
      }
      webglRef.current = null;
    }
    repaintTerminal(false);
  }, [attachWebgl, repaintTerminal, shouldUseWebgl]);

  // FONT-LOAD FIX: the WebGL atlas rasterizes each glyph with whatever font is
  // actually resolved at draw time. "JetBrains Mono" is a web font, so if the
  // atlas warms up before it finishes loading, the initial glyph cache is built
  // from a fallback (SF Mono / Menlo) with wrong shapes and metrics - and those
  // stay cached (keyed by codepoint+colors, not by font) until something clears
  // them. Once the real font is ready, throw the atlas away once so glyphs
  // re-rasterize correctly. Skipped entirely when the primary family is already
  // available, so it costs nothing on the steady-state path.
  useEffect(() => {
    if (!shouldUseWebgl) return;
    const family = fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY;
    const primary = family.split(",")[0].trim();
    if (!primary) return;
    const probe = `${fontSize}px ${primary}`;
    try {
      if (document.fonts.check(probe)) return; // already loaded - atlas is fine
    } catch {
      /* font shorthand rejected (unusual) - fall through and wait on ready */
    }
    let cancelled = false;
    document.fonts.ready
      .then(() => {
        if (cancelled) return;
        const term = xtermRef.current;
        if (!term) return;
        try {
          webglRef.current?.clearTextureAtlas();
          term.refresh(0, Math.max(term.rows - 1, 0));
        } catch {
          /* ignore - terminal may be mid-dispose */
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [shouldUseWebgl, fontFamily, fontSize]);

  useEffect(() => {
    if (!isVisible) return;
    // Repaint the freshly-shown terminal (webgl atlas, scrollback). Focus is
    // NOT done here - it's owned by the isActive effect below, so a concurrent
    // fit can't swallow it. Also re-assert size to the PTY (with nudge for
    // rich TUIs) so harnesses re-render their static layout when the terminal
    // view is brought back (tab switch, split activation, etc.).
    healWebgl();
    repaintTerminal(false);
    forcePtyReassert();
    const frame = requestAnimationFrame(() => repaintTerminal(false));
    const timer = setTimeout(() => repaintTerminal(false), RENDER_REPAIR_DELAY_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [isVisible, healWebgl, repaintTerminal, forcePtyReassert]);

  // Single source of truth for keyboard focus: whenever this becomes THE active
  // terminal (tab switch, split-pane navigation, or an overlay/modal closing),
  // focus its xterm. Deliberately decoupled from fitTerminal's shared,
  // cancellable rAF so a stray fit can't drop the focus. The find bar wants the
  // focus while it's open, so defer to it.
  const wantsFocus = isActive && !findOpen;
  useEffect(() => {
    if (!wantsFocus) return;
    let expectedActiveElement = document.activeElement;
    const focusNow = () => {
      if (!terminalFocusRetryStillOwned(expectedActiveElement, document.activeElement)) return;
      try {
        const term = xtermRef.current;
        const host = containerRef.current;
        if (term && host && host.clientWidth > 0 && host.clientHeight > 0) {
          term.focus();
          expectedActiveElement = document.activeElement;

          // When we switch *to* this pane as the active one (split navigation or
          // click), reassert size to PTY (nudge if rich). Harnesses in other
          // panes may have been the "front" one; the newly focused rich TUI
          // often needs a fresh SIGWINCH (or size delta) to repaint its focused
          // static layout.
          forcePtyReassert();
        }
      } catch {
        /* ignore - xterm may be mid-dispose */
      }
    };
    // Focus now, and retry across a couple of frames because xterm may still be
    // measuring right after a visibility/layout change.
    focusNow();
    const raf = requestAnimationFrame(focusNow);
    const timer = setTimeout(focusNow, FOCUS_RETRY_DELAY_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [wantsFocus, forcePtyReassert]);

  useEffect(() => {
    if (!isVisible) return;
    // Wake/restore: heal a possibly-dead WebGL context FIRST (a loss during
    // background/sleep won't have delivered its event yet - the user would
    // otherwise stare at a white terminal area for seconds), then repaint +
    // idempotent resize, and re-assert PTY size with a rich-TUI nudge so the
    // harness redraws its static layout.
    const onResumeRender = () => {
      healWebgl();
      repaintTerminal(false);
      forcePtyReassert();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") onResumeRender();
    };
    window.addEventListener("focus", onResumeRender);
    window.addEventListener("pageshow", onResumeRender);
    document.addEventListener("visibilitychange", onVisibilityChange);
    // The GPU helper process died and Chromium relaunched it (#79): the DOM
    // "focus"/"visibilitychange" beats above may never fire (the window kept
    // focus the whole time), so App relays the main-process signal as this
    // window event and we heal on it too.
    window.addEventListener(GPU_RELAUNCHED_EVENT, onResumeRender);
    return () => {
      window.removeEventListener("focus", onResumeRender);
      window.removeEventListener("pageshow", onResumeRender);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener(GPU_RELAUNCHED_EVENT, onResumeRender);
    };
  }, [isVisible, healWebgl, repaintTerminal, forcePtyReassert]);

  useEffect(() => {
    const onResize = () => fitTerminal();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fitTerminal]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => {
      if (isVisible) fitTerminal();
    });
    observer.observe(host);
    if (host.parentElement) observer.observe(host.parentElement);
    return () => observer.disconnect();
  }, [fitTerminal, isVisible]);

  useEffect(() => {
    if (!xtermRef.current) return;
    xtermRef.current.options.fontFamily =
      fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY;
    xtermRef.current.options.fontSize = fontSize;
    fitTerminal();
  }, [fitTerminal, fontFamily, fontSize]);

  // Clear highlights when the find bar closes so stale "match outline"
  // doesn't linger on the canvas while the user types in the PTY.
  useEffect(() => {
    if (findOpen) return;
    try {
      searchRef.current?.clearDecorations();
    } catch {
      /* ignore */
    }
  }, [findOpen]);

  // Forced-restart trigger from the host. Starts as 0; any subsequent
  // change means "spawn a fresh PTY against the same id". The old PTY has
  // already been killed by App.forceRestartTerminal before this fires.
  const lastRestartTriggerRef = useRef(restartTrigger);
  useEffect(() => {
    if (restartTrigger === lastRestartTriggerRef.current) return;
    lastRestartTriggerRef.current = restartTrigger;
    const term = xtermRef.current;
    if (!term) return;
    retireHandoverForRestartRef.current?.();
    didPostLoadResizeRef.current = false;
    markRestoring(true);
    term.writeln("\x1b[2m[restarting…]\x1b[0m");
    const restartGeneration=recoveryGenerationRef.current;
    void window.aya.ptySpawn({
      ptyId: terminal.id,
      projectSlug: terminal.projectSlug,
      presetId: terminal.presetId,
      agent: presetAgent,
      agentConfigDir: preset.configDir,
      command: commandRef.current,
      ...sharedRef.current,
      cwd: cwdRef.current,
      cols: Math.max(term.cols, TERMINAL_FALLBACK_COLS),
      rows: Math.max(term.rows, TERMINAL_FALLBACK_ROWS),
      ...(terminal.teamLaunch ? { teamLaunch: true } : {}),
    }).catch(error=>{if(recoveryGenerationRef.current===restartGeneration)handleAttachmentFailure(term,error);});
  }, [
    restartTrigger,
    terminal.id,
    terminal.projectSlug,
    terminal.presetId,
    presetAgent,
    preset.configDir,
    terminal.teamLaunch,
    markRestoring,
    handleAttachmentFailure,
  ]);

  useEffect(() => {
    markRestoring(true);
    const id = window.setTimeout(() => markRestoring(false), RESTORE_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [terminal.id, markRestoring]);

  // Hot-swap theme when the active selection changes. xterm.js stashes the
  // new palette into `options.theme` but does NOT repaint the visible grid by
  // itself - already-rendered cells keep the old colors. We force a refresh
  // of every visible row to make the change take effect immediately.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.theme = toXtermTheme(themeColors);
    try {
      term.refresh(0, Math.max(term.rows - 1, 0));
    } catch {
      /* ignore - refresh may throw if the terminal is being disposed */
    }
  }, [themeColors]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  const openTerminalContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onActivatePane?.();
    const selectedText = xtermRef.current?.getSelection() ?? "";
    const target = event.target instanceof Element ? event.target : null;
    const rowText =
      target?.closest(".xterm-rows > div")?.textContent ??
      target?.closest(".xterm-screen")?.textContent ??
      "";
    setContextMenu({
      x: Math.max(
        TERMINAL_CONTEXT_MENU_VIEWPORT_MARGIN,
        Math.min(
          event.clientX,
          window.innerWidth -
            TERMINAL_CONTEXT_MENU_WIDTH -
            TERMINAL_CONTEXT_MENU_VIEWPORT_MARGIN,
        ),
      ),
      y: Math.max(
        TERMINAL_CONTEXT_MENU_VIEWPORT_MARGIN,
        Math.min(
          event.clientY,
          window.innerHeight -
            TERMINAL_CONTEXT_MENU_MAX_HEIGHT -
            TERMINAL_CONTEXT_MENU_VIEWPORT_MARGIN,
        ),
      ),
      selectedText,
      link: firstHttpUrl(selectedText) ?? firstHttpUrl(rowText),
    });
  };

  const copySelection = async () => {
    const text = contextMenu?.selectedText || xtermRef.current?.getSelection() || "";
    if (text) await window.aya.writeClipboard(text);
    setContextMenu(null);
    xtermRef.current?.focus();
  };

  const pasteClipboard = async () => {
    if (terminal.disconnected) return;
    const text = await window.aya.readClipboard();
    if (text) xtermRef.current?.paste(text);
    setContextMenu(null);
    xtermRef.current?.focus();
  };

  const copyAttachmentPath = useCallback(async () => {
    if (!copiedAttachmentPath) return;
    await window.aya.writeClipboard(copiedAttachmentPath);
    setCopiedAttachmentPath(null);
    setAttachmentNotice({ text: "Path copied. Paste it into the pane when you are ready.", error: false });
  }, [copiedAttachmentPath]);

  const selectAllTerminal = () => {
    xtermRef.current?.selectAll();
    setContextMenu(null);
    xtermRef.current?.focus();
  };

  const openContextLink = () => {
    if (contextMenu?.link) void window.aya.openUrl(contextMenu.link);
    setContextMenu(null);
    xtermRef.current?.focus();
  };

  const endRemoteTerminal = async () => {
    try {
      await window.aya.ptyKill(terminal.id, "end-remote");
    } catch (error) {
      xtermRef.current?.write(`\r\n[Could not end the remote terminal: ${String(error).replace(/[\x00-\x1f\x7f]/g, " ")}]\r\n`);
    }
    setContextMenu(null);
    xtermRef.current?.focus();
  };

  return (
    <div
      data-testid="terminal-pane"
      data-terminal-id={terminal.id}
      data-terminal-name={terminal.name}
      className={
        `aya-pane ${terminal.remoteHost ? "aya-pane--remote" : ""} ${isScrollbarHidden ? "aya-pane--scrollbar-hidden" : ""} ${
          isActivePane ? "aya-pane--active-split" : ""
        }`
      }
      style={{ display: isVisible ? "flex" : "none", ...(paneStyle ?? {}) }}
      onMouseDown={onActivatePane}
    >
      <div className="aya-pane-active" />
      <div className="aya-pane-header">
        <span
          className="aya-sidebar-icon"
          style={preset.color ? { color: preset.color } : undefined}
        >
          {preset.icon}
        </span>
        <span className="aya-pane-header-title">{terminal.name}</span>
        {terminal.remoteHost && (
          <span className="aya-pane-remote-label" title={`Remote: ${terminal.remoteHost}`}>
            <span aria-hidden="true" style={{ fontFamily: "Material Symbols Outlined" }}>lan</span>
            Remote: {terminal.remoteHost}
          </span>
        )}
        {terminal.remoteControlled && <span className="aya-pane-remote-control">Remote client controls this pane</span>}
        {terminal.remoteReadOnly && <span className="aya-pane-remote-control">Read-only remote view</span>}
        {processTitle && (
          <>
            <span className="aya-pane-header-sep">·</span>
            <span className="aya-pane-header-process" title={processTitle}>
              {processTitle}
            </span>
          </>
        )}
        {headerStatusText && (
          <div className="aya-pane-header-meta">
            <span
              className={`aya-pane-header-activity ${
                terminal.externalStatus
                  ? `aya-pane-header-activity--${terminal.externalStatus.level}`
                  : ""
              }`}
              title={headerStatusTitle}
            >
              {headerStatusText}
            </span>
          </div>
        )}
      </div>
      {terminal.spawnFailure && (
        <div className="aya-pane-recovery">
          <div className="aya-pane-recovery-text">
            <strong>{recoveryTitle(terminal.spawnFailure.reason)}</strong>
            {terminal.spawnFailure.reason === "pane-limit-reached" && <p>{terminal.spawnFailure.detail}</p>}
          </div>
          <div className="aya-pane-recovery-actions">
            {terminal.spawnFailure.reason.startsWith("cwd-") && (
              <button
                className="aya-pane-recovery-btn"
                onClick={() => onCloseProject(terminal.projectSlug)}
              >
                Close project
              </button>
            )}
            <button className="aya-pane-recovery-btn" onClick={() => onOpenSettings()}>
              Open Settings
            </button>
            <button
              className="aya-pane-recovery-btn aya-pane-recovery-btn--primary"
              onClick={respawnInPlace}
            >
              Restart
            </button>
          </div>
        </div>
      )}
      <div
        data-testid="xterm-host"
        className="aya-xterm-host"
        // CSS variable consumed by overrides.css so the padding strip around
        // the xterm canvas (the "frame" around the terminal) tracks the
        // active theme's background instead of staying GitHub-dark.
        style={
          themeColors.background
            ? ({ "--aya-term-bg": themeColors.background } as CSSProperties)
            : undefined
        }
        onWheelCapture={() => setIsScrollbarHidden(false)}
        onContextMenu={openTerminalContextMenu}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
      >
        {attachmentNotice && <div data-testid="prompt-attachment-notice" className={`aya-prompt-attachment-notice ${attachmentNotice.error ? "aya-prompt-attachment-notice--error" : ""}`} role={attachmentNotice.error ? "alert" : "status"}>{attachmentNotice.text}{copiedAttachmentPath && <button type="button" onClick={() => void copyAttachmentPath()}>Copy path</button>}</div>}
        {terminal.remoteDisconnected && historyNotice ? (
          <div
            data-testid="terminal-history-notice"
            className="aya-terminal-remote-disconnected-notice"
            role="status"
          >
            <span>{historyNotice}</span>
            <button
              type="button"
              data-testid="remote-reconnect-now"
              onClick={() => { void window.aya.ptyRemoteReconnect(terminal.id).catch(() => {}); }}
            >
              Reconnect now
            </button>
          </div>
        ) : (historyNotice || terminal.recoveryNotice || terminal.recoveryScreenUnknown || terminal.remoteReplayTruncated) ? (
          <div data-testid="terminal-history-notice" role="status" style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 3, padding: "2px 8px", fontSize: 11, background: "var(--aya-term-bg)", pointerEvents: "none" }}>
            {historyNotice ?? terminal.recoveryNotice ?? (terminal.remoteReplayTruncated ? "Earlier terminal output is no longer available; showing the most recent output." : "")}
            {terminal.recoveryScreenUnknown ? " Screen unknown after the terminal host restarted; team messages remain held until a full redraw." : ""}
            {terminal.recoveryRetryable && <button type="button" data-testid="terminal-recovery-retry" style={{ pointerEvents: "auto", marginLeft: 8 }} onClick={() => { void window.aya.retryPtyHostRecovery().catch(error => setHistoryNotice(`Could not try terminal host recovery: ${String(error)}`)); }}>Try again</button>}
          </div>
        ) : null}
        <div data-testid="xterm-frame" className="aya-xterm-frame" ref={containerRef} />
        {isRestoring && (
          <div className="aya-terminal-restoring" aria-live="polite">
            <span
              className="aya-terminal-restoring-icon"
              style={{ fontFamily: "Material Symbols Outlined" }}
            >
              sync
            </span>
            <span>Restoring sessions...</span>
          </div>
        )}
      </div>
      {contextMenu && (
        <div
          data-testid="terminal-context-menu"
          className="aya-terminal-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.link && (
            <button
              data-testid="terminal-context-open-link"
              className="aya-terminal-context-item"
              type="button"
              onClick={openContextLink}
            >
              <span style={{ fontFamily: "Material Symbols Outlined" }}>
                open_in_browser
              </span>
              Open Link
            </button>
          )}
          <button
            data-testid="terminal-context-copy"
            className="aya-terminal-context-item"
            type="button"
            disabled={!contextMenu.selectedText}
            onClick={copySelection}
          >
            <span style={{ fontFamily: "Material Symbols Outlined" }}>
              content_copy
            </span>
            Copy
          </button>
          <button
            data-testid="terminal-context-paste"
            data-aya-terminal-paste
            className="aya-terminal-context-item"
            type="button"
            disabled={terminal.disconnected || terminal.remoteReadOnly}
            onClick={pasteClipboard}
          >
            <span style={{ fontFamily: "Material Symbols Outlined" }}>
              content_paste
            </span>
            Paste
          </button>
          {terminal.remoteHost && (
            <button
              data-testid="terminal-context-end-remote"
              className="aya-terminal-context-item"
              type="button"
              disabled={terminal.remoteReadOnly || terminal.disconnected}
              onClick={() => void endRemoteTerminal()}
            >
              <span style={{ fontFamily: "Material Symbols Outlined" }}>power_settings_new</span>
              End terminal on remote host
            </button>
          )}
          <button
            data-testid="terminal-context-select-all"
            className="aya-terminal-context-item"
            type="button"
            onClick={selectAllTerminal}
          >
            <span style={{ fontFamily: "Material Symbols Outlined" }}>
              select_all
            </span>
            Select All
          </button>
        </div>
      )}
      <SnippetBar
        snippets={snippets}
        open={snippetsOpen}
        onClose={() => onSnippetsOpenChange(false)}
        onSend={sendSnippet}
        onOpenSettings={onOpenSettings}
      />
      {findOpen && (
        <FindBar
          value={findQuery}
          onChange={(v, historyMode) => {
            setFindQuery(v);
            // In History mode the query drives the transcript search inside
            // FindBar; don't move the live terminal's match cursor around.
            if (historyMode) return;
            if (!v) {
              try {
                searchRef.current?.clearDecorations();
              } catch {
                /* ignore */
              }
              return;
            }
            try {
              searchRef.current?.findNext(v, {
                regex: false,
                wholeWord: false,
                caseSensitive: false,
                incremental: true,
              });
            } catch {
              /* ignore */
            }
          }}
          historyAgent={findHistoryAgent}
          paneId={terminal.id}
          cwd={cwd}
          configDir={preset.configDir}
          command={preset.command}
          onClearTerminalMatches={() => {
            try {
              searchRef.current?.clearDecorations();
            } catch {
              /* ignore */
            }
          }}
          onNext={() => {
            if (findQuery) {
              try {
                searchRef.current?.findNext(findQuery);
              } catch {
                /* ignore */
              }
            }
          }}
          onPrev={() => {
            if (findQuery) {
              try {
                searchRef.current?.findPrevious(findQuery);
              } catch {
                /* ignore */
              }
            }
          }}
          onClose={onCloseFind}
        />
      )}
    </div>
  );
}

export const TerminalView = memo(TerminalViewComponent, terminalViewPropsEqual);

interface FindBarProps {
  value: string;
  /** `historyMode` tells the host whether the query is driving the live
   *  terminal search (false) or the transcript search inside the bar (true). */
  onChange: (v: string, historyMode: boolean) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** Non-null enables the experimental History mode for this agent tab. */
  historyAgent: "claude" | "codex" | null;
  paneId: string;
  cwd: string;
  configDir?: string;
  /** The preset's command: an inline CODEX_HOME there moves the history too. */
  command?: string;
  /** Clears xterm search highlights when the bar switches to History mode. */
  onClearTerminalMatches: () => void;
  /** A completed result can be supplied when restoring/rendering the bar. */
  initialHistoryResult?: HarnessSearchResult;
  /** A refusal can be supplied when restoring/rendering the bar. */
  initialHistoryError?: string;
}

// History (transcript) search: debounce keystrokes before the IPC round-trip
// and skip 1-character queries, which match everything.
const HISTORY_SEARCH_DEBOUNCE_MS = 200;
const HISTORY_MIN_QUERY_CHARS = 2;

function formatHitTime(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return null;
  return formatLastActivity(ms) ?? "just now";
}

export function FindBar({
  value,
  onChange,
  onNext,
  onPrev,
  onClose,
  historyAgent,
  paneId,
  cwd,
  configDir,
  command,
  onClearTerminalMatches,
  initialHistoryResult,
  initialHistoryError,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [historyMode, setHistoryMode] = useState(initialHistoryResult !== undefined);
  const [hits, setHits] = useState<HarnessSearchHit[]>(initialHistoryResult?.hits ?? []);
  const [coverage, setCoverage] = useState<HarnessSearchResult["coverage"]>(initialHistoryResult?.coverage ?? { partial: false });
  // True once a transcript search has completed for the current query, so
  // "No matches" only shows after an actual (empty) result, not while typing.
  const [searched, setSearched] = useState(initialHistoryResult !== undefined);
  const [historyError, setHistoryError] = useState<string | null>(initialHistoryError ?? null);
  const [expandedHit, setExpandedHit] = useState<number | null>(null);
  const historySeqRef = useRef(0);
  const historyRequestIdRef = useRef(0);
  useEffect(() => {
    // Focus + select-all on mount so opening the bar twice in a row lets
    // the user replace the query directly.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const historyActive = historyMode && historyAgent !== null;
  const query = value.trim();
  useEffect(() => {
    const { id: seq, shouldSearch } = beginHistorySearch(
      historySeqRef,
      query,
      HISTORY_MIN_QUERY_CHARS,
    );
    if (!historyActive || !historyAgent) return;
    if (!shouldSearch) {
      setHits([]);
      setCoverage({ partial: false });
      setSearched(false);
      setHistoryError(null);
      setExpandedHit(null);
      return;
    }
    // Results belong to the previous query and must not remain visible under
    // this one while its debounced request is waiting or being cancelled.
    setHits([]);
    setCoverage({ partial: false });
    setSearched(false);
    setHistoryError(null);
    setExpandedHit(null);
    let requestId: string | undefined;
    const timer = window.setTimeout(() => {
      requestId = `history-${seq}-${++historyRequestIdRef.current}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.aya
        .harnessSearch({ agent: historyAgent, cwd, configDir, command, query }, requestId, paneId)
        .then((results) => {
          if (historySeqRef.current !== seq) return; // stale response
          if (results.coverage.cancelled) {
            setHits([]);
            setCoverage({ partial: false });
            setSearched(false);
            setHistoryError(null);
            setExpandedHit(null);
            return;
          }
          setHits(results.hits);
          setCoverage(results.coverage);
          setSearched(true);
          setHistoryError(null);
          setExpandedHit(null);
        })
        .catch((error: unknown) => {
          if (historySeqRef.current !== seq) return;
          setHits([]);
          setCoverage({ partial: false });
          setSearched(true);
          setHistoryError(ipcMessage(error));
        });
    }, HISTORY_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      if (requestId) void window.aya.harnessSearchCancel(requestId, paneId).catch(() => {});
    };
  }, [historyActive, historyAgent, cwd, configDir, command, query, paneId]);

  const switchMode = (toHistory: boolean) => {
    if (toHistory === historyMode) return;
    setHistoryMode(toHistory);
    setExpandedHit(null);
    if (toHistory) {
      onClearTerminalMatches();
    } else {
      setHits([]);
      setCoverage({ partial: false });
      setSearched(false);
      setHistoryError(null);
      // Re-run the live terminal search for the query already in the box.
      onChange(value, false);
    }
    inputRef.current?.focus();
  };

  const agentLabel = historyAgent === "claude" ? "Claude" : "Codex";
  const partialCoverageText = formatHarnessSearchCoverage(
    coverage,
    hits.length > 0,
    agentLabel,
  );
  return (
    <div className={`aya-findbar ${historyActive ? "aya-findbar--history" : ""}`}>
      <div className="aya-findbar-row">
        {historyAgent && (
          <div
            className="aya-findbar-modes"
            aria-label="Search scope"
            title="Terminal searches visible output; History searches this directory's agent session transcripts"
          >
            {([
              [false, "Terminal"],
              [true, "History"],
            ] as const).map(([mode, label]) => (
              <button
                key={label}
                type="button"
                className={`aya-findbar-mode ${
                  historyMode === mode ? "aya-findbar-mode--active" : ""
                }`}
                onClick={() => switchMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <input
          ref={inputRef}
          className="aya-findbar-input"
          value={value}
          onChange={(e) => onChange(e.target.value, historyActive)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Enter" && !historyActive) {
              e.preventDefault();
              if (e.shiftKey) onPrev();
              else onNext();
            }
          }}
          placeholder={
            historyActive
              ? `Search ${agentLabel} session history…`
              : "Find in terminal…"
          }
          spellCheck={false}
        />
        {!historyActive && (
          <>
            <button
              className="aya-findbar-btn"
              onClick={onPrev}
              title="Previous match (Shift+Enter)"
            >
              ↑
            </button>
            <button
              className="aya-findbar-btn"
              onClick={onNext}
              title="Next match (Enter)"
            >
              ↓
            </button>
          </>
        )}
        <button
          className="aya-findbar-btn"
          onClick={onClose}
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>
      {historyActive && (searched || hits.length > 0 || historyError !== null) && (
        <div className="aya-findbar-results">
          {hits.length === 0 ? (
            <div className="aya-findbar-empty">
              {historyError ?? (partialCoverageText
                ? <FindBarCoverageLine coverage={coverage} hasHits={false} agentLabel={agentLabel} />
                : `No matches in recent ${agentLabel} sessions for this directory`)}
            </div>
          ) : (
            hits.map((hit, index) => {
              const time = formatHitTime(hit.timestamp);
              const expanded = expandedHit === index;
              return (
                <button
                  key={`${hit.sessionId}-${index}`}
                  type="button"
                  className="aya-findbar-hit"
                  onClick={() => setExpandedHit(expanded ? null : index)}
                  title={expanded ? "Collapse" : "Expand full message"}
                >
                  <div className="aya-findbar-hit-meta">
                    <span className="aya-findbar-hit-role">
                      {hit.role === "user" ? "You" : agentLabel}
                    </span>
                    {time && <span>{time}</span>}
                  </div>
                  {expanded ? (
                    <div
                      className="aya-findbar-hit-full"
                      // Let the user select/copy the text without the click
                      // bubbling to the row button and collapsing it.
                      onClick={(e) => e.stopPropagation()}
                    >
                      {hit.text}
                    </div>
                  ) : (
                    <div className="aya-findbar-hit-snippet">
                      {hit.snippet.slice(0, hit.matchStart)}
                      <mark>
                        {hit.snippet.slice(
                          hit.matchStart,
                          hit.matchStart + hit.matchLength,
                        )}
                      </mark>
                      {hit.snippet.slice(hit.matchStart + hit.matchLength)}
                    </div>
                  )}
                </button>
              );
            })
          )}
          {partialCoverageText && hits.length > 0 && (
            <FindBarCoverageLine coverage={coverage} hasHits agentLabel={agentLabel} />
          )}
        </div>
      )}
    </div>
  );
}
