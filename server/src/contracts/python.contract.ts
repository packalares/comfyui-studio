// Zod schemas for the python/pip domain.

import { z } from 'zod';

export const InstalledPackageSchema = z.object({
  name:    z.string(),
  version: z.string(),
});

export const DependencyItemSchema = z.object({
  name:             z.string(),
  version:          z.string(),
  missing:          z.boolean().optional(),
  versionMismatch:  z.boolean().optional(),
});

export const PluginDependencyReportSchema = z.object({
  plugin:       z.string(),
  dependencies: z.array(DependencyItemSchema),
  missingDeps:  z.array(z.string()),
});

// ---- Body schemas ----

export const PipSourceBodySchema = z.object({
  source: z.string().min(1),
});

export const PackageInstallBodySchema = z.object({
  package: z.string().min(1),
});

export const FixDepsBodySchema = z.object({
  plugin: z.string().min(1),
});

// ---- Response schemas ----

export const PipSourceResponseSchema = z.object({
  source: z.string(),
});

export const PackageOpResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  output:  z.string(),
});

export const FixDepsResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  output:  z.string(),
});
