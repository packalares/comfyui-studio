import React, { createContext, useContext, useState, useCallback } from 'react';
import type { TemplateSummary, GalleryItem } from '../types';
import { api } from '../services/comfyui';

export interface CatalogContextType {
  templates: TemplateSummary[];
  gallery: GalleryItem[];
  galleryTotal: number;
  recentGallery: GalleryItem[];
  refreshTemplates: () => Promise<void>;
  refreshGallery: () => Promise<void>;
  // Internal setters exposed to sibling providers (Ws, façade).
  _setGalleryTotal: React.Dispatch<React.SetStateAction<number>>;
  _setRecentGallery: React.Dispatch<React.SetStateAction<GalleryItem[]>>;
}

const CatalogContext = createContext<CatalogContextType | null>(null);

export function CatalogProvider({ children }: { children: React.ReactNode }) {
  // Templates are kept as the slim `TemplateSummary` shape — the heavy
  // fields (workflow JSON, formInputs, io, models[], plugins[]) live behind
  // `/api/template-bundle/:name`, fetched on demand by Studio when a
  // template is picked.
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [galleryTotal, setGalleryTotal] = useState<number>(0);
  const [recentGallery, setRecentGallery] = useState<GalleryItem[]>([]);

  const refreshTemplates = useCallback(async () => {
    try {
      const data = await api.getTemplatesList();
      setTemplates(data);
    } catch {
      // Keep existing templates if any are cached; don't clear on failure
    }
  }, []);

  const refreshGallery = useCallback(async () => {
    try {
      const data = await api.getGallery();
      setGallery(data);
    } catch {
      // Keep existing gallery data on failure
    }
  }, []);

  return (
    <CatalogContext.Provider
      value={{
        templates,
        gallery,
        galleryTotal,
        recentGallery,
        refreshTemplates,
        refreshGallery,
        _setGalleryTotal: setGalleryTotal,
        _setRecentGallery: setRecentGallery,
      }}
    >
      {children}
    </CatalogContext.Provider>
  );
}

export function useCatalog() {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error('useCatalog must be used within CatalogProvider');
  return ctx;
}
