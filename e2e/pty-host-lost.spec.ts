import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {appEnv} from "./helpers/seed";
import type { Page } from "@playwright/test";
import { expect, expectHeadlessUiEvents, hostPidsForHome, test as base, launchApp, launchE2eElectron, closeAndWait, ciElectronFlags } from "./fixtures";
import { waitForShellReady } from "./helpers/terminal";

// These are the unknown-key reuse cases. A main that created the host now
// recovers it automatically, including ordinary relaunch with valid continuity.
// This fixture explicitly models an older authenticated host without continuity.
const test=base.extend({app:async({seeded},use)=>{
  const env={...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:"0"}};
  const first=await launchApp(env);
  await waitForShellReady(await first.firstWindow());
  await expect.poll(()=>inventory(seeded.ayaHome).panes.length).toBe(2);
  await closeAndWait(first);
  const wrapper=join(seeded.root,'unsupported-continuity-main.js'),root=join(__dirname,'..');
  writeFileSync(wrapper,`const {PtyHostClient}=require(require('node:path').join(process.env.AYA_TEST_APP_ROOT,'dist-electron/pty-host-client.js'));const send=PtyHostClient.prototype.sendRequest;PtyHostClient.prototype.sendRequest=function(socket,req){if(req.type==='owner-continuity')return Promise.reject(Object.assign(Error('unsupported continuity'),{code:'PTY_HOST_REMOTE_ERROR'}));return send.call(this,socket,req);};require(require('node:path').join(process.env.AYA_TEST_APP_ROOT,'dist-electron/main.js'));`);
  const reused=await launchE2eElectron({cwd:root,args:[wrapper,`--user-data-dir=${seeded.userDataDir}`,...ciElectronFlags()],env:appEnv({...env,launchEnv:{...env.launchEnv,AYA_TEST_APP_ROOT:root}})});
  await use(reused);await closeAndWait(reused);
}});

type Inventory = { pid: number; panes: Array<{ id: string; pid: number; generation: number }> };
const inventory = (home: string): Inventory => JSON.parse(readFileSync(join(home, "pty-owner/record.json"), "utf8"));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const panes = (record: Inventory) => record.panes.map(({ id, pid, generation }) => ({ id, pid, generation })).sort((a, b) => a.id.localeCompare(b.id));

async function loseHost(window: Page, home: string) {
  await waitForShellReady(window);
  await expect.poll(() => inventory(home).panes.length).toBe(2);
  const before = inventory(home), hosts = hostPidsForHome(home);
  expect(hosts).toHaveLength(1);
  for (const pid of hosts) process.kill(pid, "SIGKILL");
  await expect.poll(() => hosts.some(alive)).toBe(false);
  const row = window.locator('.aya-sidebar-row[data-terminal-name="shell 1"]');
  const statusDot = row.locator(".aya-sidebar-statusdot");
  await expect(statusDot).toHaveClass(/--error/);
  await expect(statusDot).toHaveAttribute(
    "aria-label",
    "shell 1: Terminal is disconnected. Select it to view recovery options.",
  );
  await expect(statusDot).toHaveAttribute(
    "title",
    "Terminal is disconnected. Select it to view recovery options.",
  );
  await expect(window.getByTestId("xterm-host").first()).toContainText("terminal host disconnected");
  await expect(window.getByTestId("terminal-history-notice").first()).toContainText("could not verify recovery data");
  return { before, row };
}

test('unavailable continuity visibly disables automatic recovery while the authenticated pane still serves input',async({window,seeded})=>{
  await waitForShellReady(window);const before=inventory(seeded.ayaHome),hosts=hostPidsForHome(seeded.ayaHome);
  await expect(window.getByTestId('terminal-history-notice').first()).toContainText('Automatic terminal host recovery is off');
  await expect(window.getByTestId('terminal-history-notice').first()).toContainText('This host still serves the panes');
  await window.getByTestId('xterm-host').first().click();await window.keyboard.type("printf 'CONTINUITY_OFF_INPUT_WORKS\\n'");await window.keyboard.press('Enter');
  await expect.poll(()=>window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('CONTINUITY_OFF_INPUT_WORKS\r\n');
  expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);expect(panes(inventory(seeded.ayaHome))).toEqual(panes(before));
  expect(readFileSync(join(seeded.ayaHome,'pty-events.log'),'utf8').split('\n').filter(line=>{try{return JSON.parse(line).ev==='spawn';}catch{return false;}})).toHaveLength(2);
});

test("a killed JS host leaves its shells alive and disconnected; Shift+Enter never silently respawns them", async ({ app, window, seeded }) => {
  const { before, row } = await loseHost(window, seeded.ayaHome);
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { unexpectedSpawns: unknown[] }; g.unexpectedSpawns = [];
    ipcMain.removeHandler("pty:spawn");
    ipcMain.handle("pty:spawn", (_event, req) => { g.unexpectedSpawns.push(req); });
  });
  await window.getByTestId("xterm-host").first().click();
  await window.keyboard.press("Shift+Enter");
  await window.waitForTimeout(500);
  await expect(row.locator(".aya-sidebar-statusdot")).toHaveClass(/--error/);
  expect(await app.evaluate(() => (globalThis as unknown as { unexpectedSpawns: unknown[] }).unexpectedSpawns)).toEqual([]);
  expect(alive(before.pid)).toBe(true);
  for (const pane of before.panes) expect(alive(pane.pid)).toBe(true);
  const after = inventory(seeded.ayaHome);
  expect(after.pid).toBe(before.pid); expect(panes(after)).toEqual(panes(before));
});

test("a refused kill explains why restart stopped and keeps the disconnected pane without another spawn", async ({ app, window, seeded }) => {
  expectHeadlessUiEvents(seeded, ["renderer.alert"]);
  const { before, row } = await loseHost(window, seeded.ayaHome);
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { unexpectedSpawns: unknown[]; restartQuestions: number };
    g.unexpectedSpawns = []; g.restartQuestions = 0;
    ipcMain.removeHandler("pty:confirm-restart");
    ipcMain.handle("pty:confirm-restart", () => { g.restartQuestions++; return true; });
    ipcMain.removeHandler("pty:kill");
    ipcMain.handle("pty:kill", () => { throw new Error("The native owner cannot authenticate this Aya"); });
    ipcMain.removeHandler("pty:spawn");
    ipcMain.handle("pty:spawn", (_event, req) => { g.unexpectedSpawns.push(req); });
  });
  await window.evaluate(()=>{
    const w=window as any;w.headlessUiEvents=[];
    window.addEventListener("aya:e2e-headless-dialog",event=>w.headlessUiEvents.push((event as CustomEvent).detail));
  });
  await row.click({ button: "right" });
  await window.locator(".aya-context-menu-item", { hasText: "Restart terminal" }).click();
  await expect.poll(()=>window.evaluate(()=>(window as any).headlessUiEvents)).toContainEqual(expect.objectContaining({kind:"renderer.alert"}));
  const message = (await window.evaluate(()=>(window as any).headlessUiEvents.at(-1).message)) as string;
  expect(message).toContain("Aya did not restart shell 1: it could not confirm that the old terminal stopped");
  expect(message).toContain("The native owner cannot authenticate this Aya");
  await window.waitForTimeout(500);
  await expect(row).toBeVisible();
  await expect(row.locator(".aya-sidebar-statusdot")).toHaveClass(/--error/);
  await expect(window.getByTestId("xterm-host").first()).toContainText("terminal host disconnected");
  expect(await app.evaluate(() => {
    const g = globalThis as unknown as { unexpectedSpawns: unknown[]; restartQuestions: number };
    return { questions: g.restartQuestions, spawns: g.unexpectedSpawns };
  })).toEqual({ questions: 1, spawns: [] });
  expect(alive(before.pid)).toBe(true);
  for (const pane of before.panes) expect(alive(pane.pid)).toBe(true);
  const after = inventory(seeded.ayaHome);
  expect(after.pid).toBe(before.pid); expect(panes(after)).toEqual(panes(before));
});

test("typing and paste into a disconnected pane are disabled instead of silently sending input", async ({ app, window, seeded }) => {
  const { before } = await loseHost(window, seeded.ayaHome);
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { disconnectedWrites: unknown[] }; g.disconnectedWrites = [];
    ipcMain.removeHandler("pty:write");
    ipcMain.handle("pty:write", (_event, ...args) => { g.disconnectedWrites.push(args); return false; });
  });
  const terminal = window.getByTestId("xterm-host").first(); await terminal.click();
  await window.keyboard.type("must not be sent"); await window.keyboard.press("Enter"); await window.keyboard.press("Control+c");
  await terminal.locator(".xterm-helper-textarea").evaluate(textarea => {
    const transfer = new DataTransfer(); transfer.setData("text/plain", "pasted text\n");
    textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await terminal.click({ button: "right" });
  await expect(window.getByTestId("terminal-context-paste")).toBeDisabled();
  await window.keyboard.press("Escape");
  await expect(terminal).toContainText("Input is disabled while disconnected");
  expect(await app.evaluate(() => (globalThis as unknown as { disconnectedWrites: unknown[] }).disconnectedWrites)).toEqual([]);
  expect(alive(before.pid)).toBe(true); for (const pane of before.panes) expect(alive(pane.pid)).toBe(true);
});

test.describe("a pane mounted after its host disconnected", () => {
  test.use({ seedOptions: { split: false } });
  test("shows the disconnected explanation from stored state and keeps input disabled", async ({ app, window, seeded }) => {
    await waitForShellReady(window);
    const projectFile = join(seeded.ayaHome, "projects/e2e-proj.json");
    const project = JSON.parse(readFileSync(projectFile, "utf8"));
    project.tabs.push({ id: "deferred", presetId: "shell", name: "Deferred" });
    writeFileSync(projectFile, JSON.stringify(project));
    const row = window.locator('.aya-sidebar-row[data-terminal-name="Deferred"]');
    await expect(row).toBeVisible();
    await expect(window.locator('.aya-pane[data-terminal-id="deferred"]')).toHaveCount(0);
    await window.evaluate(cwd => window.aya.ptySpawn({ ptyId: "deferred", command: "/bin/sleep 60", cwd, cols: 80, rows: 24 }), seeded.projectDir);
    await expect.poll(() => inventory(seeded.ayaHome).panes.length).toBe(3);
    const before = inventory(seeded.ayaHome), hosts = hostPidsForHome(seeded.ayaHome);
    expect(hosts).toHaveLength(1); process.kill(hosts[0], "SIGKILL");
    await expect(row.locator(".aya-sidebar-statusdot")).toHaveClass(/--error/);
    await expect(window.locator('.aya-pane[data-terminal-id="deferred"]')).toHaveCount(0);
    // Suppress all attach/replay responses: the warning must come from stored
    // disconnected state on the first mount, rather than a new PTY event.
    await app.evaluate(({ ipcMain }) => {
      (globalThis as unknown as { deferredWrites: unknown[] }).deferredWrites = [];
      ipcMain.removeHandler("pty:spawn"); ipcMain.handle("pty:spawn", () => {});
      ipcMain.removeHandler("pty:write");
      ipcMain.handle("pty:write", (_event, ...args) => { (globalThis as unknown as { deferredWrites: unknown[] }).deferredWrites.push(args); return false; });
    });
    await row.click();
    const terminal = window.locator('.aya-pane[data-terminal-id="deferred"]').getByTestId("xterm-host");
    await expect(terminal).toContainText("terminal host disconnected");
    await expect(terminal).toContainText("Input is disabled while disconnected");
    await expect(row.locator(".aya-sidebar-statusdot")).toHaveClass(/--error/);
    await terminal.click(); await window.keyboard.type("not delivered"); await window.keyboard.press("Enter");
    await terminal.locator(".xterm-helper-textarea").evaluate(textarea => {
      const transfer = new DataTransfer(); transfer.setData("text/plain", "late pasted input\n");
      textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    expect(await app.evaluate(() => (globalThis as unknown as { deferredWrites: unknown[] }).deferredWrites)).toEqual([]);
    expect(alive(before.pid)).toBe(true); for (const pane of before.panes) expect(alive(pane.pid)).toBe(true);
  });
});

test('Diagnostics separately confirms stopping a retained owner after unavailable continuity and JS death',async({app,window,seeded})=>{
  const {before}=await loseHost(window,seeded.ayaHome);
  const pageErrors:string[]=[];window.on('pageerror',error=>pageErrors.push(String(error)));
  await window.evaluate(()=>{
    const w=window as any;w.headlessUiEvents=[];
    window.addEventListener('aya:e2e-headless-dialog',event=>w.headlessUiEvents.push((event as CustomEvent).detail));
    w.__ayaE2eHeadlessUi.setResponse('renderer.confirm',true);
  });
  await app.evaluate(({dialog})=>{
    const original=dialog.showMessageBox.bind(dialog),g=globalThis as any;g.ownerAnswer=1;g.ownerQuestions=[];
    dialog.showMessageBox=(async(...args:Parameters<typeof dialog.showMessageBox>)=>{
      const options=args.at(-1) as {message:string;detail?:string};
      if(options.message!=='Work in progress will stop')return original(...args);
      g.ownerQuestions.push(options.detail??'');return {response:g.ownerAnswer,checkboxChecked:false};
    }) as typeof dialog.showMessageBox;
  });
  const {fireShortcut}=await import('./helpers/shortcut');await fireShortcut(app,'open-settings');
  const settings=window.locator('.aya-modal--settings');await settings.getByTestId('settings-tab').filter({hasText:'Diagnostics'}).click();
  const restart=settings.locator('.aya-settings-general-row',{hasText:'PTY host'}).getByRole('button',{name:'Restart'});
  await restart.click();
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).ownerQuestions.length)).toBe(1);
  const question=await app.evaluate(()=>(globalThis as any).ownerQuestions[0]);expect(question).toContain('Stopping the terminal owner');expect(question).toContain(`PID ${before.pid}`);
  for(const pane of before.panes){expect(question).toContain(`PID ${pane.pid}`);expect(alive(pane.pid)).toBe(true);}
  expect(alive(before.pid)).toBe(true);expect(hostPidsForHome(seeded.ayaHome)).toEqual([]);
  await expect.poll(()=>window.evaluate(()=>(window as any).headlessUiEvents.filter((event:any)=>event.kind==='renderer.confirm').length)).toBe(1);
  await app.evaluate(()=>{(globalThis as any).ownerAnswer=0;});await restart.click();
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).ownerQuestions.length)).toBe(2);
  await expect.poll(()=>alive(before.pid)).toBe(false);
  await expect.poll(()=>window.evaluate(()=>(window as any).headlessUiEvents.filter((event:any)=>event.kind==='renderer.confirm').length)).toBe(2);
  expect(await window.evaluate(()=>(window as any).headlessUiEvents.filter((event:any)=>event.kind==='renderer.confirm').map((event:any)=>event.message))).toEqual([
    'Restart the PTY host? This stops all running terminals; restart each with Shift+Enter.',
    'Restart the PTY host? This stops all running terminals; restart each with Shift+Enter.',
  ]);
  await expect.poll(()=>alive(before.pid)).toBe(false);for(const pane of before.panes)await expect.poll(()=>alive(pane.pid)).toBe(false);
  await expect.poll(()=>{try{const pid=inventory(seeded.ayaHome).pid;return pid>1&&pid!==before.pid;}catch{return false;}}).toBe(true);
  expect(inventory(seeded.ayaHome).pid).not.toBe(before.pid);
  expect(inventory(seeded.ayaHome).panes).toEqual([]);expect(await app.evaluate(()=>(globalThis as any).ownerQuestions.length)).toBe(2);
  expect(pageErrors).toEqual([]);
});
