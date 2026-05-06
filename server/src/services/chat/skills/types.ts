// Types for the skills subsystem.

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  trigger_when?: string;
  scripts?: string[];
  [key: string]: unknown;
}

export interface Skill {
  name: string;
  frontmatter: SkillFrontmatter;
  body: string;
  description: string;
  /** Names of bundled script files under the skill's scripts/ directory. */
  scripts: string[];
}

export interface SkillIndex {
  name: string;
  description: string;
}
