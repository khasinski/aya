/** Decode bounded NDJSON frames independently of stdout chunk boundaries. */
export class GuiJsonLines {
  private parts: string[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes = 16 * 1024 * 1024) {}

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
        try { message = JSON.parse(line); } catch { throw Error('Malformed JSON from agent'); }
        receive(message);
      }
      start = end + 1;
    }
  }
}
