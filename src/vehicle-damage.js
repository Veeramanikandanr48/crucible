import { invalidField } from './field-error.js';

// Crash damage for vehicles. A hit is an impulse (N s). Body parts dent in proportion to it, loose parts come off above a
// threshold, and a driven path can be searched for the moment it meets a wall. Everything here is a pure function of its
// inputs, so the same crash gives the same bytes on every run.

export const MAX_DENT_IMPACTS = 8;
export const MAX_DENT_VERTICES = 4096;
export const DEFAULT_DENT_STIFFNESS = 2000;
export const DEFAULT_DENT_MAX_DEPTH = 0.25;
export const DEFAULT_DENT_RADIUS = 0.4;
export const MAX_DENT_DEPTH_LIMIT = 2;
export const MAX_DETACHABLE_PARTS = 32;

const DENT_FIELDS = ['stiffness', 'maxDepth', 'radius', 'impacts'];
const IMPACT_FIELDS = ['point', 'direction', 'impulse'];
const DEFAULT_SEARCH_STEP_SECONDS = 1 / 60;
const MAX_SEARCH_SAMPLES = 100000;

function requirePlainObject(value, path, example) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidField(path, value, `a plain object, such as ${example}`, TypeError);
  }
}

function rejectUnknownFields(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalidField(`${path}.${key}`, value[key], `no such field; use one of ${allowed.join(', ')}`, TypeError);
    }
  }
}

function requireNumber(value, path, minimum, maximum, example) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidField(path, value, `a number from ${minimum} to ${maximum}, such as ${example}`);
  }
  return value;
}

function requireVector3(value, path, example) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
    throw invalidField(path, value, `three finite numbers, such as ${example}`);
  }
  return value;
}

function normalized(vector) {
  const length = Math.hypot(...vector);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

/**
 * Check a dent definition: `{ impacts: [{ point, direction, impulse }], stiffness, maxDepth, radius }`.
 * Returns the definition with its defaults filled in and every direction as a unit vector.
 */
export function normalizeDent(definition, path = 'dent') {
  const field = name => (path ? `${path}.${name}` : name);
  requirePlainObject(definition, path || 'dented geometry', '{ "impacts": [{ "point": [0, 0.5, 2], "direction": [0, 0, -1], "impulse": 3000 }] }');
  rejectUnknownFields(definition, DENT_FIELDS, path);
  const stiffness = requireNumber(definition.stiffness ?? DEFAULT_DENT_STIFFNESS, field('stiffness'), 1e-6, 1e9, DEFAULT_DENT_STIFFNESS);
  const maxDepth = requireNumber(definition.maxDepth ?? DEFAULT_DENT_MAX_DEPTH, field('maxDepth'), 1e-6, MAX_DENT_DEPTH_LIMIT, DEFAULT_DENT_MAX_DEPTH);
  const radius = requireNumber(definition.radius ?? DEFAULT_DENT_RADIUS, field('radius'), 1e-6, 100, DEFAULT_DENT_RADIUS);
  const impacts = definition.impacts;
  if (!Array.isArray(impacts) || impacts.length < 1 || impacts.length > MAX_DENT_IMPACTS) {
    throw invalidField(field('impacts'), impacts, `a list of 1 to ${MAX_DENT_IMPACTS} impacts, such as [{ "point": [0, 0.5, 2], "direction": [0, 0, -1], "impulse": 3000 }]`);
  }
  const checkedImpacts = impacts.map((impact, index) => {
    const impactPath = `${field('impacts')}[${index}]`;
    requirePlainObject(impact, impactPath, '{ "point": [0, 0.5, 2], "direction": [0, 0, -1], "impulse": 3000 }');
    rejectUnknownFields(impact, IMPACT_FIELDS, impactPath);
    const point = requireVector3(impact.point, `${impactPath}.point`, '[0, 0.5, 2], a point on the part in its own space');
    const direction = requireVector3(impact.direction, `${impactPath}.direction`, '[0, 0, -1], the way the hit pushes the surface');
    if (Math.hypot(...direction) < 1e-6) {
      throw invalidField(`${impactPath}.direction`, direction, 'a vector that is not zero, such as [0, 0, -1]');
    }
    const impulse = requireNumber(impact.impulse, `${impactPath}.impulse`, 0, 1e9, 3000);
    return { point: [...point], direction: normalized(direction), impulse };
  });
  return { stiffness, maxDepth, radius, impacts: checkedImpacts };
}

/** How far a hit pushes the surface in, in metres: the impulse over the stiffness, never past `maxDepth`. */
export function dentDepth(impulse, { stiffness = DEFAULT_DENT_STIFFNESS, maxDepth = DEFAULT_DENT_MAX_DEPTH } = {}) {
  return Math.min(maxDepth, impulse / stiffness);
}

function nearestVertices(positions, point, radius) {
  const radiusSquared = radius * radius;
  const found = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const dx = positions[vertex * 3] - point[0];
    const dy = positions[vertex * 3 + 1] - point[1];
    const dz = positions[vertex * 3 + 2] - point[2];
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared < radiusSquared) found.push({ vertex, distanceSquared });
  }
  found.sort((first, second) => first.distanceSquared - second.distanceSquared || first.vertex - second.vertex);
  return found.slice(0, MAX_DENT_VERTICES);
}

function recomputeNormals(geometry, movedVertices) {
  const { positions, normals, indices } = geometry;
  const sums = new Map();
  const moved = new Set(movedVertices);
  // A face that shares a moved vertex changes shape, so its unmoved corners get new normals too.
  for (let corner = 0; corner < indices.length; corner += 3) {
    const triangle = [indices[corner], indices[corner + 1], indices[corner + 2]];
    if (!triangle.some(vertex => moved.has(vertex))) continue;
    for (const vertex of triangle) sums.set(vertex, [0, 0, 0]);
  }
  for (let corner = 0; corner < indices.length; corner += 3) {
    const triangle = [indices[corner], indices[corner + 1], indices[corner + 2]];
    if (!triangle.some(vertex => sums.has(vertex))) continue;
    const [vertexA, vertexB, vertexC] = triangle.map(vertex => positions.subarray(vertex * 3, vertex * 3 + 3));
    const edgeOne = [vertexB[0] - vertexA[0], vertexB[1] - vertexA[1], vertexB[2] - vertexA[2]];
    const edgeTwo = [vertexC[0] - vertexA[0], vertexC[1] - vertexA[1], vertexC[2] - vertexA[2]];
    const areaNormal = [
      edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1],
      edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2],
      edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0],
    ];
    for (const vertex of triangle) {
      const sum = sums.get(vertex);
      if (!sum) continue;
      sum[0] += areaNormal[0];
      sum[1] += areaNormal[1];
      sum[2] += areaNormal[2];
    }
  }
  for (const [vertex, sum] of sums) {
    const length = Math.hypot(...sum);
    if (length < 1e-12) continue;
    normals[vertex * 3] = sum[0] / length;
    normals[vertex * 3 + 1] = sum[1] / length;
    normals[vertex * 3 + 2] = sum[2] / length;
  }
}

/**
 * A copy of a render geometry (`{ positions, normals, indices, ... }`) with the surface pushed in around each hit.
 * A vertex within `radius` of a hit moves along the hit's direction by `dentDepth(impulse)` times a smooth falloff.
 * At most 4096 vertices move per hit (the nearest), and no vertex ends up more than `maxDepth` from where it started,
 * however many hits land on it. The input geometry is not changed.
 */
export function dentGeometry(geometry, definition) {
  const { stiffness, maxDepth, radius, impacts } = normalizeDent(definition);
  if (!(geometry?.positions instanceof Float32Array) || !(geometry.indices?.length >= 0) || !(geometry.normals instanceof Float32Array)) {
    throw invalidField('geometry', geometry, 'a render geometry with Float32Array positions and normals and an indices list');
  }
  const dented = {};
  for (const [name, value] of Object.entries(geometry)) dented[name] = ArrayBuffer.isView(value) ? value.slice() : value;
  const offsets = new Map();
  for (const impact of impacts) {
    const depth = dentDepth(impact.impulse, { stiffness, maxDepth });
    for (const { vertex, distanceSquared } of nearestVertices(geometry.positions, impact.point, radius)) {
      const falloff = (1 - distanceSquared / (radius * radius)) ** 2;
      const offset = offsets.get(vertex) ?? [0, 0, 0];
      for (let axis = 0; axis < 3; axis++) offset[axis] += impact.direction[axis] * depth * falloff;
      const length = Math.hypot(...offset);
      if (length > maxDepth) for (let axis = 0; axis < 3; axis++) offset[axis] *= maxDepth / length;
      offsets.set(vertex, offset);
    }
  }
  for (const [vertex, offset] of offsets) {
    for (let axis = 0; axis < 3; axis++) dented.positions[vertex * 3 + axis] += offset[axis];
  }
  recomputeNormals(dented, offsets.keys());
  return dented;
}

/** The impulse (N s) a vehicle of `mass` kg takes stopping from `speed` m/s against a fixed wall; a bounce of `restitution` adds to it. */
export function crashImpulse({ mass, speed, restitution = 0 }) {
  requireNumber(mass, 'mass', 1e-6, 1e9, 1400);
  requireNumber(speed, 'speed', 0, 1e4, 12);
  requireNumber(restitution, 'restitution', 0, 1, 0.1);
  return mass * speed * (1 + restitution);
}

/**
 * The ids of the loose parts a hit of `impulse` tears off: those whose `threshold` (N s) it reaches. A part with a
 * higher threshold stays on. `parts` is `[{ id, threshold }]`, at most 32; ids come back in list order.
 */
export function detachedPartIds(parts, impulse) {
  if (!Array.isArray(parts) || parts.length > MAX_DETACHABLE_PARTS) {
    throw invalidField('parts', parts, `a list of at most ${MAX_DETACHABLE_PARTS} loose parts, such as [{ "id": "front-bumper", "threshold": 2500 }]`);
  }
  requireNumber(impulse, 'impulse', 0, 1e9, 3000);
  return parts.filter((part, index) => {
    requirePlainObject(part, `parts[${index}]`, '{ "id": "front-bumper", "threshold": 2500 }');
    if (typeof part.id !== 'string' || part.id === '') throw invalidField(`parts[${index}].id`, part.id, 'the id of a part, such as "front-bumper"', TypeError);
    return impulse >= requireNumber(part.threshold, `parts[${index}].threshold`, 1e-6, 1e9, 2500);
  }).map(part => part.id);
}

function frontPointOf(pose, frontOffset) {
  const travel = pose.direction ?? 1;
  return [
    pose.position[0] + Math.sin(pose.heading) * frontOffset * travel,
    pose.position[1],
    pose.position[2] + Math.cos(pose.heading) * frontOffset * travel,
  ];
}

/**
 * The first moment a drive (from `driveAlongPath`) carries the front of the car into a wall, sampled every 1/60 s.
 * `wall` is `{ point, normal }`: a plane, with `normal` pointing toward the side the car comes from. `frontOffset` is the
 * distance in metres from `pose.position` to the nose. Returns `{ time, speed, impulse, point, direction }`
 * (`point` in the drive's space, `direction` the way the wall pushes the nose in, which is `normal`, ready for a dent impact) or null when the car
 * never reaches the wall.
 */
export function findDriveImpact(drive, wall, { mass, frontOffset = 0, restitution = 0, step = DEFAULT_SEARCH_STEP_SECONDS } = {}) {
  requirePlainObject(wall, 'wall', '{ "point": [0, 0, 10], "normal": [0, 0, -1] }');
  const point = requireVector3(wall.point, 'wall.point', '[0, 0, 10]');
  const rawNormal = requireVector3(wall.normal, 'wall.normal', '[0, 0, -1], pointing toward the car');
  if (Math.hypot(...rawNormal) < 1e-6) {
    throw invalidField('wall.normal', rawNormal, 'a vector that is not zero, such as [0, 0, -1], pointing toward the car');
  }
  const normal = normalized(rawNormal);
  requireNumber(frontOffset, 'frontOffset', -100, 100, 2);
  requireNumber(step, 'step', 1e-4, 10, DEFAULT_SEARCH_STEP_SECONDS);
  if (drive.duration / step > MAX_SEARCH_SAMPLES) {
    throw invalidField('step', step, `a step of at least ${drive.duration / MAX_SEARCH_SAMPLES} s for a ${drive.duration} s drive`);
  }
  for (let time = 0; time <= drive.duration + step; time += step) {
    const pose = drive.sample(Math.min(time, drive.duration));
    const front = frontPointOf(pose, frontOffset);
    const gap = (front[0] - point[0]) * normal[0] + (front[1] - point[1]) * normal[1] + (front[2] - point[2]) * normal[2];
    if (gap > 0) continue;
    const speed = Math.abs(pose.speed);
    return {
      time: pose.time,
      speed,
      impulse: crashImpulse({ mass, speed, restitution }),
      point: front.map((component, axis) => component - normal[axis] * gap),
      direction: normal,
    };
  }
  return null;
}

export const MAX_FLIGHT_SECONDS = 30;
export const MAX_LAUNCH_SPEED = 30;
const FLIGHT_STEP_SECONDS = 1 / 120;
const LAUNCH_IMPULSE_PER_KILOGRAM = 100;
const LAUNCH_UPWARD_SHARE = 0.5;
const SPREAD_SHARE = 0.3;
const REBOUND_SHARE = 0.2;
const MAX_SPIN_RADIANS_PER_SECOND = 12;
const GROUND_FRICTION = 0.6;
const SETTLE_SPEED = 0.2;

function seededUnitSequence(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function sidewaysOf(direction) {
  const horizontalLength = Math.hypot(direction[0], direction[2]);
  return horizontalLength < 1e-6 ? [1, 0, 0] : [-direction[2] / horizontalLength, 0, direction[0] / horizontalLength];
}

function launchVelocityOf(part, hit, nextUnit) {
  const direction = normalized(hit.direction);
  const sideways = sidewaysOf(direction);
  const speed = Math.min(MAX_LAUNCH_SPEED, (hit.impulse - part.threshold) / (part.mass * LAUNCH_IMPULSE_PER_KILOGRAM));
  const sidewaysShare = nextUnit() < 0.5 ? -1 : 1;
  const reboundShare = REBOUND_SHARE * (0.5 + nextUnit() * 0.5);
  const upwardShare = LAUNCH_UPWARD_SHARE + nextUnit() * SPREAD_SHARE;
  return [
    (sideways[0] * sidewaysShare + direction[0] * reboundShare) * speed,
    (direction[1] * reboundShare + upwardShare) * speed,
    (sideways[2] * sidewaysShare + direction[2] * reboundShare) * speed,
  ];
}

function rotateByEuler(rotation, vector) {
  const [x, y, z] = vector;
  const [cosZ, sinZ] = [Math.cos(rotation[2]), Math.sin(rotation[2])];
  const aroundZ = [x * cosZ - y * sinZ, x * sinZ + y * cosZ, z];
  const [cosY, sinY] = [Math.cos(rotation[1]), Math.sin(rotation[1])];
  const aroundY = [aroundZ[0] * cosY + aroundZ[2] * sinY, aroundZ[1], -aroundZ[0] * sinY + aroundZ[2] * cosY];
  const [cosX, sinX] = [Math.cos(rotation[0]), Math.sin(rotation[0])];
  return [aroundY[0], aroundY[1] * cosX - aroundY[2] * sinX, aroundY[1] * sinX + aroundY[2] * cosX];
}

/** How far the part's box (`halfExtents`, turned by `rotation`) reaches along `normal` from its centre; 0 for a part with no size. */
function reachAlong(normal, rotation, halfExtents) {
  if (!halfExtents) return 0;
  let reach = 0;
  for (let axis = 0; axis < 3; axis++) {
    const unitAxis = [0, 0, 0];
    unitAxis[axis] = halfExtents[axis];
    const turned = rotateByEuler(rotation, unitAxis);
    reach += Math.abs(turned[0] * normal[0] + turned[1] * normal[1] + turned[2] * normal[2]);
  }
  return reach;
}

function keepOnCarSide(state, flight) {
  const { wall, halfExtents, restitution } = flight;
  const centreDepth = (state.position[0] - wall.point[0]) * wall.normal[0] + (state.position[1] - wall.point[1]) * wall.normal[1] + (state.position[2] - wall.point[2]) * wall.normal[2];
  const depth = centreDepth - reachAlong(wall.normal, state.rotation, halfExtents);
  if (depth >= 0) return;
  for (let axis = 0; axis < 3; axis++) state.position[axis] -= depth * wall.normal[axis];
  const approach = state.velocity[0] * wall.normal[0] + state.velocity[1] * wall.normal[1] + state.velocity[2] * wall.normal[2];
  if (approach >= 0) return;
  for (let axis = 0; axis < 3; axis++) state.velocity[axis] -= (1 + restitution) * approach * wall.normal[axis];
}

const WORLD_UP = [0, 1, 0];

function crossProduct(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

/** The Euler angles (XYZ order) of the rotation whose columns are the three world directions of the box axes. */
function eulerFromAxes(columns) {
  const element = (row, column) => columns[column][row];
  const sineY = Math.max(-1, Math.min(1, element(0, 2)));
  const angleY = Math.asin(sineY);
  if (Math.abs(sineY) > 0.9999999) return [Math.atan2(element(2, 1), element(1, 1)), angleY, 0];
  return [Math.atan2(-element(1, 2), element(2, 2)), angleY, Math.atan2(-element(0, 1), element(0, 0))];
}

/** The world directions of the three box axes after `rotation`. */
function boxAxesOf(rotation) {
  return [0, 1, 2].map(axis => {
    const unitAxis = [0, 0, 0];
    unitAxis[axis] = 1;
    return rotateByEuler(rotation, unitAxis);
  });
}

/**
 * The rotation that lies the box on the face of `verticalAxis`, the yaw kept: that axis becomes vertical (pointing the way it
 * already leans) and one of the other two keeps its flat direction, whichever is flatter to the ground.
 */
function restingRotationOn(rotation, verticalAxis) {
  const columns = boxAxesOf(rotation);
  const first = (verticalAxis + 1) % 3;
  const second = (verticalAxis + 2) % 3;
  const up = columns[verticalAxis][1] < 0 ? [0, -1, 0] : WORLD_UP;
  const flatFirst = Math.hypot(columns[first][0], columns[first][2]);
  const flatSecond = Math.hypot(columns[second][0], columns[second][2]);
  const rebuilt = [null, null, null];
  rebuilt[verticalAxis] = up;
  if (flatFirst >= flatSecond) {
    const firstAxis = flatFirst < 1e-9 ? [1, 0, 0] : [columns[first][0] / flatFirst, 0, columns[first][2] / flatFirst];
    rebuilt[first] = firstAxis;
    rebuilt[second] = crossProduct(up, firstAxis);
  } else {
    const secondAxis = [columns[second][0] / flatSecond, 0, columns[second][2] / flatSecond];
    rebuilt[second] = secondAxis;
    rebuilt[first] = crossProduct(secondAxis, up);
  }
  return eulerFromAxes(rebuilt);
}

/** Kinetic energy per kilogram of the box, moving at `velocity` and spinning at `spin` (radians per second, about the box's own axes' world frame, the box's inertia as a uniform cuboid). */
function kineticEnergyPerKilogram(velocity, spin, size) {
  const translation = 0.5 * (velocity[0] ** 2 + velocity[1] ** 2 + velocity[2] ** 2);
  let rotation = 0;
  for (let axis = 0; axis < 3; axis++) {
    const first = size[(axis + 1) % 3];
    const second = size[(axis + 2) % 3];
    rotation += 0.5 * spin[axis] ** 2 * (first * first + second * second) / 12;
  }
  return translation + rotation;
}

/**
 * The face the box comes to rest on, judged from the landing pose, whose nearest face to lying down is `nearestAxis`. The box falls
 * onto a face when its centre has already passed the edge towards it (the world up, in the box's axes, leans more towards that axis
 * than the box is wide against tall), and it tips onto a face when its kinetic energy (`energyPerKilogram`) can lift the centre over
 * the edge, which peaks at half the diagonal of the two faces the edge joins: `energy / gravity` above the landing centre height.
 * Of the reachable faces, and the nearest one, it takes the one with the lowest centre, the largest: the widest base, the most
 * energy to tip off it. Two opposite faces are equally stable, so the one the box already leans to is the one it takes.
 */
function mostStableFaceAxis(rotation, size, landingCentreHeight, energyPerKilogram, gravity) {
  const columns = boxAxesOf(rotation);
  const nearestAxis = [0, 1, 2].reduce((best, axis) => (Math.abs(columns[axis][1]) > Math.abs(columns[best][1]) ? axis : best), 0);
  const liftableHeight = landingCentreHeight + (gravity > 0 ? energyPerKilogram / gravity : 0);
  const standingHeight = Math.max(Math.abs(columns[nearestAxis][1]), 1e-9);
  let chosenAxis = nearestAxis;
  for (let axis = 0; axis < 3; axis++) {
    if (axis === nearestAxis) continue;
    const hasFallen = Math.abs(columns[axis][1]) / standingHeight > size[axis] / size[nearestAxis];
    const canTip = Math.hypot(size[nearestAxis], size[axis]) / 2 <= liftableHeight;
    if (!hasFallen && !canTip) continue;
    if (size[axis] < size[chosenAxis]) chosenAxis = axis;
  }
  return chosenAxis;
}

function settle(state, flight) {
  const energyPerKilogram = flight.halfExtents ? kineticEnergyPerKilogram(state.velocity, state.spin, flight.size) : 0;
  state.velocity.fill(0);
  state.spin.fill(0);
  state.settled = true;
  if (!flight.halfExtents) return;
  const landingCentreHeight = reachAlong(WORLD_UP, state.rotation, flight.halfExtents);
  const faceAxis = mostStableFaceAxis(state.rotation, flight.size, landingCentreHeight, energyPerKilogram, flight.gravity);
  state.rotation = restingRotationOn(state.rotation, faceAxis);
  keepOnCarSide(state, flight);
  state.position[1] = flight.groundY + reachAlong(WORLD_UP, state.rotation, flight.halfExtents);
}

function advanceFlight(state, flight, seconds) {
  const steps = Math.round(seconds / FLIGHT_STEP_SECONDS);
  for (let step = 0; step < steps && !state.settled; step++) {
    state.velocity[1] -= flight.gravity * FLIGHT_STEP_SECONDS;
    for (let axis = 0; axis < 3; axis++) state.position[axis] += state.velocity[axis] * FLIGHT_STEP_SECONDS;
    for (let axis = 0; axis < 3; axis++) state.rotation[axis] += state.spin[axis] * FLIGHT_STEP_SECONDS;
    keepOnCarSide(state, flight);
    const lowestCentreHeight = flight.groundY + reachAlong(WORLD_UP, state.rotation, flight.halfExtents);
    if (state.position[1] > lowestCentreHeight) continue;
    state.position[1] = lowestCentreHeight;
    state.velocity[1] = -state.velocity[1] * flight.restitution;
    state.velocity[0] *= GROUND_FRICTION;
    state.velocity[2] *= GROUND_FRICTION;
    for (let axis = 0; axis < 3; axis++) state.spin[axis] *= GROUND_FRICTION;
    if (Math.hypot(...state.velocity) < SETTLE_SPEED) settle(state, flight);
  }
}

/**
 * The flight of a loose part a hit tears off. `part` is `{ id, threshold, mass, position, size }` (N s, kg, the part's centre in
 * metres, `size` its box as three extents in metres, optional); `hit` is `{ impulse, direction, point }` from `findDriveImpact` (`point` is optional and defaults to the part's centre). Returns null when the impulse stays below the
 * threshold, so the part stays on. Otherwise it returns `{ id, launchVelocity, sample(time) }`: the part leaves mostly
 * sideways (a seeded sign, across `direction`) with a small rebound along `direction` and an up kick, tumbles, falls under gravity and bounces on the ground plane `groundY` (the top of the ground, not the centre height: with a `size` the lowest corner touches it, and at rest the box lies on a face with its lowest corner exactly on `groundY`, the largest face it can reach from its landing pose by falling over an edge or tipping over it with its kinetic energy (see `mostStableFaceAxis`); without a `size` the centre is held at `groundY` and the rotation is not snapped). No corner of its box (turned by the Euler angles in XYZ order) crosses the wall plane through `point` with normal `direction`; a part with no `size` is held by its centre only.
 * `sample(time)` gives `{ position, rotation (Euler radians), velocity, settled }` for 0 to 30 s, and the same inputs
 * with the same `seed` give the same numbers on every run.
 */
export function detachedPartFlight(part, hit, { seed = 0, gravity = 9.81, groundY = 0, restitution = 0.3 } = {}) {
  requirePlainObject(part, 'part', '{ "id": "front-bumper", "threshold": 9000, "mass": 12, "position": [0, 0.5, 2] }');
  if (typeof part.id !== 'string' || part.id === '') throw invalidField('part.id', part.id, 'the id of a part, such as "front-bumper"', TypeError);
  requireNumber(part.threshold, 'part.threshold', 1e-6, 1e9, 9000);
  requireNumber(part.mass, 'part.mass', 1e-3, 1e5, 12);
  requireVector3(part.position, 'part.position', '[0, 0.5, 2]');
  if (part.size !== undefined) {
    requireVector3(part.size, 'part.size', '[1.7, 0.35, 0.2], the box of the part in metres').forEach((extent, axis) => requireNumber(extent, `part.size[${axis}]`, 1e-3, 100, 0.5));
  }
  requirePlainObject(hit, 'hit', '{ "impulse": 16800, "direction": [0, 0, -1] }');
  requireNumber(hit.impulse, 'hit.impulse', 0, 1e9, 16800);
  const rawDirection = requireVector3(hit.direction, 'hit.direction', '[0, 0, -1]');
  if (Math.hypot(...rawDirection) < 1e-6) throw invalidField('hit.direction', rawDirection, 'a vector that is not zero, such as [0, 0, -1]');
  if (hit.point !== undefined) requireVector3(hit.point, 'hit.point', '[0, 0.5, 2.1]');
  requireNumber(seed, 'seed', 0, 4294967295, 7);
  requireNumber(gravity, 'gravity', 0, 100, 9.81);
  requireNumber(groundY, 'groundY', -1e4, 1e4, 0);
  requireNumber(restitution, 'restitution', 0, 1, 0.3);
  if (hit.impulse < part.threshold) return null;
  const nextUnit = seededUnitSequence(seed);
  const launchVelocity = launchVelocityOf(part, hit, nextUnit);
  const spin = [0, 1, 2].map(() => (nextUnit() * 2 - 1) * MAX_SPIN_RADIANS_PER_SECOND);
  const wall = { point: hit.point ?? part.position, normal: normalized(rawDirection) };
  const halfExtents = part.size ? part.size.map(extent => extent / 2) : null;
  const flight = { gravity, groundY, restitution, wall, halfExtents, size: part.size };
  return {
    id: part.id,
    launchVelocity,
    sample(time) {
      requireNumber(time, 'time', 0, MAX_FLIGHT_SECONDS, 1);
      const state = { position: [...part.position], rotation: [0, 0, 0], velocity: [...launchVelocity], spin: [...spin], settled: false };
      advanceFlight(state, flight, time);
      return { position: state.position, rotation: state.rotation, velocity: state.velocity, settled: state.settled };
    },
  };
}

export const MAX_SWING_SECONDS = 30;
export const MAX_SWING_SPEED = 15;
export const MAX_DOOR_ANGLE_DEGREES = 170;
export const MAX_DOOR_DAMPING = 20;
const DOOR_STEP_SECONDS = 1 / 240;
const DOOR_IMPULSE_SHARE = 0.01;
const DOOR_SPEED_JITTER = 0.1;
const DOOR_STOP_BOUNCE = 0.1;
const DOOR_DRY_FRICTION = 2;
const DOOR_REST_SPEED = 0.05;
const DEFAULT_DOOR_MAX_ANGLE_DEGREES = 70;
const DEFAULT_DOOR_DAMPING = 3;

function dotProduct(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

/** Rotate `vector` by `angle` radians about the unit `axis` (Rodrigues). */
function rotateAboutAxis(vector, axis, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const crossed = crossProduct(axis, vector);
  const along = dotProduct(axis, vector) * (1 - cosine);
  return [0, 1, 2].map(index => vector[index] * cosine + crossed[index] * sine + axis[index] * along);
}

/** Euler angles (radians, XYZ order, like `detachedPartFlight`) of the turn by `angle` about the unit `axis`. */
function eulerOfAxisAngle(axis, angle) {
  const [columnX, columnY, columnZ] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(unit => rotateAboutAxis(unit, axis, angle));
  const sineY = Math.max(-1, Math.min(1, columnZ[0]));
  if (Math.abs(sineY) > 0.9999999) return [Math.atan2(columnY[2], columnY[1]), Math.asin(sineY), 0];
  return [Math.atan2(-columnZ[1], columnZ[2]), Math.asin(sineY), Math.atan2(-columnY[0], columnX[0])];
}

function swingInertia(part, hingePoint, axis) {
  const toCentre = subtract(part.position, hingePoint);
  const alongAxis = dotProduct(toCentre, axis);
  const centreDistance = Math.hypot(toCentre[0] - axis[0] * alongAxis, toCentre[1] - axis[1] * alongAxis, toCentre[2] - axis[2] * alongAxis);
  if (centreDistance < 1e-3) throw invalidField('hinge.point', hingePoint, 'a point on the hinge line, which must pass at least 1 mm from the door centre, such as [0.8, 0.6, -0.1]');
  const longestSide = part.size ? Math.max(...part.size) : 0;
  return part.mass * (centreDistance * centreDistance + (longestSide * longestSide) / 12);
}

function initialSwingSpeed(part, hit, hinge, inertia, nextUnit) {
  const lever = subtract(hit.point ?? part.position, hinge.point);
  const excessImpulse = hit.impulse - part.threshold;
  const push = normalized(hit.direction).map(component => component * excessImpulse * DOOR_IMPULSE_SHARE);
  const torque = dotProduct(hinge.axis, crossProduct(lever, push));
  const jitter = 1 + (nextUnit() * 2 - 1) * DOOR_SPEED_JITTER;
  return Math.max(-MAX_SWING_SPEED, Math.min(MAX_SWING_SPEED, (torque / inertia) * jitter));
}

/** Advance the opening of the door (0 shut to `swing.maxAngle` open, speed positive while opening) by `seconds`. */
function advanceSwing(state, swing, seconds) {
  let remaining = seconds;
  while (remaining > 0 && !state.settled) {
    const step = Math.min(DOOR_STEP_SECONDS, remaining);
    const heading = Math.sign(state.speed);
    let speed = state.speed - (swing.damping * state.speed + DOOR_DRY_FRICTION * heading) * step;
    if (Math.sign(speed) !== heading) speed = 0;
    state.opening += speed * step;
    if (state.opening >= swing.maxAngle) {
      state.opening = swing.maxAngle;
      speed = -speed * DOOR_STOP_BOUNCE;
    } else if (state.opening <= 0) {
      state.opening = 0;
      speed = -speed * DOOR_STOP_BOUNCE;
    }
    state.speed = speed;
    state.settled = Math.abs(speed) < DOOR_REST_SPEED;
    if (state.settled) state.speed = 0;
    remaining -= step;
  }
}

/**
 * A door swings open on its hinge instead of tearing off. `part` is `{ id, threshold, mass, position, size }` (the door's
 * centre; `size` is optional and sets its inertia), `hit` is `{ impulse, direction, point }` as for `detachedPartFlight`,
 * and `hinge` is `{ point, axis }`: a point on the hinge line and its direction (any length but zero). Returns null while
 * the impulse stays below `threshold`. Otherwise `swing.sample(time)` gives `{ angle, angularVelocity, position, rotation,
 * quaternion, settled }` for 0 to 30 s: the door turns about the hinge line at the speed the hit's torque gives it
 * (a share of `impulse - threshold` about the lever from `point` to the hinge, over the door's inertia, at most 15 rad/s),
 * slows by `damping` and dry friction, stops at `maxAngle` degrees (0 to 170, default 70) with a small bounce and rests. It never swings back past shut, since the frame stops it.
 * `angle` is in radians and its sign follows the hit; `position` is the door centre and `rotation` (Euler XYZ) and
 * `quaternion` ([x, y, z, w]) its turn, so the hinge line stays fixed. A hit along the hinge line gives no torque, so
 * the door does not move. The same inputs and `seed` give the same numbers.
 */
export function hingedDoorSwing(part, hit, { hinge, maxAngle = DEFAULT_DOOR_MAX_ANGLE_DEGREES, damping = DEFAULT_DOOR_DAMPING, seed = 0 } = {}) {
  requirePlainObject(part, 'part', '{ "id": "door-left", "threshold": 9000, "mass": 20, "position": [0.8, 0.6, 0.4] }');
  if (typeof part.id !== 'string' || part.id === '') throw invalidField('part.id', part.id, 'the id of a part, such as "door-left"', TypeError);
  requireNumber(part.threshold, 'part.threshold', 1e-6, 1e9, 9000);
  requireNumber(part.mass, 'part.mass', 1e-3, 1e5, 20);
  requireVector3(part.position, 'part.position', '[0.8, 0.6, 0.4]');
  if (part.size !== undefined) {
    requireVector3(part.size, 'part.size', '[0.1, 0.9, 1.0], the box of the door in metres').forEach((extent, axis) => requireNumber(extent, `part.size[${axis}]`, 1e-3, 100, 0.5));
  }
  requirePlainObject(hit, 'hit', '{ "impulse": 16800, "direction": [1, 0, 0], "point": [0.8, 0.6, 0.9] }');
  requireNumber(hit.impulse, 'hit.impulse', 0, 1e9, 16800);
  const rawDirection = requireVector3(hit.direction, 'hit.direction', '[1, 0, 0]');
  if (Math.hypot(...rawDirection) < 1e-6) throw invalidField('hit.direction', rawDirection, 'a vector that is not zero, such as [1, 0, 0]');
  if (hit.point !== undefined) requireVector3(hit.point, 'hit.point', '[0.8, 0.6, 0.9]');
  requirePlainObject(hinge, 'hinge', '{ "point": [0.8, 0.6, -0.1], "axis": [0, 1, 0] }');
  const hingePoint = requireVector3(hinge.point, 'hinge.point', '[0.8, 0.6, -0.1]');
  const rawAxis = requireVector3(hinge.axis, 'hinge.axis', '[0, 1, 0]');
  if (Math.hypot(...rawAxis) < 1e-6) throw invalidField('hinge.axis', rawAxis, 'a direction that is not zero, such as [0, 1, 0]');
  requireNumber(maxAngle, 'maxAngle', 0, MAX_DOOR_ANGLE_DEGREES, DEFAULT_DOOR_MAX_ANGLE_DEGREES);
  requireNumber(damping, 'damping', 0, MAX_DOOR_DAMPING, DEFAULT_DOOR_DAMPING);
  requireNumber(seed, 'seed', 0, 4294967295, 7);
  const axis = normalized(rawAxis);
  const inertia = swingInertia(part, hingePoint, axis);
  if (hit.impulse < part.threshold) return null;
  const initialSpeed = initialSwingSpeed(part, hit, { point: hingePoint, axis }, inertia, seededUnitSequence(seed));
  const swing = { damping, maxAngle: (maxAngle * Math.PI) / 180 };
  const toCentre = subtract(part.position, hingePoint);
  return {
    id: part.id,
    initialAngularVelocity: initialSpeed,
    sample(time) {
      requireNumber(time, 'time', 0, MAX_SWING_SECONDS, 1);
      const state = { opening: 0, speed: Math.abs(initialSpeed), settled: initialSpeed === 0 };
      advanceSwing(state, swing, time);
      const angle = Math.sign(initialSpeed) * state.opening + 0;
      const turned = rotateAboutAxis(toCentre, axis, angle);
      const half = Math.sin(angle / 2);
      return {
        angle,
        angularVelocity: Math.sign(initialSpeed) * state.speed + 0,
        position: [hingePoint[0] + turned[0], hingePoint[1] + turned[1], hingePoint[2] + turned[2]],
        rotation: eulerOfAxisAngle(axis, angle),
        quaternion: [axis[0] * half, axis[1] * half, axis[2] * half, Math.cos(angle / 2)],
        settled: state.settled,
      };
    },
  };
}

/**
 * The vertex estimate of a recipe `dented` geometry, which is its source's: checks the dent fields and that the source
 * is a geometry of the recipe that is not itself a fragment or a dent. `estimateSource` estimates a source record.
 */
export function dentedVertexEstimate(value, definitions, estimateSource) {
  const { id, type, source: sourceId, ...dent } = value;
  if (typeof sourceId !== 'string') {
    throw invalidField('source', sourceId, 'the ID of a geometry in geometries, such as "front-bumper"', TypeError);
  }
  normalizeDent(dent, '');
  if (!definitions) return 16;
  const source = definitions.get(sourceId);
  if (!source || source.type === 'fragment' || source.type === 'dented') {
    const reason = source ? 'a geometry that is not itself a fragment or a dent' : `the ID of a geometry in geometries, one of ${[...definitions.keys()].slice(0, 8).join(', ') || 'none yet'}`;
    throw invalidField(`geometries.${id}.source`, sourceId, reason);
  }
  return estimateSource(source);
}
