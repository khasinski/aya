// Claude at a permission dialog that stays up while its hooks report `aya status waiting`, then `aya status done`, once
// the test writes $AYA_PROJECT_DIR/go-<pane>. argv: <aya>; writes HOOK-SENT or FAIL to $AYA_PROJECT_DIR/dialog-<pane>.log.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const aya = process.argv[2];
const me = process.env.AYA_TERMINAL_ID;
const dir = process.env.AYA_PROJECT_DIR;
const log = path.join(dir, `dialog-${me}.log`);
fs.writeFileSync(log, "");
process.stdout.write("\x1b[2J\x1b[HBash command\r\n  npm run deploy\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n");
const poll = setInterval(() => {
  if (!fs.existsSync(path.join(dir, `go-${me}`))) return;
  clearInterval(poll);
  const env = { ...process.env, AYA_VIA: "hook" };
  const fail = (err, stderr) => fs.appendFileSync(log, `FAIL ${stderr || err.message}\n`);
  // In order, as Claude fires them: the Notification hook, then the Stop hook's finished turn.
  execFile(aya, ["status", "waiting", "Claude needs your permission to use Bash"], { env }, (err, _out, stderr) => {
    if (err) return fail(err, stderr);
    execFile(aya, ["status", "done", "Turn finished"], { env }, (err2, _out2, stderr2) =>
      err2 ? fail(err2, stderr2) : fs.appendFileSync(log, "HOOK-SENT\n"),
    );
  });
}, 100);
setInterval(() => {}, 1 << 30);
