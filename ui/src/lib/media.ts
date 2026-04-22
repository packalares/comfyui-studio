// Small media-type helpers that live client-side only.
//
// The server classifies `.glb` / `.gltf` / `.usdz` / `.obj` under
// `mediaType: 'image'` on purpose — they all surface in the Gallery's
// image filter bucket (same as the user's other generated outputs).
// Rendering is a different question: these aren't raster images, so the
// gallery tile needs a 3D placeholder and the detail / result viewers
// need to mount `<model-viewer>` instead of an `<img>`.
//
// This helper is the classifier for that rendering branch.

const THREE_D_EXTS = ['.glb', '.gltf', '.usdz', '.obj'] as const;

export function isThreeDFilename(filename: string | undefined | null): boolean {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  return THREE_D_EXTS.some(ext => lower.endsWith(ext));
}
