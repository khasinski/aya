// Binary byte units: a KiB is 1024 bytes, and each unit after it is 1024 of the one before.
// Limits are written in these units and sizes are shown in them, in main and in the renderer.
const BINARY_STEP = 1024;
const BYTES_PER_KIB = BINARY_STEP;
const BYTES_PER_MIB = BYTES_PER_KIB * BINARY_STEP;
const MIB_PER_GIB = BINARY_STEP;
const BYTES_PER_GIB = BYTES_PER_MIB * MIB_PER_GIB;
exports.BYTES_PER_KIB = BYTES_PER_KIB;
exports.BYTES_PER_MIB = BYTES_PER_MIB;

exports.gib = bytes => bytes === null ? "?" : (bytes / BYTES_PER_GIB).toFixed(1);
exports.gibFromMiB = mib => mib === null ? "?" : (mib / MIB_PER_GIB).toFixed(1);
exports.mib = bytes => bytes === null ? "?" : (bytes / BYTES_PER_MIB).toFixed(1);
