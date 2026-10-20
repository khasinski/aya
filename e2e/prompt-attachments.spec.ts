import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

const HELPER = join(__dirname, "helpers", "prompt-attachment-pane.cjs");
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const command = (mode = "") =>
  `${quote(process.execPath)} ${quote(HELPER)} "$AYA_PROJECT_DIR/attachment-$AYA_TERMINAL_ID.log" ${mode}`.trim();
const paneLog = (projectDir: string, terminalId: string) => join(projectDir, `attachment-${terminalId}.log`);
const paneBuffer = (window: import("@playwright/test").Page, terminalId: string) =>
  window.evaluate((id) => window.aya.ptyBuffer(id), terminalId);

async function waitForReady(window: import("@playwright/test").Page, terminalId: string) {
  await expect.poll(() => paneBuffer(window, terminalId), { timeout: 30_000 }).toContain("ATTACHMENT_PANE_READY");
}

async function dropFiles(
  window: import("@playwright/test").Page,
  host: import("@playwright/test").Locator,
  paths: string[],
): Promise<boolean> {
  const box = await host.boundingBox();
  if (!box) throw new Error("The terminal is not visible for a file drop.");
  const cdp = await window.context().newCDPSession(window);
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  const x = box.x + Math.min(80, box.width / 2);
  const y = box.y + Math.min(80, box.height / 2);
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x, y, data });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x, y, data });
  await cdp.send("Input.dispatchDragEvent", { type: "drop", x, y, data });
  await cdp.detach();
  return true;
}

async function putClipboardImage(app: import("@playwright/test").ElectronApplication, window: import("@playwright/test").Page): Promise<Buffer> {
  const png = await window.screenshot();
  const state = await app.evaluate(({ clipboard, nativeImage }, base64: string) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
    clipboard.writeImage(image);
    const copied = clipboard.readImage();
    return { imageEmpty: image.isEmpty(), clipboardEmpty: copied.isEmpty(), clipboardPng: copied.toPNG().toString("base64") };
  }, png.toString("base64"));
  expect(state.imageEmpty).toBe(false);
  expect(state.clipboardEmpty).toBe(false);
  return Buffer.from(state.clipboardPng, "base64");
}

async function pasteImage(textarea: import("@playwright/test").Locator) {
  await textarea.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
}

const presetList = [
  { id: "shell", name: "Attachment reader", icon: "$", color: "", agent: "claude", command: command() },
  { id: "held", name: "Waiting reader", icon: "$", color: "", agent: "claude", command: command("hold") },
];

test.describe("local prompt attachments", () => {
  test.use({ seedOptions: { presetList, rightTab: { presetId: "held", name: "waiting reader" } } });

  test("dropped files and a clipboard image are typed, not submitted, and held panes receive nothing", async ({ window, app, seeded }, testInfo) => {
    expect(await window.evaluate(() => {
      const exposed = window.aya as unknown as Record<string, unknown>;
      return ["getDroppedFilePath", "addPromptAttachments", "addClipboardImageToPrompt"].filter((key) => key in exposed);
    })).toEqual([]);
    const left = seeded.tabIds.left;
    const right = seeded.tabIds.right;
    await waitForReady(window, left);
    await waitForReady(window, right);
    await expect.poll(() => paneBuffer(window, left), { timeout: 5_000 }).toContain("? for shortcuts");
    await expect.poll(() => paneBuffer(window, right), { timeout: 5_000 }).toContain("Do you want to proceed?");
    const leftHost = window.locator(`[data-testid="terminal-pane"][data-terminal-id="${left}"] [data-testid="xterm-host"]`);
    const rightHost = window.locator(`[data-testid="terminal-pane"][data-terminal-id="${right}"] [data-testid="xterm-host"]`);
    const before = testInfo.outputPath("prompt-attachments-before.png");
    await window.screenshot({ path: before });
    await testInfo.attach("before - empty prompt", { path: before, contentType: "image/png" });

    const droppedPaths = [join(seeded.root, "quarterly report.txt"), join(seeded.root, "photo.png")];
    writeFileSync(droppedPaths[0], "report");
    writeFileSync(droppedPaths[1], "png bytes");
    expect(await dropFiles(window, leftHost, droppedPaths)).toBe(true);
    const localDirectory = join(seeded.ayaHome, "prompt-attachments", "e2e-proj");
    await expect(window.getByTestId("prompt-attachment-notice")).toContainText("Nothing was submitted");
    await expect(window.getByTestId("prompt-attachment-notice")).toContainText("2 file paths added");
    expect(existsSync(localDirectory)).toBe(false);
    expect(readFileSync(droppedPaths[1]).equals(Buffer.from("png bytes"))).toBe(true);
    await expect.poll(() => paneBuffer(window, left)).toContain(droppedPaths[0].slice(0, 25));
    expect(existsSync(paneLog(seeded.projectDir, left))).toBe(false);
    await window.locator(`[data-testid="terminal-pane"][data-terminal-id="${left}"] .xterm-helper-textarea`).press("Enter");
    await expect.poll(() => existsSync(paneLog(seeded.projectDir, left))).toBe(true);
    const typedDrop = readFileSync(paneLog(seeded.projectDir, left), "utf8").trim();
    for (const path of droppedPaths) expect(typedDrop).toContain(`'${path}'`);

    const clipboardPng = await putClipboardImage(app, window);
    const leftTextarea = window.locator(`[data-testid="terminal-pane"][data-terminal-id="${left}"] .xterm-helper-textarea`);
    await pasteImage(leftTextarea);
    await expect(window.getByTestId("prompt-attachment-notice")).toContainText("Image saved and its path added");
    await expect.poll(() => readdirSync(localDirectory).length).toBe(1);
    const imagePath = readdirSync(localDirectory).map((name) => join(localDirectory, name)).find((path) => path.endsWith(".png") && !droppedPaths.includes(path));
    expect(imagePath).toBeTruthy();
    expect(readFileSync(imagePath!).equals(clipboardPng)).toBe(true);
    await expect.poll(() => paneBuffer(window, left)).toContain(imagePath!);
    expect(existsSync(paneLog(seeded.projectDir, left))).toBe(true);
    await leftTextarea.press("Enter");
    await expect.poll(() => readFileSync(paneLog(seeded.projectDir, left), "utf8")).toContain(`'${imagePath}'`);

    const heldFile = join(seeded.root, "do-not-type.txt");
    writeFileSync(heldFile, "secret");
    expect(await dropFiles(window, rightHost, [heldFile])).toBe(true);
    await expect(window.getByRole("alert")).toContainText("Not sent:");
    await expect(window.getByRole("alert")).toContainText("Nothing was typed");
    expect(existsSync(paneLog(seeded.projectDir, right))).toBe(false);
    await putClipboardImage(app, window);
    await pasteImage(window.locator(`[data-testid="terminal-pane"][data-terminal-id="${right}"] .xterm-helper-textarea`));
    await expect(window.getByRole("alert")).toContainText("Not sent:");
    expect(existsSync(paneLog(seeded.projectDir, right))).toBe(false);
    expect(await paneBuffer(window, right)).not.toContain("do-not-type.txt");

    const after = testInfo.outputPath("prompt-attachments-after.png");
    await window.screenshot({ path: after });
    await testInfo.attach("after - paths typed and held-pane refusal", { path: after, contentType: "image/png" });
  });
});

test.describe("remote prompt attachments", () => {
  test.use({ seedOptions: { presetList: [presetList[0]], singleTab: { presetId: "shell", name: "remote reader" }, remoteProject: true } });

  test("copies to a private remote folder and types the remote path", async ({ window, seeded }) => {
    const terminalId = seeded.tabIds.left;
    const host = window.locator(`[data-testid="terminal-pane"][data-terminal-id="${terminalId}"] [data-testid="xterm-host"]`);
    const textarea = window.locator(`[data-testid="terminal-pane"][data-terminal-id="${terminalId}"] .xterm-helper-textarea`);
    await textarea.pressSequentially(`${quote(process.execPath)} ${quote(HELPER)} ${quote(paneLog(seeded.projectDir, terminalId))}`);
    await textarea.press("Enter");
    await waitForReady(window, terminalId);
    await window.waitForTimeout(1200);
    const directory = join(seeded.root, "remote-runtime", "aya", "attachments", "e2e-proj");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const stale = join(directory, "stale.txt");
    writeFileSync(stale, "old attachment", { mode: 0o600 });
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(stale, oldTime, oldTime);
    const sourceFile = join(seeded.root, "remote file.txt");
    writeFileSync(sourceFile, "remote bytes");
    expect(await dropFiles(window, host, [sourceFile])).toBe(true);
    await expect(window.getByTestId("prompt-attachment-notice")).toContainText("Nothing was submitted");
    await expect.poll(() => existsSync(directory) ? readdirSync(directory).length : 0).toBe(1);
    const remotePath = join(directory, readdirSync(directory)[0]);
    expect(existsSync(stale)).toBe(false);
    expect(statSync(join(seeded.root, "remote-runtime", "aya")).mode & 0o777).toBe(0o700);
    expect(statSync(join(seeded.root, "remote-runtime", "aya", "attachments")).mode & 0o777).toBe(0o700);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(remotePath).mode & 0o777).toBe(0o600);
    expect(remotePath).toMatch(/[a-f0-9]{32}-remote-file\.txt$/);
    expect(readFileSync(remotePath, "utf8")).toBe("remote bytes");
    await expect(window.getByTestId("prompt-attachment-notice")).toContainText("Nothing was submitted");
    expect(existsSync(paneLog(seeded.projectDir, terminalId))).toBe(false);
    await window.locator(`[data-testid="terminal-pane"][data-terminal-id="${terminalId}"] .xterm-helper-textarea`).press("Enter");
    await expect.poll(() => readFileSync(paneLog(seeded.projectDir, terminalId), "utf8")).toContain(`'${remotePath}'`);
  });
});
