// Media-type detection + node-output collection.
//
// ComfyUI's history schema is inconsistent about where media lands:
//   - SaveImage   -> nodeOutput.images = [{filename: "foo.png", ...}]
//   - SaveVideo   -> nodeOutput.images = [{filename: "foo.mp4", ...}] with `animated: true`
//   - SaveAudio   -> nodeOutput.audio  = [{filename: "foo.mp3", ...}]
//   - Some older nodes use .videos directly.
//
// We walk every array-valued key and infer mediaType from the file extension.

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v']);
const AUDIO_EXTS = new Set(['wav', 'mp3', 'ogg', 'flac', 'm4a', 'opus', 'aac']);

export type MediaType = 'image' | 'video' | 'audio';

export function detectMediaType(filename: string): MediaType {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'image';
}

export interface OutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

/** Collect every file-shaped entry from one node's output bag, regardless of which key holds it. */
export function collectNodeOutputFiles(nodeOutput: Record<string, unknown>): OutputFile[] {
  const files: OutputFile[] = [];
  for (const value of Object.values(nodeOutput)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item && typeof item === 'object' && typeof (item as OutputFile).filename === 'string') {
        files.push(item as OutputFile);
      }
    }
  }
  return files;
}
