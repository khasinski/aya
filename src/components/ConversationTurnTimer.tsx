import { memo, useEffect, useRef, useState } from 'react';
import { formatElapsed } from '../gui-status';

/** The clock never invalidates the conversation tree and sleeps when not visible. */
export const ConversationTurnTimer = memo(function ConversationTurnTimer({ busy, hidden }: { busy: boolean; hidden: boolean }) {
  const started = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (!busy) {
      if (started.current !== null) setElapsed(Date.now() - started.current);
      started.current = null;
      return;
    }
    started.current ??= Date.now();
    let timer: ReturnType<typeof setInterval> | null = null;
    const refresh = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (hidden || document.visibilityState === 'hidden') return;
      const tick = () => setElapsed(Date.now() - started.current!);
      tick(); timer = setInterval(tick, 1000);
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => { if (timer !== null) clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [busy, hidden]);
  return elapsed === null ? null : <span className="aya-gui-turn-timer" aria-hidden="true">{busy ? 'Working' : 'Worked'} for {formatElapsed(elapsed)}</span>;
});
