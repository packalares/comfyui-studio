import { type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import AppModal from './AppModal';

interface CivitaiMetaShape {
  originalUrl?: string;
  modelId?: number;
  description?: string;
  tags?: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  tags?: string[];
  models?: string[];
  civitaiMeta?: CivitaiMetaShape;
  extras?: ReactNode;
}

// Allow-list of HTML tags we'll render for civitai descriptions. Anything
// outside this set is stripped; attributes on every tag are removed except
// `href` on anchors. This is NOT a full sanitizer — it's a conservative
// allow-list suited to the narrow shape civitai posts (prose, lists, links).
const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'a',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

function sanitizeHtml(raw: string): string {
  // Strip script/style/iframe bodies entirely.
  let s = raw.replace(/<(script|style|iframe)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Rewrite every tag, filtering attributes.
  s = s.replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi, (match, tag: string, attrs: string) => {
    const name = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    const isClosing = match.startsWith('</');
    if (isClosing) return `</${name}>`;
    if (name === 'a') {
      // Preserve href only if it's http(s) or a safe anchor fragment.
      const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
      if (/^(https?:)?\/\//i.test(url) || url.startsWith('#')) {
        const safe = url.replace(/"/g, '%22');
        return `<a href="${safe}" target="_blank" rel="noopener noreferrer">`;
      }
      return '<a>';
    }
    return `<${name}>`;
  });
  return s.trim();
}

function hasHtmlTags(s: string): boolean {
  return /<[a-z][\s\S]*?>/i.test(s);
}

/**
 * Read-only details dialog used by both the Studio TemplateCard and the
 * CivitaiTemplateCard. Visual language mirrors `ImportWorkflowModal`
 * (`.panel`-style shell + backdrop click-to-close + X in header — now
 * provided by `AppModal`).
 */
export default function DescriptionModal(props: Props): JSX.Element | null {
  const { open, onClose, title, description, tags, models, civitaiMeta, extras } = props;

  if (!open) return null;

  // Prefer civitaiMeta.description when both are the same (civitai cards pass
  // item.description as BOTH top-level and civitaiMeta.description — dedup
  // here so we render it once). Otherwise keep both.
  const topDesc = description ?? '';
  const civDesc = civitaiMeta?.description ?? '';
  const topDescDup = topDesc.length > 0 && topDesc === civDesc;
  const showTopDesc = topDesc.length > 0 && !topDescDup;
  const civitaiLink = civitaiMeta?.originalUrl
    ?? (civitaiMeta?.modelId ? `https://civitai.com/models/${civitaiMeta.modelId}` : undefined);

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title={title}
      subtitle="Template details"
      size="md"
    >
      <div className="space-y-4">
        {showTopDesc && (
          <section>
            <h3 className="field-label mb-1.5">Description</h3>
            {hasHtmlTags(topDesc) ? (
              <div
                className="text-xs text-slate-700 break-words prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(topDesc) }}
              />
            ) : (
              <p className="text-xs text-slate-700 whitespace-pre-wrap break-words">
                {topDesc}
              </p>
            )}
          </section>
        )}

        {tags && tags.length > 0 && (
          <section>
            <h3 className="field-label mb-1.5">Tags</h3>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span key={tag} className="badge-pill badge-slate">
                  {tag}
                </span>
              ))}
            </div>
          </section>
        )}

        {models && models.length > 0 && (
          <section>
            <h3 className="field-label mb-1.5">Models</h3>
            <pre className="text-[11px] font-mono text-slate-700 bg-slate-50 ring-1 ring-inset ring-slate-200 rounded-md px-3 py-2 whitespace-pre-wrap break-all">
              {models.join('\n')}
            </pre>
          </section>
        )}

        {civitaiMeta && (civDesc || civitaiMeta.tags?.length || civitaiLink) && (
          <section className="rounded-lg border border-teal-200 bg-teal-50/60 p-3">
            <h3 className="field-label text-teal-700 mb-1.5">CivitAI</h3>
            {civDesc && (
              hasHtmlTags(civDesc) ? (
                <div
                  className="text-xs text-slate-700 break-words prose prose-sm max-w-none mb-2"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(civDesc) }}
                />
              ) : (
                <p className="text-xs text-slate-700 whitespace-pre-wrap break-words mb-2">
                  {civDesc}
                </p>
              )
            )}
            {civitaiMeta.tags && civitaiMeta.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {civitaiMeta.tags.map((tag) => (
                  <span key={`civ-${tag}`} className="badge-pill badge-teal">
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {civitaiLink && (
              <a
                href={civitaiLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-teal-700 hover:text-teal-800 underline"
              >
                <ExternalLink className="w-3 h-3" />
                Open on CivitAI
              </a>
            )}
          </section>
        )}

        {!topDesc && !civDesc && (!tags || tags.length === 0) && (!models || models.length === 0) && !civitaiMeta && (
          <div className="empty-box">No details available.</div>
        )}

        {extras}
      </div>
    </AppModal>
  );
}
