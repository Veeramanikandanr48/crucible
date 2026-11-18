import test from 'node:test';
import assert from 'node:assert/strict';
import { ICON_CAPABILITIES, ICON_LIMITS, atlasCapacity, cameraBasis, cameraForFraming, iconNames, iconRecipe, layoutAtlas, lightRigEnvironment, normalizeIconSettings, sphereFraming } from '../src/icon-sheet.js';

const valid = { kind: 'icons', items: ['sword.glb'] };

test('defaults: 256 px, clean, fit, three-quarter view and the padding', () => {
  const settings = normalizeIconSettings(valid);
  assert.deepEqual({ size: settings.size, style: settings.style, scale: settings.scale, padding: settings.padding, viewpoint: settings.viewpoint },
    { size: 256, style: 'clean', scale: 'fit', padding: 0.08, viewpoint: { azimuth: 35, elevation: 25 } });
  assert.deepEqual(settings.items, [{ source: 'sword.glb' }]);
  assert.equal(settings.frameCount, 1);
  assert.equal(settings.transparent, true);
});

test('sketch is refused as coming, not as unknown', () => {
  assert.throws(() => normalizeIconSettings({ ...valid, style: 'sketch' }), /style: got "sketch"; expected clean or toon: the sketch style is coming/);
  assert.throws(() => normalizeIconSettings({ ...valid, style: 'pencil' }), /style: got "pencil"; expected one of clean, toon/);
});

test('fields left for later releases say they are coming', () => {
  for (const field of ['angles', 'breakdown', 'lighting', 'background', 'outline']) {
    assert.throws(() => normalizeIconSettings({ ...valid, [field]: 4 }), new RegExp(`settings.${field}: .*is coming`));
  }
  assert.throws(() => normalizeIconSettings({ ...valid, bogus: 1 }), /Unknown settings field: bogus/);
});

test('every field is checked and the error names it and what to pass', () => {
  const cases = [
    [{ items: [] }, /items: got 0; expected a list of 1 to 256/],
    [{ items: 'sword.glb' }, /items: got "string"; expected a list of 1 to 256/],
    [{ items: [7] }, /items\[0\]: got "number"; expected a catalog GLB name/],
    [{ items: ['https://example.com/a.glb'] }, /remote URLs are not accepted/],
    [{ items: ['a'.repeat(300)] }, /items\[0\]: got .* expected a catalog GLB name of 1 to 260/],
    [{ items: [{ source: 'a.glb', asset: 'xyz' }] }, /items\[0\]\.asset: got "xyz"; expected the 64 hexadecimal/],
    [{ size: 100 }, /size: got 100; expected one of 64, 128, 256, 512/],
    [{ scale: 'huge' }, /scale: got "huge"; expected fit/],
    [{ padding: 0.9 }, /padding: got 0.9; expected a fraction of the icon side from 0.02 to 0.4/],
    [{ padding: 0 }, /padding: got 0;/],
    [{ viewpoint: 'top' }, /viewpoint: got "string"; expected "three-quarter" or \{ azimuth, elevation \}/],
    [{ viewpoint: { azimuth: 200 } }, /viewpoint.azimuth: got 200; expected degrees from -180 to 180/],
    [{ viewpoint: { elevation: 90 } }, /viewpoint.elevation: got 90; expected degrees from -89 to 89/],
    [{ viewpoint: { roll: 1 } }, /viewpoint.roll/],
  ];
  for (const [overrides, pattern] of cases) assert.throws(() => normalizeIconSettings({ ...valid, ...overrides }), pattern, JSON.stringify(overrides).slice(0, 60));
});

test('the item count is bounded by 256 and by the atlas for the size', () => {
  const items = count => Array.from({ length: count }, (_, index) => `item-${index}.glb`);
  assert.equal(normalizeIconSettings({ kind: 'icons', items: items(256), size: 256 }).frameCount, 256);
  assert.throws(() => normalizeIconSettings({ kind: 'icons', items: items(257) }), /items: got 257; expected a list of 1 to 256/);
  assert.equal(atlasCapacity(512), 64);
  assert.throws(() => normalizeIconSettings({ kind: 'icons', items: items(65), size: 512 }), /items: got 65; expected at most 64 items at size 512/);
  assert.equal(normalizeIconSettings({ kind: 'icons', items: items(64), size: 512 }).frameCount, 64);
});

test('a view override replaces azimuth and elevation and keeps the other default', () => {
  assert.deepEqual(normalizeIconSettings({ ...valid, viewpoint: { azimuth: -45 } }).viewpoint, { azimuth: -45, elevation: 25 });
  assert.deepEqual(normalizeIconSettings({ ...valid, viewpoint: 'three-quarter' }).viewpoint, ICON_LIMITS.defaultView);
});

test('stored settings with the pinned item form normalise to themselves', () => {
  const asset = 'ab'.repeat(32);
  const settings = normalizeIconSettings({ ...valid, items: [{ source: 'sword.glb', asset }] });
  assert.deepEqual(settings.items, [{ source: 'sword.glb', asset }]);
  // The job store re-reads its records without the frame count, which it checks separately.
  const { frameCount, ...stored } = settings;
  assert.deepEqual(normalizeIconSettings(stored), settings);
});

test('the camera looks at the item from the view direction with an orthographic square frame', () => {
  const { toCamera, right, up } = cameraBasis({ azimuth: 0, elevation: 0 });
  const rounded = vector => vector.map(value => Math.round(value) + 0);
  assert.deepEqual(rounded(toCamera), [0, 0, 1]);
  assert.deepEqual(rounded(right), [1, 0, 0]);
  assert.deepEqual(rounded(up), [0, 1, 0]);
  const framing = sphereFraming({ min: [-1, 0, -1], max: [1, 2, 1] });
  assert.deepEqual(framing.center, [0, 1, 0]);
  const camera = cameraForFraming(framing, { azimuth: 35, elevation: 25 });
  assert.equal(camera.projection, 'orthographic');
  assert.equal(camera.orthoScale, framing.radius * 2);
  assert.ok(camera.near > 0 && camera.far > camera.near);
});

test('the light rig and toon lines come from the recipe, never from the caller', () => {
  const clean = iconRecipe({ assetId: 'ab'.repeat(32), style: 'clean', view: { azimuth: 35, elevation: 25 }, size: 256 });
  const toon = iconRecipe({ assetId: 'ab'.repeat(32), style: 'toon', view: { azimuth: 35, elevation: 25 }, size: 256 });
  assert.equal(clean.environment.lines, undefined);
  assert.deepEqual(toon.environment.lines, { width: 2, toon: 3 });
  assert.equal(clean.environment.ground, false);
  assert.equal(clean.environment.world, false);
  assert.deepEqual(lightRigEnvironment({ azimuth: 35, elevation: 25 }), clean.environment);
  assert.ok(Math.abs(Math.hypot(...clean.environment.lightDirection) - 1) < 1e-9);
  assert.deepEqual(clean.nodes, [{ id: 'icon', asset: { id: 'ab'.repeat(32) } }]);
});

test('the atlas is a near square grid and names stay unique', () => {
  const layout = layoutAtlas(9, 64);
  assert.deepEqual([layout.columns, layout.rows, layout.width, layout.height], [3, 3, 192, 192]);
  assert.deepEqual(layout.rectangles[4], { x: 64, y: 64, width: 64, height: 64 });
  assert.deepEqual(iconNames(['kenney/sword.glb', 'other\\sword.glb', 'chest.GLB']), ['sword-0', 'sword-1', 'chest']);
});

test('scene_capabilities reports the limits the validator enforces', () => {
  assert.equal(ICON_CAPABILITIES.maximumItems, 256);
  assert.deepEqual(ICON_CAPABILITIES.styles, ['clean', 'toon']);
  assert.deepEqual(ICON_CAPABILITIES.itemsPerSize, { 64: 256, 128: 256, 256: 256, 512: 64 });
  assert.ok(ICON_CAPABILITIES.notYet.includes('breakdown'));
});
