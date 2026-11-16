// The image formats a board card can hold, in one list: electron/board.ts checks
// saved and read images against it, and the board's file picker offers it.
// A format is recognised by its first bytes; any one of its signatures matches.

const freezeFormat = (format) => Object.freeze({
  ...format,
  signatures: Object.freeze(format.signatures.map((parts) => Object.freeze(parts.map((part) => Object.freeze(part))))),
});

exports.BOARD_IMAGE_FORMATS = Object.freeze([
  { name: "PNG", mime: "image/png", ext: ".png", signatures: [[{ at: 0, bytes: [137, 80, 78, 71, 13, 10, 26, 10] }]] },
  { name: "JPEG", mime: "image/jpeg", ext: ".jpg", signatures: [[{ at: 0, bytes: [0xff, 0xd8, 0xff] }]] },
  { name: "WebP", mime: "image/webp", ext: ".webp", signatures: [[{ at: 0, text: "RIFF" }, { at: 8, text: "WEBP" }]] },
  { name: "GIF", mime: "image/gif", ext: ".gif", signatures: [[{ at: 0, text: "GIF87a" }], [{ at: 0, text: "GIF89a" }]] },
].map(freezeFormat));

/** The file picker's accept list. */
exports.BOARD_IMAGE_ACCEPT = exports.BOARD_IMAGE_FORMATS.map((format) => format.mime).join(",");

/** The format names as a list, e.g. "PNG, JPEG, WebP, and GIF" or "..., or GIF". */
exports.listBoardImageFormats = (conjunction) => {
  const names = exports.BOARD_IMAGE_FORMATS.map((format) => format.name);
  return `${names.slice(0, -1).join(", ")}, ${conjunction} ${names[names.length - 1]}`;
};

const partMatches = (bytes, { at, bytes: expected, text }) => {
  const want = expected ?? Array.from(text, (char) => char.charCodeAt(0));
  return bytes.length >= at + want.length && want.every((value, index) => bytes[at + index] === value);
};

/** The format the bytes start with, or null. */
exports.detectBoardImageFormat = (bytes) =>
  exports.BOARD_IMAGE_FORMATS.find((format) => format.signatures.some((parts) => parts.every((part) => partMatches(bytes, part)))) ?? null;
