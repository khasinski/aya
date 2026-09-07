// `aya pane send <name> --submit <text>` must actually SUBMIT in the target
// pane, not just type into it.
//
// The reported bug: the text appeared in the Codex/Claude composer and sat
// there unsent. The cause was the byte shape, not the CLI parsing - pane-send
// wrote `${text}\r` as ONE chunk, and those composers treat a burst arriving
// together as a paste, so the carriage return became a newline in the message
// box instead of Enter. The fix sends the Enter as its own chunk once the
// burst has gone idle (electron/control.ts, PANE_SEND_SUBMIT_DELAY_MS).
//
// Two legs, because neither alone pins the fix:
//  - the RECORDER leg pins the byte-level contract the agent TUIs depend on -
//    the text arrives, then Enter as a separate, later chunk - without needing
//    a real agent. Its exact-equality assertion is also what rules out the
//    tempting wrong fix: wrapping the text in bracketed paste does submit in
//    both agent TUIs, but bash 3.2 (macOS /bin/sh and /bin/bash) has no
//    bracketed paste and turns the markers into literal command text
//    (`bash: 00~echo: command not found`). A shell pane cannot pin that - the
//    seed runs $SHELL, and zsh/bash 5 handle the markers fine.
//  - the SHELL leg proves those bytes actually RUN a command end to end, which
//    byte assertions alone never show.
//
// Both drive the real `bin/aya`, so the argument order the user types
// (`--submit` between the pane name and the text) is covered too.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import type { SeededEnv } from "./helpers/seed";

// Each test boots the app AND waits for a login shell to bring up a program
// (a node recorder, or the shell's own line editor). Under the full suite that
// startup is far slower than in an isolated run, so these need more than the
// project-wide 45 s.
test.describe.configure({ timeout: 120_000 });

const AYA_CLI = join(__dirname, "..", "bin", "aya");
const RECORDER = join(__dirname, "helpers", "pty-recorder.cjs");
// The pane command runs under the user's login shell, whose PATH is not the
// runner's - so spawn the recorder with the very node running this spec.
const NODE = process.execPath;
/** Smallest gap that still proves the CR left the text's burst behind. */
const MIN_SUBMIT_GAP_MS = 50;

/** Run the real CLI against the TEST instance. Every AYA_* variable is dropped
 *  first: this suite is often run from inside an Aya pane, and an inherited
 *  AYA_SOCKET would aim the command at the developer's live app instead. */
function ayaPaneSend(ayaHome: string, args: string[]): void {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("AYA_")),
  ) as Record<string, string>;
  execFileSync(AYA_CLI, ["pane", "send", ...args], {
    env: { ...env, AYA_HOME: ayaHome },
    encoding: "utf8",
    timeout: 15_000,
  });
}

const paneBuffer = (window: Page, terminalId: string) =>
  window.evaluate((id) => window.aya.ptyBuffer(id), terminalId);

/** Poll a pane's PTY buffer until it contains `needle`. */
async function paneShows(window: Page, terminalId: string, needle: string) {
  await expect
    .poll(() => paneBuffer(window, terminalId), {
      message: `pane ${terminalId} never showed ${needle}`,
      timeout: 60_000,
    })
    .toContain(needle);
}

/** Prove a shell pane is EXECUTING, not merely echoing. A shell that has not
 *  finished starting swallows queued bytes, while the tty echoes the typed
 *  line either way - so "the text is visible" is not readiness (that mistake
 *  made this spec fail under full-suite load). Retype until the output of an
 *  arithmetic expansion, which only execution can produce, shows up. */
async function shellExecuting(window: Page, paneIndex: number, terminalId: string) {
  await window.locator(".aya-pane").nth(paneIndex).locator(".xterm-screen").click();
  await expect
    .poll(
      async () => {
        const buffer = await paneBuffer(window, terminalId);
        if (buffer.includes("ready-2")) return buffer;
        await window.keyboard.insertText("echo ready-$((1+1))");
        await window.keyboard.press("Enter");
        return buffer;
      },
      {
        message: `the shell in ${terminalId} never executed a command`,
        timeout: 60_000,
        intervals: [1_000],
      },
    )
    .toContain("ready-2");
}

const recorderLog = (seeded: SeededEnv, terminalId: string) =>
  join(seeded.projectDir, `rec-${terminalId}.jsonl`);

/** The recorder creates its (empty) log file once it is reading stdin, so the
 *  file appearing is the readiness gate - bytes sent after it cannot be lost. */
async function recorderReady(seeded: SeededEnv, terminalId: string) {
  await expect
    .poll(() => existsSync(recorderLog(seeded, terminalId)), {
      message: `the recorder in ${terminalId} never started`,
      timeout: 60_000,
    })
    .toBe(true);
}

/** What the recorder pane logged: one entry per raw PTY chunk, in order. */
function recorded(seeded: SeededEnv, terminalId: string) {
  const path = recorderLog(seeded, terminalId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { t: number; b: string });
}

const bytes = (chunks: { b: string }[]) => chunks.map((c) => c.b).join("");

test.describe("pane-send into an agent-shaped program", () => {
  // Both seeded tabs run the recorder instead of a shell, so a test can read
  // back the exact bytes - and their arrival times - that reached the PTY.
  // (These tests take the `window` fixture without touching the DOM: asking
  // for it is what launches the app the CLI then drives.)
  test.use({
    seedOptions: {
      presetList: [
        {
          id: "shell",
          name: "Recorder",
          icon: "$",
          color: "",
          // The two panes share a project dir, so the terminal id keeps their
          // logs apart.
          command: `'${NODE}' '${RECORDER}' "$AYA_PROJECT_DIR/rec-$AYA_TERMINAL_ID.jsonl"`,
        },
      ],
    },
  });

  test("--submit delivers Enter as its own chunk, after the text", async ({
    window,
    seeded,
  }) => {
    await recorderReady(seeded, seeded.tabIds.right);

    ayaPaneSend(seeded.ayaHome, ["shell 2", "--submit", "tekst"]);

    // Exact equality also proves nothing extra is injected - bracketed-paste
    // markers would show up right here.
    await expect
      .poll(() => bytes(recorded(seeded, seeded.tabIds.right)), {
        message: "the pane never received the full text plus a CR",
        timeout: 15_000,
      })
      .toBe("tekst\r");

    // The contract: the CR is NOT part of the text's burst. A combined
    // "tekst\r" chunk is exactly what left the agent composers unsubmitted.
    const chunks = recorded(seeded, seeded.tabIds.right);
    const cr = chunks.at(-1)!;
    expect(cr.b, "the CR rode along in the text's chunk").toBe("\r");
    expect(cr.t - chunks[chunks.length - 2].t).toBeGreaterThanOrEqual(
      MIN_SUBMIT_GAP_MS,
    );
  });

  test("without --submit the text is typed but no Enter follows", async ({
    window,
    seeded,
  }) => {
    await recorderReady(seeded, seeded.tabIds.right);

    ayaPaneSend(seeded.ayaHome, ["shell 2", "tekst"]);

    await expect
      .poll(() => bytes(recorded(seeded, seeded.tabIds.right)), {
        message: "the pane never received the text",
        timeout: 15_000,
      })
      .toBe("tekst");
  });
});

test("pane-send --submit runs the command in an ordinary shell pane", async ({
  window,
  seeded,
}) => {
  await shellExecuting(window, 1, seeded.tabIds.right);

  // Arithmetic expansion separates "typed" from "executed": the echoed line
  // shows the literal $((21+21)), only a real submit prints ok-42.
  ayaPaneSend(seeded.ayaHome, ["shell 2", "--submit", "echo ok-$((21+21))"]);

  await paneShows(window, seeded.tabIds.right, "ok-42");
});
