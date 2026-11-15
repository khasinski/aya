import { useEffect, useRef, type ReactNode } from 'react';

/** A compact settings summary keeps the composer actions on one line. */
export function ComposerOptions({ open, onOpenChange, summary, active, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: string;
  active: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLElement>('select,input') ?? panel.current?.querySelector<HTMLElement>('button'))?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) onOpenChange(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault(); event.stopImmediatePropagation();
      onOpenChange(false); trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open, onOpenChange]);
  return <div className="aya-composer-options" ref={root} onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onOpenChange(false);
  }}>
    <button type="button" ref={trigger} className="aya-composer-options-trigger" aria-label={`Conversation settings: ${summary}`} aria-haspopup="dialog" aria-expanded={open} data-active={active || undefined} title={summary} onClick={() => onOpenChange(!open)}>
      <span className="aya-gui-icon" aria-hidden="true">tune</span><span className="aya-composer-options-summary">{summary}</span><span className="aya-composer-options-chevron" aria-hidden="true">⌃</span>
    </button>
    {open && <div ref={panel} className="aya-composer-options-panel" role="dialog" aria-label="Conversation settings">
      <div className="aya-composer-options-heading"><strong>Conversation settings</strong><button type="button" aria-label="Close conversation settings" onClick={() => { onOpenChange(false); trigger.current?.focus(); }}>×</button></div>
      {children}
      <small>Changes apply to the next turn.</small>
    </div>}
  </div>;
}
