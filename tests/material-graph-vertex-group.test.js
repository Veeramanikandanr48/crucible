import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { compileMaterialGraph } from '../src/material-graph.js';
import { bakeMaterialPattern, normalizeMaterialPattern } from '../src/material-patterns.js';
import { vertexGroupMap } from '../src/material-vertex-group-map.js';
import { packAtlas } from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

const EDGE_GRAPH = { color: { mul: [[1, 1, 1], { vertexGroup: { name: 'edge' } }] } };

function recipeWith({ edits, pattern, geometryId = 'hatch' }) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{
      id: geometryId,
      type: 'mesh',
      base: { type: 'box', bevel: 0, subdivisions: 1 },
      edits: [
        { op: 'subdivide_edges', edges: { all: true }, cuts: 3 },
        { op: 'vertex_group', name: 'edge', measure: 'edge', angle: 45 },
        ...edits,
      ],
    }],
    materials: [{ id: 'paint', pattern }],
    nodes: [{ id: 'hatch', geometry: geometryId, material: 'paint' }],
  };
}

const withUvs = [{ op: 'uv_project', mode: 'cube' }];
const graphPattern = (graph, extra = {}) => ({ type: 'graph', mapping: 'uv', resolution: 256, graph, ...extra });

function redChannel(texture) {
  const { data } = texture.image;
  const values = [];
  for (let offset = 0; offset < data.length; offset += 4) values.push(data[offset]);
  return values;
}

test('vertexGroup validates its name without a mesh and costs work units', () => {
  assert.ok(compileMaterialGraph(EDGE_GRAPH).outputs.color);
  for (const bad of [{ vertexGroup: {} }, { vertexGroup: { name: '' } }, { vertexGroup: { name: 4 } }, { vertexGroup: { name: 'edge', extra: 1 } }]) {
    assert.throws(() => compileMaterialGraph({ roughness: bad }), /vertexGroup/);
  }
});

test('a graph with vertexGroup needs uv mapping', () => {
  assert.throws(() => normalizeMaterialPattern({ type: 'graph', graph: EDGE_GRAPH }), /vertexGroup.*"mapping": "uv"/);
  assert.ok(normalizeMaterialPattern(graphPattern(EDGE_GRAPH)));
});

test('the weight map holds the triangle blend of the vertex weights and spreads past the island edge', () => {
  const geometry = {
    indices: Uint32Array.from([0, 1, 2]),
    uvs: Float32Array.from([0.25, 0.25, 0.75, 0.25, 0.25, 0.75]),
    vertexGroups: { edge: Float32Array.from([0, 1, 1]) },
  };
  const map = vertexGroupMap(geometry, 'edge', 256, 'quad');
  const at = (column, row) => map.data[(row * 256 + column) * 4];
  assert.ok(Math.abs(at(100, 100) - 147) <= 2, 'the blend at (0.3945, 0.3945) is 1 - barycentric weight of the weight-0 corner');
  assert.ok(at(100, 120) > at(100, 100), 'weight rises toward the weight-1 corners');
  assert.ok(at(62, 100) > 0, 'dilation fills the texel just outside the triangle');
  assert.equal(at(50, 100), 0, 'texels beyond the spread stay empty');
  assert.equal(at(250, 250), 0, 'texels far from any island stay empty');
  assert.equal(vertexGroupMap(geometry, 'edge', 256, 'quad'), map, 'the map is cached per geometry');
});

test('a mesh without UVs or without the group is refused with what to pass', () => {
  assert.throws(() => createAgentScene(recipeWith({ edits: [], pattern: graphPattern(EDGE_GRAPH) })), /vertexGroup: got "edge"; expected a mesh with UVs \(node hatch has none\)/);
  const missing = graphPattern({ color: { vertexGroup: { name: 'rust' } } });
  assert.throws(() => createAgentScene(recipeWith({ edits: withUvs, pattern: missing })), /got "rust".*known groups: edge/);
});

test('the part bakes the graph with its own mesh weights; a graph without the node is unchanged', () => {
  const scene = createAgentScene(recipeWith({ edits: withUvs, pattern: graphPattern(EDGE_GRAPH) }));
  const [part] = scene.parts;
  const baked = redChannel(part.material.map);
  assert.ok(baked.some(value => value > 200), 'texels at the edge group are bright');
  assert.ok(baked.some(value => value < 40), 'texels away from it are dark');
  assert.equal(part.material.map, part.material.map, 'the texture is stable between reads');
  const rebuilt = createAgentScene(recipeWith({ edits: withUvs, pattern: graphPattern(EDGE_GRAPH) })).parts[0];
  assert.deepEqual(redChannel(rebuilt.material.map), baked, 'baking is deterministic');

  const plainPattern = graphPattern({ color: [0.4, 0.5, 0.6] });
  const plain = createAgentScene(recipeWith({ edits: withUvs, pattern: plainPattern })).parts[0];
  const direct = bakeMaterialPattern(normalizeMaterialPattern(plainPattern));
  assert.deepEqual(redChannel(plain.material.map), redChannel(direct.map), 'a graph without the node bakes exactly as before');
});

test('the baked weight map reaches the GPU tracer texture list and the atlas holds its texels', () => {
  const scene = createAgentScene(recipeWith({ edits: withUvs, pattern: graphPattern(EDGE_GRAPH) }));
  const traced = buildTraceScene(scene.parts, {});
  const [material] = traced.materials;
  assert.ok(material.texture, 'the traced material carries the baked graph as its colour texture');
  const baked = redChannel(scene.parts[0].material.map);
  assert.equal(material.texture.width * material.texture.height, baked.length);
  const atlas = packAtlas(traced.materials);
  const placement = atlas.placements.get(material.texture.data);
  assert.ok(placement, 'the atlas placed the baked texture');
  const atlasTexels = [];
  for (let row = 0; row < material.texture.height; row++) {
    const start = ((placement.y + row) * atlas.width + placement.x) * 4;
    for (let column = 0; column < material.texture.width; column++) atlasTexels.push(atlas.data[start + column * 4]);
  }
  assert.ok(atlasTexels.some(value => value > 200) && atlasTexels.some(value => value < 40), 'the atlas keeps the bright edge and dark interior of the weight map');
});
