"use strict";

/** Decide whether electron-builder should use its normal identity path or the
 * local ad-hoc fallback. A found identity always keeps the existing release
 * signing/notarization flow unchanged. */
exports.macSigningMode = ({ platform, identity, identityFound }) => {
  if (platform !== "darwin") return "not-macOS";
  if (identity === "-") return "ad-hoc-configured";
  return identityFound ? "identity" : "ad-hoc-fallback";
};

