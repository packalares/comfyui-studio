import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Terminal, ExternalLink } from 'lucide-react';
import { api } from '../../services/comfyui';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader } from '../ui/card';

/**
 * Small panel showing the currently configured pip index-url with a
 * shortcut to Settings for editing it.
 */
export default function PipSourceCard() {
  const navigate = useNavigate();
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getPipSource()
      .then((s) => {
        if (!cancelled) setSource(s.trim() || null);
      })
      .catch(() => {
        if (!cancelled) setSource(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardHeader className="flex items-center gap-2">
        <Terminal className="w-3.5 h-3.5 text-slate-400" />
        <div>
          <h2 className="text-sm font-semibold text-slate-900 leading-tight">pip source</h2>
          <p className="mt-0.5 text-[11px] text-slate-400">The index-url used by pip install.</p>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col md:flex-row md:items-center gap-3">
        <code className="flex-1 text-xs font-mono text-slate-700 bg-slate-50 ring-1 ring-inset ring-slate-200 rounded-md px-2.5 py-1.5 truncate">
          {loading ? 'Loading…' : source || 'https://pypi.org/simple'}
        </code>
        <Button
          onClick={() => navigate('/settings')}
          variant="secondary"
          className="shrink-0"
          title="Change the pip index-url in Settings"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Edit in Settings
        </Button>
      </CardContent>
    </Card>
  );
}
