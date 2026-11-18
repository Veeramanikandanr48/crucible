// detailNoise on a grid volume (#1832): bounded and validated, applied while the grid is sampled (CPU tracer and the rasterizer's shader text), eroding the thin edge and not
// the core, and a grid volume without the field keeps its resolved object, packed buffers, shader text and traced bytes.
import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeVolumeGrid, decodeVolumeGrid, registerVolumeGrid } from '../src/volume-grid.js';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes, localVolumeGridSample, localVolumeProfile } from '../src/local-volumes.js';
import { bindLocalVolumeParts } from '../src/local-volume-parts.js';
import { createLocalVolumeCrossing } from '../src/path-tracer-volume.js';
import { createLocalVolumeCompositeFragment, createPostFragment } from '../src/post.js';
import { createHash } from 'node:crypto';
import { GRID_DETAIL_CORE_DENSITY } from '../src/local-volume-grid-detail.js';

const RESOLUTION = [8, 8, 8];

// Density rises along x from a thin rim (0.02) to a core above the erosion's core density, with flame and temperature everywhere.
function rampChannels() {
  const voxels = RESOLUTION[0] * RESOLUTION[1] * RESOLUTION[2];
  const channels = { density: new Float32Array(voxels), temperature: new Float32Array(voxels).fill(2000), flame: new Float32Array(voxels) };
  for (let index = 0; index < voxels; index++) {
    const along = (index % RESOLUTION[0]) / (RESOLUTION[0] - 1);
    channels.density[index] = 0.02 + 0.98 * along;
    channels.flame[index] = channels.density[index];
  }
  return channels;
}

registerVolumeGrid('detail-ramp', decodeVolumeGrid(encodeVolumeGrid({ resolution: RESOLUTION, channels: rampChannels() })));

const GRID = { shape: 'grid', grid: 'detail-ramp', center: [0, 0, 0], size: [8, 8, 8], density: 2, emissionStrength: 3, emission: [1, 0.5, 0.2], blackbodyIntensity: 0.5, temperatureScale: 1 };

function bound(extra = {}) {
  return bindLocalVolumeParts(resolveLocalVolumes([{ ...GRID, ...extra }]), [])[0];
}

test('detailNoise is bounded and its errors say what to pass', () => {
  const detail = field => () => resolveLocalVolumes([{ ...GRID, detailNoise: field }], 'environment.localVolumes');
  assert.deepEqual(resolveLocalVolumes([{ ...GRID, detailNoise: {} }])[0].detailNoise, { strength: 0.5, scale: 2, octaves: 1 });
  assert.deepEqual(resolveLocalVolumes([{ ...GRID, detailNoise: { strength: 1, scale: 64, octaves: 5 } }])[0].detailNoise, { strength: 1, scale: 64, octaves: 5 });
  assert.throws(detail(3), /environment\.localVolumes\[0\]\.detailNoise must be an object such as \{ strength: 0\.6, scale: 2, octaves: 3 \}/);
  assert.throws(detail({ strength: 1.5 }), /detailNoise\.strength must be between 0 and 1/);
  assert.throws(detail({ scale: 0.1 }), /detailNoise\.scale must be between 0\.25 and 64/);
  assert.throws(detail({ octaves: 6 }), /detailNoise\.octaves must be a whole number from 1 to 5/);
  assert.throws(detail({ octaves: 2.5 }), /detailNoise\.octaves must be a whole number from 1 to 5/);
  assert.throws(detail({ strengh: 0.2 }), /detailNoise has no field "strengh"; use strength, scale, octaves/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'sphere', center: [0, 0, 0], radius: 1, detailNoise: {} }]), /detailNoise belongs to shape "grid"/);
});

test('a grid volume without the field resolves, packs and compiles as before, and a resolved one resolves again', () => {
  const [plain] = resolveLocalVolumes([GRID]);
  assert.equal('detailNoise' in plain, false);
  const [resolved] = resolveLocalVolumes([{ ...GRID, detailNoise: { strength: 0.3, scale: 2, octaves: 3 } }]);
  assert.deepEqual(resolveLocalVolumes([resolved])[0], resolved);
  const plainBuffers = packLocalVolumes([bound()], createLocalVolumeBuffers());
  assert.deepEqual(Array.from(plainBuffers.gridDetail), [0, 0, 0, 0]);
  const detailBuffers = packLocalVolumes([bound({ detailNoise: { strength: 0.25, scale: 2, octaves: 3 } })], createLocalVolumeBuffers());
  assert.deepEqual(Array.from(detailBuffers.gridDetail), [0.25, 2, 3, 0]);
  assert.equal(createLocalVolumeCompositeFragment(false, 'grid', false, false), createLocalVolumeCompositeFragment(false, 'grid'));
  assert.equal(createLocalVolumeCompositeFragment(false, 'both', true, false), createLocalVolumeCompositeFragment(false, 'both', true));
  assert.ok(!/localGridDetail|LocalGridDetail/.test(createLocalVolumeCompositeFragment(true, 'grid')));
});

// Taken on main (509707b3, after #1736 and #1735) without #1832: every local-volume composite variant (motion, kind, octaves) and the full post pass, hashed together. A frame without detail noise must not move it.
test('every shader a frame without detail noise compiles is the text main compiled', () => {
  const hash = createHash('sha256');
  for (const motion of [false, true]) {
    for (const kind of ['both', 'grid', 'shape']) {
      for (const octaves of [false, true]) hash.update(createLocalVolumeCompositeFragment(motion, kind, octaves));
    }
  }
  hash.update(createPostFragment());
  assert.equal(hash.digest('hex'), '9a39db46fab1305a50e508b30eb95dac18c96aef14796f45b619adaf6ef3128a');
});

test('the shader of a frame with detail noise carries the erosion in the grid sampler and the blackbody tap', () => {
  const source = createLocalVolumeCompositeFragment(false, 'grid', false, true);
  assert.match(source, /uniform vec4 localGridDetail;/);
  assert.match(source, /float localVolumeFractalNoise\(vec3 position, int octaves\)/, 'a grid-only frame compiles the noise it did not have');
  assert.match(source, /cell\.x \*= kept;\s*cell\.z \*= kept;/);
  assert.match(source, /radiance \*= localGridDetailKept\(/);
  assert.ok(source.length > createLocalVolumeCompositeFragment(false, 'grid').length);
});

test('the sampler leaves a core alone, erodes a thin rim, and takes flame and blackbody with the density', () => {
  const plain = bound();
  const eroded = bound({ detailNoise: { strength: 0.2, scale: 1, octaves: 3 } });
  const zero = bound({ detailNoise: { strength: 0, scale: 1, octaves: 3 } });
  const plainCell = new Float64Array(6);
  const erodedCell = new Float64Array(6);
  let rimLoss = 0;
  let rimSamples = 0;
  let coreChanged = 0;
  const distinctRim = new Set();
  for (let y = -3.5; y <= 3.5; y += 0.5) {
    for (let z = -3.5; z <= 3.5; z += 0.5) {
      for (let x = -3.9; x <= 3.9; x += 0.3) {
        localVolumeGridSample(plain, x, y, z, plainCell, true);
        localVolumeGridSample(eroded, x, y, z, erodedCell, true);
        assert.deepEqual(Array.from(localVolumeGridSample(zero, x, y, z, new Float64Array(6), true)), Array.from(plainCell), 'strength 0 is the plain sample');
        assert.ok(erodedCell[0] <= plainCell[0] + 1e-12);
        if (plainCell[0] >= GRID_DETAIL_CORE_DENSITY) {
          if (erodedCell[0] !== plainCell[0]) coreChanged++;
        } else if (plainCell[0] > 0) {
          rimLoss += plainCell[0] - erodedCell[0];
          rimSamples++;
          distinctRim.add(erodedCell[0].toFixed(6));
          const kept = erodedCell[0] / plainCell[0];
          assert.ok(Math.abs(erodedCell[2] - plainCell[2] * kept) < 1e-9, 'flame shrinks with the density');
          assert.ok(Math.abs(erodedCell[4] - plainCell[4] * kept) <= 1e-9 * Math.max(1, plainCell[4]), 'blackbody shrinks with the density');
          assert.equal(erodedCell[1], plainCell[1], 'temperature is a state and stays');
        }
      }
    }
  }
  assert.equal(coreChanged, 0, 'a cell at or above the core density is untouched');
  assert.ok(rimSamples > 100 && rimLoss / rimSamples > 0.01, `the rim lost ${rimLoss / rimSamples} of density on average`);
  assert.ok(distinctRim.size > 50, 'the erosion is a field, not a constant');
  assert.equal(localVolumeProfile(eroded, 0.1, 0.2, 0.3), localVolumeProfile(eroded, 0.1, 0.2, 0.3), 'deterministic');
  assert.ok(localVolumeProfile(eroded, -3, 0.2, 0.3) < localVolumeProfile(plain, -3, 0.2, 0.3) + 1e-12);
});

test('the CPU tracer crosses the same bytes with strength 0 as without the field, and different bytes with it', () => {
  const lighting = { ambient: [0.2, 0.3, 0.4], sun: { direction: [0.3, 0.8, 0.5], color: [1, 0.9, 0.8] }, sunVisibility: () => 1 };
  const trace = extra => {
    const crossing = createLocalVolumeCrossing([bound({ scatter: 0.4, ...extra })], lighting);
    const values = [];
    for (const jitter of [0.1, 0.5, 0.9]) {
      const throughput = [1, 1, 1];
      const emitted = [0, 0, 0];
      crossing(-6, 0.2, 0.1, 1, 0, 0, 12, jitter, throughput, emitted);
      values.push(...throughput, ...emitted);
    }
    return values;
  };
  const plain = trace({});
  assert.deepEqual(trace({ detailNoise: { strength: 0, scale: 1, octaves: 3 } }), plain);
  assert.notDeepEqual(trace({ detailNoise: { strength: 0.3, scale: 1, octaves: 3 } }), plain);
});
