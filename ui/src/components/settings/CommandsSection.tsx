// Commands list section — thin specialisation of MarkdownLibrarySection.
// Commands are slash-triggered shortcuts available in the chat composer.
// Reads from the shared system context; mutations refresh /api/system.

import { useState } from 'react';
import { SlashSquare } from 'lucide-react';
import MarkdownLibrarySection from './markdownLibrary/MarkdownLibrarySection';
import CommandEditorModal from './CommandEditorModal';
import { useApp, useSystem } from '../../context/AppContext';

export default function CommandsSection() {
  const { personality } = useSystem();
  const { refreshSystem } = useApp();

  const [modalOpen, setModalOpen] = useState(false);
  const [editName, setEditName] = useState<string | undefined>(undefined);

  const commands = personality?.commands ?? [];
  const loading = personality === null;

  return (
    <>
      <MarkdownLibrarySection
        title="Commands"
        description="Slash-triggered shortcuts available in the chat composer (type / to invoke)."
        icon={SlashSquare}
        badgeIcon={SlashSquare}
        noun="command"
        error={null}
        loading={loading}
        items={commands}
        onRefresh={() => void refreshSystem()}
        onCreate={() => { setEditName(undefined); setModalOpen(true); }}
        onEdit={(name) => { setEditName(name); setModalOpen(true); }}
      />

      <CommandEditorModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editName={editName}
        onSaved={() => void refreshSystem()}
        onDeleted={() => void refreshSystem()}
      />
    </>
  );
}
