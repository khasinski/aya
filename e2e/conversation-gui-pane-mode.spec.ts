// Terminal ⇄ Conversation: one Claude pane switches both ways in place and every switch resumes the same session.
// The terminal is e2e/helpers/fake-claude.cjs (it logs each launch's arguments and saves a transcript like Claude),
// the Conversation is tests/helpers/fake-claude-gui.cjs with its launch log on.

import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { closeAndWait, expect, launchApp, test } from "./fixtures";
import { agentBin } from "./helpers/agent-bin";
import { seedEnv } from "./helpers/seed";
import { fireShortcut } from "./helpers/shortcut";
import { SLOW_EXPECT_TIMEOUT_MS } from "./timeouts";

const FAKE_CLAUDE = agentBin("claude", join(__dirname, "helpers", "fake-claude.cjs"));
const FAKE_CODEX = agentBin("codex", join(__dirname, "helpers", "fake-codex.cjs"));

function seedClaudePane() {
  const seed = seedEnv({
    singleTab: { presetId: "claude", name: "Claude" },
    presetList: [{
      // No auto-resume: the seeded tab starts fresh (--session-id), and a switch resumes all the same.
      id: "claude", name: "Claude", icon: "✻", color: "", agent: "claude", configDir: "~/claude-config", autoResume: false,
      command: `CLAUDE_CONFIG_DIR="$HOME/claude-config" ${FAKE_CLAUDE} "$AYA_PROJECT_DIR/claude-$AYA_TERMINAL_ID.jsonl"`,
    }],
  });
  const bin = join(seed.root, "gui-bin"); mkdirSync(bin);
  copyFileSync(resolve("tests/helpers/fake-claude-gui.cjs"), join(bin, "claude")); chmodSync(join(bin, "claude"), 0o755);
  const guiLog = join(seed.root, "gui-launches.jsonl");
  seed.launchEnv = { ...seed.launchEnv, AYA_E2E_CLAUDE_BIN: join(bin, "claude"), AYA_FAKE_CLAUDE_LAUNCH_LOG: guiLog, AYA_FAKE_CLAUDE_FAIL_FILE: join(seed.root, "claude-gui-fails") };
  const lines = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const terminalLaunches = () => lines(join(seed.projectDir, `claude-${seed.tabIds.left}.jsonl`)) as { args: string[]; sessionId: string | null }[];
  const guiLaunches = () => lines(guiLog) as { args: string[] }[];
  const savedTab = () => (JSON.parse(readFileSync(join(seed.ayaHome, "projects", "e2e-proj.json"), "utf8")).tabs as { id: string; presetId: string; interfaceMode?: string; sessionId?: string }[])[0];
  const transcript = (sessionId: string) => {
    const projects = join(seed.root, "home", "claude-config", "projects");
    for (const dir of readdirSync(projects)) if (existsSync(join(projects, dir, `${sessionId}.jsonl`))) return join(projects, dir, `${sessionId}.jsonl`);
    throw Error(`no transcript for ${sessionId}`);
  };
  return { seed, terminalLaunches, guiLaunches, savedTab, transcript };
}

test("a Claude pane switches terminal → conversation → terminal on the same session, and keeps its mode", async () => {
  const { seed, terminalLaunches, guiLaunches, savedTab, transcript } = seedClaudePane();
  let app = await launchApp(seed);
  try {
    let page = await app.firstWindow();
    const terminal = page.locator('[data-testid="terminal-pane"]:visible');
    await expect.poll(() => terminalLaunches().length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(1);
    const sessionId = terminalLaunches()[0].sessionId!;
    expect(terminalLaunches()[0].args).toEqual(["--session-id", sessionId]);
    await expect.poll(() => savedTab().sessionId, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(sessionId);
    // What the terminal conversation said, as Claude Code saves it.
    appendFileSync(transcript(sessionId), [
      { type: "user", uuid: "u1", message: { role: "user", content: "Remember the word PELICAN." } },
      { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "I will remember PELICAN." }] } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");

    // Both modes draw the same header, with the switch in it.
    const header = terminal.locator('header.aya-pane-header[data-pane-mode="terminal"]');
    await expect(header.getByRole("button", { name: "Show as terminal" })).toHaveAttribute("aria-pressed", "true");
    await header.getByRole("button", { name: "Show as conversation" }).click();

    const gui = page.locator(".aya-conversation");
    await expect(gui.locator("header").getByRole("status")).toHaveText("Ready");
    await expect(gui.locator('header[data-pane-mode="gui"]').getByRole("button", { name: "Show as conversation" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-testid="terminal-pane"]:visible')).toHaveCount(0);
    await expect(gui.locator("article.user").first()).toContainText("Remember the word PELICAN.");
    await expect(gui.locator("article.assistant").first()).toContainText("I will remember PELICAN.");
    await expect(gui.locator(".aya-gui-import-notice")).toContainText("Continued the terminal session");
    expect(guiLaunches().at(-1)!.args).toEqual(expect.arrayContaining(["--resume", sessionId]));
    await expect.poll(() => savedTab().interfaceMode).toBe("gui");
    expect(savedTab()).toMatchObject({ presetId: "claude", sessionId });

    // A pending approval holds the switch, with a message; the pane stays a conversation.
    const prompt = gui.getByRole("textbox", { name: "Message Claude" });
    await prompt.fill("approval"); await prompt.press("Enter");
    const approval = gui.getByRole("group", { name: "Approval required" });
    await expect(approval).toBeVisible();
    await gui.getByRole("button", { name: "Show as terminal" }).click();
    await expect(gui.getByRole("alert").filter({ hasText: "Answer the pending approval" })).toBeVisible();
    await expect(gui).toBeVisible();
    await approval.getByRole("button", { name: "Allow once" }).click();
    await expect(gui.getByRole("status", { name: "Turn status" })).toHaveText("Turn complete");

    // ⌘⌥G (View menu): back to the terminal, which resumes the conversation's session.
    await fireShortcut(app, "toggle-pane-mode");
    await expect(page.locator('[data-testid="terminal-pane"]:visible')).toHaveCount(1);
    await expect(gui).toHaveCount(0);
    await expect.poll(() => terminalLaunches().length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(2);
    expect(terminalLaunches()[1].args).toEqual(["--resume", sessionId]);
    await expect.poll(() => savedTab().interfaceMode).toBe("terminal");

    // The mode survives a restart: switch once more and relaunch.
    await page.locator('[data-testid="terminal-pane"]:visible').getByRole("button", { name: "Show as conversation" }).click();
    await expect(page.locator(".aya-conversation header").getByRole("status")).toHaveText("Ready");
    await expect.poll(() => savedTab().interfaceMode).toBe("gui");
    await closeAndWait(app);
    const launchesBefore = guiLaunches().length;
    app = await launchApp(seed);
    page = await app.firstWindow();
    await expect(page.locator(".aya-conversation header").getByRole("status")).toHaveText("Ready");
    await expect(page.locator(".aya-conversation article.user").first()).toContainText("Remember the word PELICAN.");
    expect(terminalLaunches()).toHaveLength(2);
    expect(guiLaunches().length).toBe(launchesBefore + 1);
    expect(guiLaunches().at(-1)!.args).toEqual(expect.arrayContaining(["--resume", sessionId]));
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("a Codex pane carries its thread from the terminal to the conversation and back", async () => {
  const seed = seedEnv({
    singleTab: { presetId: "codex", name: "Codex" },
    presetList: [{
      id: "codex", name: "Codex", icon: "◆", color: "", agent: "codex", configDir: "~/codex-home", autoResume: false,
      command: `FAKE_CODEX_STORE=on CODEX_HOME="$HOME/codex-home" ${FAKE_CODEX} "$AYA_PROJECT_DIR/codex-$AYA_TERMINAL_ID.jsonl"`,
    }],
  });
  const bin = join(seed.root, "gui-bin"); mkdirSync(bin);
  copyFileSync(resolve("tests/helpers/fake-codex-gui.cjs"), join(bin, "codex")); chmodSync(join(bin, "codex"), 0o755);
  seed.launchEnv = { ...seed.launchEnv, AYA_E2E_CODEX_BIN: join(bin, "codex") };
  const launchFile = join(seed.projectDir, `codex-${seed.tabIds.left}.jsonl`);
  const launches = () => existsSync(launchFile) ? readFileSync(launchFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; session: string | null }) : [];
  const savedTab = () => JSON.parse(readFileSync(join(seed.ayaHome, "projects", "e2e-proj.json"), "utf8")).tabs[0] as { sessionId?: string; interfaceMode?: string };
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow();
    await expect.poll(() => launches().length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(1);
    const thread = launches()[0].session!;
    // Aya learns a Codex terminal's thread from Codex's own store.
    await expect.poll(() => savedTab().sessionId, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(thread);
    const day = join(seed.root, "home", "codex-home", "sessions", "2026", "11", "26");
    mkdirSync(day, { recursive: true });
    appendFileSync(join(day, `rollout-2026-11-26T10-00-00-${thread}.jsonl`), [
      { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "Remember the word HERON." }] } } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "HERON noted." }] } } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");

    await page.locator('[data-testid="terminal-pane"]:visible').getByRole("button", { name: "Show as conversation" }).click();
    const gui = page.locator(".aya-conversation");
    await expect(gui.locator("header").getByRole("status")).toHaveText("Ready");
    await expect(gui.locator("article.user").first()).toContainText("Remember the word HERON.");
    await expect(gui.locator("article.assistant").first()).toContainText("HERON noted.");

    await gui.getByRole("button", { name: "Show as terminal" }).click();
    await expect.poll(() => launches().length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(2);
    // The conversation resumed the terminal's thread (thread/resume), and the terminal resumes it again.
    expect(launches()[1]).toMatchObject({ args: ["resume", thread], session: thread });
    await expect.poll(() => savedTab().interfaceMode).toBe("terminal");
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

type Frame = { t: number; sameHeader: boolean; headerH: number; headerTop: number; veil: number; phase: string | null; term: boolean; rows: number; gui: boolean; guiStatus: string; articles: number; alert: string };

/** Records every animation frame from now on: the header node and its box, the veil's opacity, and which view is
 *  on screen with what it shows. */
async function recordFrames(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: unknown[]; __stopFrames?: boolean };
    const first = document.querySelector("header.aya-pane-header--unified");
    const t0 = performance.now();
    w.__frames = []; w.__stopFrames = false;
    const tick = () => {
      const header = document.querySelector("header.aya-pane-header--unified");
      const box = header?.getBoundingClientRect();
      const veil = document.querySelector<HTMLElement>('[data-testid="pane-mode-veil"]');
      const term = document.querySelector<HTMLElement>('[data-testid="terminal-pane"]');
      const termShown = !!term && getComputedStyle(term).display !== "none";
      const gui = document.querySelector<HTMLElement>(".aya-conversation");
      const guiShown = !!gui && getComputedStyle(gui).display !== "none";
      w.__frames.push({
        t: Math.round(performance.now() - t0), sameHeader: header === first, headerH: box?.height ?? 0, headerTop: box?.top ?? -1,
        veil: veil ? Number(getComputedStyle(veil).opacity) : 0, phase: veil?.closest(".aya-pane-mode-veil")?.getAttribute("data-phase") ?? null,
        term: termShown, rows: termShown ? (term!.querySelector(".xterm-rows")?.textContent ?? "").trim().length : 0,
        gui: guiShown, guiStatus: guiShown ? header?.querySelector('.aya-sr-only[role="status"]')?.textContent ?? "" : "",
        articles: guiShown ? gui!.querySelectorAll("article").length : 0,
        alert: header?.querySelector('[role="alert"]')?.textContent ?? "",
      });
      if (!w.__stopFrames) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return async () => page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __stopFrames?: boolean };
    w.__stopFrames = true;
    return w.__frames;
  });
}

/** Every frame where any of the pane's body shows through the veil shows one settled view: a terminal with
 *  output, or a connected conversation with its history. Never both, never neither, never "Connecting…". */
function assertNoFlash(frames: Frame[]) {
  expect(frames.length).toBeGreaterThan(10);
  expect(frames.every((f) => f.sameHeader), "the header is the same element throughout").toBe(true);
  expect(new Set(frames.map((f) => f.headerH)).size, `the header keeps its height: ${JSON.stringify([...new Set(frames.map((f) => f.headerH))])}`).toBe(1);
  expect(new Set(frames.map((f) => f.headerTop)).size, "the header keeps its place").toBe(1);
  expect(frames.some((f) => f.veil >= 0.999), "the veil covered the pane at some point").toBe(true);
  for (const f of frames) {
    if (f.veil >= 0.999) continue;
    const what = JSON.stringify(f);
    expect(Number(f.term) + Number(f.gui), `one view shows through: ${what}`).toBe(1);
    if (f.term) expect(f.rows, `a terminal shows output, not a blank screen: ${what}`).toBeGreaterThan(0);
    if (f.gui) {
      expect(f.guiStatus, `a conversation shows through only once connected: ${what}`).toBe("Ready");
      expect(f.articles, `a conversation shows its history: ${what}`).toBeGreaterThan(0);
    }
  }
}

test("switching never flashes an empty pane or a half-loaded view, and the header stays put", async () => {
  const { seed, transcript, terminalLaunches } = seedClaudePane();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow();
    await expect.poll(() => terminalLaunches().length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(1);
    const sessionId = terminalLaunches()[0].sessionId!;
    appendFileSync(transcript(sessionId), JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "Remember the word PELICAN." } }) + "\n");
    await expect(page.locator('[data-testid="terminal-pane"]:visible .xterm-rows')).toContainText("fake claude ready");

    // Terminal → Conversation.
    let stop = await recordFrames(page);
    await page.getByRole("button", { name: "Show as conversation" }).click();
    // Optimistic toggle, a spinner on it, and the loading veil, before anything is ready.
    await expect(page.getByRole("button", { name: "Show as conversation" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".aya-pane-mode-spinner")).toHaveCount(1);
    await expect(page.getByTestId("pane-mode-veil")).toContainText("Opening conversation…");
    await expect(page.getByTestId("pane-mode-veil")).toContainText("Resuming session");
    await expect(page.getByTestId("pane-mode-veil")).toHaveCount(0);
    await expect(page.locator(".aya-conversation header").getByRole("status")).toHaveText("Ready");
    let frames = await stop();
    assertNoFlash(frames);
    const toGui = frames.filter((f) => f.phase !== null);
    console.log(`terminal → conversation: ${frames.length} frames, veil up ${toGui.length} frames (${toGui.at(-1)!.t - toGui[0].t} ms), ` +
      `terminal shown through it ${frames.filter((f) => f.term && f.veil < 0.999).length}, conversation ${frames.filter((f) => f.gui && f.veil < 0.999).length}, ` +
      `frames with neither and veil < 1: ${frames.filter((f) => !f.term && !f.gui && f.veil < 0.999).length}`);

    // Conversation → terminal.
    stop = await recordFrames(page);
    await page.getByRole("button", { name: "Show as terminal" }).click();
    await expect(page.getByTestId("pane-mode-veil")).toContainText("Starting terminal…");
    await expect(page.getByTestId("pane-mode-veil")).toHaveCount(0);
    await expect(page.locator('[data-testid="terminal-pane"]:visible .xterm-rows')).toContainText("fake claude ready");
    frames = await stop();
    assertNoFlash(frames);
    const toTerm = frames.filter((f) => f.phase !== null);
    console.log(`conversation → terminal: ${frames.length} frames, veil up ${toTerm.length} frames (${toTerm.at(-1)!.t - toTerm[0].t} ms), ` +
      `conversation shown through it ${frames.filter((f) => f.gui && f.veil < 0.999).length}, terminal ${frames.filter((f) => f.term && f.veil < 0.999).length}, ` +
      `frames with neither and veil < 1: ${frames.filter((f) => !f.term && !f.gui && f.veil < 0.999).length}`);

    // A failure mid-switch: the conversation cannot start. The veil lifts on the pane as it is, the reason shows next
    // to the toggle, and Reconnect retries.
    const fail = join(seed.root, "claude-gui-fails");
    appendFileSync(fail, "");
    await page.getByRole("button", { name: "Show as conversation" }).click();
    const alert = page.locator('header.aya-pane-header--unified [role="alert"]');
    await expect(alert).toContainText("Could not open the conversation");
    await expect(page.getByTestId("pane-mode-veil")).toHaveCount(0);
    rmSync(fail);
    await page.locator(".aya-conversation").getByRole("button", { name: "Reconnect" }).click();
    await expect(page.locator(".aya-conversation header").getByRole("status")).toHaveText("Ready");

    // A refusal (a pending approval) keeps the view and says why next to the toggle; no veil, nothing moves.
    const prompt = page.locator(".aya-conversation").getByRole("textbox", { name: "Message Claude" });
    await prompt.fill("approval"); await prompt.press("Enter");
    await expect(page.locator(".aya-conversation").getByRole("group", { name: "Approval required" })).toBeVisible();
    stop = await recordFrames(page);
    await page.getByRole("button", { name: "Show as terminal" }).click();
    await expect(alert).toContainText("Answer the pending approval");
    frames = await stop();
    expect(frames.every((f) => f.sameHeader && f.gui && !f.term && f.phase === null)).toBe(true);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("a pane whose agent has no Conversation has no switch", async () => {
  const seed = seedEnv({ singleTab: { presetId: "shell", name: "Shell" } });
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow();
    const header = page.locator('[data-testid="terminal-pane"]:visible header.aya-pane-header');
    await expect(header).toBeVisible();
    await expect(header.getByRole("group", { name: "Pane mode" })).toHaveCount(0);
    await fireShortcut(app, "toggle-pane-mode");
    await expect(page.locator(".aya-conversation")).toHaveCount(0);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("Claude and Claude GUI twin presets merge into one, and the GUI pane keeps opening as a conversation", async () => {
  const seed = seedEnv({
    singleTab: { presetId: "claude-gui", name: "Claude GUI" },
    presetList: [
      { id: "claude", name: "Claude", icon: "✻", color: "", command: "claude" },
      { id: "claude-gui", name: "Claude GUI", icon: "✦", color: "", command: "claude", agent: "claude", interfaceMode: "gui" },
      { id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" },
    ],
  });
  const bin = join(seed.root, "gui-bin"); mkdirSync(bin);
  copyFileSync(resolve("tests/helpers/fake-claude-gui.cjs"), join(bin, "claude")); chmodSync(join(bin, "claude"), 0o755);
  seed.launchEnv = { ...seed.launchEnv, AYA_E2E_CLAUDE_BIN: join(bin, "claude") };
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".aya-conversation header").getByRole("status")).toHaveText("Ready");
    const presets = JSON.parse(readFileSync(join(seed.ayaHome, "presets.json"), "utf8")).presets as { id: string }[];
    expect(presets.map((p) => p.id)).toEqual(["claude", "shell"]);
    const tab = JSON.parse(readFileSync(join(seed.ayaHome, "projects", "e2e-proj.json"), "utf8")).tabs[0];
    expect(tab).toMatchObject({ presetId: "claude", interfaceMode: "gui", name: "Claude GUI" });
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
