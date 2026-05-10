// Barrel for the markdownLibrary shared primitives.

export { parseFrontmatter } from './frontmatter.js';
export type { ParsedFrontmatter } from './frontmatter.js';

export { isValidLibraryName } from './nameValidation.js';

export { safeLibraryPath } from './pathGuard.js';

export {
  listOverlay,
  loadOverlay,
  writeUser,
  deleteUser,
  isBundledOnlyItem,
} from './overlayLoader.js';

export { createMarkdownRegistry } from './registry.js';
export type { Registry, RegistryItem, RegistryOpts } from './registry.js';
