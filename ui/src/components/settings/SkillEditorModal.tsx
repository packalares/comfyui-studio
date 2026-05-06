// Thin wrapper around MarkdownEditorModal for skills.
// Owns the API calls (skills.get / skills.put / skills.delete).

import { useState, useEffect } from 'react';
import MarkdownEditorModal from './markdownLibrary/MarkdownEditorModal';
import { api } from '../../services/comfyui';

const SKILL_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

const BODY_PLACEHOLDER =
  '---\ndescription: Explain a concept step by step\n---\n\nWhen using this skill, break down the topic into clear numbered steps.';

interface Props {
  open: boolean;
  onClose: () => void;
  editName?: string;
  onSaved: () => void;
  onDeleted: () => void;
}

export default function SkillEditorModal({ open, onClose, editName, onSaved, onDeleted }: Props) {
  const isEdit = Boolean(editName);

  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoadError(null);
    if (editName) {
      setName(editName);
      setLoading(true);
      api.skills.get(editName)
        .then(data => { setBody(data.body); })
        .catch(err => {
          setLoadError(err instanceof Error ? err.message : 'Could not load skill');
          setBody('');
        })
        .finally(() => setLoading(false));
    } else {
      setName('');
      setBody('');
    }
  }, [open, editName]);

  const handleSave = async () => {
    await api.skills.put(name.trim(), body);
    onSaved();
  };

  const handleDelete = editName
    ? async () => {
        await api.skills.delete(editName);
        onDeleted();
      }
    : undefined;

  return (
    <MarkdownEditorModal
      open={open}
      onClose={onClose}
      mode={isEdit ? 'edit' : 'create'}
      noun="skill"
      name={name}
      setName={setName}
      body={body}
      setBody={setBody}
      nameRegex={SKILL_NAME_REGEX}
      namePlaceholder="step-by-step"
      bodyPlaceholder={BODY_PLACEHOLDER}
      loading={loading}
      loadError={loadError}
      onSave={handleSave}
      onDelete={handleDelete}
    />
  );
}
