import * as z from 'zod/v4';
import { describeReceived } from '../src/field-error.js';

const ISSUES_WITH_A_REJECTED_VALUE = new Set(['too_big', 'too_small', 'invalid_value', 'invalid_format', 'not_multiple_of']);

// Names an agent reaches for that the recipe spells differently. A synonym whose target is a valid key at that level
// becomes a "did you mean"; the others point at the place the thing lives.
const KEY_SYNONYMS = {
  position: { key: 'translation' },
  metalness: { key: 'metallic' },
  tags: { key: 'tag' },
  size: { advice: 'geometries are unit solids, so size a part with the "scale" of its node' },
  radius: { advice: 'geometries are unit solids, so size a part with the "scale" of its node' },
  lights: { advice: 'point, spot and area lights are environment.pointLights, environment.spotLights and environment.areaLights (scene_capabilities environment)' },
};

const MAXIMUM_TYPO_DISTANCE = 2;

function editDistance(first, second) {
  let previousRow = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex++) {
    const row = [firstIndex];
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex++) {
      const substitution = previousRow[secondIndex - 1] + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1);
      row.push(Math.min(previousRow[secondIndex] + 1, row[secondIndex - 1] + 1, substitution));
    }
    previousRow = row;
  }
  return previousRow[second.length];
}

function closestValidKey(rejectedKey, validKeys) {
  let best;
  let bestDistance = Infinity;
  for (const validKey of validKeys) {
    const distance = editDistance(rejectedKey.toLowerCase(), validKey.toLowerCase());
    if (distance < bestDistance) {
      best = validKey;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.min(MAXIMUM_TYPO_DISTANCE, Math.floor(rejectedKey.length / 2)) ? best : undefined;
}

// At most one suggestion per rejected key, so a long error stays short.
export function suggestionForRejectedKey(rejectedKey, validKeys) {
  const synonym = Object.hasOwn(KEY_SYNONYMS, rejectedKey) ? KEY_SYNONYMS[rejectedKey] : undefined;
  if (synonym?.key && validKeys.includes(synonym.key)) {
    return `Use "${synonym.key}" instead of "${rejectedKey}".`;
  }
  const closest = closestValidKey(rejectedKey, validKeys);
  if (closest) {
    return `Use "${closest}" instead of "${rejectedKey}".`;
  }
  if (synonym?.advice) {
    return `For "${rejectedKey}": ${synonym.advice}.`;
  }
  return undefined;
}

function unrecognizedKeysMessage(issue, wording) {
  const validKeys = Object.keys(issue.inst?._zod?.def?.shape ?? {});
  const suggestions = issue.keys.map(key => suggestionForRejectedKey(key, validKeys)).filter(Boolean);
  if (suggestions.length === 0) {
    return undefined;
  }
  return `${wording}. ${suggestions.join(' ')}`;
}

// A field that takes a number while a sibling takes the colour an agent passed.
const COLOUR_SIBLINGS = { emission: 'emissiveColor' };

function wrongTypeMessage(issue, wording) {
  const fieldName = issue.path?.at(-1);
  const sibling = typeof fieldName === 'string' && Object.hasOwn(COLOUR_SIBLINGS, fieldName) ? COLOUR_SIBLINGS[fieldName] : undefined;
  if (issue.expected === 'number' && Array.isArray(issue.input) && sibling) {
    return `${wording}. ${fieldName} takes one number (a multiplier); for an RGB colour use ${sibling}.`;
  }
  return undefined;
}

// The SDK prefixes each schema message with the field path (recipe.materials.0.color.2). The English wording says what
// was expected ("Too big: expected number to be <=1") but not what arrived, so the received value is added here, and an
// unrecognized key names the valid key it was probably meant to be.
function messageWithReceivedValue(issue) {
  const wording = z.locales.en().localeError(issue);
  const text = typeof wording === 'string' ? wording : wording?.message;
  if (!text) {
    return undefined;
  }
  if (issue.code === 'unrecognized_keys') {
    return unrecognizedKeysMessage(issue, text);
  }
  if (issue.code === 'invalid_type') {
    return wrongTypeMessage(issue, text);
  }
  if (ISSUES_WITH_A_REJECTED_VALUE.has(issue.code) && Object.hasOwn(issue, 'input')) {
    return `${text} (got ${describeReceived(issue.input)})`;
  }
  return undefined;
}

export function describeSchemaInputsWithReceivedValues() {
  z.config({ customError: messageWithReceivedValue });
}
