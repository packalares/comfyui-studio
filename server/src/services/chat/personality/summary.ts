// Personality summary — the read-only snapshot of every markdown overlay
// (souls, skills, commands), the default soul name, and the pending-edits
// queue. Feeds both `GET /api/personality` and the `personality` block on
// `GET /api/system` so the UI can hydrate everything in one round-trip.

import { listSouls, getDefaultSoulName } from './loader.js';
import { listPendingEdits } from './pendingEdits.js';
import { listSkills } from '../skills/registry.js';
import { listCommands } from '../commands/registry.js';

export interface PersonalitySummarySoul {
  name: string;
  description: string;
}

export interface PersonalitySummarySkill {
  name: string;
  description: string;
  scripts: string[];
}

export interface PersonalitySummaryCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export interface PersonalitySummary {
  souls: PersonalitySummarySoul[];
  skills: PersonalitySummarySkill[];
  commands: PersonalitySummaryCommand[];
  defaultSoul: string | null;
  edits: ReturnType<typeof listPendingEdits>;
}

export function getPersonalitySummary(): PersonalitySummary {
  return {
    souls: listSouls().map(s => ({ name: s.name, description: s.description })),
    skills: listSkills().map(s => ({
      name: s.name,
      description: s.description,
      scripts: s.scripts,
    })),
    commands: listCommands().map(c => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
    })),
    defaultSoul: getDefaultSoulName(),
    edits: listPendingEdits(),
  };
}
