// Typed wrappers for python/pip routes.

import { z } from 'zod';
import { apiCall } from './client.js';
import type { PythonPackage, PluginDependencyReport } from '../types/index.js';

// ---- Inline schemas ----

const InstalledPackageSchema = z.object({ name: z.string(), version: z.string() });

const DependencyItemSchema = z.object({
  name:            z.string(),
  version:         z.string(),
  missing:         z.boolean().optional(),
  versionMismatch: z.boolean().optional(),
});

const PluginDependencyReportSchema = z.object({
  plugin:       z.string(),
  dependencies: z.array(DependencyItemSchema),
  missingDeps:  z.array(z.string()),
});

const PipSourceResponseSchema = z.object({ source: z.string() });

const PackageOpResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  output:  z.string(),
});

// ---- Route specs ----

const getPipSourceSpec = {
  method: 'GET' as const,
  path: '/python/pip-source',
  response: PipSourceResponseSchema,
};

const setPipSourceSpec = {
  method: 'POST' as const,
  path: '/python/pip-source',
  body: z.object({ source: z.string() }),
  response: PipSourceResponseSchema,
};

const listPackagesSpec = {
  method: 'GET' as const,
  path: '/python/packages',
  response: z.array(InstalledPackageSchema),
};

const installPackageSpec = {
  method: 'POST' as const,
  path: '/python/packages/install',
  body: z.object({ package: z.string() }),
  response: PackageOpResponseSchema,
};

const uninstallPackageSpec = {
  method: 'POST' as const,
  path: '/python/packages/uninstall',
  body: z.object({ package: z.string() }),
  response: PackageOpResponseSchema,
};

const pluginDepsSpec = {
  method: 'GET' as const,
  path: '/python/plugins/dependencies',
  response: z.array(PluginDependencyReportSchema),
};

const fixDepsSpec = {
  method: 'POST' as const,
  path: '/python/plugins/fix-dependencies',
  body: z.object({ plugin: z.string() }),
  response: PackageOpResponseSchema,
};

// ---- Public API ----

export async function getPipSource(): Promise<string> {
  const res = await apiCall(getPipSourceSpec, {});
  return res.source;
}

export async function setPipSource(source: string) {
  return apiCall(setPipSourceSpec, { body: { source } });
}

export async function listPythonPackages(): Promise<PythonPackage[]> {
  return apiCall(listPackagesSpec, {}) as Promise<PythonPackage[]>;
}

export async function installPythonPackage(packageSpec: string) {
  return apiCall(installPackageSpec, { body: { package: packageSpec } });
}

export async function uninstallPythonPackage(packageName: string) {
  return apiCall(uninstallPackageSpec, { body: { package: packageName } });
}

export async function getPluginDependencies(): Promise<PluginDependencyReport[]> {
  return apiCall(pluginDepsSpec, {}) as Promise<PluginDependencyReport[]>;
}

export async function fixPluginDependencies(plugin: string) {
  return apiCall(fixDepsSpec, { body: { plugin } });
}
