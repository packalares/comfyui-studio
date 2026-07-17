// Client-side service for the Recipe CRUD API.
// Keeps comfyui.ts clean — all recipe calls route through here.

import { fetchJson } from './comfyui';

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

export interface NewRecipeInput {
  title: string;
  notes?: string;
  tags?: string[];
  loras: LoraEntry[];
}

export interface RecipeListFilter {
  search?: string;
  tag?: string;
}

function envelope<T>(res: { data: T } | T): T {
  if (res && typeof res === 'object' && 'data' in (res as object)) {
    return (res as { data: T }).data;
  }
  return res as T;
}

const BASE = '/api/models/recipes';

export async function listRecipes(filter?: RecipeListFilter): Promise<Recipe[]> {
  const qs = new URLSearchParams();
  if (filter?.search) qs.set('search', filter.search);
  if (filter?.tag) qs.set('tag', filter.tag);
  const url = qs.toString() ? `${BASE}?${qs}` : BASE;
  const res = await fetchJson<{ data: Recipe[] } | Recipe[]>(url);
  return envelope(res);
}

export async function getRecipe(id: number): Promise<Recipe> {
  const res = await fetchJson<{ data: Recipe } | Recipe>(`${BASE}/${id}`);
  return envelope(res);
}

export async function createRecipe(input: NewRecipeInput): Promise<Recipe> {
  const res = await fetchJson<{ data: Recipe } | Recipe>(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return envelope(res);
}

export async function updateRecipe(id: number, patch: Partial<NewRecipeInput>): Promise<Recipe> {
  const res = await fetchJson<{ data: Recipe } | Recipe>(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return envelope(res);
}

export async function deleteRecipe(id: number): Promise<void> {
  await fetchJson<unknown>(`${BASE}/${id}`, { method: 'DELETE' });
}
