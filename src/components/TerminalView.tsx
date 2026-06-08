import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import type { Preset, Snippet, TerminalState, ThemeColors } from "../types";
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
  shouldPreserveTerminalScrollback,
  shouldUseTerminalWebgl,
  stripScrollbackErase,
} from "../terminal-rendering";
import { snippetPtyPayload } from "../snippet-payload";
import { SnippetBar } from "./SnippetBar";

// Terminal sizing + timing constants. The fallback cols/rows are the standard
// 80x24 a PTY gets before xterm has measured the pane (used at every spawn).
const TERMINAL_FALLBACK_COLS = 80;
const TERMINAL_FALLBACK_ROWS = 24;
const DEFAULT_TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace';
// Lines of scrollback xterm keeps in memory per terminal.
const SCROLLBACK_LINES = 10_000;
// Wheel-scroll easing: ~8 frames at 60Hz — smooth without feeling sluggish.
const SMOOTH_SCROLL_DURATION_MS = 125;
// Delay before re-fitting/repainting a freshly-shown terminal, giving xterm a
// beat to finish measuring after a visibility/layout change.
const RENDER_REPAIR_DELAY_MS = 80;
// Retry delay for focusing the active terminal once it's done measuring.
const FOCUS_RETRY_DELAY_MS = 60;
// How long to keep showing "Restoring sessions…" before assuming the replay
// arrived (or there was nothing to replay).
const RESTORE_FALLBACK_MS = 2_500;
const INPUT_LOG_MAX_CHARS = 240;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`]+/i;
const URL_TRAILING_PUNCTUATION_RE = /[),.;\]]+$/;
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
  /** Saved snippets the user can inject into this terminal via the drawer. */
  snippets: Snippet[];
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
  onOpenSettings: (tab?: SettingsTab) => void;
  onCloseProject: (slug: string) => void;
  onPtyData?: (chunk: string) => void;
  macOptionKeyMode: MacOptionKeyMode;
  /** Called when the user requests a restart of an exited PTY via the
   *  Shift+Enter hint. The host resets the terminal's exitCode/status so the
   *  PTY event loop can flow again. */
  onRequestRestart?: () => void;
  /** Bumped by App when the user right-clicks → Restart on this terminal.
   *  The component reuses its xterm instance and spawns a fresh PTY. */
  restartTrigger: number;
  isActivePane?: boolean;
  /** True when this is THE terminal the user is interacting with right now:
   *  active project + active tab + active split cell, and no overlay/modal is
   *  open. Drives deterministic keyboard focus (see the focus effect below). */
  isActive?: boolean;
  onActivatePane?: () => void;
  enableWebgl?: boolean;
}

/** Our internal ThemeColors shape is a superset of xterm.js's ITheme. This
 *  just hands it through — separate function so the call site stays clean. */
function toXtermTheme(c: ThemeColors): ITheme {
  return c;
}

function formatLastActivity(timestamp: number): string | null {
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const monthMs = 30 * dayMs;

  if (elapsedMs < minuteMs) return null;
  if (elapsedMs < hourMs) {
    const minutes = Math.floor(elapsedMs / minuteMs);
    return `${minutes} min ago`;
  }
  if (elapsedMs < dayMs) {
    const hours = Math.floor(elapsedMs / hourMs);
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  if (elapsedMs < monthMs) {
    const days = Math.floor(elapsedMs / dayMs);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }
  const months = Math.floor(elapsedMs / monthMs);
  return `${months} ${months === 1 ? "month" : "months"} ago`;
}

function recoveryTitle(
  reason: NonNullable<TerminalState["spawnFailure"]>["reason"],
): string {
  if (reason === "command-not-found") return "Command not found";
  if (reason === "preset-empty-command") return "Preset command is empty";
  if (reason === "cwd-missing") return "Project folder is missing";
  if (reason === "cwd-not-directory") return "Project path is not a folder";
  if (reason === "cwd-unreadable") return "Project folder is not readable";
  return "Terminal failed to start";
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

export function TerminalView({
  terminal,
  preset,
  command,
  snippets,
  isVisible,
  cwd,
  lastActivity,
  fontFamily,
  fontSize,
  themeColors,
  findOpen,
  onCloseFind,
  onOpenSettings,
  onCloseProject,
  onPtyData,
  onRequestRestart,
  restartTrigger,
  isActivePane = false,
  isActive = false,
  onActivatePane,
  enableWebgl = true,
  macOptionKeyMode,
}: Props) {
  const shouldUseWebgl =
    shouldUseTerminalWebgl(enableWebgl, preset.id);
  const shouldPreserveScrollback =
    shouldPreserveTerminalScrollback(preset.id);
  const lastActivityLabel = lastActivity ? formatLastActivity(lastActivity) : null;
  const headerStatusText = terminal.externalStatus?.text ?? lastActivityLabel;
  const headerStatusTitle = terminal.externalStatus
    ? new Date(terminal.externalStatus.updatedAt).toLocaleString()
    : lastActivity
      ? new Date(lastActivity).toLocaleString()
      : undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const spawnedRef = useRef(false);
  // True while a full-screen/rich TUI (claude, codex, vim…) is running, detected
  // via focus-reporting mode (DECSET 1004). Gates the Shift+Enter soft newline.
  const richInputRef = useRef(false);
  const fitFrameRef = useRef<number | null>(null);
  const replayingOutputRef = useRef(0);
  const optionSideRef = useRef<OptionSide>("unknown");
  const macOptionKeyModeRef = useRef(macOptionKeyMode);
  macOptionKeyModeRef.current = macOptionKeyMode;
  const [findQuery, setFindQuery] = useState("");
  const [isScrollbarHidden, setIsScrollbarHidden] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState | null>(
    null,
  );

  // Write a saved snippet's text into this terminal's PTY. autoRun appends a
  // carriage return so it executes immediately; otherwise we only type the
  // text and leave the cursor for the user to edit/extend. Either way we
  // return focus to the terminal so the user can keep working.
  const sendSnippet = useCallback(
    (snippet: Snippet) => {
      // A dead PTY (exited / spawn-failed) silently swallows ptyWrite, so the
      // snippet would vanish with no feedback. Tell the user in the terminal
      // itself and skip the no-op write. exitCode is non-null once the PTY has
      // exited; restarting (Shift+Enter) clears it back to null.
      if (terminal.exitCode !== null) {
        try {
          xtermRef.current?.write(
            "\r\n\x1b[2maya: terminal has exited — press Shift+Enter to restart, then send the snippet again\x1b[0m\r\n",
          );
        } catch {
          /* ignore — terminal may be mid-dispose */
        }
        setSnippetsOpen(false);
        return;
      }
      void window.aya.ptyWrite(terminal.id, snippetPtyPayload(snippet));
      // Collapse the drawer so the result (and the typed text) is visible —
      // an open drawer covers the bottom of the terminal — and return focus
      // so the user can keep typing / press Enter on a held snippet.
      setSnippetsOpen(false);
      try {
        xtermRef.current?.focus();
      } catch {
        /* ignore — terminal may be mid-dispose */
      }
    },
    [terminal.id, terminal.exitCode],
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
  canRestartRef.current = terminal.exitCode === 0;
  const commandRef = useRef(command);
  commandRef.current = command;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

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
        /* ignore — xterm may be mid-dispose or still measuring fonts */
      }
    });
  }, []);

  const repairTerminalRender = useCallback(
    (shouldFocus = false) => {
      const refresh = () => {
        const term = xtermRef.current;
        if (!term) return;
        try {
          webglRef.current?.clearTextureAtlas();
          term.refresh(0, Math.max(term.rows - 1, 0));
        } catch {
          /* ignore — renderer may be recreating after sleep/wake */
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

  const attachWebgl = useCallback(
    (term: XTerm) => {
      if (!shouldUseWebgl || webglRef.current) return;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          try {
            webgl.dispose();
          } catch {
            /* ignore */
          }
          if (webglRef.current === webgl) webglRef.current = null;
          repairTerminalRender(false);
        });
        term.loadAddon(webgl);
        webglRef.current = webgl;
        repairTerminalRender(false);
      } catch {
        // WebGL unavailable; DOM renderer is fine, just drifty.
      }
    },
    [repairTerminalRender, shouldUseWebgl],
  );

  // Create the xterm instance + spawn the PTY once.
  useEffect(() => {
    if (!containerRef.current || xtermRef.current) return;
    const term = new XTerm({
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

    // GPU-accelerated renderer — eliminates the column-drift you get with
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

    const unsubscribe = window.aya.onPtyEvent((event) => {
      if (event.ptyId !== terminal.id) return;
      setIsRestoring(false);
      if (event.type === "data") {
        // Track whether a full-screen / rich TUI (claude, codex, vim…) is
        // running via focus-reporting mode (DECSET 1004). It gates Shift+Enter:
        // soft newline inside the TUI, plain Enter (submit) at the shell prompt.
        richInputRef.current = focusReportingState(event.chunk, richInputRef.current);
        const displayChunk = shouldPreserveScrollback
          ? stripScrollbackErase(event.chunk)
          : event.chunk;
        if (event.replay) {
          replayingOutputRef.current += 1;
          term.write(displayChunk, () => {
            replayingOutputRef.current = Math.max(0, replayingOutputRef.current - 1);
          });
        } else {
          term.write(displayChunk);
        }
        if (onPtyData) onPtyData(event.chunk);
      } else if (event.type === "exit") {
        const restartHint =
          event.exitCode === 0
            ? " — press Shift+Enter to restart"
            : "";
        term.write(
          `\r\n\x1b[2m[process exited with code ${event.exitCode}${restartHint}]\x1b[0m\r\n`,
        );
      }
    });

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.key === "Alt") {
        optionSideRef.current =
          ev.type === "keydown" ? optionSideFromCode(ev.code) : "unknown";
        return true;
      }
      if (ev.type !== "keydown") return true;

      // Enter handling (restart / soft newline / submit) — see enterKeyAction.
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
          const t = xtermRef.current;
          if (!t) return false;
          t.writeln("\x1b[2m[restarting...]\x1b[0m");
          onRequestRestart?.();
          void window.aya.ptySpawn({
            ptyId: terminal.id,
            projectSlug: terminal.projectSlug,
            presetId: terminal.presetId,
            command: commandRef.current,
            cwd: cwdRef.current,
            cols: Math.max(t.cols, TERMINAL_FALLBACK_COLS),
            rows: Math.max(t.rows, TERMINAL_FALLBACK_ROWS),
          });
          canRestartRef.current = false;
          return false;
        }
        if (action === "soft-newline" || action === "submit") {
          // Shift/Option+Enter: a newline inside a running rich TUI (focus-
          // reporting on), a plain submit at the shell — xterm's default is
          // wrong for both (it submits Shift+Enter; macOptionIsMeta turns
          // Option+Enter into a zsh multiline edit).
          ev.preventDefault();
          void window.aya.ptyWrite(
            terminal.id,
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
        void window.aya.ptyWrite(terminal.id, leftOptionSeq);
        return false;
      }

      // Option+Arrow / Option+Backspace word navigation. xterm.js's default
      // encoding for these is CSI with an Alt modifier (`\x1b[1;3D` etc.),
      // which is NOT bound in vanilla zsh and which some shell configs
      // misinterpret as a delete command (user-visible symptom: text
      // disappears instead of cursor moving). Send the iTerm2-style
      // ESC-prefixed sequences instead — those are what readline, zsh's
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
          void window.aya.ptyWrite(terminal.id, seq);
          return false;
        }
      }

      // Bare control + letter combos (no Cmd/Shift/Alt) are shell-level
      // control characters. Chromium intercepts several of them at the
      // WebContents level — Ctrl+R as page-reload is the headline one,
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
        if (code >= 97 && code <= 122) {
          // a–z → control byte 0x01–0x1A
          ev.preventDefault();
          const ctrlByte = String.fromCharCode(code - 96);
          void window.aya.ptyWrite(terminal.id, ctrlByte);
          return false;
        }
      }

      return true;
    });

    const onDataDisposable = term.onData((data) => {
      if (replayingOutputRef.current > 0) return;
      if (data.length > 0) setIsScrollbarHidden(true);
      if (localStorage.getItem("aya:debug-terminal-input") === "1") {
        console.debug(
          `[aya terminal input] ${terminal.id} ${preset.id}: ${printableControlData(data)}`,
        );
      }
      void window.aya.ptyWrite(terminal.id, data);
    });

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      void window.aya.ptyResize(terminal.id, cols, rows);
    });

    // Track the current foreground process via OSC 0/2 title sequences.
    // macOS zsh's default config emits these via preexec/precmd hooks, so
    // running `git log` in a shell tab updates the title to "git log".
    const onTitleDisposable = term.onTitleChange((title) => {
      setProcessTitle(title);
    });

    if (!spawnedRef.current) {
      spawnedRef.current = true;
      const { cols, rows } = term;
      void window.aya.ptySpawn({
        ptyId: terminal.id,
        projectSlug: terminal.projectSlug,
        presetId: terminal.presetId,
        command,
        cwd,
        cols: Math.max(cols, TERMINAL_FALLBACK_COLS),
        rows: Math.max(rows, TERMINAL_FALLBACK_ROWS),
      });
    }

    return () => {
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
      repairTerminalRender(false);
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
    repairTerminalRender(false);
  }, [attachWebgl, repairTerminalRender, shouldUseWebgl]);

  useEffect(() => {
    if (!isVisible) return;
    // Repaint the freshly-shown terminal (webgl atlas, scrollback). Focus is
    // NOT done here — it's owned by the isActive effect below, so a concurrent
    // fit can't swallow it.
    repairTerminalRender(false);
    const frame = requestAnimationFrame(() => repairTerminalRender(false));
    const timer = setTimeout(() => repairTerminalRender(false), RENDER_REPAIR_DELAY_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [isVisible, repairTerminalRender]);

  // Single source of truth for keyboard focus: whenever this becomes THE active
  // terminal (tab switch, split-pane navigation, or an overlay/modal closing),
  // focus its xterm. Deliberately decoupled from fitTerminal's shared,
  // cancellable rAF so a stray fit can't drop the focus. The find bar wants the
  // focus while it's open, so defer to it.
  const wantsFocus = isActive && !findOpen;
  useEffect(() => {
    if (!wantsFocus) return;
    const focusNow = () => {
      try {
        const term = xtermRef.current;
        const host = containerRef.current;
        if (term && host && host.clientWidth > 0 && host.clientHeight > 0) {
          term.focus();
        }
      } catch {
        /* ignore — xterm may be mid-dispose */
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
  }, [wantsFocus]);

  useEffect(() => {
    if (!isVisible) return;
    const onResumeRender = () => repairTerminalRender(false);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") onResumeRender();
    };
    window.addEventListener("focus", onResumeRender);
    window.addEventListener("pageshow", onResumeRender);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onResumeRender);
      window.removeEventListener("pageshow", onResumeRender);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isVisible, repairTerminalRender]);

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
    setIsRestoring(true);
    term.writeln("\x1b[2m[restarting…]\x1b[0m");
    void window.aya.ptySpawn({
      ptyId: terminal.id,
      projectSlug: terminal.projectSlug,
      presetId: terminal.presetId,
      command: commandRef.current,
      cwd: cwdRef.current,
      cols: Math.max(term.cols, TERMINAL_FALLBACK_COLS),
      rows: Math.max(term.rows, TERMINAL_FALLBACK_ROWS),
    });
  }, [restartTrigger, terminal.id]);

  useEffect(() => {
    setIsRestoring(true);
    const id = window.setTimeout(() => setIsRestoring(false), RESTORE_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [terminal.id]);

  // Hot-swap theme when the active selection changes. xterm.js stashes the
  // new palette into `options.theme` but does NOT repaint the visible grid by
  // itself — already-rendered cells keep the old colors. We force a refresh
  // of every visible row to make the change take effect immediately.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.theme = toXtermTheme(themeColors);
    try {
      term.refresh(0, Math.max(term.rows - 1, 0));
    } catch {
      /* ignore — refresh may throw if the terminal is being disposed */
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
    const text = await window.aya.readClipboard();
    if (text) xtermRef.current?.paste(text);
    setContextMenu(null);
    xtermRef.current?.focus();
  };

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

  return (
    <div
      data-testid="terminal-pane"
      data-terminal-id={terminal.id}
      data-terminal-name={terminal.name}
      className={
        `aya-pane ${isScrollbarHidden ? "aya-pane--scrollbar-hidden" : ""} ${
          isActivePane ? "aya-pane--active-split" : ""
        }`
      }
      style={{ display: isVisible ? "flex" : "none" }}
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
        <button
          data-testid="snippet-toggle"
          className={`aya-pane-snippettoggle ${
            snippetsOpen ? "aya-pane-snippettoggle--on" : ""
          }`}
          type="button"
          title="Saved snippets"
          // Keep terminal focus when toggling the drawer (same as the top-bar
          // dropdowns) — opening snippets shouldn't force a re-click to type.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            setSnippetsOpen((v) => !v);
          }}
        >
          <span style={{ fontFamily: "Material Symbols Outlined" }}>bolt</span>
          <span className="aya-pane-snippettoggle-label">snippets</span>
          <span style={{ fontFamily: "Material Symbols Outlined" }}>
            {snippetsOpen ? "expand_more" : "expand_less"}
          </span>
        </button>
      </div>
      {terminal.spawnFailure && (
        <div className="aya-pane-recovery">
          <div className="aya-pane-recovery-text">
            <strong>{recoveryTitle(terminal.spawnFailure.reason)}</strong>
            <span>{terminal.spawnFailure.detail.split("\n")[0]}</span>
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
              onClick={onRequestRestart}
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
      >
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
            className="aya-terminal-context-item"
            type="button"
            onClick={pasteClipboard}
          >
            <span style={{ fontFamily: "Material Symbols Outlined" }}>
              content_paste
            </span>
            Paste
          </button>
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
        onClose={() => setSnippetsOpen(false)}
        onSend={sendSnippet}
        onOpenSettings={onOpenSettings}
      />
      {findOpen && (
        <FindBar
          value={findQuery}
          onChange={(v) => {
            setFindQuery(v);
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

interface FindBarProps {
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

function FindBar({
  value,
  onChange,
  onNext,
  onPrev,
  onClose,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Focus + select-all on mount so opening the bar twice in a row lets
    // the user replace the query directly.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="aya-findbar">
      <input
        ref={inputRef}
        className="aya-findbar-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          }
        }}
        placeholder="Find in terminal…"
        spellCheck={false}
      />
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
      <button
        className="aya-findbar-btn"
        onClick={onClose}
        title="Close (Esc)"
      >
        ✕
      </button>
    </div>
  );
}
