// Generic modal for creating or editing a single markdown-backed library item
// (soul, skill, or command). Replicates SoulEditorModal's layout:
//   - Name field (locked in edit mode because renames orphan server files)
//   - Body textarea (font-mono, frontmatter hint in placeholder)
//   - Cancel / Delete / Save footer
//   - ConfirmDialog for destructive delete
//
// Callers supply the save/delete callbacks and any entity-specific strings.

import { useState, useEffect, type ReactNode } from 'react';
import { Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import AppModal from '../../modals/AppModal';
import { Button } from '../../ui/button';
import ConfirmDialog from '../../modals/ConfirmDialog';

export interface MarkdownEditorModalProps {
  open: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  /** The human-readable noun for toasts ("soul", "skill", "command"). */
  noun: string;
  /** Name of the item being edited. In create mode, this is the typed value. */
  name: string;
  setName: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
  /** Validate the name field. Return error string or null. */
  nameRegex: RegExp;
  /** Placeholder for the name input (e.g. "my-soul"). */
  namePlaceholder: string;
  /** Hint shown under the body textarea. */
  frontmatterHint?: ReactNode;
  /** Placeholder for the body textarea. */
  bodyPlaceholder: string;
  /** True while the modal is fetching the existing body from the API. */
  loading: boolean;
  /** Optional API load error to surface in the modal. */
  loadError: string | null;
  onSave: () => Promise<void>;
  /** When omitted the delete button is hidden. */
  onDelete?: () => Promise<void>;
}

export default function MarkdownEditorModal({
  open,
  onClose,
  mode,
  noun,
  name,
  setName,
  body,
  setBody,
  nameRegex,
  namePlaceholder,
  frontmatterHint,
  bodyPlaceholder,
  loading,
  loadError,
  onSave,
  onDelete,
}: MarkdownEditorModalProps) {
  const isEdit = mode === 'edit';
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Clear validation state each time the modal opens.
  useEffect(() => {
    if (open) setNameError(null);
  }, [open]);

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
    if (!nameRegex.test(trimmed)) {
      setNameError('Only lowercase letters, digits, and hyphens. Must start with a letter or digit.');
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setBusy(true);
    try {
      await onSave();
      toast.success(isEdit ? `${noun} updated` : `${noun} created`);
      onClose();
    } catch (err) {
      toast.error(isEdit ? `Failed to update ${noun}` : `Failed to create ${noun}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    try {
      await onDelete();
      toast.success(`${noun} deleted`);
      setConfirmDelete(false);
      onClose();
    } catch (err) {
      toast.error(`Failed to delete ${noun}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Capitalise for the title.
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const canSave = !busy && !loading && nameRegex.test(name.trim());

  return (
    <>
      <AppModal
        open={open}
        onClose={onClose}
        title={isEdit ? `Edit ${noun}: ${name}` : `New ${Noun}`}
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
              {isEdit && onDelete && (
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
              placeholder={namePlaceholder}
              disabled={busy || loading || isEdit}
              spellCheck={false}
              autoFocus={!isEdit}
            />
            {nameError && (
              <p className="mt-1 text-xs text-destructive">{nameError}</p>
            )}
            {!nameError && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Lowercase letters, digits, and hyphens only (e.g. <code>{namePlaceholder}</code>).
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
                placeholder={bodyPlaceholder}
                disabled={busy}
                spellCheck={false}
              />
            )}
            {frontmatterHint ?? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Markdown. Optional <code>---</code> frontmatter block at the top for metadata.
              </p>
            )}
          </div>
        </div>
      </AppModal>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete "${name}"?`}
        description={`The ${noun} file will be permanently removed from the server. This cannot be undone.`}
        confirmLabel="Delete"
        confirmTone="danger"
        onConfirm={handleDelete}
      />
    </>
  );
}
