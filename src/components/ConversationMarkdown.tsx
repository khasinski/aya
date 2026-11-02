import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { WorkspaceImage } from './WorkspaceImage';
const plugins = [remarkGfm];
function isSafeExternalHref(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}
export const ConversationMarkdown = memo(function ConversationMarkdown({ text, loadImage }: { text: string; loadImage: (path: string) => Promise<unknown> }) {
  const components = useMemo(() => ({
    img: ({ src, alt }: { src?: string; alt?: string }) => <WorkspaceImage path={String(src || '')} alt={alt || 'Image'} load={loadImage} />,
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
      isSafeExternalHref(href) ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            const aya = window.aya as (typeof window.aya & { openExternal?: (url: string) => Promise<void> }) | undefined;
            if (typeof aya?.openExternal === 'function') void aya.openExternal(href);
            else if (typeof aya?.openUrl === 'function') void aya.openUrl(href);
          }}
        >
          {children}
        </a>
      ) : (
        <span>{children}</span>
      ),
  }), [loadImage]);
  return <ReactMarkdown remarkPlugins={plugins} components={components}>{text}</ReactMarkdown>;
});
