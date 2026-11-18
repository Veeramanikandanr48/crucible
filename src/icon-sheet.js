// Icon sheets: the pure part of the `icons` render job (docs/agent-render-jobs.md, "Icons"). Validation of the job settings, the camera
// and light rig, the framing arithmetic that fits one silhouette, the atlas layout and the icons.json manifest. No browser, no files.
import { invalidField } from './field-error.js';

export const ICON_LIMITS = Object.freeze({
  maximumItems: 256,
  sizes: Object.freeze([64, 128, 256, 512]),
  styles: Object.freeze(['clean', 'toon']),
  scales: Object.freeze(['fit', 'relative']),
  maximumAtlasSide: 4096,
  minimumPadding: 0.02,
  maximumPadding: 0.4,
  defaultPadding: 0.08,
  defaultView: Object.freeze({ azimuth: 35, elevation: 25 }),
  maximumElevation: 89,
});

/** What `icons` leaves out of this release, named so an error can say it is coming and not that it is unknown. */
const COMING_FIELDS = Object.freeze({
  angles: 'turnaround sheets (angles 4 or 8)',
  breakdown: 'the step-by-step strip',
  lighting: 'an HDRI rig (the three-point rig is fixed)',
  background: 'a background colour (icons are transparent)',
  outline: 'an outline colour and width',
});

const ASSET_ID = /^[0-9a-f]{64}$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const DERIVED_FIELDS = ['width', 'height', 'fps', 'duration', 'transparent'];
const SETTING_FIELDS = ['kind', 'items', 'size', 'style', 'viewpoint', 'scale', 'padding', ...DERIVED_FIELDS];
const MAXIMUM_ITEM_LENGTH = 260;

export const ICON_ARTIFACTS = Object.freeze({ atlas: 'atlas.png', manifest: 'icons.json' });

export function iconArtifactName(index) {
  return `icon-${index}.png`;
}

/** Every artifact of an icons job, in the order the runner writes them: one PNG per item, the atlas, then icons.json. */
export function iconArtifactNames(itemCount) {
  return [...Array.from({ length: itemCount }, (_, index) => iconArtifactName(index)), ICON_ARTIFACTS.atlas, ICON_ARTIFACTS.manifest];
}

/** How many items fit one atlas at this size: a square grid no wider than the atlas limit. */
export function atlasCapacity(size) {
  return (ICON_LIMITS.maximumAtlasSide / size) ** 2;
}

function itemFrom(item, position) {
  const label = `items[${position}]`;
  if (typeof item === 'string') item = { source: item };
  if (!item || Object.getPrototypeOf(item) !== Object.prototype || typeof item.source !== 'string') {
    throw invalidField(label, typeof item, 'a catalog GLB name from scene_asset_catalog, such as "sword.glb", or its 64 hexadecimal asset id', TypeError);
  }
  const source = item.source;
  if (!source || source.length > MAXIMUM_ITEM_LENGTH) {
    throw invalidField(label, `${source.length} characters`, `a catalog GLB name of 1 to ${MAXIMUM_ITEM_LENGTH} characters`, RangeError);
  }
  if (URL_SCHEME.test(source)) {
    throw invalidField(label, source.slice(0, 60), 'a catalog GLB name from scene_asset_catalog (inside --assets or --packs); remote URLs are not accepted', RangeError);
  }
  if (item.asset !== undefined && (typeof item.asset !== 'string' || !ASSET_ID.test(item.asset))) {
    throw invalidField(`${label}.asset`, String(item.asset).slice(0, 20), 'the 64 hexadecimal characters of a catalog asset id', RangeError);
  }
  return item.asset === undefined ? { source } : { source, asset: item.asset };
}

function viewFrom(view) {
  if (view === undefined || view === 'three-quarter') return { ...ICON_LIMITS.defaultView };
  if (!view || Object.getPrototypeOf(view) !== Object.prototype) {
    throw invalidField('viewpoint', typeof view, '"three-quarter" or { azimuth, elevation } in degrees', TypeError);
  }
  for (const key of Object.keys(view)) {
    if (!['azimuth', 'elevation'].includes(key)) throw invalidField(`viewpoint.${key}`, 'an unknown field', 'only azimuth and elevation, in degrees', TypeError);
  }
  const azimuth = view.azimuth ?? ICON_LIMITS.defaultView.azimuth;
  const elevation = view.elevation ?? ICON_LIMITS.defaultView.elevation;
  if (!Number.isFinite(azimuth) || azimuth < -180 || azimuth > 180) throw invalidField('viewpoint.azimuth', azimuth, 'degrees from -180 to 180', RangeError);
  if (!Number.isFinite(elevation) || Math.abs(elevation) > ICON_LIMITS.maximumElevation) {
    throw invalidField('viewpoint.elevation', elevation, `degrees from -${ICON_LIMITS.maximumElevation} to ${ICON_LIMITS.maximumElevation}`, RangeError);
  }
  return { azimuth, elevation };
}

/**
 * The settings of an icons job as the store keeps them, every default filled in and every limit checked. `items` may be bare
 * strings (the caller's form) or `{ source, asset }` (the pinned form the runtime stores, where `asset` is the catalog id).
 * It also fills the frame fields the rest of the job store reads (width, height, fps, duration), so an icons job has a size
 * and a frame count like any other job: one frame per item.
 */
export function normalizeIconSettings(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('settings must be a plain object.');
  for (const key of Object.keys(input)) {
    if (COMING_FIELDS[key] !== undefined) {
      throw invalidField(`settings.${key}`, 'a field the first icons release leaves out', `no ${key}: ${COMING_FIELDS[key]} is coming (issue #2031)`, RangeError);
    }
    if (!SETTING_FIELDS.includes(key)) {
      throw new TypeError(`Unknown settings field: ${key}. Allowed fields for kind icons: ${SETTING_FIELDS.filter(field => !DERIVED_FIELDS.includes(field)).join(', ')}.`);
    }
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > ICON_LIMITS.maximumItems) {
    throw invalidField('items', Array.isArray(input.items) ? input.items.length : typeof input.items, `a list of 1 to ${ICON_LIMITS.maximumItems} catalog GLB names (the count of items it holds is shown when it is a list)`, RangeError);
  }
  const size = input.size ?? 256;
  if (!ICON_LIMITS.sizes.includes(size)) throw invalidField('size', size, `one of ${ICON_LIMITS.sizes.join(', ')} (pixels per icon side)`, RangeError);
  const capacity = atlasCapacity(size);
  if (input.items.length > capacity) {
    throw invalidField('items', input.items.length, `at most ${capacity} items at size ${size} (the atlas side is capped at ${ICON_LIMITS.maximumAtlasSide} px), or a smaller size`, RangeError);
  }
  const style = input.style ?? 'clean';
  if (style === 'sketch') throw invalidField('style', 'sketch', 'clean or toon: the sketch style is coming (issue #2031)', RangeError);
  if (!ICON_LIMITS.styles.includes(style)) throw invalidField('style', String(style), `one of ${ICON_LIMITS.styles.join(', ')}`, RangeError);
  const scale = input.scale ?? 'fit';
  if (!ICON_LIMITS.scales.includes(scale)) throw invalidField('scale', String(scale), `fit (every item fills its frame) or relative (one scale for the set)`, RangeError);
  const padding = input.padding ?? ICON_LIMITS.defaultPadding;
  if (!Number.isFinite(padding) || padding < ICON_LIMITS.minimumPadding || padding > ICON_LIMITS.maximumPadding) {
    throw invalidField('padding', padding, `a fraction of the icon side from ${ICON_LIMITS.minimumPadding} to ${ICON_LIMITS.maximumPadding}`, RangeError);
  }
  const items = input.items.map(itemFrom);
  return { kind: 'icons', size, width: size, height: size, fps: 1, duration: 1, frameCount: items.length, transparent: true, items, style, viewpoint: viewFrom(input.viewpoint), scale, padding };
}

/** The lowercase unit vector from the subject toward the camera, and the camera's right and up axes, for a azimuth and elevation in degrees. */
export function cameraBasis({ azimuth, elevation }) {
  const azimuthRadians = azimuth * Math.PI / 180;
  const elevationRadians = elevation * Math.PI / 180;
  const toCamera = [Math.sin(azimuthRadians) * Math.cos(elevationRadians), Math.sin(elevationRadians), Math.cos(azimuthRadians) * Math.cos(elevationRadians)];
  const right = [Math.cos(azimuthRadians), 0, -Math.sin(azimuthRadians)];
  const up = [
    toCamera[1] * right[2] - toCamera[2] * right[1],
    toCamera[2] * right[0] - toCamera[0] * right[2],
    toCamera[0] * right[1] - toCamera[1] * right[0],
  ];
  return { toCamera, right, up };
}

/** A framing that holds the whole bounding sphere: the first guess, before any silhouette is measured. */
export function sphereFraming(bounds) {
  const center = [0, 1, 2].map(axis => (bounds.min[axis] + bounds.max[axis]) / 2);
  const radius = Math.max(1e-6, Math.hypot(...[0, 1, 2].map(axis => (bounds.max[axis] - bounds.min[axis]) / 2)));
  return { center, radius, orthoScale: radius * 2 };
}

/** The orthographic camera of a framing: square view, `orthoScale` metres tall, looking at the center along the view direction. */
export function cameraForFraming(framing, view) {
  const { toCamera } = cameraBasis(view);
  const distance = framing.radius * 3;
  return {
    eye: framing.center.map((value, axis) => value + toCamera[axis] * distance),
    target: [...framing.center],
    up: [0, 1, 0],
    projection: 'orthographic',
    orthoScale: framing.orthoScale,
    near: Math.max(0.001, distance - framing.radius * 1.1),
    far: distance + framing.radius * 1.1,
  };
}

/**
 * The fixed three-point rig: a key from above the camera's left, a fill and a rim from the studio's two fill lights, and a soft
 * ambient term. The key direction follows the view, so every icon of a set is lit from the same side of its own picture.
 */
export function lightRigEnvironment(view) {
  const { toCamera, right, up } = cameraBasis(view);
  const lightDirection = [0, 1, 2].map(axis => -right[axis] * 0.55 + up[axis] * 0.7 + toCamera[axis] * 0.6);
  const length = Math.hypot(...lightDirection);
  // No ground and no sky: an icon is the item alone on a transparent background.
  return { ground: false, world: false, lightDirection: lightDirection.map(value => value / length), keyIntensity: 1, fillIntensity: 0.6, ambientIntensity: 0.7 };
}

/** The line width of the toon style in output pixels: the same share of the picture at every size. */
export function toonLineWidth(size) {
  return Math.max(0.75, size / 128);
}

/** The scene recipe that draws one catalog asset as an icon: the asset at the origin, the light rig, and line art for toon. */
export function iconRecipe({ assetId, style, view, size }) {
  const environment = lightRigEnvironment(view);
  if (style === 'toon') environment.lines = { width: toonLineWidth(size), toon: 3 };
  return { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [{ id: 'icon', asset: { id: assetId } }], environment };
}

/** The pixel box of the pixels whose alpha passes `threshold`, with exclusive right and bottom, or null when nothing is drawn. */
export function alphaBounds(rgba, width, height, threshold = 1) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      if (rgba[(row * width + column) * 4 + 3] < threshold) continue;
      if (column < left) left = column;
      if (column > right) right = column;
      if (row < top) top = row;
      if (row > bottom) bottom = row;
    }
  }
  return right < 0 ? null : { left, top, right: right + 1, bottom: bottom + 1 };
}

/**
 * The framing that puts a measured silhouette in the middle of its icon. `fixedScale` keeps the view height (the relative
 * scale of a set); without it the view height changes so the longer side of the silhouette spans the icon minus its padding.
 * The view is orthographic, so a box measured in the picture maps back to the view plane by a plain ratio.
 */
export function refineFraming(framing, box, { size, view, padding, fixedScale }) {
  const metresPerPixel = framing.orthoScale / size;
  const { right, up } = cameraBasis(view);
  const shiftRight = ((box.left + box.right) / 2 - size / 2) * metresPerPixel;
  const shiftUp = -((box.top + box.bottom) / 2 - size / 2) * metresPerPixel;
  const center = framing.center.map((value, axis) => value + right[axis] * shiftRight + up[axis] * shiftUp);
  const extent = Math.max(box.right - box.left, box.bottom - box.top);
  const fitScale = framing.orthoScale * extent / (size * (1 - 2 * padding));
  return { center, radius: framing.radius, orthoScale: Math.max(framing.radius * 0.02, fixedScale ?? fitScale) };
}

/** Whether a silhouette sits in its frame: centred within a pixel, inside the edges, and (for `fit`) spanning the padded side within 2 pixels. */
export function isFramed(box, { size, padding, fit = true }) {
  const centeredColumn = Math.abs((box.left + box.right) / 2 - size / 2) <= 1;
  const centeredRow = Math.abs((box.top + box.bottom) / 2 - size / 2) <= 1;
  const inside = box.left >= 1 && box.top >= 1 && box.right <= size - 1 && box.bottom <= size - 1;
  if (!inside || !centeredColumn || !centeredRow) return false;
  if (!fit) return true;
  const extent = Math.max(box.right - box.left, box.bottom - box.top);
  return Math.abs(extent - size * (1 - 2 * padding)) <= 2;
}

/** The view height of the whole set at one scale: the largest fitted view height, so the biggest item fills its icon and the rest stay smaller. */
export function relativeScale(fittedScales) {
  return Math.max(...fittedScales);
}

/** A square grid of cells, row by row: the atlas rectangle of every item. */
export function layoutAtlas(count, size) {
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const rectangles = Array.from({ length: count }, (_, index) => ({ x: index % columns * size, y: Math.floor(index / columns) * size, width: size, height: size }));
  return { columns, rows, width: columns * size, height: rows * size, rectangles };
}

/** Unique, file-safe names for the items: the file name without folder or extension, with the item number added to a repeat. */
export function iconNames(sources) {
  const bases = sources.map(source => (source.split(/[\\/]/).pop() ?? source).replace(/\.glb$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'item');
  const counts = new Map();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  return bases.map((base, index) => (counts.get(base) > 1 ? `${base}-${index}` : base));
}

/** The icons.json document: plain JSON a game engine or web page reads without a converter. */
export function iconManifest({ settings, layout, entries }) {
  const names = iconNames(settings.items.map(item => item.source));
  return {
    version: 1,
    size: settings.size,
    style: settings.style,
    scale: settings.scale,
    padding: settings.padding,
    viewpoint: settings.viewpoint,
    atlas: { file: ICON_ARTIFACTS.atlas, width: layout.width, height: layout.height, columns: layout.columns, rows: layout.rows },
    icons: settings.items.map((item, index) => ({
      name: names[index],
      file: iconArtifactName(index),
      source: item.source,
      asset: item.asset,
      angle: settings.viewpoint.azimuth,
      rect: layout.rectangles[index],
      bounds: entries[index].bounds,
      viewHeight: entries[index].viewHeight,
    })),
  };
}

/** What `scene_capabilities` jobs reports for kind icons: the limits the validator enforces and the files a job writes. */
export const ICON_CAPABILITIES = Object.freeze({
  kind: 'icons',
  note: 'settings.kind icons draws each item (a catalog GLB name or asset id from scene_asset_catalog) as a transparent square icon with an orthographic three-quarter view, a fixed three-point light rig and a silhouette fit. Writes icon-<n>.png per item, atlas.png and icons.json (name, atlas rect, source, bounds). The submitted scene is not drawn.',
  maximumItems: ICON_LIMITS.maximumItems,
  sizes: ICON_LIMITS.sizes,
  styles: ICON_LIMITS.styles,
  comingStyles: Object.freeze(['sketch']),
  scales: ICON_LIMITS.scales,
  viewpoint: Object.freeze({ default: 'three-quarter', azimuth: ICON_LIMITS.defaultView.azimuth, elevation: ICON_LIMITS.defaultView.elevation, maximumElevation: ICON_LIMITS.maximumElevation }),
  padding: Object.freeze({ default: ICON_LIMITS.defaultPadding, minimum: ICON_LIMITS.minimumPadding, maximum: ICON_LIMITS.maximumPadding }),
  maximumAtlasSide: ICON_LIMITS.maximumAtlasSide,
  itemsPerSize: Object.freeze(Object.fromEntries(ICON_LIMITS.sizes.map(size => [size, Math.min(ICON_LIMITS.maximumItems, atlasCapacity(size))]))),
  notYet: Object.freeze(Object.keys(COMING_FIELDS)),
});
