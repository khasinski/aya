// Shared by the status-bar renderer and `aya machines` so the repair text stays the same.
function hostTelemetryUnavailableText(error, sshTarget) {
  const reason = String(error || "SSH probe failed")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const base = `Host telemetry unavailable: ${reason}`;
  if (!sshTarget) return base;
  const sentenceBreak = /[.!?]$/.test(reason) ? " " : ". ";
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key changed|Offending .*key in .*known_hosts/i.test(reason)) {
    return `${base}${sentenceBreak}Verify the changed host key in a terminal: ssh ${sshTarget}. Do not re-add the key before verifying the change.`;
  }
  if (/Host key verification failed|No .+ host key is known|host key .+ unknown/i.test(reason)) {
    return `${base}${sentenceBreak}Verify the host key once in a terminal: ssh ${sshTarget}`;
  }
  return base;
}

module.exports = { hostTelemetryUnavailableText };
