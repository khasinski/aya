// One size standard for all of Aya: binary gibibytes, 1 GiB = 2^30 bytes, labelled GiB. RAM and VRAM read as their
// spec says (128.0 GiB on a 128 GB Mac, 24.0 GiB on a 24 GB RTX 4090); a model's 8.5 GiB stands next to the 9.1 GB
// `ollama ps` prints for the same bytes, and the label shows it is another unit, not another number.
// electron/units.ts and src/units.ts are the same file, since electron/ never imports from src/;
// tests/units-parity.test.mjs keeps them equal.

const BYTES_PER_GIB = 2 ** 30;
const MIB_PER_GIB = 1024;

/** "8.5" for 9_086_015_897 bytes; "?" when unknown. */
export const gib = (bytes: number | null): string => (bytes === null ? "?" : (bytes / BYTES_PER_GIB).toFixed(1));

/** nvidia-smi counts in MiB; shown in the same GiB as everything else. */
export const gibFromMiB = (mib: number | null): string => (mib === null ? "?" : (mib / MIB_PER_GIB).toFixed(1));
