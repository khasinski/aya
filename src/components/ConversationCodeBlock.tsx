import { memo, useEffect, useMemo, useState } from 'react';
import hljs, { EXT_TO_LANGUAGE } from '../syntax-highlight';

/** Language names and file extensions both work (js, tsx, py, sh, …). */
export const ConversationCodeBlock = memo(function ConversationCodeBlock({ source, language = '' }: { source: string; language?: string }) {
  const [copyState, setCopyState] = useState('Copy');
  useEffect(() => {
    setCopyState('Copy');
  }, [source]);
  useEffect(() => {
    if (copyState === 'Copy') return;
    const timer = setTimeout(() => setCopyState('Copy'), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);
  const highlighted = useMemo(() => {
    const name = EXT_TO_LANGUAGE[language.toLowerCase()] || language.toLowerCase();
    // Huge outputs stay selectable without blocking the UI on tokenization.
    if (!name || !hljs.getLanguage(name) || source.length > 100_000) return null;
    try { return hljs.highlight(source, { language: name, ignoreIllegals: true }).value; }
    catch { return null; }
  }, [source, language]);
  return <div className="aya-chat-code">
    <div className="aya-chat-block-toolbar"><span>{language || 'text'}</span><button type="button" aria-label="Copy code" onClick={() => {
      void navigator.clipboard.writeText(source).then(() => setCopyState('Copied'), () => setCopyState('Copy failed'));
    }}>{copyState}</button></div>
    <pre>{highlighted === null ? <code>{source}</code> : <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />}</pre>
  </div>;
});
