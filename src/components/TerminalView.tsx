import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { Preset, TerminalState, ThemeColors } from "../types";

interface Props {
  terminal: TerminalState;
  preset: Preset;
  command: string;
  isVisible: boolean;
  cwd: string;
  fontSize: number;
  themeColors: ThemeColors;
  onPtyData?: (chunk: string) => void;
  /** Called when the user requests a restart of an exited PTY via the
   *  Shift+Enter hint. The host resets the terminal's exitCode/status so the
   *  PTY event loop can flow again. */
  onRequestRestart?: () => void;
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
  onPtyData,
  onRequestRestart,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
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
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    });

    xtermRef.current = term;
    fitRef.current = fit;

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

    // Intercept Shift+Enter when the PTY is dead-but-cleanly-exited and
    // turn it into a restart. Returning false from this handler stops
    // xterm from forwarding the key to the (now-defunct) PTY.
    term.attachCustomKeyEventHandler((ev) => {
      if (
        ev.type === "keydown" &&
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
        // Let the host clear exit state first, then ask main for a fresh
        // PTY against the same id. ptySpawn is idempotent against existing
        // ids; the previous PTY was removed on exit, so this spawns anew.
        onRequestRestart?.();
        void window.aya.ptySpawn({
          ptyId: terminal.id,
          command: commandRef.current,
          cwd: cwdRef.current,
          cols: Math.max(t.cols, 80),
          rows: Math.max(t.rows, 24),
        });
        // Mark as live so a follow-up keypress doesn't re-trigger restart.
        canRestartRef.current = false;
        return false;
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);

  useEffect(() => {
    if (!isVisible) return;
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      xtermRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [isVisible]);

  useEffect(() => {
    const onResize = () => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!xtermRef.current) return;
    xtermRef.current.options.fontSize = fontSize;
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
  }, [fontSize]);

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
    </div>
  );
}
