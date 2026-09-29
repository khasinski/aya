// `aya pane read` returns what a pane SHOWS. The raw tail of a repainting TUI
// (Grok animates its logo) is escape codes and spinner frames with no text, so
// the whole replay buffer is replayed through a headless terminal instead.

import { Terminal } from "@xterm/headless";

// Fills PANE_READ_MAX_CHARS once rows average 6.4+ chars; shorter rows
// (`yes x`) read back fewer chars. 32,000 rows would fit any row, but for 1 MB
// of 2-char lines at 160 cols it peaked at +127 MB RSS vs +55 MB (103 vs 78 ms).
export const PANE_RENDER_SCROLLBACK_LINES = 10_000;

// The replay buffer is capped, so a long-running TUI's own enter can be gone.
const ENTER_ALT_SCREEN = "\x1b[?1049h";

export interface PaneSize {
  cols: number;
  rows: number;
  /** The host's mirror holds the alt screen; absent from an older host. */
  alt?: boolean;
}

/** Plain text of `raw` replayed at cols x rows: the alt screen if a TUI holds
 *  it (or `alt` says so), else scrollback + screen, trailing blanks cut. */
export async function renderPaneText(
  raw: string,
  cols: number,
  rows: number,
  alt = false,
): Promise<string> {
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: PANE_RENDER_SCROLLBACK_LINES,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => terminal.write(alt ? ENTER_ALT_SCREEN + raw : raw, resolve));
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      const text = line?.translateToString(true) ?? "";
      if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd();
  } finally {
    terminal.dispose();
  }
}

/** Rendered text when the pane's size is known; an older pty host cannot
 *  report it, and then the raw buffer is all there is. */
export function paneReadText(
  buffer: string,
  size: PaneSize | null,
): Promise<string> {
  return size
    ? renderPaneText(buffer, size.cols, size.rows, size.alt)
    : Promise.resolve(buffer);
}
