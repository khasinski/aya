// Actual transformed renderer terminals, never a second display mirror in host.
import type {Terminal} from "@xterm/xterm";
import {captureRendererVt} from "./terminal-vt-checkpoint";
const terminals=new Map<string,{term:Terminal;ready:()=>boolean}>();let listening=false;
export function registerCheckpointTerminal(id:string,terminal:Terminal,ready:()=>boolean=()=>true):()=>void {
  const entry={term:terminal,ready};terminals.set(id,entry);
  if(!listening&&typeof window.aya.onHandoverCapture==='function'){
    listening=true;
    window.aya.onHandoverCapture(async request=>{
      const entry=terminals.get(request.ptyId);if(!entry||!entry.ready())return null;const term=entry.term;
      try{return JSON.stringify(await captureRendererVt(term,request.maxBytes,250));}catch{return null;}
    });
  }
  return ()=>{if(terminals.get(id)===entry)terminals.delete(id);};
}

/** The last `maxLines` lines of a terminal's screen and scrollback, or null when it has no live xterm (a GUI pane, a
 *  terminal that is not open). Rows the terminal wrapped are joined, so a long line is one line. */
export function terminalExcerpt(id: string, maxLines = 60): string | null {
  const entry = terminals.get(id);
  if (!entry) return null;
  const buffer = entry.term.buffer.active;
  const lines: string[] = [];
  let carry = "";
  for (let y = buffer.length - 1; y >= 0 && lines.length < maxLines; y--) {
    const row = buffer.getLine(y);
    if (!row) continue;
    const text = row.translateToString(true) + carry;
    if (row.isWrapped) { carry = text; continue; }
    carry = "";
    lines.unshift(text);
  }
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.join("\n");
}
