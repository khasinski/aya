import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import type { Preset, TerminalState, ThemeColors } from "../types";

interface Props {
  terminal: TerminalState;
  preset: Preset;
  command: string;
  isVisible: boolean;
  cwd: string;
  fontSize: number;
  themeColors: ThemeColors;
  /** When true, render the in-pane search bar (Cmd+F target). */
  findOpen: boolean;
  /** Called when the user closes the search bar (Esc / ✕). */
  onCloseFind: () => void;
  onPtyData?: (chunk: string) => void;
  /** Called when the user requests a restart of an exited PTY via the
   *  Shift+Enter hint. The host resets the terminal's exitCode/status so the
   *  PTY event loop can flow again. */
  onRequestRestart?: () => void;
  /** Bumped by App when the user right-clicks → Restart on this terminal.
   *  The component reuses its xterm instance and spawns a fresh PTY. */
  restartTrigger: number;
}

/** Our internal ThemeColors shape is a superset of xterm.js's ITheme. This
 *  just hands it through — separate function so the call site stays clean. */
function toXtermTheme(c: ThemeColors): ITheme {
  return c;
}

export function TerminalView({
  terminal,
  preset,
  command,
  isVisible,
  cwd,
  fontSize,
  themeColors,
  findOpen,
  onCloseFind,
  onPtyData,
  onRequestRestart,
  restartTrigger,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const spawnedRef = useRef(false);
  const fitFrameRef = useRef<number | null>(null);
  const [findQuery, setFindQuery] = useState("");
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
      // Option-as-Meta so Option+B / Option+F / Option+Backspace send the
      // ESC-prefixed sequences readline (zsh, bash, claude, codex) expects
      // for backward-word / forward-word / delete-word. Without this, macOS
      // intercepts Option+letter and emits Unicode (Option+e → "´"), which
      // is what produced the "aeaer ;3D" garbage on backspace-word.
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
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
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        // Browser dropped the WebGL context (tab backgrounded for too long
        // on low-memory machines). Dispose the addon — xterm will fall
        // back to DOM rendering automatically and the user keeps a
        // working terminal at the cost of the drift fix.
        try {
          webgl.dispose();
        } catch {
          /* ignore */
        }
      });
      term.loadAddon(webgl);
    } catch {
      // WebGL unavailable; DOM renderer is fine, just drifty.
    }

    xtermRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    fitTerminal();

    const unsubscribe = window.aya.onPtyEvent((event) => {
      if (event.ptyId !== terminal.id) return;
      if (event.type === "data") {
        term.write(event.chunk);
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
          command: commandRef.current,
          cwd: cwdRef.current,
          cols: Math.max(t.cols, 80),
          rows: Math.max(t.rows, 24),
        });
        canRestartRef.current = false;
        return false;
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
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);

  useEffect(() => {
    if (!isVisible) return;
    fitTerminal(true);
    const frame = requestAnimationFrame(() => fitTerminal(true));
    const timer = setTimeout(() => fitTerminal(true), 80);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [fitTerminal, isVisible]);

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
    term.writeln("\x1b[2m[restarting…]\x1b[0m");
    void window.aya.ptySpawn({
      ptyId: terminal.id,
      command: commandRef.current,
      cwd: cwdRef.current,
      cols: Math.max(term.cols, 80),
      rows: Math.max(term.rows, 24),
    });
  }, [restartTrigger, terminal.id]);

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
      className="aya-pane"
      style={{ display: isVisible ? "flex" : "none" }}
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
        <div className="aya-pane-header-meta">
          <span className="dim">{cwd}</span>
        </div>
      </div>
      <div className="aya-xterm-host" ref={containerRef} />
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
