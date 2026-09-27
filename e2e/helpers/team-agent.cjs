// A stand-in agent for team e2e: tab-left sends one team message; every pane
// records what reaches its input in team-<pane>.log in the project dir.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// The branch's own CLI: an older installed `aya` may come first on PATH.
const aya = process.argv[2];
// "ask": the implementer sits on an approval prompt, like a real agent would.
const mode = process.argv[3];
const me = process.env.AYA_TERMINAL_ID;
const log = path.join(process.env.AYA_PROJECT_DIR, `team-${me}.log`);
fs.writeFileSync(log, "");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => fs.appendFileSync(log, chunk));
if (mode === "ask" && me === "tab-right") {
  process.stdout.write("Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n");
}
if (me === "tab-left" && mode !== "quiet") {
  setTimeout(() => {
    try {
      const out = execFileSync(aya, ["team", "send", "implementer", "round 5 ready"], { encoding: "utf8" });
      fs.appendFileSync(log, `SENT ${out}`);
    } catch (err) {
      fs.appendFileSync(log, `FAIL ${err.stderr || err.message}`);
    }
  }, 3000);
}
setInterval(() => {}, 60_000);
