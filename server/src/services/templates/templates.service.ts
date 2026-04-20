// Template list cache + loader. Pulls the category index from ComfyUI's
// `/templates/index.json`, flattens each category's templates, and generates
// form inputs via the companion module. Exposes a cached accessor so other
// services can look up a template by name without re-fetching.

import { generateFormInputs } from './templates.formInputs.js';
import type { TemplateData, RawCategory } from './types.js';
import { logger } from '../../lib/logger.js';

function mapCategory(
  categoryTitle: string,
  _type: string,
): 'image' | 'video' | 'audio' | '3d' | 'tools' {
  const title = categoryTitle.toLowerCase();
  if (title.includes('video')) return 'video';
  if (title.includes('audio')) return 'audio';
  if (title.includes('3d')) return '3d';
  if (title.includes('utility') || title.includes('tool')) return 'tools';
  if (title.includes('llm')) return 'tools';
  return 'image';
}

let cachedTemplates: TemplateData[] = [];

export async function loadTemplatesFromComfyUI(comfyuiUrl: string): Promise<void> {
  try {
    const res = await fetch(`${comfyuiUrl}/templates/index.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const categories: RawCategory[] = await res.json();
    const templates: TemplateData[] = [];

    for (const cat of categories) {
      if (!cat.templates) continue;
      const studioCat = mapCategory(cat.title, cat.type);

      for (const t of cat.templates) {
        templates.push({
          name: t.name,
          title: t.title,
          description: t.description || '',
          mediaType: t.mediaType || 'image',
          mediaSubtype: t.mediaSubtype,
          tags: t.tags || [],
          models: t.models || [],
          category: cat.title,
          studioCategory: studioCat,
          io: {
            inputs: t.io?.inputs || [],
            outputs: t.io?.outputs || [],
          },
          formInputs: generateFormInputs(t),
          thumbnail: t.thumbnail || [],
          thumbnailVariant: t.thumbnailVariant,
          size: t.size || 0,
          vram: t.vram || 0,
          usage: t.usage || 0,
          openSource: t.openSource,
          username: t.username,
          date: t.date,
          logos: t.logos,
          searchRank: t.searchRank,
        });
      }
    }

    cachedTemplates = templates;
    logger.info(
      `Loaded ${templates.length} templates from ComfyUI (${categories.length} categories)`,
    );
  } catch (err) {
    logger.error('Failed to load templates from ComfyUI', { error: String(err) });
    logger.info('No templates available - ComfyUI may not be running');
  }
}

export function getTemplates(): TemplateData[] {
  return cachedTemplates;
}

export function getTemplate(name: string): TemplateData | undefined {
  return cachedTemplates.find(t => t.name === name);
}
