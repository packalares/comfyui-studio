// Souls list section for the Settings > Souls tab.
// Fetches the list on mount, then opens SoulEditorModal for create / edit.
// Each row shows the soul name (bold) and description (muted). The
// default soul (from getDefaultSoul) gets a "default" badge so users can
// tell at a glance which soul new chats start with.

import { useState, useEffect, useCallback } from 'react';
import { Plus, RefreshCw, Pencil, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Button } from '../ui/button';
import { ButtonGroup } from '../ui/button-group';
import { Badge } from '../ui/badge';
import SoulEditorModal from './SoulEditorModal';
import { api } from '../../services/comfyui';

interface SoulRow {
  name: string;
  description: string;
}

export default function SoulsSection() {
  const [souls, setSouls] = useState<SoulRow[]>([]);
  const [defaultSoul, setDefaultSoul] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state — editName=undefined means create mode.
  const [modalOpen, setModalOpen] = useState(false);
  const [editName, setEditName] = useState<string | undefined>(undefined);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listResult, defaultResult] = await Promise.all([
        api.personality.listSouls(),
        api.personality.getDefaultSoul(),
      ]);
      setSouls(listResult.souls);
      setDefaultSoul(defaultResult.name);
    } catch (err) {
      setError('Could not load souls');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const openCreate = () => {
    setEditName(undefined);
    setModalOpen(true);
  };

  const openEdit = (name: string) => {
    setEditName(name);
    setModalOpen(true);
  };

  const handleClose = () => setModalOpen(false);

  // Both save and delete close the modal and refresh the list.
  const handleSaved = () => { void fetchData(); };
  const handleDeleted = () => { void fetchData(); };

  return (
    <>
      <Card>
        <CardHeader className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Sparkles className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
            <div>
              <h2 className="text-sm font-semibold text-foreground leading-tight">Souls</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Personality files loaded as the system prompt for each chat session.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!loading && souls.length > 0 && (
              <Badge variant="slate">
                <Sparkles className="h-3 w-3" />
                {souls.length} {souls.length === 1 ? 'soul' : 'souls'}
              </Badge>
            )}
            <ButtonGroup>
              <Button
                variant="secondary"
                onClick={() => void fetchData()}
                disabled={loading}
                aria-label="Refresh souls"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <Button onClick={openCreate}>
                <Plus className="h-3.5 w-3.5" />
                New soul
              </Button>
            </ButtonGroup>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
              ))}
            </div>
          ) : souls.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-muted/40 px-4 py-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Sparkles className="h-6 w-6" />
              </div>
              <p className="text-sm text-muted-foreground max-w-sm">
                No souls yet. Create one to give the assistant a persistent personality.
              </p>
              <Button onClick={openCreate}>
                <Plus className="h-3.5 w-3.5" />
                New soul
              </Button>
            </div>
          ) : (
            <div className="divide-y rounded-lg border overflow-hidden">
              {souls.map(soul => (
                <div
                  key={soul.name}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted transition-colors group"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground font-mono">
                        {soul.name}
                      </span>
                      {defaultSoul === soul.name && (
                        <Badge variant="slate">default</Badge>
                      )}
                    </div>
                    {soul.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground truncate">
                        {soul.description}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit soul ${soul.name}`}
                    onClick={() => openEdit(soul.name)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <SoulEditorModal
        open={modalOpen}
        onClose={handleClose}
        editName={editName}
        onSaved={handleSaved}
        onDeleted={handleDeleted}
      />
    </>
  );
}
