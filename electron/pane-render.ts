// `aya pane read` returns what a pane SHOWS. The raw tail of a repainting TUI
// (Grok animates its logo) is escape codes and spinner frames with no text, so
// the whole replay buffer is replayed through a headless terminal instead.

import { Terminal } from "@xterm/headless";

// Enough lines to fill PANE_READ_MAX_CHARS even for short lines; the terminal
// lives only for one read.
export const PANE_RENDER_SCROLLBACK_LINES = 10_000;

export interface PaneSize {
  cols: number;
  rows: number;
}

/** Plain text of `raw` replayed at cols x rows: the alt screen if a TUI holds
 *  it, else scrollback + screen, wrapped rows rejoined, trailing blanks cut. */
export async function renderPaneText(
  raw: string,
  cols: number,
  rows: number,
): Promise<string> {
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: PANE_RENDER_SCROLLBACK_LINES,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => terminal.write(raw, resolve));
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
    ? renderPaneText(buffer, size.cols, size.rows)
    : Promise.resolve(buffer);
}
