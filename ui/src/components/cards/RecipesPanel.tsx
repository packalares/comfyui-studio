// Panel for the Recipes tab in the Models page.
// Shows a list of saved LoRA recipes; clicking a row opens the editor.

import { useState, useEffect, useCallback } from 'react';
import { Plus, BookOpen } from 'lucide-react';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import RecipeEditorModal from '../modals/RecipeEditorModal';
import { listRecipes, deleteRecipe, type Recipe } from '../../services/recipes';
import { toast } from 'sonner';

export default function RecipesPanel(): JSX.Element {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState<Recipe | null | 'new'>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = await listRecipes();
      setRecipes(items);
    } catch {
      toast.error('Failed to load recipes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = useCallback(async (recipe: Recipe) => {
    try {
      await deleteRecipe(recipe.id);
      setRecipes((prev) => prev.filter((r) => r.id !== recipe.id));
      toast.success(`Deleted "${recipe.title}"`);
    } catch {
      toast.error('Failed to delete recipe');
    }
  }, []);

  const handleSaved = useCallback(() => {
    setEditTarget(null);
    void load();
  }, [load]);

  return (
    <>
      <div className="panel">
        <div className="panel-header flex items-center justify-between">
          <div>
            <p className="panel-header-title">Recipes</p>
            <p className="panel-header-desc">Saved LoRA combinations</p>
          </div>
          <Button size="sm" onClick={() => setEditTarget('new')}>
            <Plus className="w-3.5 h-3.5" />
            New Recipe
          </Button>
        </div>

        <div className="panel-body p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner size="md" />
            </div>
          ) : recipes.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-center">
              <BookOpen className="w-10 h-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No recipes yet</p>
              <p className="text-xs text-muted-foreground mt-1">Create a recipe to save a LoRA combination for quick reuse.</p>
            </div>
          ) : (
            <div className="divide-y">
              {recipes.map((recipe) => (
                <RecipeRow
                  key={recipe.id}
                  recipe={recipe}
                  onEdit={() => setEditTarget(recipe)}
                  onDelete={() => void handleDelete(recipe)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <RecipeEditorModal
        open={editTarget !== null}
        recipe={editTarget === 'new' ? null : editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={handleSaved}
      />
    </>
  );
}

interface RecipeRowProps {
  recipe: Recipe;
  onEdit: () => void;
  onDelete: () => void;
}

function RecipeRow({ recipe, onEdit, onDelete }: RecipeRowProps): JSX.Element {
  return (
    <div
      className="flex items-center gap-3 py-2.5 px-4 hover:bg-muted/40 cursor-pointer"
      onClick={onEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onEdit(); }}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{recipe.title}</p>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <span className="text-xs text-muted-foreground">{recipe.loras.length} LoRA{recipe.loras.length !== 1 ? 's' : ''}</span>
          {recipe.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="badge badge-neutral">{tag}</span>
          ))}
          {recipe.tags.length > 4 && (
            <span className="text-xs text-muted-foreground">+{recipe.tags.length - 4}</span>
          )}
        </div>
      </div>
      <button
        type="button"
        className="text-xs text-destructive hover:opacity-80 shrink-0 px-2 py-1"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        aria-label={`Delete ${recipe.title}`}
      >
        Delete
      </button>
    </div>
  );
}
