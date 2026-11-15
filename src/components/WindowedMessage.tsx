import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

interface WindowObserver { observer: IntersectionObserver; callbacks: Map<Element, (visible: boolean) => void> }
const observers = new WeakMap<Element, WindowObserver>();
function observe(root: Element, node: Element, receive: (visible: boolean) => void) {
  let entry = observers.get(root);
  if (!entry) {
    const callbacks = new Map<Element, (visible: boolean) => void>();
    entry = { callbacks, observer: new IntersectionObserver(entries => {
      for (const item of entries) callbacks.get(item.target)?.(item.isIntersecting);
    }, { root, rootMargin: '1000px 0px' }) };
    observers.set(root, entry);
  }
  entry.callbacks.set(node, receive); entry.observer.observe(node);
  return () => {
    entry.callbacks.delete(node); entry.observer.unobserve(node);
    if (!entry.callbacks.size) { entry.observer.disconnect(); observers.delete(root); }
  };
}

/** Retain cheap height anchors, mounting Markdown only near the viewport.
 * Questions stay mounted so unsent form answers survive scrolling. Find mode
 * mounts the full text so existing browser Range-based search remains exact. */
export const WindowedMessage = memo(function WindowedMessage({ children, viewport, estimate, initiallyVisible, keepMounted, findOpen }: {
  children: ReactNode;
  viewport: RefObject<HTMLDivElement | null>;
  estimate: number;
  initiallyVisible: boolean;
  keepMounted: boolean;
  findOpen: boolean;
}) {
  const node = useRef<HTMLDivElement>(null);
  const measured = useRef<number | null>(null);
  const [visible, setVisible] = useState(initiallyVisible);
  const mounted = visible || keepMounted || findOpen;
  useEffect(() => {
    const root = viewport.current, element = node.current;
    if (!root || !element) return;
    return observe(root, element, next => {
      if (!next) {
        // Never remove focused controls or the user's selected quote.
        const selection = window.getSelection();
        if (element.contains(document.activeElement) || (selection && !selection.isCollapsed && selection.containsNode(element, true))) return;
      }
      setVisible(next);
    });
  }, [viewport]);
  useLayoutEffect(() => {
    const element = node.current;
    if (!mounted || !element) return;
    const measure = () => { const height = element.getBoundingClientRect().height; if (height > 0) measured.current = height; };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [mounted, children]);
  return <div ref={node} className="aya-message-window" style={mounted ? { display: 'flow-root' } : { height: measured.current ?? estimate }} data-windowed={!mounted || undefined}>
    {mounted ? children : null}
  </div>;
});
