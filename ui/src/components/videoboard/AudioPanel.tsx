// AudioPanel — slim dropzone used when no audio is loaded yet.
// The full audio player, waveform, and lyrics live in AnalyzeView.tsx.
// This component handles only: file upload drop-zone + analyze button.

import { useCallback, useRef, useState } from 'react';
import { Upload, Loader2, AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { uploadAudio, analyzeProject, updateProject } from '../../api/videoboard';
import { useVideoboardEvents } from '../../services/videoboardEvents';
import type { Project } from '../../api/videoboard';

export interface AudioPanelProps {
  projectId: string;
  project: Project;
  onProjectUpdate: (p: Project) => void;
  /** Called after a successful upload so the parent can switch to Analyze tab. */
  onUploaded?: () => void;
}

export function AudioPanel({ projectId, project, onProjectUpdate, onUploaded }: AudioPanelProps): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useVideoboardEvents(projectId, {
    onJob: (job) => {
      if (job.kind === 'analyze') {
        if (job.status === 'running' || job.status === 'queued') {
          setAnalyzing(true);
        } else if (job.status === 'done') {
          setAnalyzing(false);
        } else if (job.status === 'error') {
          setAnalyzing(false);
          toast.error('Analysis failed', { description: job.message });
        }
      }
    },
  });

  const processFile = useCallback(async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!ext || !['mp3', 'wav'].includes(ext)) {
      toast.error('Unsupported file type', { description: 'Please upload an MP3 or WAV file.' });
      return;
    }
    setUploading(true);
    try {
      const { audioPath } = await uploadAudio(projectId, file);
      const updated = await updateProject(projectId, { audioPath });
      onProjectUpdate(updated);
      onUploaded?.();
    } catch (err) {
      toast.error('Upload failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploading(false);
    }
  }, [projectId, onProjectUpdate, onUploaded]);

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) await processFile(file);
  }, [processFile]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => setDragging(false), []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await processFile(file);
    e.target.value = '';
  }, [processFile]);

  const handleAnalyze = useCallback(async () => {
    if (analyzing) return;
    setAnalyzing(true);
    try {
      await analyzeProject(projectId);
    } catch (err) {
      setAnalyzing(false);
      toast.error('Could not start analysis', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [projectId, analyzing]);

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-12 px-6">
      {/* Drop zone */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload audio file — click or drag and drop"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-12 py-14 cursor-pointer transition-colors w-full max-w-sm',
          dragging
            ? 'border-brand bg-brand/5'
            : 'border-border hover:border-brand/50 hover:bg-muted/40',
          uploading && 'pointer-events-none opacity-60',
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp3,.wav,audio/mpeg,audio/wav"
          className="sr-only"
          onChange={handleFileChange}
        />
        {uploading ? (
          <Loader2 className="h-10 w-10 animate-spin text-brand" />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <Upload className="h-6 w-6 text-muted-foreground" />
          </div>
        )}
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">
            {uploading ? 'Uploading…' : 'Upload audio or drag here'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Supports MP3, WAV</p>
        </div>
      </div>

      {/* Analyze button — shown when audio is present but analysis not run yet */}
      {project.audioPath && (
        <div className="flex items-center gap-3">
          <Button
            onClick={handleAnalyze}
            disabled={analyzing}
            size="sm"
            variant={project.analysisStatus === 'ready' ? 'secondary' : 'default'}
          >
            {analyzing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Analyzing…
              </>
            ) : project.analysisStatus === 'ready' ? (
              <>
                <RefreshCw className="h-3.5 w-3.5" />
                Re-analyze
              </>
            ) : (
              'Analyze'
            )}
          </Button>

          {project.analysisStatus === 'ready' && !analyzing && (
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Analysis ready
            </span>
          )}
          {project.analysisStatus === 'error' && !analyzing && (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" />
              Analysis failed
            </span>
          )}
        </div>
      )}
    </div>
  );
}
