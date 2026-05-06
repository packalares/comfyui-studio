// Commands list section — thin specialisation of MarkdownLibrarySection.
// Commands are slash-triggered shortcuts available in the chat composer.

import { useState, useEffect, useCallback } from 'react';
import { SlashSquare } from 'lucide-react';
import MarkdownLibrarySection from './markdownLibrary/MarkdownLibrarySection';
import CommandEditorModal from './CommandEditorModal';
import { api } from '../../services/comfyui';
import type { LibraryItem } from './markdownLibrary/types';

export default function CommandsSection() {
  const [commands, setCommands] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editName, setEditName] = useState<string | undefined>(undefined);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.commands.list();
      setCommands(result.commands);
    } catch (err) {
      setError('Could not load commands');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  return (
    <>
      <MarkdownLibrarySection
        title="Commands"
        description="Slash-triggered shortcuts available in the chat composer (type / to invoke)."
        icon={SlashSquare}
        badgeIcon={SlashSquare}
        noun="command"
        error={error}
        loading={loading}
        items={commands}
        onRefresh={() => void fetchData()}
        onCreate={() => { setEditName(undefined); setModalOpen(true); }}
        onEdit={(name) => { setEditName(name); setModalOpen(true); }}
      />

      <CommandEditorModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editName={editName}
        onSaved={() => void fetchData()}
        onDeleted={() => void fetchData()}
      />
    </>
  );
}
