// Skills list section — thin specialisation of MarkdownLibrarySection.
// Skills are reusable instruction blocks the model can apply on request.
// Reads from the shared system context; mutations refresh /api/system.

import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import MarkdownLibrarySection from './markdownLibrary/MarkdownLibrarySection';
import SkillEditorModal from './SkillEditorModal';
import { useApp, useSystem } from '../../context/AppContext';

export default function SkillsSection() {
  const { personality } = useSystem();
  const { refreshSystem } = useApp();

  const [modalOpen, setModalOpen] = useState(false);
  const [editName, setEditName] = useState<string | undefined>(undefined);

  const skills = personality?.skills ?? [];
  const loading = personality === null;

  return (
    <>
      <MarkdownLibrarySection
        title="Skills"
        description="Reusable instruction blocks the model can apply on request."
        icon={BookOpen}
        badgeIcon={BookOpen}
        noun="skill"
        error={null}
        loading={loading}
        items={skills}
        onRefresh={() => void refreshSystem()}
        onCreate={() => { setEditName(undefined); setModalOpen(true); }}
        onEdit={(name) => { setEditName(name); setModalOpen(true); }}
      />

      <SkillEditorModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editName={editName}
        onSaved={() => void refreshSystem()}
        onDeleted={() => void refreshSystem()}
      />
    </>
  );
}
