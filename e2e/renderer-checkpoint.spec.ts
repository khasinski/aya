import { join } from "node:path";
import { test, expect } from "./fixtures";

// An actual opened browser terminal exercises renderer services absent from
// the Node codec tests. It is a disposable window, never a product PTY host.
test("opened renderer checkpoint preserves transformed history, viewport and palette", async ({ app }) => {
  const result = await app.evaluate(async ({ BrowserWindow }, { root, xterm }) => {
    const view = new BrowserWindow({ show: false, webPreferences: {
      nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false,
    } });
    try {
      await view.loadURL("data:text/html,<body style='margin:0'><div id='a'></div><div id='b'></div></body>");
      return await view.webContents.executeJavaScript(`(async()=>{
        const {Terminal}=require(${JSON.stringify(xterm)});
        const codec=require(${JSON.stringify(root + '/dist-test/terminal-vt-checkpoint.js')});
        const transforms=require(${JSON.stringify(root + '/dist-test/terminal-rendering.js')});
        const validator=require(${JSON.stringify(root + '/dist-electron/renderer-vt-checkpoint.js')});
        const create=id=>{const t=new Terminal({cols:80,rows:24,scrollback:10000,allowProposedApi:true,cursorBlink:true,scrollOnEraseInDisplay:true});codec.prepareRendererVt(t);t.open(document.getElementById(id));return t;};
        const a=create('a'),b=create('b'),write=(t,s)=>new Promise(r=>t.write(s,r));
        try{
          const text=Array.from({length:400},(_,n)=>'ROW '+n+' '+String.fromCharCode(65+n%26).repeat(30)+'\\r\\n').join('');
          await write(a,transforms.normalizeTerminalLinkUnderline(transforms.stripScrollbackErase(text+'\\x1b[3J\\x1b]4;1;#123456\\x07\\x1b[31mPALETTE\\x1b[0m')));
          a.scrollToLine(a.buffer.normal.baseY-20);
          const before={length:a.buffer.normal.length,base:a.buffer.normal.baseY,view:a.buffer.normal.viewportY};
          const cp=await codec.captureRendererVt(a,8*1024*1024,1000);
          codec.restoreRendererVt(b,validator.parseRendererCheckpoint(Buffer.from(JSON.stringify(cp)),8*1024*1024));
          const inspect=t=>({length:t.buffer.normal.length,base:t.buffer.normal.baseY,view:t.buffer.normal.viewportY,
            rows:Array.from({length:t.rows},(_,n)=>t.buffer.active.getLine(t.buffer.active.viewportY+n).translateToString()),
            palette:t._core._themeService.colors.ansi[1].css});
          const original=inspect(a),restored=inspect(b);
          // Observe the opened DOM too, after xterm's scheduled paint.
          const deadline=performance.now()+3000;
          while(document.querySelector('#b .xterm-rows')?.textContent?.includes('ROW 36')!==true){
            if(performance.now()>deadline)throw Error('Restored DOM did not render its scrolled viewport');
            await new Promise(r=>requestAnimationFrame(r));
          }
          const dom=id=>Array.from(document.querySelectorAll('#'+id+' .xterm-rows > div')).map(row=>row.textContent);
          const domA=dom('a'),domB=dom('b');
          // Bring the coloured line into view and wait for its actual paint.
          // Reading themeService alone would miss a stale DOM/CSS repaint.
          a.scrollToBottom();b.scrollToBottom();
          const color=id=>{const span=Array.from(document.querySelectorAll('#'+id+' .xterm-rows span')).find(s=>s.textContent.includes('PALETTE'));return span?getComputedStyle(span).color:null;};
          const paintDeadline=performance.now()+3000;
          while(color('a')!=='rgb(18, 52, 86)'||color('b')!=='rgb(18, 52, 86)'){
            if(performance.now()>paintDeadline)throw Error('Restored palette did not repaint: '+color('a')+' / '+color('b'));
            await new Promise(r=>requestAnimationFrame(r));
          }
          return {before,original,restored,domA,domB,colorA:color('a'),colorB:color('b'),cut:cp.cutLines,clamped:cp.viewportClamped};
        }finally{a.dispose();b.dispose();}
      })()`);
    } finally { view.destroy(); }
  }, { root: join(__dirname, ".."), xterm: require.resolve("@xterm/xterm") });
  expect(result.before.length).toBeGreaterThan(400);
  expect(result.cut).toBe(0); expect(result.clamped).toBe(false);
  expect(result.restored).toEqual(result.original);
  expect(result.restored.palette.toLowerCase()).toBe("#123456");
  expect(result.domB).toEqual(result.domA);
  expect(result.colorA).toBe("rgb(18, 52, 86)");
  expect(result.colorB).toBe("rgb(18, 52, 86)");
});
