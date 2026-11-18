# @codepawlhq/crucible-three-bridge

Companion package that imports a three.js object tree as Crucible parts and builds three.js meshes from Crucible parts. It imports neither `three` nor Crucible. `three` is a peer dependency of this package only; the core gains none. Not part of the core `crucible` archive. It is a library, not an addon: it registers nothing, so the MCP server does not load it with `--allow-addon`. Install it with `npm install @codepawlhq/crucible-three-bridge three`.

```js
import * as THREE from 'three';
import { exportGlb } from '@codepawlhq/crucible';
import { fromThreeObject, toThreeObject } from '@codepawlhq/crucible-three-bridge';

const { parts, warnings } = fromThreeObject(group);   // three.js Object3D -> Crucible parts
const { object } = toThreeObject(parts, THREE);        // Crucible parts -> Group of Mesh
const glb = exportGlb(parts);                          // Crucible parts -> GLB
```

Anything it cannot map is listed in `warnings`. A `ShaderMaterial` and a `SkinnedMesh` without bones throw an error that names the object. The guide with the mapping table, limits and options is [docs/three-bridge.md](../../docs/three-bridge.md).
