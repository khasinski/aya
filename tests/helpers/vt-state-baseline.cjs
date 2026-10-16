// Frozen test-only reference from main 8890bea3 electron/vt-state.ts.
// Generated CommonJS; product never imports this reference.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCREEN_SETTLE_MAX_MS = exports.SCREEN_SETTLE_MS = exports.writeVtPane = exports.vtPaneDialog = exports.vtPaneWaiting = exports.vtPaneAltScreen = exports.resizeVtPane = exports.closeVtPane = exports.closeAllVtPanes = void 0;
exports.openVtPane = openVtPane;
exports.screenRows = screenRows;
exports.screenShowsApproval = screenShowsApproval;
exports.paneHold = paneHold;
exports.paneBusy = paneBusy;
exports.__testVtPane = __testVtPane;
exports.__testScanVtPane = __testScanVtPane;
exports.snapshotHold = snapshotHold;
exports.snapshotBusy = snapshotBusy;
exports.snapshotStatus = snapshotStatus;
const agent_screen_rules_1 = require("./agent-screen-rules-baseline.cjs");
const pane_holds_1 = require("../../dist-electron/pane-holds.js");
const vt_mirror_1 = require("../../dist-electron/vt-mirror.js");
var vt_mirror_2 = require("../../dist-electron/vt-mirror.js");
Object.defineProperty(exports, "closeAllVtPanes", { enumerable: true, get: function () { return vt_mirror_2.closeAllVtPanes; } });
Object.defineProperty(exports, "closeVtPane", { enumerable: true, get: function () { return vt_mirror_2.closeVtPane; } });
Object.defineProperty(exports, "resizeVtPane", { enumerable: true, get: function () { return vt_mirror_2.resizeVtPane; } });
Object.defineProperty(exports, "vtPaneAltScreen", { enumerable: true, get: function () { return vt_mirror_2.vtPaneAltScreen; } });
Object.defineProperty(exports, "vtPaneWaiting", { enumerable: true, get: function () { return vt_mirror_2.vtPaneWaiting; } });
Object.defineProperty(exports, "vtPaneDialog", { enumerable: true, get: function () { return vt_mirror_2.vtPaneDialog; } });
Object.defineProperty(exports, "writeVtPane", { enumerable: true, get: function () { return vt_mirror_2.writeVtPane; } });
Object.defineProperty(exports, "SCREEN_SETTLE_MS", { enumerable: true, get: function () { return vt_mirror_2.SCREEN_SETTLE_MS; } });
Object.defineProperty(exports, "SCREEN_SETTLE_MAX_MS", { enumerable: true, get: function () { return vt_mirror_2.SCREEN_SETTLE_MAX_MS; } });
function openVtPane(...args) {
    (0, vt_mirror_1.openVtPane)(...args);
    const pane = vt_mirror_1.panes.get(args[0]);
    pane.onSnapshot = () => scan(pane);
}
function scan(pane) {
    const rows = screenRows(pane.terminal);
    // A numbered choice is a question for the user as much as an approval dialog (paneHold holds messages for it too).
    const screen = (0, agent_screen_rules_1.evaluateScreen)(rows, pane.agent);
    const composer = composerState(pane.terminal);
    const verdict = screen !== null && composer === "numbered-choice" ? "waiting" : screen;
    // Only until first seen: the search walks the scrollback when none is there. A dialog's
    // selected row reads as a draft, so a waiting screen is never the composer.
    if (!pane.composerSeen && verdict !== "waiting" && COMPOSER_AGENTS.has(pane.agent) && firstComposer(pane, composer, rows)) {
        pane.composerSeen = true;
    }
    // No opinion (an empty screen): say nothing rather than assert a state change.
    if (verdict === null)
        return;
    const waiting = verdict === "waiting";
    const dialog = waiting && (0, agent_screen_rules_1.screenOffersAccountSetting)(rows, pane.agent) ? pane_holds_1.HOLD_ACCOUNT_SETTING : undefined;
    if (waiting === pane.lastWaiting && dialog === pane.lastDialog)
        return;
    pane.lastWaiting = waiting;
    pane.lastDialog = dialog;
    pane.onChange(waiting, dialog);
}
/** Blank rows are kept: each rule region filters them. */
function screenRows(terminal) {
    const buffer = terminal.buffer.active;
    const rows = [];
    for (let y = 0; y < buffer.length; y += 1) {
        rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
    }
    return rows;
}
/** Tests' window onto evaluateScreen, which the live path reaches through scanPane. */
function screenShowsApproval(terminal, agent) {
    return (0, agent_screen_rules_1.evaluateScreen)(screenRows(terminal), agent) === "waiting";
}
// The composer prompt: Claude and Grok draw "❯", Codex "›", Grok inside a box.
const COMPOSER_RE = /^\s*(?:│\s*)?[❯›]\s/;
// A numbered menu row ("❯ 1. Alpha", "› 2) Beta") uses the composer's chevron;
// it is a choice waiting for an answer, not text typed by the user.
const NUMBERED_OPTION_RE = /^\s*(?:│\s*)?[❯›]\s*\d+[.)]\s/;
const FRAME_RE = /[─│╭╮╰╯\s]/g;
// Agents whose composer we can tell is drawn; others count as started once their screen settles.
const COMPOSER_AGENTS = new Set(["claude", "codex", "grok", "opencode", "antigravity"]);
// OpenCode draws its composer (and every message and dialog after it) as a bar of ┃ or ╹ rows, not a
// chevron; its footer is not a signal, a small pane drops it. Measured: blank for over 2.5 s on a cold start.
const OPENCODE_BAR_RE = /^\s*[┃╹]/;
const OPENCODE_EDGE_RE = /^\s*╹/;
const OPENCODE_ROW_RE = /^\s*┃/;
// agy 1.2.14's composer: a ">" row between two rules, then its "? for shortcuts" row, ending the screen
// (tests/fixtures/own-screens/agy-idle). Any other screen (a dialog, the palette, a turn) takes no message.
const ANTIGRAVITY_COMPOSER_RE = /(?:^|\n)\s*─{8,}\n>([^\n]*)\n\s*─{8,}\n\s*\?\s*for shortcuts[^\n]*$/;
/** What is typed in Antigravity's composer ("" when empty), or null when its composer is not what the screen ends with. */
function antigravityComposer(rows) {
    const match = rows.filter((row) => row.trim()).join("\n").match(ANTIGRAVITY_COMPOSER_RE);
    return match ? match[1].trim() : null;
}
// codex-cli 0.159.3 draws a composer under its braille splash ~0.35 s before its trust dialog: under the splash it counts
// once the screen settles. The busy spinner is one braille cell, the logo rows many.
const CODEX_SPLASH_RE = /[\u2800-\u28FF]{8,}/;
function screenSettled(pane) {
    const now = Date.now();
    // Blank is not settled: a cold start draws late.
    return (pane.lastOutputAt !== null && now - pane.lastOutputAt >= vt_mirror_1.SCREEN_SETTLE_MS) || now - pane.openedAt >= vt_mirror_1.SCREEN_SETTLE_MAX_MS;
}
/** Whether this screen shows the composer the pane's first message may go to. */
function firstComposer(pane, chevron, rows) {
    if (pane.agent === "opencode")
        return rows.some((row) => OPENCODE_BAR_RE.test(row));
    if (pane.agent === "antigravity")
        return antigravityComposer(rows) !== null;
    // A numbered choice wears the composer's chevron but is a dialog: the composer comes after it.
    if (chevron !== "empty" && chevron !== "draft")
        return false;
    return pane.agent !== "codex" || !rows.some((row) => CODEX_SPLASH_RE.test(row)) || screenSettled(pane);
}
// OpenCode's idle placeholder: `Ask anything… "<example>"`, whole, or clipped by a narrow pane.
// A draft that only starts with those words ("Ask anything about ...") is the user's text.
const OPENCODE_PLACEHOLDER_RE = /^Ask anything(?:(?:…|\.\.\.)(?:\s+".*)?)?$/;
/** Whether OpenCode's composer holds text. The composer is the run of ┃ rows closed by the lowest
 *  ╹ edge; its last row is the agent and model line, the rest is padding and what was typed. */
function opencodeDraft(pane, rows) {
    if (pane.agent !== "opencode")
        return false;
    let edge = rows.length - 1;
    while (edge >= 0 && !OPENCODE_EDGE_RE.test(rows[edge] ?? ""))
        edge -= 1;
    if (edge < 0)
        return false;
    let first = edge;
    while (first > 0 && OPENCODE_ROW_RE.test(rows[first - 1] ?? ""))
        first -= 1;
    const typed = rows.slice(first, Math.max(first, edge - 1)).map((row) => row.replace(OPENCODE_ROW_RE, "").trim());
    return typed.some((text) => text !== "" && !OPENCODE_PLACEHOLDER_RE.test(text));
}
/** Classify the lowest prompt row. Dim placeholders and box frame characters
 *  are not typed text. */
function composerState(terminal) {
    const buffer = terminal.buffer.active;
    for (let y = buffer.length - 1; y >= 0; y -= 1) {
        const line = buffer.getLine(y);
        const text = line?.translateToString(true) ?? "";
        const prompt = text.match(COMPOSER_RE);
        if (!line || !prompt)
            continue;
        if (NUMBERED_OPTION_RE.test(text))
            return "numbered-choice";
        let typed = "";
        let cursorHead = false;
        let dimAfter = false;
        for (let x = prompt[0].length; x < line.length; x += 1) {
            const cell = line.getCell(x);
            if (!cell)
                continue;
            const chars = cell.getChars();
            if (cell.isDim())
                dimAfter ||= typed !== "" && chars.trim() !== "";
            else if (chars !== "") {
                typed += chars;
                cursorHead = typed === chars && cell.isInverse() !== 0;
            }
        }
        // A focused CLI paints its cursor as an inverse cell: on an empty composer, the first
        // letter of the dim placeholder. A lone inverse letter with nothing dim after it is a draft.
        if (cursorHead && dimAfter)
            return "empty";
        return typed.replace(FRAME_RE, "") !== "" ? "draft" : "empty";
    }
    return "absent";
}
// xterm parses writes asynchronously; an empty write's callback fires once the queue is applied.
const applied = (pane) => new Promise((done) => pane.terminal.write("", done));
// Glyphs a composer draws around the typed text: its prompt chevron and box or bar edges.
const COMPOSER_EDGE = /^[\s│┃❯›]+|[\s│┃]+$/g;
const squash = (text) => text.replace(/\s+/g, "");
const edgesOf = (row) => [...row.matchAll(COMPOSER_EDGE)].map((m) => m[0]).join("");
/** Blanks the rows showing only `pasted` (our text is no prompt), keeping the composer's edges; the whole text over
 *  consecutive rows, lowest first, so a dialog quoting one sentence of it is still read. */
function withoutPasted(rows, pasted) {
    const want = squash(pasted);
    if (!want)
        return rows;
    const cells = rows.map((row) => squash(row.replace(COMPOSER_EDGE, "")));
    for (let last = rows.length - 1; last >= 0; last -= 1) {
        let seen = "";
        for (let first = last; first >= 0 && seen.length < want.length; first -= 1) {
            seen = cells[first] + seen;
            if (seen === want)
                return rows.map((row, y) => (y >= first && y <= last ? edgesOf(row) : row));
        }
    }
    return rows;
}
/** Why a message must not be typed into this pane now, or null. `pasted` is the text Aya
 *  just typed: the composer showing only it is neither a prompt nor a user's draft. */
async function paneHold(ptyId, pasted) {
    const pane = vt_mirror_1.panes.get(ptyId);
    // Every live PTY has a mirror; none means it exited or never started.
    if (!pane)
        return pane_holds_1.HOLD_NOT_RUNNING;
    await applied(pane);
    return holdPane(pane, pasted);
}
function holdPane(pane, pasted) {
    if (pane.shell)
        return pane_holds_1.HOLD_SHELL;
    const screen = screenRows(pane.terminal);
    const rows = pasted ? withoutPasted(screen, pasted) : screen;
    const composer = composerState(pane.terminal);
    const dialog = (0, agent_screen_rules_1.evaluateScreen)(rows, pane.agent) === "waiting" ? ((0, agent_screen_rules_1.asksToRunAya)(rows) ? pane_holds_1.HOLD_APPROVE_AYA : pane_holds_1.HOLD_APPROVAL) : composer === "numbered-choice" ? pane_holds_1.HOLD_CHOICE : null;
    // Only while its dialog is up: once answered, the message left in the transcript is history.
    if (dialog)
        return (0, agent_screen_rules_1.screenOffersAccountSetting)(rows, pane.agent) ? pane_holds_1.HOLD_ACCOUNT_SETTING : (0, agent_screen_rules_1.screenShowsUsageLimit)(rows, pane.agent) ? pane_holds_1.HOLD_USAGE_LIMIT : dialog;
    if (firstComposer(pane, composer, screen))
        pane.composerSeen = true;
    // Measured: a message typed before the composer is drawn goes nowhere.
    if (!pane.composerSeen && COMPOSER_AGENTS.has(pane.agent))
        return pane_holds_1.HOLD_STARTING;
    if (composer === "draft" && pasted && composerIsPasted(screen, rows))
        return null;
    if (composer === "draft" || opencodeDraft(pane, rows))
        return pane_holds_1.HOLD_DRAFT;
    if (pane.agent === "antigravity") {
        const typed = antigravityComposer(rows);
        if (typed === null)
            return pane_holds_1.HOLD_BUSY;
        if (typed !== "")
            return pane_holds_1.HOLD_DRAFT;
    }
    // Only an agent with no composer rule gets here unseen.
    if (!pane.composerSeen) {
        if (!screenSettled(pane))
            return pane_holds_1.HOLD_STARTING;
        pane.composerSeen = true;
    }
    return null;
}
/** Whether the lowest prompt row, the composer, holds only the text `withoutPasted` blanked. */
function composerIsPasted(shown, masked) {
    for (let y = shown.length - 1; y >= 0; y -= 1) {
        if (COMPOSER_RE.test(shown[y] ?? ""))
            return masked[y] !== shown[y];
    }
    return false;
}
/** Whether the pane's agent is mid-turn: typed text would only queue in its CLI. */
async function paneBusy(ptyId) {
    const pane = vt_mirror_1.panes.get(ptyId);
    if (!pane)
        return false;
    await applied(pane);
    return (0, agent_screen_rules_1.screenIsBusy)(screenRows(pane.terminal), pane.agent);
}
function __testVtPane(ptyId) {
    return vt_mirror_1.panes.get(ptyId);
}
/** Force a scan without waiting for the debounce. Tests only - production
 *  always goes through writeVtPane's timer. */
function __testScanVtPane(ptyId) {
    const pane = vt_mirror_1.panes.get(ptyId);
    if (pane)
        scan(pane);
}
/** Evaluate the same cell view the in-process mirror exposes, without parsing output a second time. */
function paneFromSnapshot(snapshot, onChange = () => { }) {
    const lines = snapshot.rows.map((text, y) => {
        const cells = new Map(snapshot.cells[y].map(([x, chars, dim, inverse]) => [x, { getChars: () => chars, isDim: () => dim, isInverse: () => inverse }]));
        return { length: snapshot.cols, translateToString: () => text, getCell: (x) => cells.get(x) };
    });
    return { terminal: { buffer: { active: { length: lines.length, getLine: (y) => lines[y] } } },
        agent: snapshot.agent, shell: snapshot.shell, composerSeen: snapshot.composerSeen,
        openedAt: snapshot.openedAt, lastOutputAt: snapshot.lastOutputAt,
        lastWaiting: false, lastDialog: undefined, timer: null, onChange };
}
function snapshotHold(snapshot, pasted) {
    if (snapshot.recoveryUnknown)
        return { hold: snapshot.shell ? pane_holds_1.HOLD_SHELL : pane_holds_1.HOLD_RECOVERY_UNKNOWN, composerSeen: false };
    const pane = paneFromSnapshot(snapshot);
    return { hold: holdPane(pane, pasted), composerSeen: pane.composerSeen };
}
function snapshotBusy(snapshot) { if (snapshot.recoveryUnknown)
    return false; return (0, agent_screen_rules_1.screenIsBusy)(snapshot.rows, snapshot.agent); }
function snapshotStatus(snapshot) {
    if (snapshot.recoveryUnknown)
        return { waiting: null, composerSeen: false };
    let waiting = null, dialog;
    const pane = paneFromSnapshot(snapshot, (w, d) => { waiting = w; dialog = d; });
    scan(pane);
    // scan emits only edges; an evaluated active screen with no dialog is an explicit false too.
    if (waiting === null && (0, agent_screen_rules_1.evaluateScreen)(snapshot.rows, snapshot.agent) !== null)
        waiting = false;
    return { waiting, dialog, composerSeen: pane.composerSeen };
}
