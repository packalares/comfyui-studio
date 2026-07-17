// LoRA list + "add new" row for RecipeEditorModal. Extracted so the editor
// modal stays under the 250-line cap. The state is owned by the parent and
// passed in via props — this component is purely presentational.

import { Plus, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { LoraEntry } from '../../services/recipes';

interface Props {
  loras: LoraEntry[];
  filename: string;
  savePath: string;
  strength: string;
  onFilenameChange: (v: string) => void;
  onSavePathChange: (v: string) => void;
  onStrengthChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
}

export default function RecipeEditorLoraSection({
  loras,
  filename,
  savePath,
  strength,
  onFilenameChange,
  onSavePathChange,
  onStrengthChange,
  onAdd,
  onRemove,
}: Props): JSX.Element {
  return (
    <div>
      <label className="field-label mb-1 block">LoRAs</label>
      {loras.length > 0 && (
        <div className="divide-y mb-2 rounded-md border">
          {loras.map((l, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className="flex-1 font-mono truncate">{l.filename}</span>
              <span className="text-muted-foreground">{l.save_path}</span>
              <span className="text-muted-foreground w-8 text-right">{l.strength}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onRemove(i)}
                aria-label="Remove LoRA"
                className="text-destructive hover:text-destructive"
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 flex-wrap items-center">
        <div className="flex-1 min-w-0">
          <Input
            type="text"
            placeholder="filename.safetensors"
            value={filename}
            onChange={(e) => onFilenameChange(e.target.value)}
          />
        </div>
        <div className="w-24">
          <Input
            type="text"
            placeholder="save_path"
            value={savePath}
            onChange={(e) => onSavePathChange(e.target.value)}
          />
        </div>
        <div className="w-16">
          <Input
            type="number"
            step="0.05"
            min="0"
            max="2"
            placeholder="1"
            value={strength}
            onChange={(e) => onStrengthChange(e.target.value)}
          />
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onAdd}>
          <Plus className="w-3.5 h-3.5" />
          Add
        </Button>
      </div>
    </div>
  );
}
