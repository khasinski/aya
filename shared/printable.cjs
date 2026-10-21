// Printable text used by both Electron-process and renderer surfaces. Keep
// control and bidi characters visible instead of letting them alter layout.
const ACTS_ON_TERMINAL = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\u206a-\u206f]/gu;

function printable(text) {
  return text.replace(ACTS_ON_TERMINAL, (c) => (c === "\t" || c === "\n" ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
}

module.exports = { printable };
