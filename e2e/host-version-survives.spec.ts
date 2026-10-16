// #217: a version-only update reuses the same PTY host and the same shell processes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {ElectronApplication} from "@playwright/test";
import { test, expect, hostPidsForHome } from "./fixtures";
import { trackLaunches } from "./helpers/relaunch";
import { waitForShellReady, visiblePane } from "./helpers/terminal";

const packageFile = join(__dirname, "..", "package.json");
const original = readFileSync(packageFile);
const { launch, quit } = trackLaunches();
test.afterEach(() => writeFileSync(packageFile, original));
test("changing only package.json version keeps the host and every pane alive", async ({ seeded }) => {
  const env = { ...seeded, launchEnv: { ...seeded.launchEnv, AYA_E2E_PTY_SHUTDOWN: "0" } };
  const first = await launch(env);
  await waitForShellReady(first.window);
  // A completed command leaves a live shell at its prompt: a version-only update must keep that process.
  await visiblePane(first.window, "shell 1").getByTestId("xterm-host").click();
  await first.window.keyboard.insertText("printf 'BEFORE_VERSION_UPDATE\\n'");
  await first.window.keyboard.press("Enter");
  await expect.poll(() => first.window.evaluate(() => window.aya.ptyBuffer("tab-left"))).toContain("BEFORE_VERSION_UPDATE");
  const panePids = await pids(first.app);
  const hosts = hostPidsForHome(seeded.ayaHome);
  expect(hosts).toHaveLength(1);
  expect(panePids.every((pid) => typeof pid === "number")).toBe(true);
  await quit(first.app);
  const pkg = JSON.parse(original.toString());
  pkg.version = "99.0.0";
  writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + "\n");
  const second = await launch(env);
  await expect(second.window.getByTestId("xterm-host").first()).toBeVisible();
  // Boot's stale check runs before the window: by here a version-based restart already killed the old host.
  expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);
  expect(await pids(second.app)).toEqual(panePids);
  const log = readFileSync(join(seeded.ayaHome, "pty-events.log"), "utf8");
  expect(log).not.toContain('"reason":"client-request"');
});

async function pids(app:ElectronApplication):Promise<Array<number|null|undefined>>{
 return app.evaluate(async(_api,root)=>{
  // Use the actual main principal. A foreign test process may not borrow the
  // capability to displace the live main merely to query its pane PIDs.
  const require=process.getBuiltinModule('module').createRequire(root+'/package.json');
  const {PtyHostClient}=require(root+'/dist-electron/pty-host-client.js');
  const client=new PtyHostClient(root+'/dist-electron/pty-host.js');
  try{return await Promise.all(['tab-left','tab-right'].map(id=>client.getPid(id)));}
  finally{client.dispose();client.dropSocket();}
 },join(__dirname,'..'));
}
