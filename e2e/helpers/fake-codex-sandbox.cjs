// Codex under its sandbox: in workspace-write without network every `aya` call fails with connect EPERM (codex-cli
// 0.158.0); with the network switch, -s danger-full-access or the bypass it goes through. Records its argv and whoami in the project dir.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const me = process.env.AYA_TERMINAL_ID;
const log = path.join(process.env.AYA_PROJECT_DIR, `codex-${me}.log`);
const reaches =
  args.includes("--dangerously-bypass-approvals-and-sandbox") ||
  args.some((a, i) => (args[i - 1] === "-c" && a === "sandbox_workspace_write.network_access=true") || (args[i - 1] === "-s" && a === "danger-full-access"));
fs.writeFileSync(log, `ARGS ${args.join(" ")}\n`);
// Codex's idle composer, its chevron, model line and footer as busy-codex.screen.txt recorded them (tests/fixtures).
process.stdout.write(["› \x1b[2mAsk Codex to do anything\x1b[22m", "  GPT-6-Luna medium · ~/proj", "  ← for agents · ? for shortcuts"].join("\r\n") + "\r\n");
if (reaches) {
  // The role is given once the window has saved the new pane: ask until it is.
  const whoami = (tries) => {
    try {
      fs.appendFileSync(log, `WHOAMI ${execFileSync(process.env.AYA_E2E_AYA, ["team", "whoami"], { encoding: "utf8" })}`);
    } catch (err) {
      if (tries > 0) setTimeout(() => whoami(tries - 1), 500);
      else fs.appendFileSync(log, `FAIL ${err.stderr || err.message}`);
    }
  };
  whoami(40);
} else {
  fs.appendFileSync(log, `FAIL connect EPERM ${process.env.AYA_SOCKET}\n`);
}
process.stdin.on("data", (chunk) => fs.appendFileSync(log, chunk));
setInterval(() => {}, 60_000);
