// The window room of the interior exposure probe (#1334), shared with the test that pins its sealed walls (#2000).
// Every wall is a box. The box geometry has bevel 0: the default bevel of 0.08 rounds each edge, and where two rounded
// boxes meet the rounding leaves a groove that opens to the outside, so sky light came in at the corners of the room.

export const ROOM = { halfWidth: 4, front: -3, back: 3.5, height: 3, wall: 0.2 };
export const WINDOW = { halfWidth: 1.4, bottom: 0.9, top: 2.4 };

export const ROOM_GEOMETRIES = [{ id: 'block', type: 'box', bevel: 0 }];

export const ROOM_MATERIALS = [
  { id: 'plaster', color: [0.75, 0.72, 0.66], roughness: 0.9 },
  { id: 'wood', color: [0.45, 0.32, 0.2], roughness: 0.6 },
  { id: 'grass', color: [0.2, 0.3, 0.12], roughness: 1 },
];

export const ROOM_CAMERA = { eye: [0, 1.5, -2.4], target: [0, 1.2, 3], up: [0, 1, 0], fov: 70, near: 0.05, far: 100 };

function box(id, translation, scale, material = 'plaster') {
  return { id, geometry: 'block', material, translation, scale };
}

/** `sealed` fills the window with a wall so no light can enter; `withoutLawn` drops the large ground slab. */
export function roomNodes({ sealed = false, withoutLawn = false } = {}) {
  const { halfWidth, front, back, height, wall } = ROOM;
  const depth = back - front;
  const middleZ = (front + back) / 2;
  const frontZ = front - wall / 2;
  const sideWidth = halfWidth - WINDOW.halfWidth;
  return [
    box('floor', [0, -wall / 2, middleZ], [halfWidth * 2 + wall * 2, wall, depth + wall * 2], 'wood'),
    box('ceiling', [0, height + wall / 2, middleZ], [halfWidth * 2 + wall * 2, wall, depth + wall * 2]),
    box('wall-left', [-halfWidth - wall / 2, height / 2, middleZ], [wall, height, depth + wall * 2]),
    box('wall-right', [halfWidth + wall / 2, height / 2, middleZ], [wall, height, depth + wall * 2]),
    box('wall-back', [0, height / 2, back + wall / 2], [halfWidth * 2, height, wall]),
    box('front-left', [-(WINDOW.halfWidth + sideWidth / 2), height / 2, frontZ], [sideWidth, height, wall]),
    box('front-right', [WINDOW.halfWidth + sideWidth / 2, height / 2, frontZ], [sideWidth, height, wall]),
    box('front-sill', [0, WINDOW.bottom / 2, frontZ], [WINDOW.halfWidth * 2, WINDOW.bottom, wall]),
    box('front-head', [0, (WINDOW.top + height) / 2, frontZ], [WINDOW.halfWidth * 2, height - WINDOW.top, wall]),
    ...(sealed ? [box('window-pane', [0, (WINDOW.bottom + WINDOW.top) / 2, frontZ], [WINDOW.halfWidth * 2, WINDOW.top - WINDOW.bottom, wall])] : []),
    ...(withoutLawn ? [] : [box('lawn', [0, -wall / 2 - 0.05, front - 20], [80, wall, 40], 'grass')]),
  ];
}
