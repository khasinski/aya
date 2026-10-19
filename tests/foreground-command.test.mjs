// What a shell pane runs right now, read with ps (#217): the terminal's foreground process group (tpgid) is the shell's
// own at its prompt, and a command's while it runs. The ps answers are faked here; e2e/restart-busy-panes.spec.ts reads a
// real shell in an Aya pane.

import { test } from "node:test";
import assert from "node:assert/strict";

const { foregroundCommand, FOREGROUND_COMMAND_MAX } = await import("../dist-electron/foreground-command.js");

/** A ps that answers tpgid and command from `table` (pid -> [tpgid, command]) and records what it was asked. */
function fakePs(table) {
  const calls = [];
  const ps = async (args) => {
    calls.push(args.join(" "));
    const row = table[Number(args.at(-1))];
    if (!row) throw new Error("ps: no such process");
    return `${args[1] === "tpgid=" ? row[0] : row[1]}\n`;
  };
  return { ps, calls };
}

const LONG = `node ${"/very/long/path".repeat(8)}/vite.js --port 5183`;

// [case, ps table, pid asked, expected]
const CASES = [
  ["at its prompt the shell holds the foreground: none", { 100: [100, "-zsh"] }, 100, null],
  ["a command took the foreground: its command line", { 100: [205, "-zsh"], 205: [205, "npm run dev"] }, 100, "npm run dev"],
  ["the whitespace ps pads with is folded", { 100: [205, "-zsh"], 205: [205, "  make   watch "] }, 100, "make watch"],
  ["a long command is cut", { 100: [205, "-zsh"], 205: [205, LONG] }, 100, `${LONG.slice(0, FOREGROUND_COMMAND_MAX - 3)}...`],
  ["the group's first process ended, the rest still runs: unnamed", { 100: [205, "-zsh"] }, 100, "a command"],
  ["no controlling terminal (tpgid -1): none", { 100: [-1, "zsh"] }, 100, null],
  ["the shell is gone: none", {}, 100, null],
  ["tpgid unreadable: none", { 100: ["", "-zsh"] }, 100, null],
];

for (const [name, table, pid, expected] of CASES) {
  test(name, async () => {
    assert.equal(await foregroundCommand(pid, fakePs(table).ps), expected);
  });
}

test("no pid to ask about: ps is not run", async () => {
  const { ps, calls } = fakePs({});
  for (const pid of [0, -5, 1.5, Number.NaN]) assert.equal(await foregroundCommand(pid, ps), null);
  assert.deepEqual(calls, []);
});

test("asks ps for the shell's tpgid, then for that group leader's command", async () => {
  const { ps, calls } = fakePs({ 100: [205, "-zsh"], 205: [205, "sleep 30"] });
  await foregroundCommand(100, ps);
  assert.deepEqual(calls, ["-o tpgid= -p 100", "-o command= -p 205"]);
});
