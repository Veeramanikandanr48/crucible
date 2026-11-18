# Pack: a recipe as a runtime-only web bundle

`crucible pack` compiles a recipe (`format: "crucible.scene"`) in Node into a compact data file, so a web page loads the renderer and the data but not the recipe compiler. The page uses a `<crucible-scene>` element: it shows a poster picture first, then swaps in live 3D when the scene is ready.

This is slice 1 of #2178. It packs a still scene. Scroll, hover and click triggers come in later slices.

## Pack a scene

```sh
npx crucible pack scene.json --out dist/scene
```

It writes into `dist/scene`:

| File | What it holds |
| --- | --- |
| `scene.pack` | the compiled parts (geometry as typed arrays), camera, lighting, effects and the shader modules the scene needs |
| `crucible-scene.js` and its chunks | the runtime: the `<crucible-scene>` element and the renderer |
| `poster.webp` | the poster: rendered from the recipe's camera, or the picture you passed with `--poster` (WebP, PNG or JPEG) |
| `index.html` | a page that uses all of the above |

## The poster

Pack renders the poster itself: it opens the bundle it just wrote in headless Chrome, lets the live element draw the recipe's camera view and saves the canvas as `poster.webp`. The poster is the picture the live 3D settles on, and the element shows it at once, before the renderer has loaded.

| Flag | What it does |
| --- | --- |
| `--poster-size <w>x<h>` | the poster size in pixels, default `1280x720`, each side from 64 to 2560 |
| `--poster <picture>` | use a WebP, PNG or JPEG you rendered instead of rendering one |
| `--no-poster` | write no poster; the element shows a dark box until the 3D is ready |

Rendering needs Chrome (set `CHROME_PATH` to its executable when it is not installed in the usual place). Without Chrome, pack stops and says to pass `--poster` or `--no-poster`.

`--runtime <file>` names a built `crucible-scene.js` when the package has no `build/` folder, such as in a source checkout.

Packing the same recipe twice writes the same `scene.pack` bytes.

## The element

```html
<script type="module" src="https://example.com/scene/crucible-scene.js"></script>
<crucible-scene src="https://example.com/scene/scene.pack" poster="https://example.com/scene/poster.webp" style="height: 480px"></crucible-scene>
```

- The poster draws at once. The element then loads the pack and the renderer, draws the scene and fades the poster out.
- The `state` attribute is `loading`, `live` or `error`. The element fires `crucible-scene-ready` or `crucible-scene-error` (with `detail.message`). After an error the poster stays.
- Changing `src` or `poster` reloads it. It draws again when it changes size.

`crucible-scene.js` imports no `agent-scene` module. `tests/scene-pack.test.js` checks the import graph.

## Baked light

A recipe `bake` section runs when you pack, in Node. The lightmaps it writes (one texture per part, one byte per channel) travel in `scene.pack`, and the page draws them: it traces no ray and loads no bake code.

A pack carries at most 262,144 lightmap texels (1 MB of raw bytes), a quarter of what a recipe build may trace, because the page downloads every texel. Past that, pack stops and names `bake.texelsPerUnit`: lower it, set `bake.preset` to `"draft"`, or bake fewer and smaller parts.

## What a pack refuses

Pack names the recipe field and what to change. For now it refuses `motion`, `timeline`, `physics`, `cloth`, `particles`, `game`, `postPasses`, `armatures`, `environment.sky`, `environment.hdri`, cascaded shadows, area lights, line art, material snippets and procedural material patterns. Scenes light with `environment.setup`. The automatic floor is not drawn: put a floor in the recipe.

## What it costs

Measured on `public/recipes/view-transform.json` (a lamp, six parts), Chrome, gzip of every file the page downloaded, with the same lighting and the same still:

| | Recipe build (compiler + renderer + recipe) | Packed bundle |
| --- | --- | --- |
| JavaScript | 232,047 B | 113,960 B |
| Data | the recipe JSON, inside the JavaScript | `scene.pack`, 114,681 B |
| Total | 232,182 B | 228,641 B |

The JavaScript halves. The data does not shrink for this scene, because the baked reflection probes of its two metal parts are 196 KB before gzip. A scene without baked probes pays much less data.

A baked room (`tests/fixtures/pack-baked-room.recipe.json` with `bake.preset` set to `"standard"`: six walls, a block, a ball and one lamp; 15,568 lightmap texels), 800 by 600 in GPU Chrome, gzip -9 of each file the page downloaded. This recipe build is bundled with esbuild and every agent-scene module, so its JavaScript is not comparable with the lamp table above:

| | Recipe build | Packed bundle |
| --- | --- | --- |
| JavaScript | 644,298 B | 110,728 B |
| Data | the recipe JSON, 552 B | `scene.pack`, 76,502 B |
| Total | 644,850 B | 187,230 B |
| Bake on the page | about 3.8 s of ray tracing in Node | none |

The two stills are pixel identical (RMSE 0, no pixel differs).
