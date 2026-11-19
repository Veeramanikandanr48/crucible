// npm's own rule for package names, so a name from the search result cannot steer the manifest request elsewhere.
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** The registry path of a package: every character encoded, then the scope's @ restored, as the registry expects. */
export function npmManifestPath(name) {
  if (typeof name !== 'string' || name.length > 214 || !NPM_PACKAGE_NAME.test(name)) return null;
  return `${encodeURIComponent(name).replace(/^%40/, '@')}/latest`;
}

/** Addons from an npm search result: entries without a valid npm name are skipped, so one bad entry cannot hide the rest. */
export function addonEntries(searchObjects) {
  if (!Array.isArray(searchObjects)) return [];
  return searchObjects
    .map((object) => object?.package)
    .filter((entry) => npmManifestPath(entry?.name) !== null)
    .map((entry) => ({ name: entry.name, version: String(entry.version ?? ''), description: String(entry.description ?? ''), range: null }));
}

export const FIRST_PARTY_PREFIX = '@codepawlhq/crucible-';
const ADDON_KEYWORD = 'crucible-addon';

/**
 * The companion packages CodePawl publishes beside the engine, from an npm search result: names under
 * `@codepawlhq/crucible-`, valid npm names, and not addons (those carry the `crucible-addon` keyword and list under Addons).
 */
export function firstPartyPackages(searchObjects) {
  if (!Array.isArray(searchObjects)) return [];
  const packages = [];
  for (const object of searchObjects) {
    const entry = object?.package;
    if (typeof entry?.name !== 'string' || !entry.name.startsWith(FIRST_PARTY_PREFIX)) continue;
    if (npmManifestPath(entry.name) === null) continue;
    if (Array.isArray(entry.keywords) && entry.keywords.includes(ADDON_KEYWORD)) continue;
    packages.push({ name: entry.name, version: String(entry.version ?? ''), description: String(entry.description ?? '') });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}
