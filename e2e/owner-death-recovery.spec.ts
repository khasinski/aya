import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, hostPidsForHome, handleRendererDialogs } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const command = `exec ${quote(process.execPath)} ${quote(join(__dirname, "helpers/pty-owner-survivor.cjs"))} --aya-e2e-survivor=\"$AYA_HOME/owner-death-recovery\"`;
test.use({ seedOptions: { singleTab: { presetId: "survivor", name: "Survivor" }, split: false,
  presetList: [{ id: "survivor", name: "Survivor", icon: "$", color: "", command }] } });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a dead owner's survivor stays blocked on Cancel and explicit confirmed recovery stops it before a new spawn", async ({ app, window, seeded }) => {
  const rendererDialogs = await handleRendererDialogs(window, seeded, { "renderer.confirm": { message: "Restart the PTY host? This stops all running terminals; restart each with Shift+Enter.", response: true } });
  const file = join(seeded.ayaHome, "pty-owner/record.json");
  let original: { pid: number; panes: Array<{ id: string; pid: number; startIdentity: string }> } | undefined;
  try {
    const terminal = window.getByTestId("xterm-host").first();
    await expect(terminal).toContainText("SURVIVOR_READY");
    original = JSON.parse(readFileSync(file, "utf8")); const pane = original!.panes[0];
    await expect(terminal).toContainText(`SURVIVOR_READY:${pane.pid}`);
    const hosts = hostPidsForHome(seeded.ayaHome); expect(hosts).toHaveLength(1);
    process.kill(original!.pid, "SIGKILL"); await expect.poll(() => alive(original!.pid)).toBe(false);
    process.kill(hosts[0], "SIGKILL"); await expect.poll(() => alive(hosts[0])).toBe(false);
    await expect(terminal).toContainText("terminal host disconnected"); expect(alive(pane.pid)).toBe(true);
    await app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { recoveryAnswer: number; recoveryQuestions: string[] };
      g.recoveryAnswer = 1; g.recoveryQuestions = [];
      const original = dialog.showMessageBox.bind(dialog);
      dialog.showMessageBox = (async (...args: Parameters<typeof dialog.showMessageBox>) => {
        const options = args.at(-1) as { message: string; detail?: string };
        if (options.message !== "Work in progress will stop") return original(...args);
        g.recoveryQuestions.push(options.detail ?? ""); return { response: g.recoveryAnswer, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    await fireShortcut(app, "open-settings"); const settings = window.locator(".aya-modal--settings");
    await settings.getByTestId("settings-tab").filter({ hasText: "Diagnostics" }).click();
    const restart = settings.locator(".aya-settings-general-row", { hasText: "PTY host" }).getByRole("button", { name: "Restart" });
    await restart.click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { recoveryQuestions: string[] }).recoveryQuestions.length)).toBe(1);
    expect(await app.evaluate(() => (globalThis as unknown as { recoveryQuestions: string[] }).recoveryQuestions[0])).toContain(`Survivor (PID ${pane.pid})`);
    expect(alive(pane.pid)).toBe(true);
    const refused = await window.evaluate(async ({ id, cwd, command }) => {
      try { await window.aya.ptySpawn({ ptyId: id, cwd, command, cols: 80, rows: 24 }); return null; }
      catch (error) { return String(error); }
    }, { id: pane.id, cwd: seeded.projectDir, command });
    expect(refused).toContain("The terminal host is disconnected or recovering");
    expect(JSON.parse(readFileSync(file, "utf8")).panes[0].pid).toBe(pane.pid);
    expect(alive(pane.pid)).toBe(true);
    // Exercise the actual TerminalView continuation after Cancel, not just
    // a direct API refusal. One remount attempts one attach and stays friendly.
    await window.keyboard.press("Escape"); await expect(settings).not.toBeVisible();
    const pageErrors: string[] = [];window.on("pageerror",error=>pageErrors.push(String(error)));
    await app.evaluate((_api,root)=>{
      const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js');
      const spawn=PtyHostClient.prototype.spawn,g=globalThis as unknown as {blockedAttachCalls:number};g.blockedAttachCalls=0;
      PtyHostClient.prototype.spawn=async function(...args:Parameters<typeof spawn>){g.blockedAttachCalls++;return spawn.apply(this,args);};
    },join(__dirname,'..'));
    await window.addInitScript(()=>{const w=window as unknown as {attachRejections:string[]};w.attachRejections=[];window.addEventListener("unhandledrejection",e=>w.attachRejections.push(String(e.reason)));});
    await window.reload();
    await expect(terminal).toContainText("terminal host disconnected");
    await expect(window.getByTestId("terminal-history-notice")).toContainText("processes may still be running");
    await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {blockedAttachCalls:number}).blockedAttachCalls)).toBe(1);
    await expect(terminal).not.toContainText("Terminal attachment failed");
    await expect(terminal).not.toContainText("Error invoking remote method");
    await expect(terminal).not.toContainText("pty:spawn");
    // Give an accidental render-triggered retry time to occur after settlement.
    await window.waitForTimeout(500);
    expect(await app.evaluate(()=>(globalThis as unknown as {blockedAttachCalls:number}).blockedAttachCalls)).toBe(1);
    expect(pageErrors).toEqual([]);expect(await window.evaluate(()=>(window as unknown as {attachRejections:string[]}).attachRejections)).toEqual([]);expect(alive(pane.pid)).toBe(true);
    expect(JSON.parse(readFileSync(file,"utf8")).panes[0].pid).toBe(pane.pid);
    await fireShortcut(app,"open-settings");await settings.getByTestId("settings-tab").filter({hasText:"Diagnostics"}).click();
    await app.evaluate(() => { (globalThis as unknown as { recoveryAnswer: number }).recoveryAnswer = 0; });
    await rendererDialogs.respond("renderer.confirm", { message: "Restart the PTY host? This stops all running terminals; restart each with Shift+Enter.", response: true });
    await restart.click();
    await expect.poll(() => alive(pane.pid), { timeout: 15000 }).toBe(false);
    await expect.poll(() => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).panes.some((p: { pid: number }) => p.pid === pane.pid) : false).toBe(false);
    await window.keyboard.press("Escape"); await expect(settings).not.toBeVisible();
    await terminal.click(); await window.keyboard.press("Shift+Enter");
    await expect.poll(() => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).panes[0]?.pid : undefined).not.toBe(pane.pid);
    await expect.poll(() => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).panes[0]?.pid : undefined).toBeGreaterThan(1);
    expect(JSON.parse(readFileSync(file, "utf8")).pid).not.toBe(original!.pid);
  } finally {
    const pane = original?.panes[0];
    if (pane?.startIdentity) require("../dist-electron/pty-owner-client.js").recoverOwnerProcessGroup(pane.pid, pane.startIdentity);
  }
});
