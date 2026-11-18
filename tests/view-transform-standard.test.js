import assert from 'node:assert/strict';
import test from 'node:test';
import { toneMapToRgba8 } from '../src/path-tracer.js';
import { normalizeAgentLook } from '../src/agent-look.js';
import { fragmentShader, viewTransformShader } from '../src/shaders.js';
import { applyViewTransform, displayColor, srgbEncode, standardColor } from '../src/view-transform.js';
import { VIEW_TRANSFORM_NAMES } from '../src/view-transform-names.js';
import '../src/view-transform-shader.js';

const closeTo = (actual, expected, tolerance = 1e-4) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('standard is the sRGB curve with no tone mapping and clips above 1', () => {
  closeTo(srgbEncode(0), 0);
  closeTo(srgbEncode(0.0031308), 0.04045, 1e-5);
  closeTo(srgbEncode(0.18), 0.4614, 5e-4);
  closeTo(srgbEncode(1), 1);
  closeTo(srgbEncode(2), 1);
  closeTo(srgbEncode(-3), 0);
});

test('standard goes through the 1 / 2.2 power the renderer applies and comes out as the sRGB encoding', () => {
  const display = displayColor([0.18, 1, 4], { viewTransform: 'standard' });
  closeTo(display[0], srgbEncode(0.18));
  closeTo(display[1], 1);
  closeTo(display[2], 1);
  assert.deepEqual(standardColor([0, 0, 0]), [0, 0, 0]);
  assert.notDeepEqual(applyViewTransform('standard', [0.18, 0.18, 0.18]), applyViewTransform('neutral', [0.18, 0.18, 0.18]));
});

test('standard differs from neutral, which shifts shadows and compresses highlights', () => {
  const fireball = [6, 2.2, 0.3];
  const standard = displayColor(fireball, { viewTransform: 'standard' });
  const neutral = displayColor(fireball, { viewTransform: 'neutral' });
  assert.deepEqual(standard.map(value => Math.round(value * 255)), [255, 255, 149]);
  assert.ok(neutral[1] < standard[1] - 0.05, 'neutral compresses the highlight that standard clips');
});

test('the path tracer image and the shader apply it, and the default is untouched', () => {
  const linear = new Float32Array([0.18, 0.18, 0.18, 2, 2, 2]);
  const bytes = toneMapToRgba8(linear, 2, 1, { viewTransform: 'standard' });
  assert.deepEqual([...bytes], [118, 118, 118, 255, 255, 255, 255, 255]);
  const shader = viewTransformShader.apply(fragmentShader, 'main', 'standard', false);
  assert.ok(shader.includes('0.0031308') && shader.includes('selectedViewTransform(color)') && !shader.includes('2.51 * color'));
  assert.deepEqual([...toneMapToRgba8(linear, 2, 1)], [...toneMapToRgba8(linear, 2, 1, { viewTransform: 'aces' })]);
});

test('standard is accepted by the recipe, the names and the capabilities text', () => {
  assert.ok(VIEW_TRANSFORM_NAMES.includes('standard'));
  assert.equal(normalizeAgentLook({ environment: { viewTransform: 'standard' } }).environment.viewTransform, 'standard');
  assert.throws(() => normalizeAgentLook({ environment: { viewTransform: 'filmic' } }), /expected one of aces, agx, neutral, standard/);
});

test('a native film frame with standard falls back to the JavaScript path, so Cook needs no change', async () => {
  const { mapLookToCookPost } = await import('../scripts/native-post-look.mjs');
  const mapped = mapLookToCookPost({ viewTransform: 'standard' });
  assert.equal(mapped.post, undefined);
  assert.match(mapped.reason, /no "standard" view transform/);
});
