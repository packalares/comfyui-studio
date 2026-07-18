// Dataset selection + upload. A dataset is a named folder of images (+
// optional sibling `<basename>.txt` caption files) — select an existing one
// from the dropdown, or type a new name and drop files to create it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FolderOpen, Image as ImageIcon, Plus, Upload } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Spinner } from '../../components/ui/spinner';
import {
  SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/forms/SelectField';
import { cn } from '../../lib/utils';
import * as api from '../../services/aiToolkit';
import type { DatasetSummary } from '../../services/aiToolkit';

interface DatasetPanelProps {
  selectedDataset: string;
  onSelectDataset: (name: string) => void;
}

export default function DatasetPanel({ selectedDataset, onSelectDataset }: DatasetPanelProps) {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [newDatasetName, setNewDatasetName] = useState('');
  const [creatingNew, setCreatingNew] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const items = await api.listDatasets();
      setDatasets(items);
      if (!selectedDataset && items.length > 0) onSelectDataset(items[0].name);
    } catch (err) {
      toast.error('Failed to load datasets', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
    // selectedDataset/onSelectDataset intentionally excluded — this only
    // needs to run on mount + after an explicit upload, not on every
    // selection change (which would fight the user's own picks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const doUpload = useCallback(async (files: File[]) => {
    const targetName = (creatingNew ? newDatasetName : selectedDataset).trim();
    if (!targetName) {
      toast.error('Name the dataset first');
      return;
    }
    if (files.length === 0) return;
    setUploading(true);
    try {
      const result = await api.uploadDatasetFiles(targetName, files);
      toast.success(`Uploaded ${result.uploadedCount} file(s) to "${result.name}"`, {
        description: `${result.imageCount} image(s), ${result.captionedCount} captioned`,
      });
      setCreatingNew(false);
      setNewDatasetName('');
      onSelectDataset(result.name);
      await refresh();
    } catch (err) {
      toast.error('Upload failed', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setUploading(false);
    }
  }, [creatingNew, newDatasetName, selectedDataset, onSelectDataset, refresh]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false);
    void doUpload(Array.from(e.dataTransfer.files));
  }, [doUpload]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) void doUpload(Array.from(e.target.files));
    e.target.value = '';
  }, [doUpload]);

  const activeDataset = datasets.find((d) => d.name === selectedDataset) ?? null;

  return (
    <Card>
      <CardHeader><CardTitle>Dataset</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex justify-center py-6"><Spinner size="sm" /></div>
        ) : (
          <>
            {!creatingNew && (
              <div className="flex gap-2">
                <SelectField
                  value={selectedDataset || undefined}
                  onValueChange={onSelectDataset}
                  disabled={datasets.length === 0}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder={datasets.length === 0 ? 'No datasets yet' : 'Select a dataset'} />
                  </SelectTrigger>
                  <SelectContent>
                    {datasets.map((d) => (
                      <SelectItem key={d.name} value={d.name}>
                        {d.name} · {d.imageCount} image{d.imageCount === 1 ? '' : 's'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectField>
                <Button variant="secondary" size="sm" onClick={() => setCreatingNew(true)}>
                  <Plus className="h-3.5 w-3.5" /> New
                </Button>
              </div>
            )}

            {creatingNew && (
              <div className="flex gap-2">
                <Input
                  autoFocus
                  value={newDatasetName}
                  onChange={(e) => setNewDatasetName(e.target.value)}
                  placeholder="my_character_lora"
                  className="flex-1"
                />
                <Button variant="ghost" size="sm" onClick={() => { setCreatingNew(false); setNewDatasetName(''); }}>
                  Cancel
                </Button>
              </div>
            )}

            {activeDataset && !creatingNew && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                <ImageIcon className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {activeDataset.imageCount} image{activeDataset.imageCount === 1 ? '' : 's'}
                  {' · '}
                  {activeDataset.captionedCount} captioned
                </span>
              </div>
            )}

            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                'cursor-pointer rounded-xl border-2 border-dashed p-4 text-center transition-colors',
                isDragOver ? 'border-brand bg-brand/10' : 'border-border hover:border-ring',
                uploading && 'pointer-events-none opacity-60',
              )}
            >
              {uploading ? (
                <Spinner size="sm" className="mx-auto" />
              ) : (
                <>
                  <Upload className={cn('mx-auto mb-1.5 h-6 w-6', isDragOver ? 'text-brand' : 'text-muted-foreground')} />
                  <p className="text-xs font-medium text-foreground">Drop images (+ matching .txt captions) here</p>
                  <p className="mt-1 text-xs text-muted-foreground">.png, .jpg, .jpeg, .webp — captions are optional, same basename</p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".png,.jpg,.jpeg,.webp,.txt"
                onChange={handleFileSelect}
                className="hidden"
              />
            </div>

            {datasets.length === 0 && !creatingNew && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <FolderOpen className="h-3 w-3" /> No datasets yet — name one above and drop images to create it.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
