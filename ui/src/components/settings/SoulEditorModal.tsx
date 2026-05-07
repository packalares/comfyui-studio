// Thin wrapper around MarkdownEditorModal for souls.
// Owns the personality API calls and threads the name + body field state.
// The generic modal owns all layout + validation.

import { useState, useEffect } from 'react';
import MarkdownEditorModal from './markdownLibrary/MarkdownEditorModal';
import { api } from '../../services/comfyui';

const SOUL_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

const BODY_PLACEHOLDER =
  '---\ndescription: A helpful assistant\n---\n\nYou are a helpful assistant.';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Pass the soul name to open in edit mode; omit for create mode. */
  editName?: string;
  onSaved: () => void;
  onDeleted: () => void;
}

export default function SoulEditorModal({ open, onClose, editName, onSaved, onDeleted }: Props) {
  const isEdit = Boolean(editName);

  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Seed the form whenever the modal opens. In edit mode fetch the current body.
  useEffect(() => {
    if (!open) return;
    setLoadError(null);
    if (editName) {
      setName(editName);
      setLoading(true);
      api.personality.get('soul', editName)
        .then(data => { setBody(data.body); })
        .catch(err => {
          setLoadError(err instanceof Error ? err.message : 'Could not load soul');
          setBody('');
        })
        .finally(() => setLoading(false));
    } else {
      setName('');
      setBody('');
    }
  }, [open, editName]);

  const handleSave = async () => {
    await api.personality.put('soul', name.trim(), body);
    onSaved();
  };

  const handleDelete = editName
    ? async () => {
        await api.personality.delete('soul', editName);
        onDeleted();
      }
    : undefined;

  return (
    <MarkdownEditorModal
      open={open}
      onClose={onClose}
      mode={isEdit ? 'edit' : 'create'}
      noun="soul"
      name={name}
      setName={setName}
      body={body}
      setBody={setBody}
      nameRegex={SOUL_NAME_REGEX}
      namePlaceholder="my-soul"
      bodyPlaceholder={BODY_PLACEHOLDER}
      loading={loading}
      loadError={loadError}
      onSave={handleSave}
      onDelete={handleDelete}
    />
  );
}
