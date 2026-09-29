/** A random 16-hex-char id for tabs, splits and draft rows. */
export function uuid(): string {
  // Secure RNG (CodeQL flags Math.random() ids); getRandomValues is available
  // even on the file:// production page, unlike crypto.randomUUID.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
