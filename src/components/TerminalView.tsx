import { useEffect, useRef } from "react";
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
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);

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
        term.write(
          `\r\n\x1b[2m[process exited with code ${event.exitCode}]\x1b[0m\r\n`,
        );
      }
    });

    const onDataDisposable = term.onData((data) => {
      void window.aya.ptyWrite(terminal.id, data);
    });

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      void window.aya.ptyResize(terminal.id, cols, rows);
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
        <div className="aya-pane-header-meta">
          <span className="dim">{cwd}</span>
        </div>
      </div>
      <div className="aya-xterm-host" ref={containerRef} />
    </div>
  );
}
