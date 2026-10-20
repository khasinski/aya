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
  host: import("@playwright/test").Locator,
  files: Array<{ name: string; type: string; body: string }>,
) {
  await host.evaluate((node, entries) => {
    const transfer = new DataTransfer();
    for (const entry of entries) transfer.items.add(new File([entry.body], entry.name, { type: entry.type }));
    node.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, files);
}

async function putClipboardImage(app: import("@playwright/test").ElectronApplication, window: import("@playwright/test").Page) {
  const png = await window.screenshot();
  const state = await app.evaluate(({ clipboard, nativeImage }, base64: string) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
    clipboard.writeImage(image);
    return { imageEmpty: image.isEmpty(), clipboardEmpty: clipboard.readImage().isEmpty() };
  }, png.toString("base64"));
  expect(state).toEqual({ imageEmpty: false, clipboardEmpty: false });
}

async function pasteImage(textarea: import("@playwright/test").Locator) {
  await textarea.evaluate((node) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["clipboard image"], "clipboard.png", { type: "image/png" }));
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
}

const presetList = [
  { id: "shell", name: "Attachment reader", icon: "$", color: "", agent: "claude", command: command() },
  { id: "held", name: "Waiting reader", icon: "$", color: "", agent: "claude", command: command("hold") },
];

test.describe("local prompt attachments", () => {
  test.use({ seedOptions: { presetList, rightTab: { presetId: "held", name: "waiting reader" } } });

  test("dropped files and a clipboard image are typed, not submitted, and held panes receive nothing", async ({ window, app, seeded }, testInfo) => {
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

    await dropFiles(leftHost, [
      { name: "quarterly report.txt", type: "text/plain", body: "report" },
      { name: "photo.png", type: "image/png", body: "png bytes" },
    ]);
    const localDirectory = join(seeded.ayaHome, "prompt-attachments", "e2e-proj");
    await expect(window.getByTestId("prompt-attachment-notice")).toContainText("Nothing was submitted");
    await expect.poll(() => readdirSync(localDirectory).length).toBe(2);
    const droppedPaths = readdirSync(localDirectory).map((name) => join(localDirectory, name));
    expect(droppedPaths.some((path) => path.endsWith(".txt"))).toBe(true);
    expect(droppedPaths.some((path) => path.endsWith(".png"))).toBe(true);
    expect(droppedPaths.every((path) => (statSync(path).mode & 0o777) === 0o600)).toBe(true);
    await expect.poll(() => paneBuffer(window, left)).toContain(droppedPaths[0].slice(0, 25));
    expect(existsSync(paneLog(seeded.projectDir, left))).toBe(false);
    await window.locator(`[data-testid="terminal-pane"][data-terminal-id="${left}"] .xterm-helper-textarea`).press("Enter");
    await expect.poll(() => existsSync(paneLog(seeded.projectDir, left))).toBe(true);
    const typedDrop = readFileSync(paneLog(seeded.projectDir, left), "utf8").trim();
    for (const path of droppedPaths) expect(typedDrop).toContain(`'${path}'`);

    await putClipboardImage(app, window);
    const leftTextarea = window.locator(`[data-testid="terminal-pane"][data-terminal-id="${left}"] .xterm-helper-textarea`);
    await pasteImage(leftTextarea);
    await expect(window.getByTestId("prompt-attachment-notice")).toContainText("Image path added");
    await expect.poll(() => readdirSync(localDirectory).length).toBe(3);
    const imagePath = readdirSync(localDirectory).map((name) => join(localDirectory, name)).find((path) => path.endsWith(".png") && !droppedPaths.includes(path));
    expect(imagePath).toBeTruthy();
    expect(existsSync(paneLog(seeded.projectDir, left))).toBe(true);
    await leftTextarea.press("Enter");
    await expect.poll(() => readFileSync(paneLog(seeded.projectDir, left), "utf8")).toContain(`'${imagePath}'`);

    await dropFiles(rightHost, [{ name: "do-not-type.txt", type: "text/plain", body: "secret" }]);
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
    await dropFiles(host, [{ name: "remote file.txt", type: "text/plain", body: "remote bytes" }]);
    await expect(window.getByTestId("prompt-attachment-notice")).toContainText("Nothing was submitted");
    await expect.poll(() => existsSync(directory) ? readdirSync(directory).length : 0).toBe(1);
    const remotePath = join(directory, readdirSync(directory)[0]);
    expect(existsSync(stale)).toBe(false);
    expect(statSync(join(seeded.root, "remote-runtime", "aya")).mode & 0o777).toBe(0o700);
    expect(statSync(join(seeded.root, "remote-runtime", "aya", "attachments")).mode & 0o777).toBe(0o700);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(remotePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(remotePath, "utf8")).toBe("remote bytes");
    await expect(window.getByTestId("prompt-attachment-notice")).toContainText("Nothing was submitted");
    expect(existsSync(paneLog(seeded.projectDir, terminalId))).toBe(false);
    await window.locator(`[data-testid="terminal-pane"][data-terminal-id="${terminalId}"] .xterm-helper-textarea`).press("Enter");
    await expect.poll(() => readFileSync(paneLog(seeded.projectDir, terminalId), "utf8")).toContain(`'${remotePath}'`);
  });
});
