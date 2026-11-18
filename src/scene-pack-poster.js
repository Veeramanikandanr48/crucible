// Renders the poster of a packed scene (docs/pack.md): the bundle `crucible pack` just wrote is opened in headless Chrome, the
// live <crucible-scene> draws the recipe's camera view, and the canvas is saved as a WebP. The poster is therefore the same
// picture the live element shows, drawn by the renderer the page ships (no second renderer).
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { indexHtml } from './scene-pack.js';

export const POSTER_FILE_NAME = 'poster.webp';
export const POSTER_DEFAULT_SIZE = Object.freeze({ width: 1280, height: 720 });
export const POSTER_SIZE_LIMITS = Object.freeze({ minimum: 64, maximum: 2560 });
const POSTER_WEBP_QUALITY = 0.85;
const RENDER_TIMEOUT_MS = 60000;
const CONTENT_TYPES = Object.freeze({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.pack': 'application/octet-stream' });

/** Reads `--poster-size 1280x720`: two integers from 64 to 2560, so a bad value fails before any browser starts. */
export function parsePosterSize(text) {
  const match = /^(\d+)x(\d+)$/.exec(String(text).trim());
  if (!match) throw new TypeError(`--poster-size: got ${JSON.stringify(text)}; pass <width>x<height>, such as 1280x720.`);
  const [width, height] = [Number(match[1]), Number(match[2])];
  const { minimum, maximum } = POSTER_SIZE_LIMITS;
  if (![width, height].every(side => side >= minimum && side <= maximum)) {
    throw new RangeError(`--poster-size: ${width}x${height} is out of range; each side must be from ${minimum} to ${maximum}.`);
  }
  return { width, height };
}

function chromeUnavailable(error) {
  return new Error(`poster: headless Chrome did not start (${error.message.split('\n')[0]}). Install Chrome or set CHROME_PATH to its executable; or pass --poster <picture.webp> to use a picture you rendered, or --no-poster to pack without one.`);
}

// Chrome cannot fetch ES modules from file://, so the bundle is served from a loopback server that reads only its own folder.
function serveFolder(folder) {
  const server = createServer(async (request, response) => {
    const requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const path = resolve(folder, requested === '/' ? 'index.html' : `.${requested}`);
    if (!path.startsWith(folder + sep) || !(extname(path) in CONTENT_TYPES)) {
      response.writeHead(404).end();
      return;
    }
    try {
      response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(path)] }).end(await readFile(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function launchChrome() {
  const { chromium } = await import('playwright-core');
  const args = ['--enable-webgl', '--ignore-gpu-blocklist'];
  const launchOptions = process.env.CHROME_PATH ? { headless: true, args, executablePath: process.env.CHROME_PATH } : { headless: true, args, channel: 'chrome' };
  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    throw chromeUnavailable(error);
  }
}

// The screenshot is PNG; the page re-encodes it as WebP, so the repo needs no encoder.
const ENCODE_WEBP = async ({ png, quality }) => {
  const image = new Image();
  image.src = `data:image/png;base64,${png}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d').drawImage(image, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
  if (!blob || blob.type !== 'image/webp') throw new Error('this Chrome cannot encode WebP');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};

/** Opens `<bundleFolder>/index.html` at the poster size and returns the live scene as WebP bytes. */
export async function renderPosterWebp(bundleFolder, { width, height } = POSTER_DEFAULT_SIZE) {
  const folder = resolve(bundleFolder);
  const server = await serveFolder(folder);
  let browser;
  try {
    browser = await launchChrome();
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    const outcome = await page.waitForFunction(() => {
      const element = document.querySelector('crucible-scene');
      return element.getAttribute('state') !== 'loading' ? element.getAttribute('state') : false;
    }).then(handle => handle.jsonValue());
    if (outcome !== 'live') throw new Error('poster: the packed scene did not draw in Chrome; open the pack in a page and read the console, or pass --poster <picture.webp>.');
    // The element fades its canvas in (240 ms); a screenshot taken before the fade ends is a darkened picture.
    await page.evaluate(async () => {
      const element = document.querySelector('crucible-scene');
      await Promise.all(element.shadowRoot.getAnimations({ subtree: true }).map(animation => animation.finished));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const png = (await page.screenshot({ type: 'png' })).toString('base64');
    return Buffer.from(await page.evaluate(ENCODE_WEBP, { png, quality: POSTER_WEBP_QUALITY }), 'base64');
  } finally {
    await browser?.close();
    server.close();
  }
}

/** Renders the poster of the bundle in `outDir` and writes `<outDir>/poster.webp`. Returns the file name. */
export async function writePosterFile(outDir, size) {
  await writeFile(join(outDir, POSTER_FILE_NAME), await renderPosterWebp(outDir, size));
  return POSTER_FILE_NAME;
}

/** After `packRecipeFile` wrote a bundle without a poster: renders one, then rewrites index.html so the element uses it. */
export async function addGeneratedPoster({ outDir, title, size = POSTER_DEFAULT_SIZE }) {
  const posterName = await writePosterFile(outDir, size);
  await writeFile(join(outDir, 'index.html'), indexHtml({ title, posterName }));
  return posterName;
}
