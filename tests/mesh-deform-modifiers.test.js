import assert from 'node:assert/strict';
import test from 'node:test';
import { box, icoSphere, grid } from '../src/geometry.js';
import { editMesh, validateTopology, meshFromGeometry, applyMeshEdits, evaluateMeshStack, normalizeMeshEdits } from '../src/mesh.js';
import { createMeshData } from '../src/mesh-data.js';
import { withPositions } from '../src/mesh-field-edits.js';

const cube = () => meshFromGeometry(box(0, 1));
const run = (mesh, edit) => applyMeshEdits(mesh, [edit]).mesh;
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-4, `${message}: ${actual} against ${expected}`);

// A beam along x from 0 to 4, one unit square in section, split in four cells so a bend has something to bend.
function beam() {
  const positions = [];
  for (let step = 0; step <= 4; step++) positions.push(step, -0.5, -0.5, step, 0.5, -0.5, step, 0.5, 0.5, step, -0.5, 0.5);
  const faces = [];
  for (let step = 0; step < 4; step++) {
    for (let side = 0; side < 4; side++) {
      const next = (side + 1) % 4;
      faces.push([step * 4 + side, step * 4 + next, (step + 1) * 4 + next, (step + 1) * 4 + side]);
    }
  }
  const faceOffsets = Uint32Array.from({ length: faces.length + 1 }, (_, index) => index * 4);
  return createMeshData({ positions: Float32Array.from(positions), faceOffsets, cornerVertices: Uint32Array.from(faces.flat()) });
}

test('lattice moves a control point fully at its vertex and by the blend elsewhere, and keeps the topology', () => {
  const moved = run(cube(), { op: 'lattice', divisions: [2, 2, 2], moves: [{ point: [1, 1, 1], offset: [0, 0, 1] }] });
  validateTopology(editMesh(moved));
  const heights = Array.from({ length: moved.vertexCount }, (_, vertex) => moved.positions[vertex * 3 + 2]);
  near(Math.max(...heights), 1.5, 'the corner on the moved control point rises by the offset');
  near(Math.min(...heights), -0.5, 'the opposite face does not move');
  const threeWide = run(beam(), { op: 'lattice', divisions: [3, 2, 2], moves: [{ point: [1, 0, 0], offset: [0, 0, -1] }] });
  near(threeWide.positions[2 * 4 * 3 + 2], -1.5, 'the vertex on the middle control point follows it');
  near(threeWide.positions[2], -0.5, 'the end of the beam stays');
});

test('lattice refuses bad grids and moves with the limit in the message', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'lattice', divisions: [9, 2, 2] }]), /edits\[0\]\.divisions: got 9; expected a whole number from 2 to 8/);
  assert.throws(() => normalizeMeshEdits([{ op: 'lattice', divisions: [2, 2, 2], moves: [{ point: [2, 0, 0], offset: [0, 0, 1] }] }]), /edits\[0\]\.moves\[0\]\.point: got 2; expected a whole number from 0 to 1/);
  assert.throws(() => normalizeMeshEdits([{ op: 'lattice', moves: new Array(65).fill({ point: [0, 0, 0], offset: [0, 0, 0] }) }]), /at most 64/);
  assert.throws(() => normalizeMeshEdits([{ op: 'lattice', moves: [{ point: [0, 0, 0] }] }]), /edits\[0\]\.moves\[0\]\.offset: got undefined; expected an array of three numbers/);
});

test('curve leaves a beam alone on a straight path along its axis and bends it along an arc', () => {
  const straight = run(beam(), { op: 'curve', path: [[0, 0, 0], [4, 0, 0]], axis: 'x' });
  straight.positions.forEach((value, index) => near(value, beam().positions[index], `straight vertex ${index}`));
  const bent = run(beam(), { op: 'curve', path: [[0, 0, 0], [2, 0, 0], [3.5, 1.5, 0], [3.5, 3.5, 0]], axis: 'x' });
  validateTopology(editMesh(bent));
  const end = Array.from(bent.positions.subarray(16 * 3, 17 * 3));
  assert.ok(end[1] > 1, `the far end turned up to y ${end[1]}`);
  const sectionWidth = Math.hypot(bent.positions[17 * 3] - bent.positions[16 * 3], bent.positions[17 * 3 + 1] - bent.positions[16 * 3 + 1], bent.positions[17 * 3 + 2] - bent.positions[16 * 3 + 2]);
  near(sectionWidth, 1, 'the cross section keeps its size');
});

test('curve names its limits', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'curve', path: [[0, 0, 0]] }]), /edits\[0\]\.path: got \[\[0,0,0\]\]; expected an array of 2 to 64 points/);
  assert.throws(() => normalizeMeshEdits([{ op: 'curve', path: [[0, 0, 0], [1, 0, 0]], axis: 'q' }]), /edits\[0\]\.axis: got "q"; expected one of "x", "y", "z"/);
  assert.throws(() => run(beam(), { op: 'curve', path: [[1, 1, 1], [1, 1, 1]] }), /edits\[0\]\.path: got \[\[1,1,1\],\[1,1,1\]\]; expected points that are apart/);
});

test('hook pulls the vertices inside the radius by the falloff weight and none outside', () => {
  const pulled = run(cube(), { op: 'hook', center: [0.5, 0.5, 0.5], radius: 0.5, translation: [0, 0, 2], falloff: 'constant' });
  const raised = Array.from({ length: pulled.vertexCount }, (_, vertex) => pulled.positions[vertex * 3 + 2]).filter(value => value > 1);
  assert.equal(raised.length, 1);
  near(raised[0], 2.5, 'the one vertex at the centre moves the whole translation');
  const soft = run(cube(), { op: 'hook', center: [0.5, 0.5, 0.5], radius: 1.2, translation: [0, 0, 1], strength: 0.5 });
  assert.ok(soft.positions[2 + 3 * 6] > 0.5 && soft.positions[2 + 3 * 6] < 1.1);
  assert.throws(() => normalizeMeshEdits([{ op: 'hook', radius: 0 }]), /edits\[0\]\.radius: got 0; expected a number above 0/);
  assert.throws(() => normalizeMeshEdits([{ op: 'hook', falloff: 'sharp' }]), /edits\[0\]\.falloff: got "sharp"; expected one of smooth, linear, constant/);
  assert.throws(() => normalizeMeshEdits([{ op: 'hook', strength: 2 }]), /edits\[0\]\.strength: got 2; expected a number from 0 to 1/);
});

test('wave lifts vertices inside its ring along z, moves with time and can follow the normal', () => {
  const flat = createMeshData({
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    faceOffsets: Uint32Array.from([0, 4]),
    cornerVertices: Uint32Array.from([0, 1, 2, 3]),
  });
  const early = run(flat, { op: 'wave', time: 0 });
  assert.ok(early.positions[2] > 0, 'the vertex at the start is on the crest');
  const later = run(flat, { op: 'wave', time: 40, cyclic: false });
  assert.equal(later.positions[2], 0, 'the single ripple has left the face');
  const alongNormal = run(flat, { op: 'wave', normal: true });
  assert.ok(Math.abs(alongNormal.positions[2]) > 0 && alongNormal.positions[0] === 0);
  assert.throws(() => normalizeMeshEdits([{ op: 'wave', axes: 'z' }]), /edits\[0\]\.axes: got "z"; expected one of xy, x, y/);
  assert.throws(() => normalizeMeshEdits([{ op: 'wave', narrowness: 51 }]), /edits\[0\]\.narrowness: got 51; expected a number from 0 to 50/);
  assert.throws(() => normalizeMeshEdits([{ op: 'wave', start: [1] }]), /edits\[0\]\.start: got \[1\]; expected an array of two numbers/);
});

test('the deforming modifiers run as stack nodes', () => {
  const outcome = evaluateMeshStack(beam(), [
    { op: 'hook', center: [4, 0, 0], radius: 2, translation: [0, 1, 0] },
    { op: 'wave' },
    { op: 'lattice', moves: [{ point: [1, 1, 1], offset: [0, 0, 0.5] }] },
    { op: 'curve', path: [[0, 0, 0], [4, 0, 0]] },
  ]);
  assert.equal(outcome.results.length, 4);
  validateTopology(editMesh(outcome.mesh));
});

// The enclosed volume of a closed mesh from the signed volumes of the tetrahedra its faces make with the origin.
function enclosedVolume(mesh) {
  let volume = 0;
  for (let face = 0; face < mesh.faceCount; face++) {
    const corners = Array.from(mesh.cornerVertices.subarray(mesh.faceOffsets[face], mesh.faceOffsets[face + 1]));
    const point = vertex => [0, 1, 2].map(axis => mesh.positions[vertex * 3 + axis]);
    for (let fan = 1; fan + 1 < corners.length; fan++) {
      const [first, second, third] = [point(corners[0]), point(corners[fan]), point(corners[fan + 1])];
      volume += (first[0] * (second[1] * third[2] - second[2] * third[1]) - first[1] * (second[0] * third[2] - second[2] * third[0]) + first[2] * (second[0] * third[1] - second[1] * third[0])) / 6;
    }
  }
  return Math.abs(volume);
}

test('smooth_laplacian keeps the volume of a closed sphere where plain smooth shrinks it, and is deterministic', () => {
  const ball = meshFromGeometry(icoSphere(3));
  const before = enclosedVolume(ball);
  const kept = run(ball, { op: 'smooth_laplacian', factor: 0.5, iterations: 20 });
  const plain = run(ball, { op: 'smooth', factor: 0.5, iterations: 20 });
  const keptLoss = 1 - enclosedVolume(kept) / before;
  const plainLoss = 1 - enclosedVolume(plain) / before;
  assert.ok(Math.abs(keptLoss) < 0.02, `smooth_laplacian lost ${(keptLoss * 100).toFixed(2)} percent`);
  assert.ok(plainLoss > 0.05 && plainLoss > Math.abs(keptLoss) * 5, `plain smooth lost ${(plainLoss * 100).toFixed(2)} percent`);
  assert.deepEqual(run(ball, { op: 'smooth_laplacian', iterations: 20 }).positions, run(ball, { op: 'smooth_laplacian', iterations: 20 }).positions);
  const shrunk = run(ball, { op: 'smooth_laplacian', factor: 0.5, iterations: 20, preserveVolume: false });
  assert.ok(enclosedVolume(shrunk) < before * 0.95, 'preserveVolume false shrinks like plain smoothing');
});

test('smooth_laplacian pins the boundary of an open mesh and weights steps by a vertex group', () => {
  const sheet = meshFromGeometry(grid(6));
  const bumpyPositions = new Float32Array(sheet.positions);
  for (let vertex = 0; vertex < sheet.vertexCount; vertex++) bumpyPositions[vertex * 3 + 2] = (vertex % 3) * 0.2;
  const bumpy = withPositions(sheet, bumpyPositions);
  const smoothed = run(bumpy, { op: 'smooth_laplacian', iterations: 5 });
  const rim = vertex => Math.abs(Math.abs(sheet.positions[vertex * 3]) - 0.5) < 1e-6 || Math.abs(Math.abs(sheet.positions[vertex * 3 + 1]) - 0.5) < 1e-6;
  let rimCount = 0;
  let movedInside = 0;
  for (let vertex = 0; vertex < sheet.vertexCount; vertex++) {
    const moved = [0, 1, 2].some(axis => smoothed.positions[vertex * 3 + axis] !== bumpy.positions[vertex * 3 + axis]);
    if (rim(vertex)) {
      rimCount++;
      assert.equal(moved, false, `rim vertex ${vertex} stayed`);
    } else if (moved) movedInside++;
  }
  assert.ok(rimCount > 0 && movedInside > 0, 'the rim is found and the inside smooths');
  const freed = run(bumpy, { op: 'smooth_laplacian', iterations: 5, pinBoundary: false });
  assert.ok(Array.from({ length: sheet.vertexCount }, (_, vertex) => vertex).some(vertex => rim(vertex) && freed.positions[vertex * 3 + 2] !== bumpy.positions[vertex * 3 + 2]), 'pinBoundary false lets the rim move');
});

test('smooth_laplacian leaves vertices whose group weight is zero where they are', () => {
  const sheet = meshFromGeometry(grid(8));
  const grouped = run(sheet, { op: 'vertex_group', name: 'mask', gradient: { axis: 'x', range: [-0.5, 0.5], weights: [0, 1] } });
  const bumpyPositions = new Float32Array(grouped.positions);
  for (let vertex = 0; vertex < grouped.vertexCount; vertex++) bumpyPositions[vertex * 3 + 2] = (vertex % 3) * 0.2;
  const bumpy = withPositions(grouped, bumpyPositions);
  const smoothed = run(bumpy, { op: 'smooth_laplacian', iterations: 3, group: 'mask' });
  const weights = bumpy.attributes.point['group:mask'].data;
  let movedWeighted = 0;
  for (let vertex = 0; vertex < bumpy.vertexCount; vertex++) {
    const moved = smoothed.positions[vertex * 3 + 2] !== bumpy.positions[vertex * 3 + 2];
    if (weights[vertex] === 0) assert.equal(moved, false, `vertex ${vertex} has weight 0`);
    else if (moved) movedWeighted++;
  }
  assert.ok(movedWeighted > 0, 'weighted vertices smooth');
});

test('smooth_laplacian names its bad fields and unknown groups', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'smooth_laplacian', iterations: 0 }]), /edits\[0\]\.iterations: got 0; expected a whole number from 1 to 64/);
  assert.throws(() => normalizeMeshEdits([{ op: 'smooth_laplacian', factor: 0 }]), /edits\[0\]\.factor/);
  assert.throws(() => normalizeMeshEdits([{ op: 'smooth_laplacian', preserveVolume: 'yes' }]), /edits\[0\]\.preserveVolume/);
  assert.throws(() => normalizeMeshEdits([{ op: 'smooth_laplacian', group: '' }]), /edits\[0\]\.group/);
  assert.throws(() => run(cube(), { op: 'smooth_laplacian', group: 'nothing' }), /Mesh edit 0 \(smooth_laplacian\): Unknown vertex group nothing/);
});

test('warp lands the vertex at the from point on the target and leaves vertices beyond the radius', () => {
  const warped = run(beam(), { op: 'warp', from: [0, -0.5, -0.5], to: [0, -0.5, 1.5], radius: 1.2 });
  near(warped.positions[2], 1.5, 'the vertex at from lands on to');
  near(warped.positions[0], 0, 'x did not change');
  for (let vertex = 0; vertex < warped.vertexCount; vertex++) {
    const distance = Math.hypot(beam().positions[vertex * 3], beam().positions[vertex * 3 + 1] + 0.5, beam().positions[vertex * 3 + 2] + 0.5);
    const moved = [0, 1, 2].some(axis => warped.positions[vertex * 3 + axis] !== beam().positions[vertex * 3 + axis]);
    assert.equal(moved, distance < 1.2, `vertex ${vertex} at distance ${distance.toFixed(2)}`);
  }
  validateTopology(editMesh(warped));
});

test('warp twists about the axis between the points and names its bad fields', () => {
  const twisted = run(beam(), { op: 'warp', from: [0, 0, 0], to: [4, 0, 0], radius: 10, curve: 'constant', twist: 90 });
  near(twisted.positions[0 * 3 + 0], 4, 'the origin-side vertices moved along x by the full shift');
  near(twisted.positions[1], 0.5, 'the vertex (0,-0.5,-0.5) turned 90 degrees about x to (0, 0.5, -0.5), then shifted');
  near(twisted.positions[2], -0.5, 'z of the turned vertex');
  assert.throws(() => normalizeMeshEdits([{ op: 'warp', from: [0, 0, 0] }]), /edits\[0\]\.to: got undefined; expected an array of three numbers/);
  assert.throws(() => normalizeMeshEdits([{ op: 'warp', from: [0, 0, 0], to: [1, 0, 0], radius: -1 }]), /edits\[0\]\.radius/);
  assert.throws(() => normalizeMeshEdits([{ op: 'warp', from: [0, 0, 0], to: [1, 0, 0], curve: 'sharp' }]), /edits\[0\]\.curve: got "sharp"; expected one of/);
  assert.throws(() => normalizeMeshEdits([{ op: 'warp', from: [1, 1, 1], to: [1, 1, 1], twist: 30 }]), /edits\[0\]\.twist/);
});

test('smooth_laplacian and warp run as stack nodes', () => {
  const outcome = evaluateMeshStack(meshFromGeometry(icoSphere(2)), [
    { op: 'warp', from: [0, 0, 1], to: [0, 0, 1.5], radius: 0.8 },
    { op: 'smooth_laplacian', iterations: 4 },
  ]);
  assert.equal(outcome.results.length, 2);
  validateTopology(editMesh(outcome.mesh));
});
