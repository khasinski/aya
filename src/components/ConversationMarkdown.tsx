import { isValidElement, memo, useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { workspaceLink } from '../../shared/workspace-link.cjs';
import { useWorkspaceFileLink } from './WorkspaceFileLinks';
import { WorkspaceImage } from './WorkspaceImage';
import { ConversationCodeBlock } from './ConversationCodeBlock';
import { ConversationDiagram } from './ConversationDiagram';
import { isInlineImage } from '../conversation-images';
const plugins = [remarkGfm];
function isSafeExternalHref(href: string | undefined): boolean {
  if (!href) return false;
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}
export const ConversationMarkdown = memo(function ConversationMarkdown({ text, loadImage }: { text: string; loadImage: (path: string) => Promise<unknown> }) {
  const openFile = useWorkspaceFileLink();
  const components = useMemo(() => ({
    img: ({ src, alt }: { src?: string; alt?: string }) => <WorkspaceImage path={src || ''} alt={alt || 'Image'} load={loadImage} />,
    pre: ({ children }: { children?: ReactNode }) => {
      if (!isValidElement<{ children?: ReactNode; className?: string }>(children)) return <pre>{children}</pre>;
      const source = String(children.props.children ?? '').replace(/\n$/, '');
      const language = /(?:^|\s)language-([^\s]+)/.exec(children.props.className || '')?.[1] || '';
      return language.toLowerCase() === 'mermaid' ? <ConversationDiagram source={source} /> : <ConversationCodeBlock source={source} language={language} />;
    },
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      if (href && isSafeExternalHref(href)) return (
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
      );
      const local = href && workspaceLink(href);
      const label = Array.isArray(children) && children.length === 1 ? children[0] : children;
      if (href && local && typeof label === 'string' && /\.(?:png|jpe?g|webp|gif|svg)$/i.test(local.path)) {
        return <span>{label}<WorkspaceImage path={href} alt={label || 'Image'} load={loadImage} /></span>;
      }
      return href && local && openFile ? <a href={href} onClick={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); openFile(href); }}>{children}</a> : <span>{children}</span>;
    },
  }), [loadImage, openFile]);
  return <ReactMarkdown urlTransform={(url, key) => isSafeExternalHref(url) || workspaceLink(url) || (key === 'src' && isInlineImage(url)) ? url : ''} remarkPlugins={plugins} components={components}>{text}</ReactMarkdown>;
});
