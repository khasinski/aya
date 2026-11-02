import { useEffect, useRef, type RefObject } from 'react';

interface Options { enabled?: boolean; blocked?: boolean; resolveDialog?: () => HTMLElement | null; focusKey?: unknown }
interface Entry { dialog: () => HTMLElement | null; close: () => void; blocked: () => boolean }
const stack: Entry[] = [];
let pendingRestores = 0;
let restoredFocus: { element: HTMLElement; pane: HTMLElement | undefined } | null = null;
/** Terminal activation after closing an overlay must yield to its opener. */
export function modalWillRestoreFocus(pane?: Element | null) {
  return pendingRestores > 0 || !!(restoredFocus && restoredFocus.element === document.activeElement && restoredFocus.pane?.isConnected && restoredFocus.pane === pane);
}
const selector = 'a[href],button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
const items = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(selector)].filter(node => node.getClientRects().length && !node.closest('[inert],[aria-hidden="true"]'));
function top() { for (let i = stack.length - 1; i >= 0; i--) { const root = stack[i].dialog(); if (root?.isConnected && root.getClientRects().length) return stack[i]; } }
function focusFirst(root: HTMLElement) { if (!root.hasAttribute('tabindex')) root.tabIndex = -1; (items(root)[0] || root).focus(); }
function onKey(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  const entry = top(), root = entry?.dialog();
  if (!entry || !root) return;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopImmediatePropagation();
    if (!entry.blocked()) entry.close();
    return;
  }
  if (event.key !== 'Tab') return;
  const nodes = items(root), first = nodes[0], last = nodes.at(-1), active = document.activeElement;
  if (!first) { event.preventDefault(); focusFirst(root); }
  else if (event.shiftKey && (active === first || !root.contains(active))) { event.preventDefault(); last!.focus(); }
  else if (!event.shiftKey && (active === last || !root.contains(active))) { event.preventDefault(); first.focus(); }
}
function onFocus(event: FocusEvent) {
  const root = top()?.dialog();
  if (root && event.target instanceof Node && !root.contains(event.target)) focusFirst(root);
}
/** One keyboard/focus policy for nested modal variants. Only the topmost modal
 * handles Escape; blocked operations still consume it instead of leaking it. */
export function useModalFocus(root: RefObject<HTMLElement | null>, close: () => void, options: Options = {}) {
  const callbacks = useRef({ close, options }); callbacks.current = { close, options };
  const skipRestore = useRef(false);
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null);
  const enabled = options.enabled !== false;
  if (!enabled && typeof document !== 'undefined') opener.current = document.activeElement as HTMLElement | null;
  useEffect(() => {
    if (!enabled || !root.current) return;
    skipRestore.current = false;
    const entry: Entry = { dialog: () => callbacks.current.options.resolveDialog?.() || root.current, close: () => callbacks.current.close(), blocked: () => callbacks.current.options.blocked === true };
    if (!stack.length) { window.addEventListener('keydown', onKey, true); document.addEventListener('focusin', onFocus, true); }
    stack.push(entry);
    const dialog = entry.dialog(); if (dialog && !dialog.contains(document.activeElement)) focusFirst(dialog);
    const previous = opener.current;
    return () => {
      const index = stack.indexOf(entry); if (index >= 0) stack.splice(index, 1);
      if (!stack.length) { window.removeEventListener('keydown', onKey, true); document.removeEventListener('focusin', onFocus, true); }
      const restoring = !skipRestore.current && !callbacks.current.options.blocked && !!previous?.isConnected && !previous.hasAttribute('disabled');
      const panes = [...document.querySelectorAll<HTMLElement>('[data-testid="terminal-pane"]')].filter(pane => pane.getClientRects().length);
      const pane = panes.find(pane => pane.classList.contains('aya-pane--active-split')) || panes[0];
      if (restoring) pendingRestores++;
      requestAnimationFrame(() => {
        if (restoring) pendingRestores--;
        const next = top()?.dialog();
        if (restoring && previous?.isConnected && (!next || next.contains(previous))) { restoredFocus = { element: previous, pane }; previous.focus(); }
        else if (next && !next.contains(document.activeElement)) focusFirst(next);
      });
    };
  }, [root, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const dialog = callbacks.current.options.resolveDialog?.() || root.current;
    if (dialog && !dialog.contains(document.activeElement)) focusFirst(dialog);
  }, [root, enabled, options.focusKey]);
  // Selection/launch actions move focus to their destination, unlike dismissal.
  return () => { skipRestore.current = true; };
}
