import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import type { Preset, Snippet, TerminalState, ThemeColors } from "../types";
import { snippetPtyPayload } from "../snippet-payload";
import { SnippetBar } from "./SnippetBar";

interface Props {
  terminal: TerminalState;
  preset: Preset;
  command: string;
  /** Saved snippets the user can inject into this terminal via the drawer. */
  snippets: Snippet[];
  isVisible: boolean;
  cwd: string;
  lastActivity?: number;
  fontSize: number;
  themeColors: ThemeColors;
  /** When true, render the in-pane search bar (Cmd+F target). */
  findOpen: boolean;
  /** Called when the user closes the search bar (Esc / ✕). */
  onCloseFind: () => void;
  onOpenSettings: () => void;
  onCloseProject: (slug: string) => void;
  onPtyData?: (chunk: string) => void;
  /** Called when the user requests a restart of an exited PTY via the
   *  Shift+Enter hint. The host resets the terminal's exitCode/status so the
   *  PTY event loop can flow again. */
  onRequestRestart?: () => void;
  /** Bumped by App when the user right-clicks → Restart on this terminal.
   *  The component reuses its xterm instance and spawns a fresh PTY. */
  restartTrigger: number;
  isActivePane?: boolean;
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

export function TerminalView({
  terminal,
  preset,
  command,
  snippets,
  isVisible,
  cwd,
  lastActivity,
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
  onActivatePane,
  enableWebgl = true,
}: Props) {
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
  const fitFrameRef = useRef<number | null>(null);
  const replayingOutputRef = useRef(0);
  const [findQuery, setFindQuery] = useState("");
  const [isScrollbarHidden, setIsScrollbarHidden] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);
  const [snippetsOpen, setSnippetsOpen] = useState(false);

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
      }, 80);
    },
    [fitTerminal],
  );

  const attachWebgl = useCallback(
    (term: XTerm) => {
      if (!enableWebgl || webglRef.current) return;
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
    [enableWebgl, repairTerminalRender],
  );

  // Create the xterm instance + spawn the PTY once.
  useEffect(() => {
    if (!containerRef.current || xtermRef.current) return;
    const term = new XTerm({
      theme: toXtermTheme(themeColors),
      fontFamily:
        '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      // Animate between row positions on wheel scroll instead of snapping
      // one row at a time per tick. Terminal grids are inherently row-
      // quantized, but the snap is what reads as "choppy" when you flick
      // the trackpad. 125ms is about 8 frames at 60Hz: noticeable easing
      // without feeling sluggish.
      smoothScrollDuration: 125,
      // Option-as-Meta so Option+B / Option+F / Option+Backspace send the
      // ESC-prefixed sequences readline (zsh, bash, claude, codex) expects
      // for backward-word / forward-word / delete-word. Without this, macOS
      // intercepts Option+letter and emits Unicode (Option+e → "´"), which
      // is what produced the "aeaer ;3D" garbage on backspace-word.
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    const webLinks = new WebLinksAddon((_e, uri) => {
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
        if (event.replay) {
          replayingOutputRef.current += 1;
          term.write(event.chunk, () => {
            replayingOutputRef.current = Math.max(0, replayingOutputRef.current - 1);
          });
        } else {
          term.write(event.chunk);
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
      if (ev.type !== "keydown") return true;

      // Shift+Enter on a cleanly-exited terminal: restart in the same pane.
      // Returning false from this handler stops xterm from forwarding the
      // key to the (now-defunct) PTY.
      if (
        ev.key === "Enter" &&
        ev.shiftKey &&
        !ev.metaKey &&
        !ev.ctrlKey &&
        !ev.altKey &&
        canRestartRef.current
      ) {
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
          cols: Math.max(t.cols, 80),
          rows: Math.max(t.rows, 24),
        });
        canRestartRef.current = false;
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
        cols: Math.max(cols, 80),
        rows: Math.max(rows, 24),
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
    if (enableWebgl) {
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
  }, [attachWebgl, enableWebgl, repairTerminalRender]);

  useEffect(() => {
    if (!isVisible) return;
    repairTerminalRender(true);
    const frame = requestAnimationFrame(() => repairTerminalRender(true));
    const timer = setTimeout(() => repairTerminalRender(true), 80);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [isVisible, repairTerminalRender]);

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
    xtermRef.current.options.fontSize = fontSize;
    fitTerminal();
  }, [fitTerminal, fontSize]);

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
      cols: Math.max(term.cols, 80),
      rows: Math.max(term.rows, 24),
    });
  }, [restartTrigger, terminal.id]);

  useEffect(() => {
    setIsRestoring(true);
    const id = window.setTimeout(() => setIsRestoring(false), 2500);
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

  return (
    <div
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
          className={`aya-pane-snippettoggle ${
            snippetsOpen ? "aya-pane-snippettoggle--on" : ""
          }`}
          type="button"
          title="Saved snippets"
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
            <button className="aya-pane-recovery-btn" onClick={onOpenSettings}>
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
      >
        <div className="aya-xterm-frame" ref={containerRef} />
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
