import { createEnvironmentMap } from './environment.js';
import { radianceForDisplayColor } from './view-transform-inverse.js';

// environment.sky { type: 'gradient' }: a sky whose colours are picked, not computed. Stops run from the horizon (at 0) to the
// zenith (at 1) by elevation angle, and an optional glow band hugs the horizon. The same colours feed the background, the
// environment map that lights the scene and the water reflection, so the three always agree. The sun, the key light and the
// haze stay as the lighting setup or the recipe set them.

export const GRADIENT_SKY_FIELDS = Object.freeze(['type', 'stops', 'horizonGlow']);
export const HORIZON_GLOW_FIELDS = Object.freeze(['color', 'width', 'intensity']);
export const MAXIMUM_GRADIENT_STOPS = 8;

const GLOW_DEFAULTS = Object.freeze({ width: 6, intensity: 1 });
// intensity multiplies the glow colour at the horizon: 1 shows the colour itself, above 1 pushes it brighter.
const GLOW_LIMITS = Object.freeze({
  width: [0.5, 45, 'the glow half width in degrees of elevation, such as 6'],
  intensity: [0, 20, 'a multiplier of the glow colour from 0 to 20, 1 shows the colour as given, such as 1.5'],
});
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const COLOR_EXAMPLE = 'a hex colour such as "#0e5d73"';
const MAP_WIDTH = 1024;
const MAP_HEIGHT = 513;

function checkedColor(value, field, fail) {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw fail(field, value, COLOR_EXAMPLE);
  }
  return value.toLowerCase();
}

function resolveStops(stops, fail) {
  if (!Array.isArray(stops) || stops.length < 1 || stops.length > MAXIMUM_GRADIENT_STOPS) {
    throw fail('environment.sky.stops', stops, `a list of 1 to ${MAXIMUM_GRADIENT_STOPS} stops, such as [{ "at": 0, "color": "#1a8a9c" }, { "at": 1, "color": "#0e5d73" }]`);
  }
  let previousAt = -Infinity;
  return stops.map((stop, index) => {
    const field = `environment.sky.stops[${index}]`;
    const unknown = stop && typeof stop === 'object' ? Object.keys(stop).find(key => key !== 'at' && key !== 'color') : 'stop';
    if (unknown !== undefined) {
      throw fail(field, unknown === 'stop' ? stop : unknown, 'an object with at (0 at the horizon to 1 at the zenith) and color');
    }
    if (!Number.isFinite(stop.at) || stop.at < 0 || stop.at > 1 || stop.at <= previousAt) {
      throw fail(`${field}.at`, stop.at, 'a number from 0 (horizon) to 1 (zenith), larger than the stop before it');
    }
    previousAt = stop.at;
    return { at: stop.at, color: checkedColor(stop.color, `${field}.color`, fail) };
  });
}

function resolveHorizonGlow(glow, fail) {
  if (!glow || typeof glow !== 'object' || Array.isArray(glow)) {
    throw fail('environment.sky.horizonGlow', glow, `an object with color (${COLOR_EXAMPLE}), width and intensity`);
  }
  const unknown = Object.keys(glow).find(key => !HORIZON_GLOW_FIELDS.includes(key));
  if (unknown !== undefined) {
    throw fail('environment.sky.horizonGlow', unknown, `the fields ${HORIZON_GLOW_FIELDS.join(', ')}`);
  }
  const resolved = { color: checkedColor(glow.color, 'environment.sky.horizonGlow.color', fail) };
  for (const [field, [minimum, maximum, example]] of Object.entries(GLOW_LIMITS)) {
    const value = glow[field] ?? GLOW_DEFAULTS[field];
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw fail(`environment.sky.horizonGlow.${field}`, value, `a number from ${minimum} to ${maximum}, ${example}`);
    }
    resolved[field] = value;
  }
  return resolved;
}

/** Checks and normalizes a gradient sky; `fail` builds the error for a field, a value and what is accepted. */
export function resolveGradientSky(input, fail) {
  const unknown = Object.keys(input).find(key => !GRADIENT_SKY_FIELDS.includes(key));
  if (unknown !== undefined) {
    throw fail('environment.sky', unknown, `type 'gradient' with fields ${GRADIENT_SKY_FIELDS.slice(1).join(', ')}`);
  }
  const resolved = { type: 'gradient', stops: resolveStops(input.stops, fail) };
  if (input.horizonGlow !== undefined && input.horizonGlow !== null) {
    resolved.horizonGlow = resolveHorizonGlow(input.horizonGlow, fail);
  }
  return resolved;
}

function srgbChannelToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(channel) {
  const clamped = Math.min(1, Math.max(0, channel));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

export function linearColorFromHex(hex) {
  return [1, 3, 5].map(offset => srgbChannelToLinear(parseInt(hex.slice(offset, offset + 2), 16) / 255));
}

// OKLab (Ottosson): blending in it keeps lightness and hue steady between two stops, where a blend of linear radiance
// goes grey and dark in the middle and a blend of encoded values bands where the hue turns.
function oklabFromLinear([red, green, blue]) {
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  ];
}

function linearFromOklab([lightness, greenRed, blueYellow]) {
  const long = (lightness + 0.3963377774 * greenRed + 0.2158037573 * blueYellow) ** 3;
  const medium = (lightness - 0.1055613458 * greenRed - 0.0638541728 * blueYellow) ** 3;
  const short = (lightness - 0.0894841775 * greenRed - 1.291485548 * blueYellow) ** 3;
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
}

function mixOklab(from, to, share) {
  return from.map((component, index) => component + (to[index] - component) * share);
}

const oklabFromHex = hex => oklabFromLinear(linearColorFromHex(hex));
const encodedFromOklab = lab => linearFromOklab(lab).map(linearChannelToSrgb);

/**
 * The radiance that shows as the hex you asked for: the view transform and the display power turn it back into the hex,
 * so a stop reads as its colour in the frame instead of being lifted by the transform (a flat #0e5d73 under aces used to
 * show as #0c6988). The inverse assumes exposure 1 and no look or post effect on the frame, and divides by the
 * environment strength, which the background and the light both multiply back in. Under aces every hex is reachable.
 * Under agx and neutral a colour the transform cannot produce lands on the nearest one it can.
 */
export function radianceFromHex(hex, viewTransform) {
  const encoded = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  return radianceForDisplayColor(encoded, viewTransform).radiance;
}

/** The recipe fields a gradient implies: the legacy sky colours that fog and the probe trace read, as radiance. */
export function gradientSkyFields(sky, viewTransform) {
  const horizon = radianceFromHex(sky.stops[0].color, viewTransform);
  const zenith = radianceFromHex(sky.stops[sky.stops.length - 1].color, viewTransform);
  return { skyTop: zenith, skyBottom: horizon, fogColor: horizon };
}

/** A gradient sky leaves the sun alone and only supplies the sky colours. */
export function applyGradientSky(input, environment, fail) {
  const sky = resolveGradientSky(input, fail);
  Object.assign(environment, gradientSkyFields(sky, environment.viewTransform), { sky });
}

function stopLabs(sky) {
  return sky.stops.map(stop => ({ at: stop.at, lab: oklabFromHex(stop.color) }));
}

function labAtHeight(stops, height) {
  if (height <= stops[0].at) {
    return stops[0].lab;
  }
  for (let index = 1; index < stops.length; index++) {
    if (height <= stops[index].at) {
      return mixOklab(stops[index - 1].lab, stops[index].lab, (height - stops[index - 1].at) / (stops[index].at - stops[index - 1].at));
    }
  }
  return stops[stops.length - 1].lab;
}

// The glow colour blends in over the gradient by its share, so the band keeps its hue as it brightens and never washes
// to white; `intensity` then scales the radiance of the band (1 shows the colour as given).
function radianceAtElevation(stops, glow, glowLab, elevation, viewTransform, strengthScale) {
  const base = labAtHeight(stops, Math.max(0, elevation) / 90);
  const glowShare = glow ? Math.exp(-((elevation / glow.width) ** 2)) : 0;
  const displayed = encodedFromOklab(glow ? mixOklab(base, glowLab, glowShare) : base);
  const brightness = glow ? 1 + (glow.intensity - 1) * glowShare : 1;
  return radianceForDisplayColor(displayed, viewTransform).radiance.map(channel => channel * brightness * strengthScale);
}

function buildMapData(sky, viewTransform, environmentIntensity) {
  const stops = stopLabs(sky);
  const glow = sky.horizonGlow;
  const glowLab = glow ? oklabFromHex(glow.color) : null;
  const strengthScale = environmentIntensity > 0 ? 1 / environmentIntensity : 1;
  const data = new Float32Array(MAP_WIDTH * MAP_HEIGHT * 3);
  for (let row = 0; row < MAP_HEIGHT; row++) {
    // Each row is one elevation: the gradient and the glow depend on the angle above the horizon only. The odd row count
    // puts the middle row exactly on the horizon, so the glow peak is the glow colour itself.
    const elevation = 90 - ((row + 0.5) / MAP_HEIGHT) * 180;
    const radiance = radianceAtElevation(stops, glow, glowLab, elevation, viewTransform, strengthScale);
    for (let column = 0; column < MAP_WIDTH; column++) {
      data.set(radiance, (row * MAP_WIDTH + column) * 3);
    }
  }
  return data;
}

const mapsByKey = new Map();
const MAXIMUM_CACHED_MAPS = 8;

/** The environment map of a gradient sky; the same object returns while sky, strength, rotation, background and view transform hold. */
export function createGradientSkyMap({ sky, environmentIntensity: intensity, environmentRotation: rotation, world: showBackground, viewTransform = 'aces' }) {
  const key = JSON.stringify([sky, intensity, rotation, showBackground, viewTransform]);
  if (!mapsByKey.has(key)) {
    if (mapsByKey.size >= MAXIMUM_CACHED_MAPS) {
      mapsByKey.clear();
    }
    mapsByKey.set(key, createEnvironmentMap({ width: MAP_WIDTH, height: MAP_HEIGHT, data: buildMapData(sky, viewTransform, intensity), intensity, rotation, showBackground }));
  }
  return mapsByKey.get(key);
}
