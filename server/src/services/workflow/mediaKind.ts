// Detect whether a workflow widget drives a media-file loader.
//
// Used by the Advanced Settings builder so the UI can swap the default
// select/text widget for the MediaLibraryModal picker on inputs that take
// an image, audio file, or video clip.
//
// Detection has two tiers:
//   1. Known loader class types (most reliable). Lists below cover the
//      vanilla comfy loaders plus the popular custom-node variants
//      (kjnodes, VHS, ACE-Step, IndexTTS, etc).
//   2. Filename-extension fallback when the class isn't in the allowlist.
//      Custom loaders we don't know about still get a picker if the
//      current value looks like a media file.

const IMAGE_LOADER_CLASSES = new Set<string>([
  'LoadImage',
  'LoadImageMask',
  'LoadImageOutput',
  'LoadImageMaskOutput',
  // kjnodes / VHS image loader variants
  'LoadImagePath',
  'LoadImagesFromPath',
  // common community extensions
  'LoadImageFromUrl',
  'ImageLoader',
  'Image Loader',
]);

const AUDIO_LOADER_CLASSES = new Set<string>([
  'LoadAudio',
  'LoadAudioMASK',
  'PreviewAudio',
  // ACE-Step + common audio chains
  'ACE_LoadAudio',
  'AudioLoader',
  // omni / TTS variants
  'OmniAudioLoader',
  'IndexTTSLoadAudio',
]);

const VIDEO_LOADER_CLASSES = new Set<string>([
  'LoadVideo',
  'LoadVideoUpload',
  // VideoHelperSuite
  'VHS_LoadVideo',
  'VHS_LoadVideoPath',
  'VHS_LoadVideoFFmpeg',
  // kjnodes
  'LoadVideoPath',
]);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const AUDIO_EXTS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.opus']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v']);

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i).toLowerCase() : '';
}

/**
 * Return the media kind a node's widget loads, or null when the node is
 * not a media loader. Class-name match wins; falls back to the current
 * widget value's extension so unknown custom loaders still get the picker
 * when they have a recognisable filename.
 */
export function mediaKindForNode(
  classType: string | null | undefined,
  value: unknown,
): 'image' | 'audio' | 'video' | null {
  if (classType) {
    if (IMAGE_LOADER_CLASSES.has(classType)) return 'image';
    if (AUDIO_LOADER_CLASSES.has(classType)) return 'audio';
    if (VIDEO_LOADER_CLASSES.has(classType)) return 'video';
  }
  if (typeof value === 'string' && value.length > 0) {
    const ext = extOf(value);
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    if (VIDEO_EXTS.has(ext)) return 'video';
  }
  return null;
}
