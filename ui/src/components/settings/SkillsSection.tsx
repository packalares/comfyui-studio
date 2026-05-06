// Skills list section — thin specialisation of MarkdownLibrarySection.
// Skills are reusable instruction blocks the model can invoke by name.

import { useState, useEffect, useCallback } from 'react';
import { BookOpen } from 'lucide-react';
import MarkdownLibrarySection from './markdownLibrary/MarkdownLibrarySection';
import SkillEditorModal from './SkillEditorModal';
import { api } from '../../services/comfyui';
import type { LibraryItem } from './markdownLibrary/types';

export default function SkillsSection() {
  const [skills, setSkills] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editName, setEditName] = useState<string | undefined>(undefined);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.skills.list();
      setSkills(result.skills);
    } catch (err) {
      setError('Could not load skills');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  return (
    <>
      <MarkdownLibrarySection
        title="Skills"
        description="Reusable instruction blocks the model can apply on request."
        icon={BookOpen}
        badgeIcon={BookOpen}
        noun="skill"
        error={error}
        loading={loading}
        items={skills}
        onRefresh={() => void fetchData()}
        onCreate={() => { setEditName(undefined); setModalOpen(true); }}
        onEdit={(name) => { setEditName(name); setModalOpen(true); }}
      />

      <SkillEditorModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editName={editName}
        onSaved={() => void fetchData()}
        onDeleted={() => void fetchData()}
      />
    </>
  );
}
