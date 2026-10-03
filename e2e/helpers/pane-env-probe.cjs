// Stands in for an agent: records the env its pane gave it, then saves a team
// with the real CLI from that pane and records the outcome, then idles.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [out, aya] = process.argv.slice(2);
const file = (name) => path.join(out, `${name}-${process.env.AYA_TERMINAL_ID}.json`);
fs.writeFileSync(file("env"), JSON.stringify(process.env));
const cli = (args, input) => spawnSync(aya, ["team", ...args], { encoding: "utf8", input });
const guide = cli(["new", "a team that reviews and fixes UX"]);
const team = guide.stdout.split(/^----- .* -----$/m)[1];
const save = cli(["save", "-"], team);
fs.writeFileSync(file("save"), JSON.stringify({ status: save.status, stdout: save.stdout, stderr: save.stderr }));
process.stdout.write("probe ready\n");
setInterval(() => {}, 60_000);
