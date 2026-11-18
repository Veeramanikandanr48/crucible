# Vehicle kit

`crucible/addons/vehicle` is available from version `0.10.0`.
It animates a wheeled vehicle along a path without physics.
Sampling the same time always returns the same pose, so frames can be rendered in any order.

```js
import { createVehicleRig, driveAlongPath, applyVehiclePoseToParts } from 'crucible/addons/vehicle';

const rig = createVehicleRig({ parts: vehicleParts });          // wheels found by name and geometry
const drive = driveAlongPath(rig, [[0, 0, -20], [5, 0, 0], [0, 0, 20]], {
  cruiseSpeed: 9,
  acceleration: 3,
  braking: 4,
  maxLateralAcceleration: 5,
  groundHeight: (x, z) => terrainHeight(x, z),
});

const pose = drive.sample(seconds);
applyVehiclePoseToParts(rig, pose);
renderer.updateParts(allParts);
```

## Conventions

- Metres, +Y up, right-handed. Angles are radians.
- The model's forward axis is `+z` unless `forwardAxis` is `'+x'`, `'-x'` or `'-z'`.
  Left is `up x forward`, so left is `+x` when forward is `+z`.
- The rig builds a local frame on the ground under the centroid of the wheel centers, then moves the whole model with it.
  The model can sit anywhere in its own space; poses are relative to its authored rest position.
- `pose.heading` is yaw about +Y, zero when facing +z. `pitch` is positive nose up. `roll` is positive when the left side rises (leaning right), which is what a left turn produces.
- Steering is positive toward the left.

A boat is not a wheeled vehicle: it floats on the ocean and is steered by forces at the stern, as a `boat` controller live and as keyframed controls in a bake. See [Boats and wakes](physics.md#boats-and-wakes) and the [boat controller](player.md#boat-controller).

## Describing the vehicle

`createVehicleRig({ parts | graph | asset, body, wheels, forwardAxis, wheelbase, maxSteerAngle })` takes exactly one source.

| Source | Moved through | Wheel and body references |
| --- | --- | --- |
| `parts` | `part.matrix` | part objects, names or indices |
| `graph` | `node.localMatrix` of a scene graph | node names |
| `asset` | node overrides of a `loadGltf` asset | node labels or ids such as `node-3` |

| Option | Default | Meaning |
| --- | --- | --- |
| `wheels` | `'auto'` | `'auto'` or an array of `{ id, part \| node \| targets, side, axle, radius, center, steerable, spinSign }` |
| `body` | everything that is not a wheel (roots for graphs and assets) | Array of parts or nodes that move rigidly |
| `forwardAxis` | `'+z'` | Model forward direction |
| `wheelbase` | measured front axle to rear axle | Metres, needed when the axles cannot be measured |
| `maxSteerAngle` | 35 degrees | Clamp for the steering angle |
| `lights` | none | Headlights and tail lights, see Lights |

Per wheel: `side` is `left`, `right` or `center`, `axle` is `front` or `rear`; both are inferred from position when omitted.
`steerable` defaults to the front axle.
`radius` and `center` are measured from the geometry bounds when omitted.
`spinSign: -1` fixes a wheel whose model axis is mirrored.
A wheel can list several parts (tire, hub, bolts); they all spin and steer together.

### Automatic wheels

`'auto'` matches wheel, tire/tyre, rim and hub names (`Wheel.001`, `FrontLeftWheel`, `tire_FR`, `RL_tyre`).
It reads corners from `FL FR RL RR`, `front/rear/back` and `left/right`, groups pieces of one corner, and attaches unnamed pieces that sit inside a wheel.
Names with steering, spare, fender, arch, brake, caliper, cover or similar words are rejected.
Check what was decided before trusting it:

```js
findWheelCandidates(names);        // { wheels: [{ name, kind, axle, side, corner }], rejected: [{ name, reason }] }
rig.wheels;                        // id, side, axle, radius, steerable, entries
rig.rejectedNames;                 // wheel-like names that were not treated as wheels
```

## Driving

`driveAlongPath(rig, path, options)` returns `{ sample(seconds), duration, length, rig }`.

The path is an array of `[x, y, z]` points (smoothed with a centripetal spline) or a camera path object, whose eye track is followed.
Speed is arc-length based. Give exactly one of:

| Option | Meaning |
| --- | --- |
| `speed` | Constant metres per second, no ramp |
| `cruiseSpeed` | Profile with `acceleration` (3), `braking` (4), `startSpeed` (0), `endSpeed` (0) and `maxLateralAcceleration` (unlimited) |

Other options: `startTime`, `groundHeight(x, z)`, `maxSteerAngle`, `rollGain` (0.012 rad per m/s2), `pitchGain` (0.012), `bounceFrequency` (1.6 Hz), `dampingRatio` (0.45), `suspensionTravel` (0.2 m), `pathSamples` (400, for camera paths).

`sample(seconds)` returns `{ time, distance, speed, direction, position, heading, pitch, roll, steerAngle, wheels: [{ id, spinAngle, steerAngle, suspensionOffset }], lights }`.

- Wheel spin is `distance / radius`; inside wheels in a corner turn slower by their lateral offset times the heading change.
- Steering uses a bicycle model: `pose.steerAngle` is `atan(wheelbase * curvature)`, clamped. By default each steerable wheel gets its own Ackermann angle `atan2(ahead * tan, wheelbase - sideways * tan)` about the same turning centre, from its measured offsets (`rig.wheelbase`, `rig.trackWidth`): at full lock the inner front wheel turns `atan(wheelbase / (R - track / 2))` and the outer `atan(wheelbase / (R + track / 2))`, with `R = wheelbase / tan(maxSteerAngle)`. Pass `steering: 'shared'` for one angle on every steerable wheel.
- Roll follows lateral acceleration and pitch follows longitudinal acceleration through a spring and damper. The response is integrated at a fixed step when the drive is created, so sampling order does not matter.
- With `groundHeight`, the body height and its slope pitch and roll are fitted to the ground under the four wheels, and each wheel gets a `suspensionOffset` so it touches the ground. Without it, height and slope come from the path.
- The vehicle holds the end of the path with zero speed. Use `cruiseSpeed` for a natural stop; a constant `speed` stops instantly and the body pitches accordingly.

## Reversing

`driveAlongLegs(rig, legs, options)` drives `[{ path, direction: 'forward' | 'reverse', pause }]` in order and takes the same options as `driveAlongPath`, which is the one-leg case.
The car stops at the end of every leg (only the first start and last end keep `startSpeed` and `endSpeed`), waits `pause` seconds (default 0), then starts the next leg.
A reverse leg's path is the way the car travels, so list its points in travel order from where the previous leg ended.
The car keeps facing the other way: heading is the path tangent plus a half turn, continuous at the stop, and steering and body roll flip so the same bend asks for the opposite lock.
`pose.distance` and `pose.speed` are signed along the car's forward axis and `pose.direction` is `1` or `-1`, so wheel spin runs backwards while reversing and spin times radius still equals `pose.distance`.

```js
const drive = driveAlongLegs(rig, [
  { path: [[0, 0, 0], [0, 0, 10]] },
  { path: [[0, 0, 10], [0, 0, 4]], direction: 'reverse', pause: 0.5 },
], { cruiseSpeed: 4, acceleration: 2, braking: 2 });
```

## Lights

Describe lamps once in `createVehicleRig({ lights })`:

| Field | Meaning |
| --- | --- |
| `headlights` | `[{ id, position, direction }]` in model space; `direction` defaults to the model forward axis |
| `tailLights` | `[{ id, part \| node \| targets, signal: 'brake' \| 'reverse', off, on }]`, the lamp material's emission strength at signal 0 and 1 (defaults 0 and 4) |

`pose.lights` is `{ brake, reverse, headlights: [{ id, position, direction }] }`.
Headlight positions and unit directions are in world space and follow the body, including pitch and roll.
`brake` is 0 to 1: the deceleration of the speed profile divided by `fullBrakeDeceleration` (default `braking`), so it is above 0 exactly while the car slows down, forwards or backwards.
A constant `speed` never decelerates, so its brake signal stays 0.
`reverse` is 1 while the car moves backwards.

`computeVehicleLightEmissions(rig, pose)` returns `[{ id, emission, entries }]` for any source.
`applyVehicleLightsToParts(rig, pose)` writes it to `part.material.emission` for a rig built from `parts` (give each lamp its own material, since parts sharing one material share the glow) and returns the parts; call `renderer.updateParts` after it.
Use the headlight poses to place spot lights; the pose carries no renderer state.

## Applying a pose

| Function | Effect |
| --- | --- |
| `applyVehiclePoseToParts(rig, pose)` | Writes `part.matrix`; then call `renderer.updateParts` |
| `applyVehiclePoseToSceneGraph(rig, pose, graph)` | Writes node `localMatrix`, calls `graph.update()` and returns `graph.parts` |
| `createVehicleNodeOverrides(rig, pose)` | Returns `nodeOverrides` (translation, rotation, scale) for `asset.stagePose` |
| `applyVehiclePoseToAsset(rig, pose, asset)` | Stages the overrides and commits them |

For imported GLBs, wheel and body nodes must be editable (positive translation, rotation, scale), and children of a moved node follow it.
Skinned vehicles are not driven by this addon.

## Driving through MCP

An agent drives a car GLB without code. The same entry works in two places.

- An asset recipe (`scene_create_asset`) takes `motion.drive`. `motion.duration` may be left out and becomes the drive time; the car holds the end of its path afterwards.
- A placed asset in a recipe scene takes `asset: { id, drive }`, with the path in the placement's own frame and scene time as drive time. The placement gets its own decoded copy, like one that plays a clip. Tail-light glow is not available there.

```json
{
  "motion": {
    "drive": {
      "legs": [
        { "path": [[0, 0, 0], [0, 0, 10], [4, 0, 16]] },
        { "path": [[4, 0, 16], [4, 0, 12]], "direction": "reverse", "pause": 0.5 }
      ],
      "cruiseSpeed": 6, "acceleration": 3, "braking": 4,
      "wheels": "auto",
      "lights": {
        "headlights": [{ "id": "left", "position": [0.5, 0.7, 2] }],
        "tailLights": [{ "material": "material-1", "signal": "brake", "off": 0.2, "on": 6 }]
      }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `path` or `legs` | Exactly one. A path is `[x, y, z]` points or a camera path `{ duration, eye: { keyframes } }`. A leg is `{ path, direction: 'forward' \| 'reverse', pause }` |
| `speed` or `cruiseSpeed` | As in `driveAlongPath`, with `acceleration`, `braking`, `startSpeed`, `endSpeed`, `maxLateralAcceleration`, `startTime`, `fullBrakeDeceleration` |
| `wheels` | `'auto'` (default) or `[{ id, node \| nodes, side, axle, radius, center, steerable, spinSign }]`, where nodes are labels or `node-N` ids |
| `body`, `forwardAxis`, `wheelbase`, `maxSteerAngle`, `steering`, `rollGain`, `pitchGain` | As in `createVehicleRig` and `driveAlongPath` (angles in radians) |
| `lights.headlights` | `[{ id, position, direction }]` in model space; poses are reported, place a spot light from them |
| `lights.tailLights` | `[{ material, signal: 'brake' \| 'reverse', off, on }]`: the material id (the lamp needs an `emissiveColor`) gets `emission` from `off` to `on` with the signal |

Nodes that the drive moves (the body roots and the wheels) must not also be keyed by `tracks`.
Sampling is a pure function of time, so `scene_review`, renders and seeks in any order show the same pose.

`scene_inspect kind: "hierarchy"` on an asset recipe returns `motionDrive`; on a recipe scene each entry of `assets` has `drive`:

```json
{ "wheels": [{ "id": "front-left", "side": "left", "axle": "front", "radius": 0.35, "steerable": true, "nodes": ["Wheel_FL"] }],
  "rejectedNames": [{ "index": 7, "name": "Steering_Wheel_Cover", "reason": "contains \"steering\", which does not roll with the wheel" }],
  "wheelbase": 2.4, "trackWidth": 1.4, "duration": 6.67, "length": 34.7,
  "lights": { "brake": 0, "reverse": 0, "headlights": [{ "id": "left", "position": [0.5, 0.7, 2], "direction": [0, 0, 1] }] },
  "speed": 0, "direction": 1 }
```

`wheels`, `rejectedNames`, `wheelbase`, `trackWidth`, `duration` and `length` describe the rig; `lights`, `speed` and `direction` are read at the current motion time.
Check `wheels` and `rejectedNames` before trusting `'auto'` on an unfamiliar model.

## Crash damage

A hit is an impulse in N s. For a car stopped by a fixed wall it is `mass * speed`: `crashImpulse({ mass, speed, restitution })`. These helpers come from `crucible/addons/vehicle` and are pure functions, so the same crash gives the same bytes.

```js
import { driveAlongPath, findDriveImpact, dentGeometry, detachedPartIds } from 'crucible/addons/vehicle';

const drive = driveAlongPath(rig, [[0, 0, 0], [0, 0, 25]], { speed: 12 });
const hit = findDriveImpact(drive, { point: [0, 0, 20], normal: [0, 0, -1] }, { mass: 1400, frontOffset: 1.7 });
// { time, speed, impulse, point, direction } or null when the car never reaches the wall

const frontPanel = dentGeometry(panelGeometry, {
  stiffness: 40000, maxDepth: 0.4, radius: 0.5,
  impacts: [{ point: panelPointOfHit, direction: hit.direction, impulse: hit.impulse }],
});
const loose = detachedPartIds([{ id: 'front-bumper', threshold: 9000 }, { id: 'mirror', threshold: 20000 }], hit.impulse);
```

- `findDriveImpact` samples the drive every 1/60 s and returns the first moment the nose (`frontOffset` metres ahead of `pose.position`) reaches the plane `{ point, normal }`, `normal` pointing toward the car. `point` is in the drive's space; move it into the part's space before you dent.
- `dentGeometry(geometry, { impacts, stiffness, maxDepth, radius })` returns a copy of a render geometry (`positions`, `normals`, `indices`) with the surface pushed in. A vertex within `radius` moves along the hit `direction` by `min(maxDepth, impulse / stiffness)` times a smooth falloff. The 4096 nearest vertices move at most, per hit (up to 8 hits), and no vertex ends up more than `maxDepth` (up to 2 m) from where it was. Defaults: `stiffness` 2000 N s per metre, `maxDepth` 0.25 m, `radius` 0.4 m. Give a stiffer part a larger `stiffness`. Normals are recomputed for moved vertices and the corners of faces that touch them. A dent deeper than a thin part's thickness (a hood or door skin) pushes the front surface through the back one, so keep `maxDepth` below the thickness of such a part.
- `detachedPartIds(parts, impulse)` lists the loose parts (`[{ id, threshold }]`, at most 32) that the hit tears off: the impulse reaches their threshold. Lower thresholds come off first.

In a recipe, a `dented` geometry does the same for a node (details in `scene_capabilities`, topic `vehicleDamage`):

```json
{ "id": "hood-dented", "type": "dented", "source": "hood", "stiffness": 40000, "maxDepth": 0.3, "radius": 0.5,
  "impacts": [{ "point": [0, 0.1, 1.2], "direction": [0, 0, -1], "impulse": 9000 }] }
```

The source can be any geometry except a fragment or another dent. The vertex count stays the same.
A part that comes off in a physics crash is a body joined to the car body by a `fixed` joint with `breakImpulse` ([breakable joints](physics.md#fracture-and-breakable-glue)); it breaks when a body takes a contact impulse over that number in one 1/60 s step.

For a drive, where nothing simulates the loose part, `detachedPartFlight(part, hit, { seed, gravity, groundY, restitution })` gives it a flight. `part` is `{ id, threshold, mass, position, size }`, with `size` the box of the part as three extents in metres (optional) and `hit` is `{ impulse, direction, point }` from `findDriveImpact` (`point` is optional and defaults to the part's centre); the part never crosses the plane through `point` with normal `direction`, which is the wall: with a `size`, no corner of its box (Euler angles in XYZ order) crosses it; without one, only the centre is held, so a long part can swing over the wall. It returns null when the impulse stays below `threshold`, so the part stays on. Otherwise `flight.sample(seconds)` (0 to 30 s) returns `{ position, rotation, velocity, settled }`: the part leaves mostly sideways at `(impulse - threshold) / (mass * 100)` m/s (at most 30) (a seeded sign, across `direction`, with a small rebound along `direction` and an up kick) and tumbles, falls, bounces on the ground plane `groundY` (the top of the ground, not the centre height) and comes to rest. With a `size` the lowest corner touches the ground, and at rest the box is snapped to lie on a face, the yaw kept, with its lowest corner exactly on `groundY`. The face is the most stable one the part can reach from its landing pose: it falls onto a face once its centre has passed the edge towards it, and tips onto one when its kinetic energy can lift the centre over the edge (half the diagonal of the two faces the edge joins). Of the reachable faces it takes the largest, so a 1.7 x 0.35 x 0.2 m bumper lies on its 0.2 m side in most seeds instead of standing on its narrow edge; without a `size` the centre is held at `groundY` and the rotation is not snapped. The same inputs and `seed` give the same numbers. Set the node's transform from the sample each frame.

A door does not tear off: `hingedDoorSwing(part, hit, { hinge, maxAngle, damping, seed })` swings it open on its hinge. `part` and `hit` are as above, and `hinge` is `{ point, axis }`: a point on the hinge line (the line passes at least 1 mm from the door's centre) and its direction (any length but zero). It returns null when the impulse stays below `threshold`. Otherwise `swing.sample(seconds)` (0 to 30 s) returns `{ angle, angularVelocity, position, rotation, quaternion, settled }`: the door turns about the hinge line from the torque of the hit (`(impulse - threshold) / 100` along `direction`, at the lever from `hit.point` to the hinge, over the door's inertia, at most 15 rad/s), slows by `damping` (0 to 20, default 3) and dry friction, stops at `maxAngle` degrees (0 to 170, default 70) with a small bounce, and comes to rest. `angle` is in radians and its sign follows the hit; the frame stops the door from swinging back past shut. `position` is the door's centre and `rotation` (Euler XYZ, radians) or `quaternion` is its turn, so the hinge line stays where it is; set the node's transform from them each frame. A hit along the hinge line gives no torque, so the door stays shut. The same inputs and `seed` give the same numbers.

Not covered yet: hood and trunk that pop open, swapping broken glass for shards, and dents driven by the live vehicle controller. A drive is kinematic, so `findDriveImpact` only reports the moment of the hit; the car does not stop or bounce.

## Limits

- Kinematic only: no collisions, tire slip or jumps. Heading follows the path tangent (plus a half turn while reversing).
- Ground is sampled under the wheels as a plane fit, so sharp bumps narrower than the wheelbase show as suspension offsets, clamped to `suspensionTravel`.
- Rear-steered wheels get no Ackermann angle: the split is measured from the rear axle.
- Through MCP the tail lights drive materials of an asset recipe only (placed assets share their materials), and `groundHeight` is not available: the car follows the path heights.
- Nodes with a nonzero scene-graph `pivot` are rejected.
- Wheel radius from geometry assumes the wheel is round in the plane across its axle.
