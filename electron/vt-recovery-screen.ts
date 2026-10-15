// Transient cell coverage for the engine-pinned headless mirror. Parser work,
// not raw escape substrings or touched rows, establishes a reconstructed screen.
import type {Terminal} from "@xterm/headless";
export const RECOVERY_SCREEN_SETTLE_MS=250;
export const RECOVERY_SCREEN_TIMEOUT_MS=10_000;
interface Disposable {dispose():void}
export class RecoveryScreen {
 private cells=new WeakMap<object,Uint8Array>();
 private lines=new Map<any,()=>void>();
 private reset=false;
 private pendingRis=false;
 private done=false;
 private pending=0;
 private epoch=0;
 private quiet:ReturnType<typeof setTimeout>|undefined;
 private deadline:ReturnType<typeof setTimeout>|undefined;
 private listeners:Disposable[]=[];
 private input:any;
 private buffers:any;
 private originalPrint:any;
 private print:any;
 private originalScroll:any;
 private scroll:any;
 private originalWrite:any;
 private write:any;
 constructor(private terminal:Terminal,private status:(known:boolean,timedOut:boolean)=>void,
  private settleMs=RECOVERY_SCREEN_SETTLE_MS,timeoutMs=RECOVERY_SCREEN_TIMEOUT_MS){
  const core=(terminal as any)._core;this.input=core?._inputHandler;this.buffers=core?._bufferService;
  if(typeof this.input?.print!=='function'||typeof this.buffers?.scroll!=='function'||typeof this.buffers?.buffers?.onBufferActivate!=='function')throw Error('This engine cannot prove recovered screen coverage');
  const self=this;
  this.originalWrite=terminal.write;
  this.write=function(data:string|Uint8Array,callback?:()=>void){
   const applied=data.length?self.noteOutput():()=>{};
   try{return self.originalWrite.call(this,data,()=>{applied();callback?.();});}
   catch(error){self.invalidate();applied();throw error;}
  };
  (terminal as any).write=this.write;
  this.originalPrint=this.input.print;
  this.print=function(...args:any[]){self.instrumentLines();return self.originalPrint.apply(this,args);};
  this.input.print=this.print;
  this.originalScroll=this.buffers.scroll;
  this.scroll=function(...args:any[]){
   const result=self.originalScroll.apply(this,args);
   // The engine inserted a new blank line, including when recycling its object.
   const buffer=self.buffers.buffer,line=buffer.lines.get(buffer.ybase+buffer.scrollBottom);
   if(line)self.cells.set(line,new Uint8Array(self.terminal.cols).fill(1));
   self.instrumentLines();return result;
  };
  this.buffers.scroll=this.scroll;
  const csi=(final:string,fn:(params:any)=>void)=>this.listeners.push(terminal.parser.registerCsiHandler({final},p=>{fn(p);return false;}));
  csi('K',p=>{const b=this.buffers.buffer,mode=p[0]??0;if(mode===0)this.cover(b.y,b.x,terminal.cols);else if(mode===1)this.cover(b.y,0,b.x+1);else if(mode===2)this.cover(b.y,0,terminal.cols);});
  csi('X',p=>{const b=this.buffers.buffer;this.cover(b.y,b.x,b.x+Math.max(1,p[0]??1));});
  csi('J',p=>{
   const b=this.buffers.buffer,mode=p[0]??0;
   if(mode===2){this.reset=true;return;}
   if(mode===0){this.cover(b.y,b.x,terminal.cols);for(let r=b.y+1;r<terminal.rows;r++)this.cover(r,0,terminal.cols);}
   if(mode===1){for(let r=0;r<b.y;r++)this.cover(r,0,terminal.cols);this.cover(b.y,0,b.x+1);}
  });
  this.listeners.push(terminal.parser.registerEscHandler({final:'c'},()=>{this.pendingRis=true;return false;}));
  this.listeners.push(terminal.onResize(()=>this.invalidate()));
  this.listeners.push(this.buffers.buffers.onBufferActivate(()=>this.invalidate()));
  // Operations that move existing cells need stronger provenance. Refuse their
  // old coverage rather than infer unknown source cells. replaceCells is intact.
  for(const final of ['@','P','L','M','S','T'])csi(final,()=>this.invalidate());
  this.instrumentLines();
  this.deadline=setTimeout(()=>{this.deadline=undefined;if(!this.done)this.status(false,true);},timeoutMs);
 }
 /** One completion per nonempty received chunk, called only by its write ACK. */
 noteOutput():()=>void {
  if(this.done)return()=>{};
  this.pending++;this.epoch++;clearTimeout(this.quiet);
  let completed=false;return()=>{if(completed)return;completed=true;this.pending--;this.applied();};
 }
 private line(row:number):any {const b=this.buffers.buffer;return b.lines.get(b.ybase+row);}
 private bits(line:any):Uint8Array {let bits=this.cells.get(line);if(!bits||bits.length!==this.terminal.cols){bits=new Uint8Array(this.terminal.cols);this.cells.set(line,bits);}return bits;}
 private cover(row:number,start:number,end:number):void {
  if(row<0||row>=this.terminal.rows)return;const line=this.line(row);if(!line)return;
  this.bits(line).fill(1,Math.max(0,Math.min(start,this.terminal.cols)),Math.max(0,Math.min(end,this.terminal.cols)));
 }
 private instrumentLines():void {
  const active=new Set<any>();
  for(let row=0;row<this.terminal.rows;row++){
   const line=this.line(row);if(!line)continue;active.add(line);if(this.lines.has(line))continue;
   const original=line.setCellFromCodepoint,self=this;
   if(typeof original!=='function')throw Error('This engine cannot track recovered cell writes');
   const wrapped=function(this:any,index:number,...args:any[]){const result=original.call(this,index,...args);if(index>=0&&index<self.terminal.cols)self.bits(this)[index]=1;return result;};
   line.setCellFromCodepoint=wrapped;
   const restores:Array<()=>void>=[()=>{if(line.setCellFromCodepoint===wrapped)line.setCellFromCodepoint=original;}];
   for(const name of ['insertCells','deleteCells','copyCellsFrom']){
    const old=line[name];if(typeof old!=='function')continue;
    const wrap=function(this:any,...args:any[]){self.cells.delete(this);return old.apply(this,args);};line[name]=wrap;
    restores.push(()=>{if(line[name]===wrap)line[name]=old;});
   }
   this.lines.set(line,()=>{for(const restore of restores)restore();});
  }
  for(const [line,restore] of this.lines)if(!active.has(line)){restore();this.lines.delete(line);}
 }
 private invalidate():void {this.cells=new WeakMap();this.reset=false;this.epoch++;clearTimeout(this.quiet);}
 private applied():void {
  if(this.done||this.pending)return;
  if(this.pendingRis){this.reset=true;this.pendingRis=false;}
  this.instrumentLines();
  if(!this.reset){for(let r=0;r<this.terminal.rows;r++){const line=this.line(r),bits=line&&this.cells.get(line);if(!bits||bits.length!==this.terminal.cols||bits.some((bit:number)=>bit===0))return;}}
  const epoch=this.epoch;clearTimeout(this.quiet);
  this.quiet=setTimeout(()=>{if(this.done||this.pending||this.epoch!==epoch)return;this.dispose();this.status(true,false);},this.settleMs);
 }
 dispose():void {
  if(this.done)return;this.done=true;clearTimeout(this.quiet);clearTimeout(this.deadline);
  if(this.input.print===this.print)this.input.print=this.originalPrint;
  if(this.buffers.scroll===this.scroll)this.buffers.scroll=this.originalScroll;
  if((this.terminal as any).write===this.write)(this.terminal as any).write=this.originalWrite;
  for(const restore of this.lines.values())restore();this.lines.clear();
  for(const listener of this.listeners)listener.dispose();this.listeners=[];
 }
}
