import { spawn } from "node:child_process";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, expect } from "./fixtures";
import { envWithoutAya } from "./helpers/env";
import { AGENT_START_TIMEOUT_MS } from "./timeouts";
import { populatedBoard } from "./helpers/kanban";

const recorder = join(__dirname, "helpers", "pty-recorder.cjs");
const fullBoard = populatedBoard();
fullBoard.cards[0].title = "A task that can be withdrawn";
test.use({ seedOptions: {
  rightTab: { presetId: "board", name: "Board" },
  presetList: [{
    id: "shell", name: "Recorder", icon: "$", color: "",
    command: `'${process.execPath}' '${recorder}' "$AYA_PROJECT_DIR/rec-$AYA_TERMINAL_ID.jsonl"`,
  }],
  ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(fullBoard) },
} });

test("GUI and CLI withdrawals reach the real recipient PTY after the initial task", async ({ window, seeded }) => {
  const log = join(seeded.projectDir, `rec-${seeded.tabIds.left}.jsonl`);
  await expect.poll(() => existsSync(log), { timeout: AGENT_START_TIMEOUT_MS }).toBe(true);
  const received = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).b).join("");
  const card = window.getByTestId("kanban-card-t-1");
  const send = async () => {
    await card.getByRole("button", { name: /Terminal/ }).click();
    await window.getByRole("menuitem", { name: /↪.*shell 1/ }).click();
    await expect(window.getByTestId("kanban-column-in-progress").getByTestId("kanban-card-t-1")).toBeVisible();
  };
  await send();
  await expect.poll(received).toContain("Task t-1: A task that can be withdrawn");

  await card.hover();
  await card.getByRole("button", { name: "Move card t-1 to Todo", exact: true }).click();
  await expect.poll(received).toContain("was returned to Todo. Stop work on this task");
  await expect(window.getByTestId("kanban-column-todo").getByTestId("kanban-card-t-1")).toBeVisible();
  await expect(card.getByRole("button", { name: "Release card t-1", exact: true })).toHaveCount(0);

  await send();
  await window.getByRole("button", { name: "+ Column", exact: true }).click();
  await window.getByPlaceholder("Column name…").fill("Backlog");
  await window.getByPlaceholder("Column name…").press("Enter");
  await expect(window.getByTestId("kanban-column-backlog")).toHaveCount(1);
  await new Promise<void>((done, reject) => {
    const child = spawn(resolve("bin/aya"), ["board", "move", "t-1", "backlog", "--project", "e2e-proj"], {
      cwd: seeded.projectDir, detached: true,
      env: { ...envWithoutAya(), AYA_SOCKET: join(seeded.ayaHome, "aya.sock") },
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? done() : reject(new Error(`aya exited ${code}: ${stderr}`)));
  });
  await expect.poll(received).toContain("was returned to Backlog. Stop work on this task");
  await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-1")).toHaveCount(1);
  await send();
  await card.getByRole("button", { name: "Release card t-1", exact: true }).click();
  await expect.poll(received).toContain("was released from your pane. Stop work on this task");
  // Notification arrives before the mutation commits. Wait for the completed
  // release rather than reading the file while delivery is still finishing.
  await expect(card.getByRole("button", { name: "Release card t-1", exact: true })).toHaveCount(0);
  const stored = JSON.parse(readFileSync(join(seeded.ayaHome, "boards/e2e-proj.json"), "utf8"));
  expect(stored.cards.find((card: { id: string }) => card.id === "t-1").claim).toBeUndefined();
  expect(stored.cards.filter((card: { id: string }) => card.id !== "t-1")).toEqual(fullBoard.cards.filter(card => card.id !== "t-1"));
  expect((received().match(/Stop work on this task/g) ?? [])).toHaveLength(3);
  await expect(window.locator(".aya-kanban-error")).toHaveCount(0);
});

test("starting a card in a new pane tracks its recipient for withdrawal", async ({ window, seeded }) => {
  await window.evaluate(() => window.aya.updateBoardCard({ projectSlug: "e2e-proj", cardId: "t-1", title: "New pane task" }));
  await expect(window.getByTestId("kanban-card-t-1")).toContainText("New pane task");
  await window.getByTestId("kanban-card-t-1").getByRole("button", { name: /Terminal/ }).click();
  await window.getByRole("menuitem", { name: "$ Recorder", exact: true }).click();
  const current = () => window.evaluate(() => window.aya.getBoard("e2e-proj"));
  await expect.poll(async () => (await current()).cards.find(card => card.id === "t-1")?.claim?.paneId).toBeTruthy();
  const card = (await current()).cards.find(card => card.id === "t-1")!;
  expect(card.columnId).toBe("in-progress");
  const log = join(seeded.projectDir, `rec-${card.claim!.paneId}.jsonl`);
  await expect.poll(() => existsSync(log), { timeout: AGENT_START_TIMEOUT_MS }).toBe(true);
  const received = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).b).join("");
  await expect.poll(received).toContain("New pane task");
  await window.evaluate(() => window.aya.moveBoardCard({ projectSlug: "e2e-proj", cardId: "t-1", columnId: "todo" }));
  await expect.poll(received).toContain("was returned to Todo. Stop work on this task");
});

test("withdrawing during new-pane startup cancels the delayed initial prompt", async ({ window, seeded }) => {
  await window.evaluate(() => window.aya.updateBoardCard({ projectSlug: "e2e-proj", cardId: "t-1", title: "Cancelled startup task" }));
  await expect(window.getByTestId("kanban-card-t-1")).toContainText("Cancelled startup task");
  await window.getByTestId("kanban-card-t-1").getByRole("button", { name: /Terminal/ }).click();
  await window.getByRole("menuitem", { name: "$ Recorder", exact: true }).click();
  const current = () => window.evaluate(() => window.aya.getBoard("e2e-proj"));
  await expect.poll(async () => (await current()).cards.find(card => card.id === "t-1")?.claim?.paneId).toBeTruthy();
  const recipient = (await current()).cards.find(card => card.id === "t-1")!.claim!.paneId!;
  await window.evaluate(() => window.aya.moveBoardCard({ projectSlug: "e2e-proj", cardId: "t-1", columnId: "todo" }));
  const log = join(seeded.projectDir, `rec-${recipient}.jsonl`);
  await expect.poll(() => existsSync(log), { timeout: AGENT_START_TIMEOUT_MS }).toBe(true);
  // The startup prompt is scheduled 1200 ms after spawn. It must remain
  // cancelled after that boundary, even though the pane itself starts.
  await window.waitForTimeout(1800);
  const received = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).b).join("");
  expect(received).not.toContain("Task t-1: Cancelled startup task");
  expect(received).not.toContain("Stop work on this task");
  expect((await current()).cards.find(card => card.id === "t-1")!.claim).toBeUndefined();
});

test("a pending startup survives renderer reload and its task is submitted only once", async ({ window, seeded }) => {
  await window.evaluate(() => window.aya.updateBoardCard({ projectSlug: "e2e-proj", cardId: "t-1", title: "Restored startup task" }));
  await expect(window.getByTestId("kanban-card-t-1")).toContainText("Restored startup task");
  await window.getByTestId("kanban-card-t-1").getByRole("button", { name: /Terminal/ }).click();
  await window.getByRole("menuitem", { name: "$ Recorder", exact: true }).click();
  const saved = () => JSON.parse(readFileSync(join(seeded.ayaHome, "projects/e2e-proj.json"), "utf8"));
  await expect.poll(() => saved().tabs.some((tab: { initialBoardCard?: { cardId: string } }) => tab.initialBoardCard?.cardId === "t-1")).toBe(true);
  const recipient = saved().tabs.find((tab: { initialBoardCard?: { cardId: string } }) => tab.initialBoardCard?.cardId === "t-1").id;
  await window.reload();
  const log = join(seeded.projectDir, `rec-${recipient}.jsonl`);
  const received = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).b).join("") : "";
  await expect.poll(received, { timeout: AGENT_START_TIMEOUT_MS }).toContain("Task t-1: Restored startup task");
  appendFileSync(log, JSON.stringify({ t: Date.now(), b: "RECORDER_PERSISTED" }) + "\n");
  await window.reload();
  await window.waitForTimeout(1800);
  expect(received()).toContain("RECORDER_PERSISTED");
  expect((received().match(/Task t-1: Restored startup task/g) ?? [])).toHaveLength(1);
});
