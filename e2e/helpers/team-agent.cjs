// A stand-in agent for team e2e: in the default modes tab-left sends one team message; every pane
// records what reaches its input in team-<pane>.log in the project dir.
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// The branch's own CLI: an older installed `aya` may come first on PATH.
const aya = process.argv[2];
// Modes (argv[3]) shape tab-right (implementer) or tab-left (tester or lead); argv[4] is a delay in ms. "transcript-*" draw an
// idle composer under a last answer; "lead-*" (but lead-restarts) answer Aya's no-progress round; "deaf"/"busy" use raw input (a real CLI does not echo).
const mode = process.argv[3] ?? "";
const me = process.env.AYA_TERMINAL_ID;
const log = path.join(process.env.AYA_PROJECT_DIR, `team-${me}.log`);
fs.writeFileSync(log, "");
const seenFile = path.join(process.env.AYA_PROJECT_DIR, `team-${me}.seen`);
let draftShown = false;
let dialogUp = false;
let askedOnce = false;
const relaunched = mode === "relaunch" && fs.existsSync(seenFile);
if (mode === "relaunch") fs.writeFileSync(seenFile, "");
process.stdin.setEncoding("utf8");
const codexPaste = mode === "codex-paste";
const chevron = codexPaste ? "›" : "❯";
const CLEAR = "\x1b[2J\x1b[H";
const boxed = (row) => process.stdout.write(`${"─".repeat(40)}\r\n${row}\r\n${"─".repeat(40)}\r\n`);
const redraw = () => (process.stdout.write(CLEAR), composer());
if (codexPaste) {
  // Codex's paste-burst rule, as measured: fast raw input is a paste, and an Enter right
  // behind it is a newline in the text, not a submit. A bracketed paste is one atomic paste.
  const BURST_MIN_CHARS = 100;
  const BURST_ENTER_WINDOW_MS = 500;
  const PASTE_START = "\x1b[200~";
  const PASTE_END = "\x1b[201~";
  let draft = "";
  let inPaste = false;
  let lastRawBurstAt = 0;
  process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?2004h");
  let pending = "";
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    for (;;) {
      if (inPaste) {
        const end = pending.indexOf(PASTE_END);
        if (end === -1) {
          // The end marker may be split across reads: keep what could be its start.
          const keep = pending.length - (PASTE_END.length - 1);
          if (keep > 0) (draft += pending.slice(0, keep)), (pending = pending.slice(keep));
          return;
        }
        draft += pending.slice(0, end);
        pending = pending.slice(end + PASTE_END.length);
        inPaste = false;
      } else if (pending.startsWith(PASTE_START)) {
        pending = pending.slice(PASTE_START.length);
        inPaste = true;
      } else if (pending === "") {
        return;
      } else if (pending === "\r") {
        pending = "";
        if (Date.now() - lastRawBurstAt < BURST_ENTER_WINDOW_MS) {
          draft += "\n";
          fs.appendFileSync(log, "SWALLOWED-ENTER\n");
        } else {
          fs.appendFileSync(log, `SUBMITTED ${draft}\n`);
          draft = "";
        }
      } else if (PASTE_START.startsWith(pending)) {
        return;
      } else {
        const marker = pending.indexOf("\x1b");
        const raw = marker > 0 ? pending.slice(0, marker) : pending;
        pending = pending.slice(raw.length);
        draft += raw;
        if (raw.length >= BURST_MIN_CHARS) lastRawBurstAt = Date.now();
      }
    }
  });
} else {
  // Cooked input reaches the agent only at Enter; the dialog must see the paste first.
  if (mode === "approval-after-paste" || mode === "slow-echo") process.stdin.setRawMode(true);
  process.stdin.on("data", (chunk) => {
    fs.appendFileSync(log, chunk);
    if (mode === "slow-echo") {
      const pasted = /\x1b\[200~([\s\S]*)\x1b\[201~/.exec(String(chunk));
      if (pasted) (process.stdout.write(CLEAR), boxed(`${chevron} ${pasted[1]}`));
      if (String(chunk).endsWith("\r")) setTimeout(redraw, Number(process.argv[4]));
    }
    if (mode === "lead-waits-dialog" && me === "tab-left" && dialogUp && String(chunk).includes("\n")) {
      dialogUp = false;
      redraw();
      fs.appendFileSync(log, "DIALOG-ANSWERED\n");
    }
    if (["lead-answers", "lead-waits", "lead-pauses", "lead-idle-hook", "lead-waits-dialog"].includes(mode) && me === "tab-left" && String(chunk).includes("no progress since") && !(mode === "lead-waits-dialog" && askedOnce)) {
      askedOnce = true;
      const args = {
        "lead-answers": ["team", "send", "implementer", "decision: ship the retry, I reran the timer test and it is green"],
        "lead-waits": ["status", "waiting", "need the staging password"],
        "lead-pauses": ["team", "pause", "no lower complexity is possible"],
        "lead-idle-hook": ["status", "waiting", "Waiting for your next prompt"],
        "lead-waits-dialog": ["status", "waiting", "need the staging password"],
      }[mode];
      const env = mode === "lead-idle-hook" ? { ...process.env, AYA_VIA: "hook" } : process.env;
      execFile(aya, args, { encoding: "utf8", env }, (err, _out, stderr) => {
        if (!err && mode === "lead-waits-dialog") {
          dialogUp = true;
          process.stdout.write(`${CLEAR}Bash command\r\n  npm run deploy\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n`);
        }
        fs.appendFileSync(log, err ? `FAIL ${stderr || err.message}\n` : `ANSWERED ${mode}\n`);
      });
    }
    if (mode === "draft-briefly" && me === "tab-left" && !draftShown && String(chunk).includes("Delivery test")) {
      draftShown = true;
      process.stdout.write(CLEAR);
      boxed(`${chevron} half typed text`);
      setTimeout(redraw, Number(process.argv[4]));
    }
    // "approval-after-paste": a permission dialog is drawn inside the 150 ms between the
    // paste and Enter (measured on real Claude: that Enter then approves the tool call).
    if (mode === "approval-after-paste" && me === "tab-right" && chunk.includes("\x1b[201~")) {
      setTimeout(() => process.stdout.write(`${CLEAR}Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n`), APPROVAL_DELAY_MS);
    }
  });
}
const APPROVAL_DELAY_MS = 40;
const LONG_MESSAGE = `long report: ${"finding ".repeat(120)}end`;
// Rows are right-trimmed: the capture's padding would wrap in a pane narrower than the capture.
const screen = (name) => `${fs.readFileSync(path.join(__dirname, "..", "..", "tests", "fixtures", name), "utf8").trimEnd().split("\n").map((row) => row.trimEnd()).join("\r\n")}\r\n`;
const bootMs = (mode === "opencode-boot" || mode === "drawing-boot") && me === "tab-right" ? Number(process.argv[4]) : null;
let drawn = bootMs === null;
if (bootMs !== null) {
  if (!Number.isFinite(bootMs)) throw new Error(`${mode} needs its delay in ms`);
  process.stdin.on("data", (chunk) => drawn || fs.appendFileSync(log, `EARLY ${JSON.stringify(chunk)}\n`));
}
const PLACEHOLDER = 'Try "write a test for <filepath>"';
const composerRow = mode === "focused-cursor" ? `${chevron}\u00a0\x1b[7m${PLACEHOLDER[0]}\x1b[27m\x1b[2m${PLACEHOLDER.slice(1)}\x1b[22m` : `${chevron} `;
const composer = () => boxed(composerRow);
if ((mode.startsWith("ask") || (mode === "relaunch" && !relaunched)) && me === "tab-right") {
  process.stdout.write("Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n");
  if (mode === "ask-briefly") {
    const askMs = Number(process.argv[4]);
    if (!Number.isFinite(askMs)) throw new Error("ask-briefly needs its delay in ms");
    setTimeout(redraw, askMs);
  } else if (mode === "ask-until-released") {
    // The test, not a clock, decides when the prompt clears: prompt-release-<pane> in, prompt-cleared-<pane> out.
    const dir = process.env.AYA_PROJECT_DIR;
    const release = setInterval(() => {
      if (!fs.existsSync(path.join(dir, `prompt-release-${me}`))) return;
      clearInterval(release);
      redraw();
      fs.writeFileSync(path.join(dir, `prompt-cleared-${me}`), "");
    }, 100);
  }
} else if (mode === "transcript-waiting" && me === "tab-right") {
  process.stdin.setRawMode(true);
  process.stdout.write("\u23fa I'm waiting for approval before starting titleCase.\r\n");
  composer();
  process.stdout.write("  \u23f5\u23f5 auto mode on (shift+tab to cycle)\r\n");
} else if (mode.startsWith("transcript-waiting-") && me === "tab-right") {
  process.stdin.setRawMode(true);
  const said = "I'm waiting for approval before starting titleCase.";
  const idle = {
    codex: [`• ${said}`, "", "› \x1b[2mAsk Codex to do anything\x1b[22m", "  GPT-6-Luna medium · ~/proj", "  ← for agents · ? for shortcuts"],
    opencode: [`     ${said}`, "", "  ┃", "  ┃", "  ┃  Build · DeepSeek V4 Flash OpenCode Zen", `  ╹${"▀".repeat(50)}`, "         ctrl+p commands    • OpenCode 1.18.30"],
    grok: [`     ${said}`, "", `  ╭${"─".repeat(56)}╮`, `  │ ❯${" ".repeat(54)}│`, `  ╰${"─".repeat(19)} Grok 4.7 (medium) · always-approve ─╯`, "", "  Shift+Tab:mode  │  Ctrl+x:shortcuts"],
  }[mode.slice("transcript-waiting-".length)];
  process.stdout.write(idle.join("\r\n") + "\r\n");
} else if (mode === "transcript-question" && me === "tab-left") {
  // Asks its question 2 s after start: output before the window attaches is only replayed.
  process.stdin.setRawMode(true);
  composer();
  setTimeout(() => {
    process.stdout.write(`${CLEAR}\u23fa Do you want me to start titleCase now?\r\n`);
    composer();
    process.stdout.write("  \u23f5\u23f5 auto mode on (shift+tab to cycle)\r\n");
  }, 2_000);
} else if (mode === "deaf" && me === "tab-right") {
  process.stdin.setRawMode(true);
  composer();
} else if (mode === "exit" && me === "tab-right") {
  composer();
  setTimeout(() => process.exit(0), 1_500);
} else if (mode === "exit-on-round" && me === "tab-right") {
  // The relaunch liveness check needs one typed round per app life, then a
  // stopped agent. A timed exit can take three rounds and trigger the brake.
  composer();
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (/Round \d+:/.test(input)) process.exit(0);
  });
} else if (mode === "busy" && me === "tab-right") {
  // The recorded footer is wider than the e2e pane and would wrap; keep its shape, shortened.
  process.stdin.setRawMode(true);
  composer();
  process.stdout.write("  ⏵⏵ auto mode on · esc to interrupt\r\n");
} else if (mode === "drawing-boot" && bootMs !== null) {
  process.stdin.setRawMode(true);
  const loading = setInterval(() => process.stdout.write(`loading ${Date.now()}\r\n`), 300);
  setTimeout(() => {
    clearInterval(loading);
    drawn = true;
    redraw();
  }, bootMs);
} else if (bootMs !== null) {
  process.stdin.setRawMode(true);
  setTimeout(() => {
    drawn = true;
    process.stdout.write(screen("opencode-idle.screen.txt"));
  }, bootMs);
} else if (mode === "opencode-draft" && me === "tab-right") {
  process.stdin.setRawMode(true);
  process.stdout.write(screen("opencode-draft.screen.txt"));
  setTimeout(() => process.stdout.write(`${CLEAR}${screen("opencode-idle.screen.txt")}`), Number(process.argv[4]));
} else if (mode === "plan" && me === "tab-left") {
  process.stdout.write(screen("opencode-plan-question.screen.txt"));
} else if (mode === "permission" && me === "tab-left") {
  process.stdin.setRawMode(true);
  process.stdout.write(screen("opencode-permission-80.screen.txt"));
} else if (mode === "plan" || mode === "permission") {
  // The preset says opencode for both panes, and Aya holds an OpenCode pane until it draws OpenCode's bar.
  process.stdout.write(screen("opencode-idle.screen.txt"));
} else {
  composer();
}
if (mode === "lead-restarts" && me === "tab-left") {
  let tries = 0;
  setInterval(() => {
    const unset = tries++ % 2 === 1;
    const env = { ...process.env };
    if (unset) delete env.AYA_TERMINAL_ID;
    const tag = unset ? "id unset" : "id set";
    execFile(aya, ["team", "start", "ux-review", "1b27df1 is already measured: easy 51, medium 45, hard 393", "--to", "implementer"], { encoding: "utf8", env }, (err, out, stderr) =>
      fs.appendFileSync(log, err ? `START-FAIL (${tag}) ${stderr || err.message}` : `START-OK (${tag}) ${out}`),
    );
  }, 1000);
}
if (mode === "relaunch") {
  setTimeout(() => {
    try {
      fs.appendFileSync(log, `WHOAMI ${execFileSync(aya, ["team", "whoami"], { encoding: "utf8" })}`);
    } catch (err) {
      fs.appendFileSync(log, `WHOAMI-FAIL ${err.stderr || err.message}`);
    }
  }, 1000);
}
if (me === "tab-left" && !["quiet", "plan", "focused-cursor", "draft-briefly", "slow-echo", "lead-answers", "lead-waits", "lead-pauses", "lead-idle-hook", "lead-waits-dialog", "lead-restarts", "transcript-question"].includes(mode) && !relaunched) {
  setTimeout(() => {
    try {
      const text = codexPaste ? LONG_MESSAGE : mode === "relaunch" ? "peer report from life 1" : "round 5 ready";
      const out = execFileSync(aya, ["team", "send", "implementer", text], { encoding: "utf8" });
      fs.appendFileSync(log, `SENT ${out}`);
    } catch (err) {
      fs.appendFileSync(log, `FAIL ${err.stderr || err.message}`);
    }
  }, 3000);
}
// A test stands in for an agent that outlived the app and asks who it is: the request has to come
// from a process of this pane, since Aya checks that a command runs under the pane it names.
const whoamiRequest = path.join(process.env.AYA_PROJECT_DIR, `whoami-request-${me}`);
setInterval(() => {
  if (!fs.existsSync(whoamiRequest)) return;
  fs.rmSync(whoamiRequest);
  const outFile = path.join(process.env.AYA_PROJECT_DIR, `whoami-out-${me}`);
  execFile(aya, ["team", "whoami"], { encoding: "utf8", env: { ...process.env, AYA_OPEN_WAIT_SECONDS: "60" } }, (err, stdout, stderr) =>
    fs.writeFileSync(outFile, err ? `FAIL ${stderr || err.message}` : stdout),
  );
}, 200);
// send-request-<pane> holds "<to> <text>", sent from this pane's process (role commands need that proof).
const sendRequest = path.join(process.env.AYA_PROJECT_DIR, `send-request-${me}`);
setInterval(() => {
  if (!fs.existsSync(sendRequest)) return;
  const [to, ...text] = fs.readFileSync(sendRequest, "utf8").trim().split(" ");
  fs.rmSync(sendRequest);
  execFile(aya, ["team", "send", to, text.join(" ")], { encoding: "utf8" }, (err, _out, stderr) => fs.appendFileSync(log, err ? `FAIL ${stderr || err.message}\n` : "SENT on request\n"));
}, 200);
