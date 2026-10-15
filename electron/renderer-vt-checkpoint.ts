// Main validates a renderer's bounded encoded string before materializing it
// or accepting any private xterm fields. No browser library is loaded in main.
import { parseCheckpointJson } from "./vt-checkpoint-schema";
import { validateRendererCommonState } from "./vt-checkpoint-binding";
import { decodeCellRuns } from "../shared/renderer-cell-runs.cjs";
export const BROWSER_ENGINE = "14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972";
export const MAX_RENDERER_PANE_BYTES = 64 * 1024 * 1024;
export const MAX_RENDERER_TOTAL_BYTES = 96 * 1024 * 1024;
export interface RendererCheckpoint {
    format: 2;
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
        value.format !== 2 || value.browserEngine !== BROWSER_ENGINE || !Number.isSafeInteger(value.cutLines) || value.cutLines < 0 || value.cutLines > 10000 || typeof value.viewportClamped !== "boolean")
        throw new Error("Invalid renderer checkpoint envelope");
    validateRendererCommonState(expandRendererRows(value.state));
    return value;
}
/** Bound aggregate decoded cells before expanding any row. Common VT schema
 * then validates flags, references and geometry over the exact decoded planes. */
export function expandRendererRows(value: unknown): unknown {
    const fail = (): never => { throw new Error("Invalid renderer rows"); };
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const state = value as Record<string, unknown>;
    let cells = 0;
    for (const name of ["normal", "alternate"]) {
        const buffer = state[name] as {lines?: Array<{length?: unknown}>};
        if (!buffer || !Array.isArray(buffer.lines) || buffer.lines.length > 11000) fail();
        for (const line of buffer.lines!) {
            if (!line || !Number.isSafeInteger(line.length) || (line.length as number) < 1 || (line.length as number) > 1000) fail();
            cells += line.length as number;
            if (cells > 3_000_000) throw new Error("Renderer retained-cell allocation limit");
        }
    }
    const expanded = {...state};
    for (const name of ["normal", "alternate"]) {
        const buffer = state[name] as {lines: Array<Record<string, unknown>>};
        expanded[name] = {...buffer, lines: buffer.lines.map(line => {
            if (!Object.hasOwn(line, "runs")) return line;
            if (Object.keys(line).sort().join(",") !== "combined,extended,isWrapped,length,runs") fail();
            const words = decodeCellRuns(line.runs, line.length as number);
            const bytes = Buffer.allocUnsafe(words.length * 4);
            for (let n = 0; n < words.length; n++) bytes.writeUInt32LE(words[n], n * 4);
            const {runs: _runs, ...rest} = line;
            return {...rest, data: bytes.toString("base64")};
        })};
    }
    return expanded;
}
