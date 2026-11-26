/** Decode bounded NDJSON frames independently of stdout chunk boundaries. A line that is not JSON goes to `malformed`
 *  and the next lines are still read (a stray line an agent prints must not end its session); without it, it throws. */
export class GuiJsonLines {
  private parts: string[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes = 16 * 1024 * 1024, private readonly malformed?: (line: string) => void) {}

  push(chunk: string, receive: (message: unknown) => void) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf('\n', start);
      const part = chunk.slice(start, end < 0 ? undefined : end);
      this.bytes += Buffer.byteLength(part, 'utf8');
      if (this.bytes > this.maxBytes) throw Error('Protocol frame exceeded 16 MB');
      this.parts.push(part);
      if (end < 0) return;
      const line = this.parts.join('').trim();
      this.parts = [];
      this.bytes = 0;
      if (line) {
        let message: unknown;
        let parsed = true;
        try { message = JSON.parse(line); } catch { if (!this.malformed) throw Error('Malformed JSON from agent'); parsed = false; }
        if (parsed) receive(message); else this.malformed!(line);
      }
      start = end + 1;
    }
  }
}

/** An agent's stray non-JSON line is logged and skipped. */
export const skipMalformedLine = (agent: string) => (line: string) => console.warn(`Aya: skipped a line from ${agent} that is not JSON: ${line.slice(0, 200)}`);
