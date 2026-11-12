import { copyFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, expect, launchApp, closeAndWait } from "./fixtures";
import { populatedBoard } from "./helpers/kanban";

test.use({ seedOptions: {
  rightTab: { presetId: "gui", name: "Codex GUI" },
  presetList: [{ id: "gui", name: "Codex GUI", icon: "◆", color: "", command: "codex", agent: "codex", interfaceMode: "gui" }],
  ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(populatedBoard()) },
} });

test("a full board keeps receiving live updates after cancelling Quit during a GUI turn", async ({ seeded }) => {
  const bin = join(seeded.root, "gui-bin");
  mkdirSync(bin);
  copyFileSync(resolve("tests/helpers/fake-codex-gui.cjs"), join(bin, "codex"));
  chmodSync(join(bin, "codex"), 0o755);
  seeded.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, "codex"), AYA_E2E_PTY_SHUTDOWN: "0" };
  const file = join(seeded.ayaHome, "projects/e2e-proj.json");
  const project = JSON.parse(readFileSync(file, "utf8"));
  project.tabs[0] = { id: project.tabs[0].id, presetId: "board", name: "Board" };
  writeFileSync(file, JSON.stringify(project));
  const app = await launchApp(seeded);
  const window = await app.firstWindow();
  const gui = window.locator(".aya-conversation");
  try {
    await expect(gui.locator("header").getByRole("status")).toHaveText("Ready");
    await expect(window.getByTestId("kanban-pane")).toBeVisible();
    await app.evaluate(({ dialog }) => {
      (globalThis as unknown as { cancelledQuit: boolean }).cancelledQuit = false;
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { buttons: string[] };
        if (!options.buttons.includes("Quit")) throw Error("Unexpected dialog");
        (globalThis as unknown as { cancelledQuit: boolean }).cancelledQuit = true;
        return { response: 1, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    await gui.getByRole("textbox", { name: "Message Codex" }).fill("wait");
    await gui.getByRole("textbox", { name: "Message Codex" }).press("Enter");
    await expect(gui.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await app.evaluate(({ app: electron }) => electron.quit());
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { cancelledQuit: boolean }).cancelledQuit)).toBe(true);
    await window.evaluate(() => window.aya.addBoardColumn({ projectSlug: "e2e-proj", title: "After cancelled Quit" }));
    await expect(window.getByTestId("kanban-column-after-cancelled-quit")).toBeVisible();
    await expect(gui.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  } finally {
    await gui.getByRole("button", { name: "Stop", exact: true }).click().catch(() => {});
    await closeAndWait(app);
  }
});
