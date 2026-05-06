// Thin wrapper around MarkdownEditorModal for commands.
// Owns the API calls (commands.get / commands.put / commands.delete).

import { useState, useEffect } from 'react';
import MarkdownEditorModal from './markdownLibrary/MarkdownEditorModal';
import { api } from '../../services/comfyui';

const COMMAND_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

const BODY_PLACEHOLDER =
  '---\ndescription: Summarise the conversation so far\nargument_hint: (optional topic)\n---\n\nPlease summarise the conversation so far, focusing on the key points.';

interface Props {
  open: boolean;
  onClose: () => void;
  editName?: string;
  onSaved: () => void;
  onDeleted: () => void;
}

export default function CommandEditorModal({ open, onClose, editName, onSaved, onDeleted }: Props) {
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
      api.commands.get(editName)
        .then(data => { setBody(data.body); })
        .catch(err => {
          setLoadError(err instanceof Error ? err.message : 'Could not load command');
          setBody('');
        })
        .finally(() => setLoading(false));
    } else {
      setName('');
      setBody('');
    }
  }, [open, editName]);

  const handleSave = async () => {
    await api.commands.put(name.trim(), body);
    onSaved();
  };

  const handleDelete = editName
    ? async () => {
        await api.commands.delete(editName);
        onDeleted();
      }
    : undefined;

  return (
    <MarkdownEditorModal
      open={open}
      onClose={onClose}
      mode={isEdit ? 'edit' : 'create'}
      noun="command"
      name={name}
      setName={setName}
      body={body}
      setBody={setBody}
      nameRegex={COMMAND_NAME_REGEX}
      namePlaceholder="summarise"
      bodyPlaceholder={BODY_PLACEHOLDER}
      loading={loading}
      loadError={loadError}
      onSave={handleSave}
      onDelete={handleDelete}
    />
  );
}
