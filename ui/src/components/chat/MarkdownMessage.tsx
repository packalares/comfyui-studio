import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

interface Props { text: string }

export default function MarkdownMessage({ text }: Props) {
  return (
    <div className="prose prose-sm max-w-none text-slate-800
                    prose-headings:font-semibold prose-headings:text-slate-900
                    prose-code:rounded prose-code:bg-slate-100 prose-code:px-1
                    prose-code:py-0.5 prose-code:font-mono prose-code:text-xs
                    prose-code:text-slate-800 prose-code:before:content-['']
                    prose-code:after:content-['']
                    prose-pre:rounded-lg prose-pre:bg-slate-900 prose-pre:text-slate-100
                    prose-a:text-blue-600">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
