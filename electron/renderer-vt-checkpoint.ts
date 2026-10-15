// Main validates a renderer's bounded encoded string before materializing it
// or accepting any private xterm fields. No browser library is loaded in main.
import { parseCheckpointJson } from "./vt-checkpoint-schema";
import { validateRendererCommonState } from "./vt-checkpoint-binding";
const BROWSER_ENGINE = "14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972";
export const MAX_RENDERER_PANE_BYTES = 64 * 1024 * 1024;
export const MAX_RENDERER_TOTAL_BYTES = 96 * 1024 * 1024;
export interface RendererCheckpoint {
    format: 1;
    browserEngine: string;
    state: unknown;
    cutLines: number;
    viewportClamped: boolean;
}
export function parseRendererCheckpoint(input: Buffer, budget = MAX_RENDERER_PANE_BYTES): RendererCheckpoint {
    if (!Number.isSafeInteger(budget) || budget < 65536 || budget > MAX_RENDERER_PANE_BYTES)
        throw new Error("Invalid renderer checkpoint budget");
    const value = parseCheckpointJson(input, budget) as RendererCheckpoint;
    if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "browserEngine,cutLines,format,state,viewportClamped" ||
        value.format !== 1 || value.browserEngine !== BROWSER_ENGINE || !Number.isSafeInteger(value.cutLines) || value.cutLines < 0 || value.cutLines > 10000 || typeof value.viewportClamped !== "boolean")
        throw new Error("Invalid renderer checkpoint envelope");
    validateRendererCommonState(value.state);
    return value;
}
