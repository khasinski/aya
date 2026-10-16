const crypto = require("node:crypto");

function ptyOwnerBuildId({ platform, arch, flags, compilerVersion, paneLimitSource, ownerSource, protocolSource, identitySource }) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ platform, arch, flags, compilerVersion }))
    .update(paneLimitSource)
    .update(ownerSource)
    .update(protocolSource)
    .update(identitySource)
    .digest("hex");
}

module.exports = { ptyOwnerBuildId };
