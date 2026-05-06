// Modal for creating or editing a single soul.
// In edit mode the soul name field is locked — renames would orphan the old
// file on the backend; users should delete and recreate instead.
// Validation: name must match ^[a-z0-9][a-z0-9-]*$ (lowercase slug) so it
// doubles as a safe filename on the server side.

import { useState, useEffect } from 'react';
import { Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import AppModal from '../modals/AppModal';
import { Button } from '../ui/button';
import ConfirmDialog from '../modals/ConfirmDialog';
import { api } from '../../services/comfyui';

const SOUL_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

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
  const [nameError, setNameError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Seed the form whenever the modal opens. In edit mode we fetch the current
  // body from the API so the user always edits the live server state.
  useEffect(() => {
    if (!open) return;
    setNameError(null);
    setLoadError(null);
    if (editName) {
      setName(editName);
      setLoading(true);
      api.personality.getSoul(editName)
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

  const handleNameChange = (v: string) => {
    setName(v);
    if (nameError) setNameError(null);
  };

  const validate = (): boolean => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('Name is required');
      return false;
    }
    if (!SOUL_NAME_REGEX.test(trimmed)) {
      setNameError('Only lowercase letters, digits, and hyphens. Must start with a letter or digit.');
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setBusy(true);
    try {
      await api.personality.putSoul(name.trim(), body);
      toast.success(isEdit ? 'Soul updated' : 'Soul created');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(isEdit ? 'Failed to update soul' : 'Failed to create soul', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!editName) return;
    try {
      await api.personality.deleteSoul(editName);
      toast.success('Soul deleted');
      setConfirmDelete(false);
      onDeleted();
      onClose();
    } catch (err) {
      toast.error('Failed to delete soul', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const canSave = !busy && !loading && SOUL_NAME_REGEX.test(name.trim());

  return (
    <>
      <AppModal
        open={open}
        onClose={onClose}
        title={isEdit ? `Edit soul: ${editName}` : 'New soul'}
        size="md"
        scrollBody={false}
        disableClose={busy}
        footer={
          <div className="flex w-full items-center justify-between">
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={onClose} disabled={busy}>
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
              {isEdit && (
                <Button
                  variant="destructive"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              )}
            </div>
            <Button onClick={() => void handleSave()} disabled={!canSave}>
              <Save className="h-3.5 w-3.5" />
              Save
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {loadError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
              <p className="text-xs text-destructive">{loadError}</p>
            </div>
          )}

          {/* Name field — locked in edit mode because renaming would orphan
              the server file; the user must delete and recreate instead. */}
          <div>
            <label className="field-label mb-1 block">
              Name <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              className={`field-input w-full rounded-md border px-2.5 py-1.5 text-sm ${nameError ? 'border-destructive' : 'border-input'}`}
              value={name}
              onChange={e => handleNameChange(e.target.value)}
              placeholder="my-soul"
              disabled={busy || loading || isEdit}
              spellCheck={false}
              autoFocus={!isEdit}
            />
            {nameError && (
              <p className="mt-1 text-xs text-destructive">{nameError}</p>
            )}
            {!nameError && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Lowercase letters, digits, and hyphens only (e.g. <code>helpful-coder</code>).
              </p>
            )}
          </div>

          {/* Body textarea */}
          <div>
            <label className="field-label mb-1 block">Body</label>
            {loading ? (
              <div className="h-40 rounded-lg bg-muted animate-pulse" />
            ) : (
              <textarea
                className="field-textarea w-full min-h-[200px] font-mono text-sm"
                value={body}
                onChange={e => setBody(e.target.value)}
                placeholder={'---\ndescription: A helpful assistant\n---\n\nYou are a helpful assistant.'}
                disabled={busy}
                spellCheck={false}
              />
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">
              Markdown. Optional <code>---</code> frontmatter block at the top for metadata (description, tags, etc.).
            </p>
          </div>
        </div>
      </AppModal>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete "${editName}"?`}
        description="The soul file will be permanently removed from the server. This cannot be undone."
        confirmLabel="Delete"
        confirmTone="danger"
        onConfirm={handleDelete}
      />
    </>
  );
}
