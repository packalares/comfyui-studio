// Shared types for the API-prompt emission pipeline.

export type PromptEntry = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title: string };
};

export type ApiPrompt = Record<string, PromptEntry>;
