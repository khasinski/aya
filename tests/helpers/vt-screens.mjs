import { readFileSync } from "node:fs";
import { closeVtPane, openVtPane, paneHold, writeVtPane } from "../../dist-electron/vt-state.js";

export const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8").trimEnd().split("\n");
const CLEAR = "\x1b[2J\x1b[H";
/** Long enough for the vt mirror to have parsed what was just written to it. */
export const settle = () => new Promise((r) => setTimeout(r, 30));

/** The hold `paneHold` reports for `agent`'s pane after each of `screens` (rows) is drawn in turn. */
export async function holdAfter(agent, screens) {
  openVtPane("screens", 100, 30, () => {}, agent, false);
  try {
    let reason;
    for (const rows of screens) {
      writeVtPane("screens", CLEAR + rows.join("\r\n"));
      await settle();
      reason = await paneHold("screens");
    }
    return reason;
  } finally {
    closeVtPane("screens");
  }
}
