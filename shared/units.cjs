exports.gib = bytes => bytes === null ? "?" : (bytes / 2 ** 30).toFixed(1);
exports.gibFromMiB = mib => mib === null ? "?" : (mib / 1024).toFixed(1);
