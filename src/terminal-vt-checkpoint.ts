// Browser-only counterpart of the pinned common VT DTO. Capture runs after
// the renderer transforms, only at a drained ground boundary. No Node APIs.
import { Terminal as XTerm } from "@xterm/xterm";
import { encodeCellRuns, decodeCellRuns } from "../shared/renderer-cell-runs.cjs";
declare const __AYA_XTERM_ENGINE__: string;
export const SUPPORTED_BROWSER_ENGINE = "14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972";
const ACTUAL_BROWSER_ENGINE = typeof __AYA_XTERM_ENGINE__ === "undefined" ? SUPPORTED_BROWSER_ENGINE : __AYA_XTERM_ENGINE__;
// The outer browser engine pin verifies the producing/consuming runtime;
// the common-core DTO retains the reviewed headless-format identity.
const ENGINE = "17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed";
const MAX_SNAPSHOT = 64 * 1024 * 1024;
const CANONICAL_OPTIONS = { "cols": 80, "rows": 24, "cursorBlink": false, "cursorStyle": "block", "cursorWidth": 1, "cursorInactiveStyle": "outline", "customGlyphs": true, "drawBoldTextInBrightColors": true, "documentOverride": null, "fastScrollModifier": "alt", "fastScrollSensitivity": 5, "fontFamily": "monospace", "fontSize": 15, "fontWeight": "normal", "fontWeightBold": "bold", "ignoreBracketedPasteMode": false, "lineHeight": 1, "letterSpacing": 0, "linkHandler": null, "logLevel": "info", "logger": null, "scrollback": 0, "scrollOnEraseInDisplay": false, "scrollOnUserInput": true, "scrollSensitivity": 1, "screenReaderMode": false, "smoothScrollDuration": 0, "macOptionIsMeta": false, "macOptionClickForcesSelection": false, "minimumContrastRatio": 1, "disableStdin": false, "allowProposedApi": true, "allowTransparency": false, "tabStopWidth": 8, "theme": {}, "reflowCursorLine": false, "rescaleOverlappingGlyphs": false, "rightClickSelectsWord": false, "windowOptions": {}, "windowsMode": false, "windowsPty": {}, "wordSeparator": " ()[]{}',\"`", "altClickMovesCursor": true, "convertEol": false, "termName": "xterm", "cancelEvents": false, "overviewRuler": {} };
function canonicalOptions(term: any): any {
    const raw = term._core.optionsService.rawOptions;
    for (const key of ['cursorStyle', 'cursorWidth', 'convertEol', 'tabStopWidth', 'ignoreBracketedPasteMode', 'windowsMode', 'windowsPty', 'reflowCursorLine', 'termName', 'windowOptions'] as (keyof typeof CANONICAL_OPTIONS)[]) {
        if (JSON.stringify(raw[key]) !== JSON.stringify(CANONICAL_OPTIONS[key]))
            throw Error('Unsupported renderer terminal option');
    }
    return { ...CANONICAL_OPTIONS, cols: raw.cols, rows: raw.rows, scrollback: raw.scrollback, cursorBlink: raw.cursorBlink, scrollOnEraseInDisplay: raw.scrollOnEraseInDisplay };
}
function encode(bytes: Uint8Array): string {
    let text = "";
    for (let n = 0; n < bytes.length; n += 0x4000)
        text += String.fromCharCode(...bytes.subarray(n, n + 0x4000));
    return btoa(text);
}
function decode(text: string): Uint8Array { const raw = atob(text); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
const palettes = new WeakMap();
const ownedUnicodeProviders = new WeakMap();
const ownedHandlers = new WeakMap();
const callbacks = new WeakMap();
function trackPalette(term: any, saved: any = {}) {
    const existing = palettes.get(term);
    if (existing) {
        existing.clear();
        for (const [key, value] of Object.entries(saved))
            existing.set(key, value);
        return;
    }
    callbacks.set(term, { logger: term._core.optionsService.rawOptions.logger, linkHandler: term._core.optionsService.rawOptions.linkHandler });
    ownedUnicodeProviders.set(term, new Map(Object.entries(term._core.unicodeService._providers)));
    const p = term._core._inputHandler._parser;
    ownedHandlers.set(term, new Set([p._csiHandlers, p._escHandlers, p._oscParser._handlers, p._dcsParser._handlers].flatMap(handlers => (Object.values(handlers) as any[]).flat())));
    const palette = new Map(Object.entries(saved));
    palettes.set(term, palette);
    term._core._inputHandler.onColor((events: any[]) => {
        for (const event of events) {
            if (event.type === 1)
                palette.set(String(event.index), copy(event.color));
            else if (event.type === 2) {
                if (event.index === undefined)
                    palette.clear();
                else
                    palette.delete(String(event.index));
            }
        }
    });
}
const copy = (value: any): any => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const pick = (object: any, fields: string[]): any => Object.fromEntries(fields.filter(key => object[key] !== undefined).map(key => [key, copy(object[key])]));
const B = ['ydisp', 'ybase', 'y', 'x', 'scrollBottom', 'scrollTop', 'tabs', 'savedY', 'savedX', 'savedCharset', '_cols', '_rows', '_hasScrollback'];
const H = ['_windowTitle', '_iconName', '_windowTitleStack', '_iconNameStack', '_specialColors'];
const C = ['isCursorInitialized', 'isCursorHidden', 'modes', 'decPrivateModes'];
const M = ['_activeProtocol', '_activeEncoding', '_lastEvent', '_wheelPartialScroll'];
const raw = (array: any) => encode(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
function handlerShape(term: any) {
    const c = term._core, p = c._inputHandler._parser;
    const shapes = [p._csiHandlers, p._escHandlers, p._oscParser._handlers, p._dcsParser._handlers].map(handlers => Object.entries(handlers).map(([key, entries]) => [key, (entries as any[]).length] as const).sort(([a], [b]) => a.localeCompare(b)));
    return JSON.stringify([shapes, Object.keys(c.unicodeService._providers).sort()]);
}
const probe: any = new XTerm({ allowProposedApi: true }), HANDLERS = handlerShape(probe);
probe.dispose();
function ground(term: any) { const h = term._core._inputHandler; return h._parser.currentState === 0 && !h._parseStack.paused; }
function attrs(value: any) { return { fg: value.fg, bg: value.bg, extended: pick(value.extended, ['_ext', '_urlId']) }; }
function restoreAttrs(target: any, value: any) { target.fg = value.fg; target.bg = value.bg; Object.assign(target.extended, value.extended); }
function rendererLine(line: any, cache?: Map<any, any>): any {
    if (cache?.has(line)) return cache.get(line);
    const common = {length: line.length, isWrapped: line.isWrapped, combined: copy(line._combined), extended: Object.fromEntries(Object.entries(line._extendedAttrs).filter(([, v]) => v).map(([k, v]) => [k, pick(v, ['_ext', '_urlId'])]))};
    const runs = encodeCellRuns(line._data, line.length);
    const packed = runs && JSON.stringify(runs).length < line.length * 16 ? {...common, runs} : {...common, data: raw(line._data.subarray(0, line.length * 3))};
    cache?.set(line, packed);
    return packed;
}
function bufferState(buffer: any, start = 0, cache?: Map<any, any>) {
    return { state: pick(buffer, B), saved: attrs(buffer.savedCurAttrData), lines: Array.from({ length: buffer.lines.length - start }, (_, n) => {
            const line = buffer.lines.get(n + start);
            return rendererLine(line, cache);
        }) };
}
function assertOwnership(term: any, drained = true) {
    if (ACTUAL_BROWSER_ENGINE !== SUPPORTED_BROWSER_ENGINE)
        throw Error('Unsupported VT engine implementation');
    if (handlerShape(term) !== HANDLERS)
        throw Error('Custom parser/Unicode handlers are not eligible');
    const known = ownedUnicodeProviders.get(term);
    if (!known || Object.entries(term._core.unicodeService._providers).some(([key, provider]) => known.get(key) !== provider))
        throw Error('Custom Unicode provider replacement is not eligible');
    const c = term._core, buffers = c._bufferService.buffers;
    if ((drained && c._writeBuffer._pendingData) || c._inputHandler._parseStack.paused)
        throw Error('VT writes have not drained');
    const p = c._inputHandler._parser, handlers = ownedHandlers.get(term);
    if ([p._oscParser._active, p._dcsParser._active, p._parseStack.handlers].flat().some(handler => !handlers?.has(handler)))
        throw Error('Unsupported active parser handler');
    if (c.optionsService.rawOptions.logger !== callbacks.get(term)?.logger || c.optionsService.rawOptions.linkHandler !== callbacks.get(term)?.linkHandler)
        throw Error('Custom handlers are not eligible');
    const seen = new Set();
    for (const entry of c._oscLinkService._dataByLinkId.values())
        for (const marker of entry.lines) {
            if (marker.isDisposed || (!buffers.normal.markers.includes(marker) && !buffers.alt.markers.includes(marker)))
                throw Error('Unowned OSC link marker');
            seen.add(marker);
        }
    if ([...buffers.normal.markers, ...buffers.alt.markers].some(marker => !seen.has(marker)))
        throw Error('External markers are not eligible');
}
function capture(term: any, metadata: any = {}, start = 0, cache?: Map<any, any>) {
    assertOwnership(term);
    if (!ground(term))
        throw Error('VT parser is not in ground state');
    const c = term._core, h = c._inputHandler, p = h._parser, bs = c._bufferService, buffers = bs.buffers;
    if (c._writeBuffer._pendingData)
        throw Error('VT writes have not drained');
    if (h._parser._parseStack.state)
        throw Error('Asynchronous parser continuation is unsupported');
    if (c.optionsService.rawOptions.logger !== callbacks.get(term)?.logger || c.optionsService.rawOptions.linkHandler !== callbacks.get(term)?.linkHandler)
        throw Error('Custom handlers are not eligible');
    const seen = new Set(), links = [];
    for (const entry of c._oscLinkService._dataByLinkId.values()) {
        const lines = entry.lines.map((marker: any) => {
            const buffer = buffers.normal.markers.includes(marker) ? 'normal' : buffers.alt.markers.includes(marker) ? 'alternate' : null;
            if (!buffer || marker.isDisposed)
                throw Error('Unowned OSC link marker');
            seen.add(marker);
            return { buffer, line: marker.line - (buffer === "normal" ? start : 0) };
        }).filter((line: any) => line.line >= 0);
        links.push({ id: entry.id, key: entry.key, data: copy(entry.data), lines });
    }
    if ([...buffers.normal.markers, ...buffers.alt.markers].some(marker => !seen.has(marker)))
        throw Error('External markers are not eligible');
    const dto = { format: 1, engine: ENGINE, options: canonicalOptions(term), metadata: copy(metadata),
        cols: term.cols, rows: term.rows, normal: bufferState(buffers.normal, start, cache), alternate: bufferState(buffers.alt, 0, cache), active: buffers.active === buffers.alt ? 'alternate' : 'normal',
        userScrolling: bs.isUserScrolling, core: pick(c.coreService, C), mouse: pick(c.coreMouseService, M), charset: pick(c._charsetService, ['charset', 'glevel', '_charsets']),
        input: pick(h, H), current: attrs(h._curAttrData), erase: attrs(h._eraseAttrDataInternal),
        parser: { initialState: p.initialState, currentState: p.currentState, precedingJoinState: p.precedingJoinState, collect: p._collect,
            params: { ...pick(p._params, ['maxLength', 'maxSubParamsLength', 'length', '_subParamsLength', '_rejectDigits', '_rejectSubDigits', '_digitIsSub']), params: raw(p._params.params), sub: raw(p._params._subParams), indices: raw(p._params._subParamsIdx) } },
        stringInterim: h._stringDecoder._interim, utf8Interim: raw(h._utf8Decoder.interim), unicode: c.unicodeService.activeVersion,
        palette: Object.fromEntries(palettes.get(term) ?? []), links: { nextId: c._oscLinkService._nextId, entries: links } };
    dto.normal.state.ybase -= start;
    dto.normal.state.ydisp = Math.max(0, dto.normal.state.ydisp - start);
    dto.normal.state.savedY = Math.max(0, dto.normal.state.savedY - start);
    const bytes = new TextEncoder().encode(JSON.stringify(dto));
    if (bytes.length > MAX_SNAPSHOT)
        throw Error('VT snapshot size limit');
    return dto;
}
function restoreBuffer(buffer: any, snapshot: any, extendedPrototype: any) {
    const Line = buffer.getBlankLine(buffer.savedCurAttrData).constructor;
    buffer.lines.length = 0;
    for (const saved of snapshot.lines) {
        if (saved.length > 1000)
            throw Error('Invalid VT line');
        const line = new Line(saved.length);
        if (saved.runs) line._data.set(decodeCellRuns(saved.runs, saved.length));
        else {
            const bytes = decode(saved.data);
            if(bytes.length !== saved.length * 12) throw Error('Invalid VT line');
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let n = 0; n < saved.length * 3; n++) line._data[n] = view.getUint32(n * 4, true);
        }
        line.isWrapped = saved.isWrapped;
        line._combined = copy(saved.combined);
        line._extendedAttrs = {};
        for (const [key, value] of Object.entries(saved.extended))
            line._extendedAttrs[key] = Object.assign(Object.create(extendedPrototype), value);
        buffer.lines.push(line);
    }
    Object.assign(buffer, snapshot.state);
    restoreAttrs(buffer.savedCurAttrData, snapshot.saved);
}
function restore(term: any, dto: any) {
    if (ACTUAL_BROWSER_ENGINE !== SUPPORTED_BROWSER_ENGINE)
        throw Error('Unsupported VT engine implementation');
    if (dto.format !== 1 || dto.engine !== ENGINE || dto.parser.currentState !== 0)
        throw Error('Unsupported VT checkpoint identity/state');
    if (!Number.isInteger(dto.cols) || dto.cols < 2 || dto.cols > 1000 || !Number.isInteger(dto.rows) || dto.rows < 1 || dto.rows > 1000)
        throw Error('Invalid VT geometry');
    if (dto.normal.lines.length > dto.rows + dto.options.scrollback || dto.alternate.lines.length > dto.rows)
        throw Error('Invalid retained VT size');
    term.resize(dto.cols, dto.rows);
    const c = term._core, h = c._inputHandler, bs = c._bufferService, buffers = bs.buffers;
    // xterm's resize changes buffer geometry but retains constructor option
    // values. Preserve that distinction instead of silently changing rawOptions.
    c.optionsService.rawOptions.cols = dto.options.cols;
    c.optionsService.rawOptions.rows = dto.options.rows;
    trackPalette(term, dto.palette);
    const extProto = Object.getPrototypeOf(h._curAttrData.extended);
    restoreBuffer(buffers.normal, dto.normal, extProto);
    restoreBuffer(buffers.alt, dto.alternate, extProto);
    buffers._activeBuffer = dto.active === 'alternate' ? buffers.alt : buffers.normal;
    h._activeBuffer = buffers.active;
    bs.isUserScrolling = dto.userScrolling;
    Object.assign(c.coreService, dto.core);
    Object.assign(c.coreMouseService, dto.mouse);
    Object.assign(c._charsetService, dto.charset);
    c._charsetService._charsets = c._charsetService._charsets.map((value: any) => value ?? undefined);
    Object.assign(h, dto.input);
    restoreAttrs(h._curAttrData, dto.current);
    restoreAttrs(h._eraseAttrDataInternal, dto.erase);
    h._stringDecoder._interim = dto.stringInterim;
    h._utf8Decoder.interim.set(decode(dto.utf8Interim));
    c.unicodeService.activeVersion = dto.unicode;
    const p = h._parser;
    p.initialState = dto.parser.initialState;
    p.currentState = 0;
    p.precedingJoinState = dto.parser.precedingJoinState;
    p._collect = dto.parser.collect;
    const { params, sub, indices, ...state } = dto.parser.params;
    Object.assign(p._params, state);
    for (const [target, encoded] of [[p._params.params, params], [p._params._subParams, sub], [p._params._subParamsIdx, indices]]) {
        const data = decode(encoded);
        if (data.length !== target.byteLength)
            throw Error('Unsupported parser parameter storage');
        new Uint8Array(target.buffer, target.byteOffset, target.byteLength).set(data);
    }
    const service = c._oscLinkService;
    for (const saved of dto.links.entries) {
        const entry: any = { id: saved.id, data: copy(saved.data), ...(saved.key === undefined ? {} : { key: saved.key }), lines: [] };
        for (const item of saved.lines) {
            const buffer = item.buffer === 'normal' ? buffers.normal : buffers.alt, marker = buffer.addMarker(item.line);
            entry.lines.push(marker);
            marker.onDispose(() => service._removeMarkerFromLink(entry, marker));
        }
        service._dataByLinkId.set(entry.id, entry);
        if (entry.key !== undefined)
            service._entriesWithId.set(entry.key, entry);
    }
    service._nextId = dto.links.nextId;
    return { term, metadata: dto.metadata };
}
export interface RendererVtCheckpoint {
    format: 2;
    browserEngine: string;
    state: unknown;
    cutLines: number;
    viewportClamped: boolean;
}
export const MAX_RENDERER_PANE_BYTES = 64 * 1024 * 1024;
export function prepareRendererVt(term: XTerm): void {
    if (ACTUAL_BROWSER_ENGINE !== SUPPORTED_BROWSER_ENGINE)
        throw Error('Unsupported renderer VT engine');
    if (!palettes.has(term))
        throw Error('Renderer VT was not tracked from owned construction');
}
/** Establish handler/provider ownership before the caller can mutate a terminal.
 * Unknown engines still render normally, but cannot export this checkpoint. */
export function createRendererVt(options: ConstructorParameters<typeof XTerm>[0]): XTerm {
    const term = new XTerm(options);
    if (ACTUAL_BROWSER_ENGINE === SUPPORTED_BROWSER_ENGINE) trackPalette(term);
    return term;
}
function lineEstimate(line: any, cache: Map<any, any>): number {
    return new TextEncoder().encode(JSON.stringify(rendererLine(line, cache))).length + 1;
}
/** No continuous history copies: the old host first freezes its output and
 * flushes its fanout. Capture drains the already-rendered/transformed writes.
 * A missing/stuck/non-ground renderer falls back to replay, never a PTY stop. */
export async function captureRendererVt(term: XTerm, maxBytes = MAX_RENDERER_PANE_BYTES, timeoutMs = 250): Promise<RendererVtCheckpoint> {
    if (!palettes.has(term))
        throw Error('Renderer VT was not tracked from construction');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 65536 || maxBytes > MAX_RENDERER_PANE_BYTES)
        throw Error('Invalid renderer checkpoint budget');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
        throw Error('Invalid renderer checkpoint deadline');
    const deadline = performance.now() + timeoutMs;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Renderer checkpoint deadline expired')), timeoutMs);
        term.write('', () => { clearTimeout(timer); resolve(); });
    });
    const c = (term as any)._core, normal = c._bufferService.buffers.normal, alt = c._bufferService.buffers.alt;
    const lineCache = new Map<any, any>();
    let remaining = maxBytes - Math.min(65536, Math.floor(maxBytes / 4));
    let cellsRemaining = 3_000_000;
    for (let n = 0; n < alt.lines.length; n++) {
        remaining -= lineEstimate(alt.lines.get(n), lineCache);
        cellsRemaining -= alt.lines.get(n).length;
    }
    let start = normal.lines.length;
    // Retain the newest lines; never mutate the live terminal to enforce a cap.
    for (let n = normal.lines.length - 1; n >= 0; n--) {
        if (performance.now() > deadline)
            throw Error('Renderer checkpoint deadline expired');
        const cost = lineEstimate(normal.lines.get(n), lineCache);
        if ((remaining < cost || cellsRemaining < normal.lines.get(n).length) && n < normal.ybase)
            break;
        remaining -= cost;
        cellsRemaining -= normal.lines.get(n).length;
        start = n;
    }
    if (remaining < 0 || cellsRemaining < 0)
        throw Error('Renderer viewport exceeds its checkpoint budget');
    for (;;) {
        const state = capture(term, {}, start, lineCache);
        const result: RendererVtCheckpoint = { format: 2, browserEngine: SUPPORTED_BROWSER_ENGINE, state, cutLines: start, viewportClamped: normal.ydisp < start };
        const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
        if (performance.now() > deadline)
            throw Error('Renderer checkpoint deadline expired');
        if (bytes <= maxBytes)
            return result;
        if (start >= normal.ybase)
            throw Error('Renderer viewport exceeds its checkpoint budget');
        start = Math.min(normal.ybase, start + Math.max(1, Math.ceil((normal.ybase - start) / 8)));
    }
}
/** Main validated the closed DTO and caps before it reaches this fresh view.
 * Keep this view's known UI callbacks/theme/font; install only common VT state. */
export function restoreRendererVt(term: XTerm, checkpoint: RendererVtCheckpoint): void {
    if (checkpoint.format !== 2 || checkpoint.browserEngine !== SUPPORTED_BROWSER_ENGINE || ACTUAL_BROWSER_ENGINE !== SUPPORTED_BROWSER_ENGINE)
        throw Error('Unsupported renderer checkpoint engine');
    prepareRendererVt(term);
    assertOwnership(term);
    const dto = checkpoint.state as any;
    term.options.scrollback = dto.options.scrollback;
    term.options.cursorBlink = dto.options.cursorBlink;
    term.options.scrollOnEraseInDisplay = dto.options.scrollOnEraseInDisplay;
    restore(term, dto);
    const core = (term as any)._core, buffers = core._bufferService.buffers;
    // Browser listeners/selection are installed by this event, not by assigning
    // the private fields in the common DTO. Preserve the last-event dedup state.
    core.coreMouseService.activeEncoding = dto.mouse._activeEncoding;
    core.coreMouseService.activeProtocol = dto.mouse._activeProtocol;
    buffers._onBufferActivate.fire({ activeBuffer: buffers.active, inactiveBuffer: buffers.active === buffers.alt ? buffers.normal : buffers.alt });
    const theme = core._themeService;
    if (theme)
        theme.modifyColors((colors: any) => {
            for (const [key, rgb] of Object.entries(dto.palette) as [
                string,
                number[]
            ][]) {
                const index = Number(key), [r, g, b] = rgb;
                const color = { css: '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join(''), rgba: ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0 };
                if (index < 256)
                    colors.ansi[index] = color;
                else
                    colors[index === 256 ? 'foreground' : index === 257 ? 'background' : 'cursor'] = color;
            }
        });
    const target = buffers.active.ydisp;
    term.scrollToBottom();
    term.scrollToLine(target);
    core._bufferService.isUserScrolling = dto.userScrolling;
    if (core._renderService)
        term.refresh(0, term.rows - 1);
}
