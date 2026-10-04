// A fake `ssh` for the machines e2e: answers the read-only probe (`-- <target> sh -s`) from fixed data per target,
// logs every call to $AYA_FAKE_SSH_LOG, and never reaches a network. Anything else exits 255 like a refused host.
const fs = require("node:fs");

const args = process.argv.slice(2);
const dash = args.indexOf("--");
const target = dash >= 0 ? args[dash + 1] : "";
const command = dash >= 0 ? args.slice(dash + 2).join(" ") : "";
if (process.env.AYA_FAKE_SSH_LOG) fs.appendFileSync(process.env.AYA_FAKE_SSH_LOG, `${args.join(" ")}\n`);

const GIB_KB = 1024 * 1024;
const inMinutes = (min) => new Date(Date.now() + min * 60_000).toISOString();

function probe({ cores, load, totalGiB, availGiB, gpu, version, models }) {
  return [
    "@@nproc", String(cores),
    "@@loadavg", `${load} 1.00 0.50 1/300 4242`,
    "@@meminfo", `MemTotal:       ${totalGiB * GIB_KB} kB`, `MemFree:        ${GIB_KB} kB`, `MemAvailable:   ${availGiB * GIB_KB} kB`,
    "@@vmstat", "@@memsize",
    "@@gpu", gpu ?? "",
    "@@version", version ? JSON.stringify({ version }) : "",
    "@@ps", models ? JSON.stringify({ models }) : "",
    "@@end", "",
  ].join("\n");
}

const HOSTS = {
  "gpu-box": () =>
    probe({
      cores: 32, load: 3.2, totalGiB: 125, availGiB: 84,
      gpu: "NVIDIA GeForce RTX 4090, 97, 21500, 24564",
      version: "0.12.3",
      models: [{ name: "qwen3:32b", model: "qwen3:32b", digest: "ab12cd34ef56", size_vram: 21000000000, expires_at: inMinutes(14) }],
    }),
  // Up, but Ollama is not answering on its port.
  "mini-lab": () => probe({ cores: 10, load: 0.8, totalGiB: 32, availGiB: 20 }),
};

const fail = (line) => {
  process.stderr.write(`${line}\n`);
  process.exit(255);
};

const answer = HOSTS[target];
if (command !== "sh -s" || !answer) {
  if (target === "old-server") fail("old-server: Permission denied (publickey).");
  fail(`ssh: connect to host ${target.replace(/^.*@/, "")} port 22: Connection refused`);
}
// The probe script arrives on stdin; read it all so ssh-like behaviour holds, then answer.
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(answer()));
