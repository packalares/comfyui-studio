// Generates the "form inputs" list shown in the Studio form for a given
// template. The shape is driven by template metadata: prompts are added when
// the tags call for text, and each image/audio/video input in `io.inputs`
// becomes a matching upload field. Templates with neither tag nor io entries
// still get a generic prompt so the form is never empty.

import type { FormInputData, RawTemplate } from './types.js';

function cleanFileName(file: string): string {
  return file
    .replace(/\.[^/.]+$/, '') // remove extension
    .replace(/[_-]/g, ' ')   // replace _ and - with space
    .replace(/\b\w/g, c => c.toUpperCase()); // capitalize words
}

const PROMPT_TAG_TRIGGERS = new Set([
  'Text to Image', 'Text to Video', 'Text to Audio', 'Image Edit',
  'Image to Video', 'Text to Model', 'Text to Speech', 'Video Edit',
  'Style Transfer', 'Inpainting', 'Outpainting', 'Relight',
  'ControlNet', 'Image', 'Video', 'API',
]);

function defaultPromptField(description?: string): FormInputData {
  return {
    id: 'prompt',
    label: 'Prompt',
    type: 'textarea',
    required: true,
    description,
    placeholder: 'Describe what you want to generate...',
  };
}

function mediaInput(
  mediaType: 'image' | 'audio' | 'video',
  index: number,
  input: { nodeId: number; nodeType: string; file?: string; mediaType: string },
): FormInputData {
  const defaultLabel = `${mediaType.charAt(0).toUpperCase()}${mediaType.slice(1)} ${index + 1}`;
  return {
    id: `${mediaType}_${index}`,
    label: input.file ? cleanFileName(input.file) : defaultLabel,
    type: mediaType,
    required: true,
    nodeId: input.nodeId,
    nodeType: input.nodeType,
    mediaType,
  };
}

export function generateFormInputs(template: RawTemplate): FormInputData[] {
  const inputs: FormInputData[] = [];

  if (!template.io?.inputs) {
    // No io inputs means text-only (text-to-image, text-to-video, etc.)
    inputs.push(defaultPromptField(template.description));
    return inputs;
  }

  const needsPrompt = template.tags?.some(t => PROMPT_TAG_TRIGGERS.has(t));
  if (needsPrompt) {
    inputs.push(defaultPromptField(template.description));
  }

  template.io.inputs.forEach((input, index) => {
    if (input.mediaType === 'image') {
      inputs.push(mediaInput('image', index, input));
    } else if (input.mediaType === 'audio') {
      inputs.push(mediaInput('audio', index, input));
    } else if (input.mediaType === 'video') {
      inputs.push(mediaInput('video', index, input));
    }
  });

  // If no inputs were generated, fall back to a generic prompt so the form
  // isn't empty.
  if (inputs.length === 0) {
    inputs.push(defaultPromptField());
  }

  return inputs;
}
