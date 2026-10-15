// Engine-pinned private binding. No decoded field reaches xterm before the
// closed DTO validator accepts it. Internal xterm types are intentionally
// confined to this module; payloads never select a constructor or a method.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseVtSnapshot } from "./vt-checkpoint-schema";
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Terminal } from '@xterm/headless';
const ENGINE = createHash('sha256').update(fs.readFileSync(require.resolve('@xterm/headless'))).digest('hex');
const SUPPORTED_ENGINE = '17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed';
const MAX_SNAPSHOT = 64 * 1024 * 1024;
const palettes = new WeakMap();
const ownedUnicodeProviders = new WeakMap();
const ownedHandlers = new WeakMap();
const registrations = new WeakMap();
function trackPalette(term: any, saved: any = {}) {
    const registrationState = { epoch: 0 };
    registrations.set(term, registrationState);
    for (const [api, methods] of [[term.parser, ['registerCsiHandler', 'registerEscHandler', 'registerOscHandler', 'registerDcsHandler']], [term.unicode, ['register']]])
        for (const method of methods) {
            const original = api[method].bind(api);
            api[method] = (...args: any[]) => { registrationState.epoch++; const result = original(...args); if (result?.dispose) {
                const dispose = result.dispose.bind(result);
                result.dispose = () => { registrationState.epoch++; dispose(); };
            } return result; };
        }
    ownedUnicodeProviders.set(term, new Map(Object.entries(term._core.unicodeService._providers)));
    const p = term._core._inputHandler._parser;
    ownedHandlers.set(term, new Set([p._csiHandlers, p._escHandlers, p._oscParser._handlers, p._dcsParser._handlers].flatMap(handlers => (Object.values(handlers) as any[]).flat())));
    const palette = new Map(Object.entries(saved));
    palettes.set(term, palette);
    term._core._inputHandler.onColor((events: any[]) => { for (const event of events) {
        if (event.type === 1)
            palette.set(String(event.index), copy(event.color));
        else if (event.type === 2) {
            if (event.index === undefined)
                palette.clear();
            else
                palette.delete(String(event.index));
        }
    } });
}
const copy = (value: any): any => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const pick = (object: any, fields: string[]): any => Object.fromEntries(fields.filter(key => object[key] !== undefined).map(key => [key, copy(object[key])]));
const B = ['ydisp', 'ybase', 'y', 'x', 'scrollBottom', 'scrollTop', 'tabs', 'savedY', 'savedX', 'savedCharset', '_cols', '_rows', '_hasScrollback'];
const H = ['_windowTitle', '_iconName', '_windowTitleStack', '_iconNameStack', '_specialColors'];
const C = ['isCursorInitialized', 'isCursorHidden', 'modes', 'decPrivateModes'];
const M = ['_activeProtocol', '_activeEncoding', '_lastEvent', '_wheelPartialScroll'];
const raw = (array: any) => Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');
function handlerShape(term: any) {
    const c = term._core, p = c._inputHandler._parser;
    const shapes = [p._csiHandlers, p._escHandlers, p._oscParser._handlers, p._dcsParser._handlers].map(handlers => Object.entries(handlers).map(([key, entries]) => [key, (entries as any[]).length] as const).sort(([a], [b]) => a.localeCompare(b)));
    return JSON.stringify([shapes, Object.keys(c.unicodeService._providers).sort()]);
}
const probe: any = new Terminal({ allowProposedApi: true }), HANDLERS = handlerShape(probe);
const DEFAULT_OPTIONS = copy(probe._core.optionsService.rawOptions);
probe.dispose();
export function ground(term: any) { const h = term._core._inputHandler; return h._parser.currentState === 0 && !h._parseStack.paused; }
function attrs(value: any) { return { fg: value.fg, bg: value.bg, extended: pick(value.extended, ['_ext', '_urlId']) }; }
function restoreAttrs(target: any, value: any) { target.fg = value.fg; target.bg = value.bg; Object.assign(target.extended, value.extended); }
export function bufferState(buffer: any) {
    return { state: pick(buffer, B), saved: attrs(buffer.savedCurAttrData), lines: Array.from({ length: buffer.lines.length }, (_, n) => {
            const line = buffer.lines.get(n);
            return { length: line.length, isWrapped: line.isWrapped, data: raw(line._data.subarray(0, line.length * 3)), combined: copy(line._combined), extended: Object.fromEntries(Object.entries(line._extendedAttrs).filter(([, v]) => v).map(([k, v]) => [k, pick(v, ['_ext', '_urlId'])])) };
        }) };
}
export function assertOwnership(term: any, drained = true) {
    if (ENGINE !== SUPPORTED_ENGINE)
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
    if (c.optionsService.rawOptions.logger || c.optionsService.rawOptions.linkHandler)
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
export function capture(term: any, metadata: any = {}) {
    assertOwnership(term);
    if (!ground(term))
        throw Error('VT parser is not in ground state');
    const c = term._core, h = c._inputHandler, p = h._parser, bs = c._bufferService, buffers = bs.buffers;
    if (c._writeBuffer._pendingData)
        throw Error('VT writes have not drained');
    if (h._parser._parseStack.state)
        throw Error('Asynchronous parser continuation is unsupported');
    if (c.optionsService.rawOptions.logger || c.optionsService.rawOptions.linkHandler)
        throw Error('Custom handlers are not eligible');
    const seen = new Set(), links = [];
    for (const entry of c._oscLinkService._dataByLinkId.values()) {
        const lines = entry.lines.map((marker: any) => {
            const buffer = buffers.normal.markers.includes(marker) ? 'normal' : buffers.alt.markers.includes(marker) ? 'alternate' : null;
            if (!buffer || marker.isDisposed)
                throw Error('Unowned OSC link marker');
            seen.add(marker);
            return { buffer, line: marker.line };
        });
        links.push({ id: entry.id, key: entry.key, data: copy(entry.data), lines });
    }
    if ([...buffers.normal.markers, ...buffers.alt.markers].some(marker => !seen.has(marker)))
        throw Error('External markers are not eligible');
    const dto = { format: 1, engine: ENGINE, options: copy(c.optionsService.rawOptions), metadata: copy(metadata),
        cols: term.cols, rows: term.rows, normal: bufferState(buffers.normal), alternate: bufferState(buffers.alt), active: buffers.active === buffers.alt ? 'alternate' : 'normal',
        userScrolling: bs.isUserScrolling, core: pick(c.coreService, C), mouse: pick(c.coreMouseService, M), charset: pick(c._charsetService, ['charset', 'glevel', '_charsets']),
        input: pick(h, H), current: attrs(h._curAttrData), erase: attrs(h._eraseAttrDataInternal),
        parser: { initialState: p.initialState, currentState: p.currentState, precedingJoinState: p.precedingJoinState, collect: p._collect,
            params: { ...pick(p._params, ['maxLength', 'maxSubParamsLength', 'length', '_subParamsLength', '_rejectDigits', '_rejectSubDigits', '_digitIsSub']), params: raw(p._params.params), sub: raw(p._params._subParams), indices: raw(p._params._subParamsIdx) } },
        stringInterim: h._stringDecoder._interim, utf8Interim: raw(h._utf8Decoder.interim), unicode: c.unicodeService.activeVersion,
        palette: Object.fromEntries(palettes.get(term) ?? []), links: { nextId: c._oscLinkService._nextId, entries: links } };
    const bytes = Buffer.from(JSON.stringify(dto));
    if (bytes.length > MAX_SNAPSHOT)
        throw Error('VT snapshot size limit');
    return bytes;
}
function restoreBuffer(buffer: any, snapshot: any, extendedPrototype: any) {
    const Line = buffer.getBlankLine(buffer.savedCurAttrData).constructor;
    buffer.lines.length = 0;
    for (const saved of snapshot.lines) {
        if (saved.length > 1000 || Buffer.from(saved.data, 'base64').length !== saved.length * 12)
            throw Error('Invalid VT line');
        const line = new Line(saved.length);
        const bytes = Buffer.from(saved.data, 'base64');
        for (let n = 0; n < saved.length * 3; n++)
            line._data[n] = bytes.readUInt32LE(n * 4);
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
export function restore(bytes: Buffer) {
    if (ENGINE !== SUPPORTED_ENGINE)
        throw Error('Unsupported VT engine implementation');
    if (bytes.length > MAX_SNAPSHOT)
        throw Error('VT snapshot size limit');
    const dto: any = parseVtSnapshot(bytes, ENGINE, DEFAULT_OPTIONS);
    if (dto.format !== 1 || dto.engine !== ENGINE || dto.parser.currentState !== 0)
        throw Error('Unsupported VT checkpoint identity/state');
    if (!Number.isInteger(dto.cols) || dto.cols < 2 || dto.cols > 1000 || !Number.isInteger(dto.rows) || dto.rows < 1 || dto.rows > 1000)
        throw Error('Invalid VT geometry');
    if (dto.normal.lines.length > dto.rows + dto.options.scrollback || dto.alternate.lines.length > dto.rows)
        throw Error('Invalid retained VT size');
    const term: any = new Terminal({ ...dto.options, cols: dto.cols, rows: dto.rows }), c = term._core, h = c._inputHandler, bs = c._bufferService, buffers = bs.buffers;
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
    h._utf8Decoder.interim.set(Buffer.from(dto.utf8Interim, 'base64'));
    c.unicodeService.activeVersion = dto.unicode;
    const p = h._parser;
    p.initialState = dto.parser.initialState;
    p.currentState = 0;
    p.precedingJoinState = dto.parser.precedingJoinState;
    p._collect = dto.parser.collect;
    const { params, sub, indices, ...state } = dto.parser.params;
    Object.assign(p._params, state);
    for (const [target, encoded] of [[p._params.params, params], [p._params._subParams, sub], [p._params._subParamsIdx, indices]]) {
        const data = Buffer.from(encoded, 'base64');
        if (data.length !== target.byteLength)
            throw Error('Unsupported parser parameter storage');
        Buffer.from(target.buffer, target.byteOffset, target.byteLength).set(data);
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
export { ENGINE };
export function validateCapturedSnapshot(bytes: Buffer): void { parseVtSnapshot(bytes, ENGINE, DEFAULT_OPTIONS); }
export function createOwnedTerminal(options: ConstructorParameters<typeof Terminal>[0]): Terminal {
    const term = new Terminal(options);
    trackPalette(term);
    return term;
}
export function ownershipEpoch(term: Terminal): number { return registrations.get(term)?.epoch ?? -1; }
