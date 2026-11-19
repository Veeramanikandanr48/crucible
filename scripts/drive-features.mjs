// Reads FEATURES.md, the feature map that scripts/drive.mjs works from. No browser code lives here so tests can load it.

const FEATURE_HEADING = /^###\s+`([^`]+)`\s*$/;
const SECTION_HEADING = /^##\s+(.+?)\s*$/;
const FIELD_LINE = /^-\s+([A-Za-z]+):\s*(.*?)\s*$/;
const FIRST_BACKTICKED = /`([^`]+)`/;

export function parseFeatures(markdown) {
  const features = [];
  let section = '';
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const sectionMatch = line.match(SECTION_HEADING);
    if (sectionMatch && !line.startsWith('###')) {
      section = sectionMatch[1];
      current = null;
      continue;
    }
    const headingMatch = line.match(FEATURE_HEADING);
    if (headingMatch) {
      current = { id: headingMatch[1], section, fields: {} };
      features.push(current);
      continue;
    }
    const fieldMatch = line.match(FIELD_LINE);
    if (current && fieldMatch) current.fields[fieldMatch[1].toLowerCase()] = fieldMatch[2];
  }
  return features.map(toFeature);
}

function toFeature({ id, section, fields }) {
  const reachValue = fields.reach?.match(FIRST_BACKTICKED)?.[1] ?? '';
  const readyValue = fields.ready?.match(FIRST_BACKTICKED)?.[1] ?? null;
  return {
    id,
    section,
    name: fields.name ?? '',
    surface: fields.surface ?? '',
    reach: fields.reach ?? '',
    route: reachValue.startsWith('/') ? reachValue : null,
    source: fields.source ?? '',
    ready: readyValue,
    drive: fields.drive ?? '',
  };
}

export function findFeature(features, id) {
  const feature = features.find(candidate => candidate.id === id);
  if (feature) return feature;
  const similar = features.filter(candidate => candidate.id.includes(id)).map(candidate => candidate.id).slice(0, 8);
  const hint = similar.length ? ` Did you mean: ${similar.join(', ')}?` : ' Run `node scripts/drive.mjs list` to see the ids.';
  throw new Error(`No feature with id "${id}" in FEATURES.md.${hint}`);
}

export function requirePage(feature) {
  if (feature.route) return feature.route;
  throw new Error(`Feature "${feature.id}" is not a page (${feature.reach}). Pass a feature whose Reach is a route; ${feature.drive}.`);
}

export function formatFeatureList(features, surface = null) {
  const selected = surface ? features.filter(feature => feature.surface.toLowerCase() === surface.toLowerCase()) : features;
  const idWidth = Math.max(0, ...selected.map(feature => feature.id.length));
  return selected.map(feature => `${feature.id.padEnd(idWidth)}  [${feature.surface}] ${feature.reach}  ${feature.name}`).join('\n');
}

const VALUE_FLAGS = new Set(['out', 'origin', 'width', 'height', 'surface', 'settle']);
const BOOLEAN_FLAGS = new Set(['no-gpu-lock', 'full-page']);
const NUMBER_FLAGS = { width: 1, height: 1, settle: 0 };

function checkFlagValue(name, value) {
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value, not ${value ?? 'the end of the command'}.`);
  const minimum = NUMBER_FLAGS[name];
  if (minimum !== undefined && !(Number.isFinite(Number(value)) && Number(value) >= minimum)) throw new Error(`--${name} must be a number of at least ${minimum}; pass e.g. --${name} ${Math.max(minimum, 1000)}.`);
}

export function parseCommandLine(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const flags = {};
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const value = rest[++index];
      checkFlagValue(name, value);
      flags[name] = value;
    } else {
      throw new Error(`Unknown flag --${name}.`);
    }
  }
  return { command, positional, flags };
}
