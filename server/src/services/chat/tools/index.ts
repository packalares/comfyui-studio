// Assembles the chat-tool set from the on-disk integrations config. A tool is
// only exposed to the LLM when its required configuration is present (URL +
// any auth token). Empty config → tool absent from the tools map → the model
// can't call it.
//
// `getEnabledTools()` is called by `streamChat.ts` on every stream so a
// settings change takes effect on the next user turn without restarting the
// server.

import * as toolsSettings from '../../settings.tools.js';
import { webSearchTool } from './webSearch.js';
import { ragSearchTool } from './ragSearch.js';
import { ragUploadTool } from './ragUpload.js';
import { generateImageTool } from './generateImage.js';

export type ToolName = 'web_search' | 'rag_search' | 'rag_upload' | 'generate_image';

// Use `unknown` here so the consumer (streamText) widens its TOOLS generic
// based on whatever subset is configured at call time. Returning a typed
// union would force the caller to handle every tool's input schema even
// when only one is present.
export type EnabledToolMap = Record<string, unknown>;

export function getEnabledTools(): EnabledToolMap {
  const out: Record<string, unknown> = {};
  const searx = toolsSettings.getSearxngUrl();
  if (searx) {
    out.web_search = webSearchTool({ baseUrl: searx });
  }
  const ragUrl = toolsSettings.getRagflowUrl();
  const ragKey = toolsSettings.getRagflowApiKey();
  if (ragUrl && ragKey) {
    out.rag_search = ragSearchTool({ baseUrl: ragUrl, apiKey: ragKey });
    out.rag_upload = ragUploadTool({ baseUrl: ragUrl, apiKey: ragKey });
  }
  const defaultImageTemplate = toolsSettings.getDefaultImageTemplate();
  if (defaultImageTemplate) {
    out.generate_image = generateImageTool({ defaultTemplate: defaultImageTemplate });
  }
  return out;
}

export function listEnabledToolNames(): ToolName[] {
  const names: ToolName[] = [];
  if (toolsSettings.getSearxngUrl()) names.push('web_search');
  const ragUrl = toolsSettings.getRagflowUrl();
  const ragKey = toolsSettings.getRagflowApiKey();
  if (ragUrl && ragKey) {
    names.push('rag_search');
    names.push('rag_upload');
  }
  if (toolsSettings.getDefaultImageTemplate()) names.push('generate_image');
  return names;
}
