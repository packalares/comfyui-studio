// Domain types for the Recipe system.
// Recipes are named LoRA combinations persisted in SQLite.
// Workflow injection is explicitly out of scope — these are CRUD-only.

export interface LoraEntry {
  filename: string;
  save_path: string;
  strength: number;
}

export interface Recipe {
  id: number;
  title: string;
  notes?: string;
  tags: string[];
  loras: LoraEntry[];
  createdAt: number;
  updatedAt: number;
}

/** Input shape for creating a new recipe. */
export type NewRecipe = Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>;
