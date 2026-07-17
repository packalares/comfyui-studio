// Modal for creating and editing a Recipe.
// Title, notes, tag chips, and a LoRA list (add by filename + save_path).
//
// Uses the shared UI primitives (Button, Input, Badge, InputGroup, AppModal)
// rather than raw <input>/<button> + ad-hoc Tailwind so the modal matches the
// rest of Studio's design language. The tag input is a single InputGroup with
// the "+" addon rendered as a suffix inside the input. The LoRA list/form
// lives in RecipeEditorLoraSection so this file stays under the 250-line cap.

import { useState, useEffect, useCallback } from 'react';
import { X, Plus } from 'lucide-react';
import AppModal from './AppModal';
import RecipeEditorLoraSection from './RecipeEditorLoraSection';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '../ui/input-group';
import { Spinner } from '../ui/spinner';
import { Textarea } from '../ui/textarea';
import {
  createRecipe,
  updateRecipe,
  type Recipe,
  type NewRecipeInput,
  type LoraEntry,
} from '../../services/recipes';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** null = create mode, Recipe = edit mode */
  recipe: Recipe | null;
}

export default function RecipeEditorModal({ open, onClose, onSaved, recipe }: Props): JSX.Element {
  const isEdit = recipe !== null;

  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [loras, setLoras] = useState<LoraEntry[]>([]);
  const [loraFilename, setLoraFilename] = useState('');
  const [loraSavePath, setLoraSavePath] = useState('loras');
  const [loraStrength, setLoraStrength] = useState('1');
  const [busy, setBusy] = useState(false);

  // Populate fields when editing an existing recipe.
  useEffect(() => {
    if (!open) return;
    if (recipe) {
      setTitle(recipe.title);
      setNotes(recipe.notes ?? '');
      setTags(recipe.tags);
      setLoras(recipe.loras);
    } else {
      setTitle('');
      setNotes('');
      setTags([]);
      setLoras([]);
    }
    setTagInput('');
    setLoraFilename('');
    setLoraSavePath('loras');
    setLoraStrength('1');
  }, [open, recipe]);

  const addTag = useCallback(() => {
    const t = tagInput.trim();
    if (!t || tags.includes(t)) { setTagInput(''); return; }
    setTags((prev) => [...prev, t]);
    setTagInput('');
  }, [tagInput, tags]);

  const removeTag = useCallback((tag: string) => {
    setTags((prev) => prev.filter((t) => t !== tag));
  }, []);

  const addLora = useCallback(() => {
    const fn = loraFilename.trim();
    if (!fn) return;
    const strength = parseFloat(loraStrength);
    setLoras((prev) => [...prev, {
      filename: fn,
      save_path: loraSavePath.trim(),
      strength: isNaN(strength) ? 1 : strength,
    }]);
    setLoraFilename('');
    setLoraStrength('1');
  }, [loraFilename, loraSavePath, loraStrength]);

  const removeLora = useCallback((idx: number) => {
    setLoras((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSave = useCallback(async () => {
    if (!title.trim()) { toast.error('Title is required'); return; }
    if (loras.length === 0) { toast.error('At least one LoRA is required'); return; }
    setBusy(true);
    try {
      const input: NewRecipeInput = {
        title: title.trim(),
        notes: notes.trim() || undefined,
        tags,
        loras,
      };
      if (isEdit && recipe) {
        await updateRecipe(recipe.id, input);
        toast.success('Recipe updated');
      } else {
        await createRecipe(input);
        toast.success('Recipe created');
      }
      onSaved();
    } catch {
      toast.error('Failed to save recipe');
    } finally {
      setBusy(false);
    }
  }, [title, notes, tags, loras, isEdit, recipe, onSaved]);

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Recipe' : 'New Recipe'}
      size="md"
      scrollBody
      disableClose={busy}
      footer={
        <div className="flex w-full items-center justify-between">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={busy}>
            {busy ? <Spinner size="sm" /> : null}
            {isEdit ? 'Update' : 'Create'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Title */}
        <div>
          <label className="field-label mb-1 block">Title</label>
          <Input
            type="text"
            placeholder="My LoRA combo"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </div>

        {/* Notes */}
        <div>
          <label className="field-label mb-1 block">Notes</label>
          <Textarea
            placeholder="Usage notes (optional)"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {/* Tags */}
        <div>
          <label className="field-label mb-1 block">Tags</label>
          {tags.length > 0 && (
            <div className="flex gap-1.5 flex-wrap mb-1.5">
              {tags.map((tag) => (
                <Badge key={tag} variant="neutral" className="gap-1 pr-1.5">
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    aria-label={`Remove ${tag}`}
                    className="rounded-full hover:bg-foreground/10 -mr-0.5 p-0.5"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <InputGroup>
            <InputGroupInput
              type="text"
              placeholder="Add tag..."
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); addTag(); }
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                variant="ghost"
                size="icon-sm"
                onClick={addTag}
                aria-label="Add tag"
                disabled={!tagInput.trim()}
              >
                <Plus className="w-3.5 h-3.5" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>

        <RecipeEditorLoraSection
          loras={loras}
          filename={loraFilename}
          savePath={loraSavePath}
          strength={loraStrength}
          onFilenameChange={setLoraFilename}
          onSavePathChange={setLoraSavePath}
          onStrengthChange={setLoraStrength}
          onAdd={addLora}
          onRemove={removeLora}
        />
      </div>
    </AppModal>
  );
}
