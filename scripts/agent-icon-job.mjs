// The `icons` render job: draws each item as a transparent square icon, frames its silhouette, and writes one PNG per item,
// an atlas of all of them and icons.json. The browser side is passed in as `openItem`, so the loop runs without a page.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ICON_ARTIFACTS, alphaBounds, cameraForFraming, iconArtifactName, iconManifest, isFramed, layoutAtlas, refineFraming, relativeScale, sphereFraming } from '../src/icon-sheet.js';
import { blankImage, copyIntoAtlas, decodePng, encodePng } from './agent-icon-png.mjs';

/** Draws and measures at most this many times per item: the sphere guess, then up to three refinements. */
const MAXIMUM_DRAWS = 4;
const PNG_MIME = 'image/png';

function drewNothingError(settings, index) {
  const { source } = settings.items[index];
  return new Error(`items[${index}] (${source}) drew no pixels. Check that the GLB has visible, opaque geometry in front of the camera.`);
}

function tooSmallForRelativeError(settings, index, sizeRatio) {
  const { source } = settings.items[index];
  return new Error(`items[${index}] (${source}) is too small for scale "relative": the largest item of the set is about ${Math.round(sizeRatio)} times its size, so it draws under one pixel. Use scale "fit", or give the set consistent units.`);
}

function notFramedError(settings, index, box) {
  const { source } = settings.items[index];
  return new Error(`items[${index}] (${source}) could not be framed in ${MAXIMUM_DRAWS} draws: its silhouette spans ${box.left},${box.top} to ${box.right},${box.bottom} of ${settings.size} px. Try a smaller padding or another view.`);
}

/**
 * Draws one item until its silhouette is centred and inside the icon: a first guess from the bounding sphere, then each measured
 * box moves the camera. With `fixedScale` the view height stays, so a set keeps one scale.
 */
async function frameItem({ item, index, settings, startFraming, fixedScale, signal }) {
  const { size, viewpoint: view, padding } = settings;
  let framing = startFraming;
  for (let draw = 1; draw <= MAXIMUM_DRAWS; draw++) {
    signal.throwIfAborted();
    const image = decodePng(await item.draw(cameraForFraming(framing, view)));
    if (image.width !== size || image.height !== size) throw new Error(`items[${index}] was drawn at ${image.width}x${image.height}, not ${size}x${size}. The render budget may have reduced the frame; raise --memory.`);
    const box = alphaBounds(image.data, size, size);
    if (!box) throw fixedScale === undefined ? drewNothingError(settings, index) : tooSmallForRelativeError(settings, index, fixedScale / startFraming.fittedScale);
    if (isFramed(box, { size, padding, fit: fixedScale === undefined })) return { framing, image, box };
    if (draw === MAXIMUM_DRAWS) throw notFramedError(settings, index, box);
    framing = refineFraming(framing, box, { size, view, padding, fixedScale });
  }
  throw notFramedError(settings, index, { left: 0, top: 0, right: 0, bottom: 0 });
}

function entryOf({ framing, box }) {
  return { bounds: { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }, viewHeight: Number(framing.orthoScale.toPrecision(7)) };
}

/**
 * Runs the job. `openItem(item, index)` resolves to `{ bounds, draw(camera), close() }`: the item's world bounds, a function that
 * draws it with a camera and returns a transparent PNG of the icon size, and a release. Returns the runner result the job store reads.
 */
export async function renderIconJob({ settings, directory, signal, progress, openItem }) {
  const layout = layoutAtlas(settings.items.length, settings.size);
  const atlas = blankImage(layout.width, layout.height);
  const artifacts = [];
  const entries = [];
  const fitted = [];

  async function withItem(index, work) {
    const item = await openItem(settings.items[index], index);
    try { return await work(item); }
    finally { await item.close(); }
  }

  async function keep(index, image, framed) {
    copyIntoAtlas(atlas, image, layout.rectangles[index].x, layout.rectangles[index].y);
    const filename = iconArtifactName(index);
    await writeFile(join(directory, `${filename}.partial`), encodePng(image), { flag: 'wx' });
    artifacts.push({ temporary: `${filename}.partial`, filename, mimeType: PNG_MIME });
    entries[index] = entryOf(framed);
  }

  for (let index = 0; index < settings.items.length; index++) {
    signal.throwIfAborted();
    const framed = await withItem(index, async item => frameItem({ item, index, settings, startFraming: sphereFraming(item.bounds), signal }));
    fitted[index] = framed.framing;
    if (settings.scale === 'fit') await keep(index, framed.image, framed);
    await progress({ frames: index + 1, maximumPendingFrames: 0 });
  }

  if (settings.scale === 'relative') {
    const fixedScale = relativeScale(fitted.map(framing => framing.orthoScale));
    for (let index = 0; index < settings.items.length; index++) {
      signal.throwIfAborted();
      const startFraming = { ...fitted[index], fittedScale: fitted[index].orthoScale, orthoScale: fixedScale };
      const framed = await withItem(index, item => frameItem({ item, index, settings, startFraming, fixedScale, signal }));
      await keep(index, framed.image, framed);
    }
  }

  const atlasName = ICON_ARTIFACTS.atlas;
  await writeFile(join(directory, `${atlasName}.partial`), encodePng(atlas), { flag: 'wx' });
  artifacts.push({ temporary: `${atlasName}.partial`, filename: atlasName, mimeType: PNG_MIME });
  const manifestName = ICON_ARTIFACTS.manifest;
  await writeFile(join(directory, `${manifestName}.partial`), `${JSON.stringify(iconManifest({ settings, layout, entries }), null, 2)}\n`, { flag: 'wx' });
  artifacts.push({ temporary: `${manifestName}.partial`, filename: manifestName, mimeType: 'application/json' });
  return { artifacts, metrics: { icons: settings.items.length, atlasWidth: layout.width, atlasHeight: layout.height } };
}
