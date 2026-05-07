// Souls list section for the Settings > Souls tab.
// Thin specialisation of MarkdownLibrarySection. The default soul gets a badge.
// Reads souls + defaultSoul from the shared system context (already hydrated
// from /api/system on app boot); mutations trigger refreshSystem.

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Badge } from '../ui/badge';
import MarkdownLibrarySection from './markdownLibrary/MarkdownLibrarySection';
import SoulEditorModal from './SoulEditorModal';
import PendingEditsCard from './PendingEditsCard';
import { useApp, useSystem } from '../../context/AppContext';

export default function SoulsSection() {
  const { personality } = useSystem();
  const { refreshSystem } = useApp();

  const [modalOpen, setModalOpen] = useState(false);
  const [editName, setEditName] = useState<string | undefined>(undefined);

  const souls = personality?.souls ?? [];
  const defaultSoul = personality?.defaultSoul ?? null;
  const loading = personality === null;

  return (
    <>
      <MarkdownLibrarySection
        title="Souls"
        description="Personality files loaded as the system prompt for each chat session."
        icon={Sparkles}
        badgeIcon={Sparkles}
        noun="soul"
        error={null}
        loading={loading}
        items={souls}
        onRefresh={() => void refreshSystem()}
        onCreate={() => { setEditName(undefined); setModalOpen(true); }}
        onEdit={(name) => { setEditName(name); setModalOpen(true); }}
        itemBadge={(item) =>
          defaultSoul === item.name ? <Badge variant="slate">default</Badge> : null
        }
        above={<PendingEditsCard onSoulChanged={() => void refreshSystem()} />}
      />

      <SoulEditorModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editName={editName}
        onSaved={() => void refreshSystem()}
        onDeleted={() => void refreshSystem()}
      />
    </>
  );
}
