// Memory section for the Settings > Souls tab.
// Loads the assistant's memory on mount and allows the user to edit and save
// it. The memory persists across all chats and souls — it's always injected
// alongside the active soul's system prompt.
// Inline "Saved" indicator instead of a toast so the card reads as
// self-contained (same pattern as SecretsCard in Settings.tsx).

import { useState, useEffect, useCallback } from 'react';
import { Save, Check, BrainCog } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card';
import { Button } from '../ui/button';
import { api } from '../../services/comfyui';

export default function MemorySection() {
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const fetchMemory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.personality.getMemory();
      setBody(data.body);
    } catch (err) {
      setError('Could not load memory');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchMemory(); }, [fetchMemory]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.personality.putMemory(body);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      toast.error('Failed to save memory', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <BrainCog className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
          <div>
            <h2 className="text-sm font-semibold text-foreground leading-tight">Memory</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              What the assistant remembers about you. Persists across all chats and souls.
            </p>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {error && (
          <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="h-40 rounded-lg bg-muted animate-pulse" />
        ) : (
          <textarea
            className="field-textarea w-full min-h-[160px]"
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder={'The user prefers concise answers.\nThey are working on a TypeScript project.\n...'}
            disabled={saving}
            spellCheck={false}
          />
        )}
      </CardContent>

      <CardFooter>
        <p className="text-xs text-muted-foreground">
          {saved
            ? 'Memory saved successfully.'
            : 'Injected into every conversation alongside the active soul.'}
        </p>
        <Button onClick={() => void handleSave()} disabled={saving || loading}>
          {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
          {saved ? 'Saved' : 'Save'}
        </Button>
      </CardFooter>
    </Card>
  );
}
