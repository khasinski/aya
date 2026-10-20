import {captureMainPtyClient} from "./helpers/main-pty-client";
import {execFileSync} from "node:child_process";
import {join} from "node:path";
import {test,expect} from "./fixtures";
import {envWithoutAya} from "./helpers/env";
import {waitForShellReady} from "./helpers/terminal";
const ROOT=join(__dirname,".."),CLI=join(ROOT,"bin","aya"),AGENT=join(__dirname,"helpers","rule-screen-agent.cjs");
const quote=(s:string)=>`'${s.replace(/'/g,"'\\''")}'`;
const preset=(mode:string,agent="claude")=>({id:"screen-agent",name:"Screen agent",icon:"a",color:"",agent,command:`env AYA_SCREEN_CASE=${mode} ${quote(process.execPath)} ${quote(AGENT)} ${mode}`});
function state(home:string,target="agent"){return execFileSync(CLI,["pane","state",target,"--explain"],{env:{...envWithoutAya(),AYA_HOME:home},encoding:"utf8",timeout:10000});}
for(const [mode,want,rule,agent="claude"] of [["idle","idle","composer-hint"],["busy","busy","claude-busy"],["approval","waiting","do-you-want"],["account","waiting","claude-account-setting"],["codexBusy","busy","codex-busy","codex"]]){
 test.describe(`pane state ${mode}`,()=>{
  test.use({seedOptions:{rightTab:{presetId:"screen-agent",name:"agent"},presetList:[{id:"shell",name:"Shell",icon:"$",color:"",command:"$SHELL"},preset(mode,agent)]}});
  test("real CLI explains the applied PTY screen selected by preset, with no input",async({window,seeded})=>{
   const errors:string[]=[];window.on("pageerror",e=>errors.push(e.message));
   await expect.poll(()=>state(seeded.ayaHome),{timeout:15000}).toContain(`"agent": ${want}`);
   const output=state(seeded.ayaHome);expect(output).toContain(rule);expect(output).toMatch(/source: builtin\/(?:generic|claude|codex)/);expect(output).toMatch(/rules: 1 \([a-f0-9]{64}\)/);expect(output).toContain("region:");expect(output).toContain("excerpt:");expect(output).not.toMatch(/[\x1b\x00-\x08\x0b-\x1f\x7f-\x9f\u202e\u202d]/);expect(errors).toEqual([]);
  });
 });
}
test.describe("pane state with a local user rule",()=>{
 const localRules=JSON.stringify({schemaVersion:1,ruleSetVersion:"e2e-local-1",agent:"claude",rules:[{id:"local-composer-hold",kind:"prompt",region:"screen",pattern:"❯",flags:""}]});
 test.use({seedOptions:{rightTab:{presetId:"screen-agent",name:"agent"},presetList:[{id:"shell",name:"Shell",icon:"$",color:"",command:"$SHELL"},preset("idle")],ayaHomeFiles:{"screen-rules/claude.json":localRules}}});
 test("the real CLI explains a user rule and its source",async({seeded,window})=>{
  await expect.poll(()=>state(seeded.ayaHome),{timeout:20000}).toContain("local-composer-hold");
  const output=state(seeded.ayaHome);
  expect(output).toContain('"agent": waiting');
  expect(output).toContain("waiting rule: local-composer-hold");
  expect(output).toContain("source: user/claude.json");
  expect(output).toContain("rules: e2e-local-1");
  expect(output).not.toMatch(/[\x1b\x00-\x08\x0b-\x1f\x7f-\x9f\u202e\u202d]/);
  await expect(window.getByTestId("xterm-host").last()).toBeVisible();
 });
});
test.describe("state after a real JS-host crash",()=>{
 test.use({seedOptions:{rightTab:{presetId:"screen-agent",name:"agent"},presetList:[{id:"shell",name:"Shell",icon:"$",color:"",command:"$SHELL"},preset("idle")]}});
 test("a screen not redrawn after recovery is unknown, never idle",async({app,seeded,window})=>{
  await expect.poll(()=>state(seeded.ayaHome)).toContain('"agent": idle');
  await captureMainPtyClient(app);
  const hostPid=await app.evaluate(async()=>((globalThis as any).e2eMainPtyClient.hostStatus()).then((s:{pid:number})=>s.pid));
  process.kill(hostPid,"SIGKILL");
  await expect.poll(()=>state(seeded.ayaHome),{timeout:15000}).toContain("screen unknown after the terminal host restarted");
  const output=state(seeded.ayaHome);expect(output).toContain('"agent": unknown');expect(output).toContain("policy:recovery-screen-unknown");expect(output).not.toContain("excerpt:");
  await expect(window.getByTestId("xterm-host").last()).toBeVisible();
 });
});


test.describe("saved unmounted pane",()=>{
 test.use({seedOptions:{split:false,rightTab:{presetId:"screen-agent",name:"agent"},presetList:[{id:"shell",name:"Shell",icon:"$",color:"",command:"$SHELL"},preset("idle")]}});
 test("state of an unopened pane is stopped and never spawns it",async({window,seeded})=>{
   await waitForShellReady(window);
   const {readFileSync,writeFileSync}=await import("node:fs");
   const file=join(seeded.ayaHome,"projects/e2e-proj.json"),project=JSON.parse(readFileSync(file,"utf8"));
   project.tabs.push({id:"unopened-state",name:"Never mounted",presetId:"shell"});writeFileSync(file,JSON.stringify(project));
   await expect(window.locator('.aya-sidebar-row[data-terminal-name="Never mounted"]')).toBeVisible();
   expect(state(seeded.ayaHome,"Never mounted")).toContain('"Never mounted": stopped');
   const record=JSON.parse(readFileSync(join(seeded.ayaHome,"pty-owner","record.json"),"utf8"));
   expect(record.panes.some((p:{id:string})=>p.id==="unopened-state")).toBe(false);
 });
});

test.describe("disconnected state",()=>{
 test.use({seedOptions:{rightTab:{presetId:"screen-agent",name:"agent"},presetList:[{id:"shell",name:"Shell",icon:"$",color:"",command:"$SHELL"},preset("idle")]}});
 test("a refused recovery remains unknown without a replacement or fresh pane spawn",async({app,seeded,window})=>{
  await expect(window.getByTestId("xterm-host").last()).toBeVisible();
  await expect.poll(()=>state(seeded.ayaHome)).toContain('"agent": idle');
  const {readFileSync}=await import("node:fs");
  const record=JSON.parse(readFileSync(join(seeded.ayaHome,"pty-owner","record.json"),"utf8"));
  await captureMainPtyClient(app);
  const hostPid=await app.evaluate(async()=>{const c=(globalThis as any).e2eMainPtyClient,pid=(await c.hostStatus()).pid;c.recoverCrashedHost=async()=>"blocked";return pid;});
  process.kill(hostPid,"SIGKILL");
  await expect.poll(()=>state(seeded.ayaHome),{timeout:10000}).toContain("disconnected or recovering");
  expect(state(seeded.ayaHome)).toContain('"agent": unknown');
  const after=JSON.parse(readFileSync(join(seeded.ayaHome,"pty-owner","record.json"),"utf8"));
  expect(after.pid).toBe(record.pid);expect(after.panes.map((p:{pid:number})=>p.pid)).toEqual(record.panes.map((p:{pid:number})=>p.pid));
  for(const p of [record.pid,...record.panes.map((p:{pid:number})=>p.pid)])expect(()=>process.kill(p,0)).not.toThrow();
 });
});
