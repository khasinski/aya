// `aya pane send --submit` must SUBMIT, not just type. Recorder pane pins the
// byte shape (text, then Enter as its own later chunk); shell pane proves those
// bytes run a command. The exact-byte assertion is the ONLY guard against a
// bracketed-paste "fix", which breaks bash 3.2 - no pane here runs bash 3.2.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import type { SeededEnv } from "./helpers/seed";

// App boot plus a login shell starting a program; slower than the 45 s default.
test.describe.configure({ timeout: 120_000 });

const AYA_CLI = join(__dirname, "..", "bin", "aya");
const RECORDER = join(__dirname, "helpers", "pty-recorder.cjs");
// The pane runs under a login shell whose PATH is not the runner's.
const NODE = process.execPath;
/** Restated, not imported: shrinking PANE_SEND_SUBMIT_DELAY_MS must fail here. */
const MIN_SUBMIT_GAP_MS = 120;
/** Past the submit delay, so a regressed always-submit had its chance to fire. */
const SUBMIT_SETTLE_MS = 600;

/** Real CLI against the TEST instance: an inherited AYA_SOCKET would aim it at
 *  the developer's live app, so every AYA_* is dropped. */
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

/** Readiness is EXECUTION, not echo: the tty echoes typed bytes a starting
 *  shell will never run. Retype until the computed value appears. */
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

/** The log file appears once stdin is being read: bytes sent after cannot be lost. */
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
  // Recorder panes expose the exact bytes and arrival times reaching the PTY.
  // `window` is taken to launch the app, not to touch the DOM.
  test.use({
    seedOptions: {
      presetList: [
        {
          id: "shell",
          name: "Recorder",
          icon: "$",
          color: "",
          // Shared project dir: the terminal id keeps the two logs apart.
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

    // Exact equality also rules out injected bracketed-paste markers.
    await expect
      .poll(() => bytes(recorded(seeded, seeded.tabIds.right)), {
        message: "the pane never received the full text plus a CR",
        timeout: 15_000,
      })
      .toBe("tekst\r");

    // The CR must not ride in the text chunk: that is what left it unsubmitted.
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

    // The poll alone would also pass for an always-append-a-delayed-CR bug.
    // Settling past the submit window is what kills that deterministically.
    await window.waitForTimeout(SUBMIT_SETTLE_MS);
    const chunks = recorded(seeded, seeded.tabIds.right);
    expect(bytes(chunks), "an Enter arrived without --submit").toBe("tekst");
  });
});

test("pane-send --submit runs the command in an ordinary shell pane", async ({
  window,
  seeded,
}) => {
  await shellExecuting(window, 1, seeded.tabIds.right);

  // Arithmetic expansion separates typed from executed: only a submit prints ok-42.
  ayaPaneSend(seeded.ayaHome, ["shell 2", "--submit", "echo ok-$((21+21))"]);

  await paneShows(window, seeded.tabIds.right, "ok-42");
});
