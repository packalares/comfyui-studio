// Name validation for library items (skills, commands, souls).
// Shared so the rule is defined once and enforced everywhere.

const LIBRARY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Returns true when `name` is a valid library item name.
 * Must start with a lowercase letter or digit, then contain only
 * lowercase letters, digits, and hyphens.
 */
export function isValidLibraryName(name: string): boolean {
  return LIBRARY_NAME_RE.test(name);
}
