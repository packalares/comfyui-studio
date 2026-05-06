// Souls list section for the Settings > Souls tab.
// Thin specialisation of MarkdownLibrarySection. The default soul gets a badge.
// Fetches the list and default-soul name on mount; delegates layout to the
// generic component so this file stays ~80 lines.

import { useState, useEffect, useCallback } from 'react';
import { Sparkles } from 'lucide-react';
import { Badge } from '../ui/badge';
import MarkdownLibrarySection from './markdownLibrary/MarkdownLibrarySection';
import SoulEditorModal from './SoulEditorModal';
import PendingEditsCard from './PendingEditsCard';
import { api } from '../../services/comfyui';
import type { LibraryItem } from './markdownLibrary/types';

export default function SoulsSection() {
  const [souls, setSouls] = useState<LibraryItem[]>([]);
  const [defaultSoul, setDefaultSoul] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <>
      <MarkdownLibrarySection
        title="Souls"
        description="Personality files loaded as the system prompt for each chat session."
        icon={Sparkles}
        badgeIcon={Sparkles}
        noun="soul"
        error={error}
        loading={loading}
        items={souls}
        onRefresh={() => void fetchData()}
        onCreate={() => { setEditName(undefined); setModalOpen(true); }}
        onEdit={(name) => { setEditName(name); setModalOpen(true); }}
        itemBadge={(item) =>
          defaultSoul === item.name ? <Badge variant="slate">default</Badge> : null
        }
        above={<PendingEditsCard onSoulChanged={fetchData} />}
      />

      <SoulEditorModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editName={editName}
        onSaved={() => void fetchData()}
        onDeleted={() => void fetchData()}
      />
    </>
  );
}
