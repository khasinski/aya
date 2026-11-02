import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { WorkspaceImage } from './WorkspaceImage';
const plugins = [remarkGfm];
export const ConversationMarkdown = memo(function ConversationMarkdown({ text, loadImage }: { text: string; loadImage: (path: string) => Promise<unknown> }) {
  const components = useMemo(() => ({
    img: ({ src, alt }: { src?: string; alt?: string }) => <WorkspaceImage path={String(src || '')} alt={alt || 'Image'} load={loadImage} />,
    a: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  }), [loadImage]);
  return <ReactMarkdown remarkPlugins={plugins} components={components}>{text}</ReactMarkdown>;
});
