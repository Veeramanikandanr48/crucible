# Web Studio

Crucible Web Studio is the browser editor for a scene recipe. You pick a node in the viewport, drag a gizmo, change a material, and export the same JSON that an AI agent edits through MCP. It ships in `crucible/addons/studio`; the core library entry does not grow.

![Web Studio with the selected node and transform gizmo](https://raw.githubusercontent.com/codepawl/crucible/evidence-pr-2191/studio-node.png)

## Open the Studio

Open [`/studio.html`](/studio.html) on this site or on a dev server. The page starts with a small scene. Use **Import JSON** to load one of your own recipes, then **Export JSON** to save the current recipe.

The viewport controls stay close to the scene:

- Click a part to select it.
- Drag the arrows to move it, the rings to rotate it, and the boxes to scale it.
- Choose **Snap** and click another part to place the selection on that surface.
- Use the material and look controls to change color, roughness, metalness, environment and effects.
- Save a camera bookmark to keep a named shot in the recipe timeline.

![Web Studio with look controls and a saved camera bookmark](https://raw.githubusercontent.com/codepawl/crucible/evidence-pr-2191/studio-look.png)

## Studio and agents share the recipe

The Studio edits a `crucible.scene` recipe, not a separate editor format. An agent can use MCP tools to change the same recipe, and the Studio can open the result. Every edit returns a deterministic patch, so a person can see what changed and an agent can keep working from the same revision.

## Add Studio to an app

Import `createStudio` from `crucible/addons/studio` and pass a container and a recipe.

```js
import { createStudio } from 'crucible/addons/studio';

const studio = createStudio(document.querySelector('#studio-root'), {
  recipe: {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'clay', tag: 'surface', color: [0.8, 0.4, 0.3], roughness: 0.45, metallic: 0 }],
    nodes: [{ id: 'cube', geometry: 'box', material: 'clay', translation: [0, 0.5, 0] }],
    camera: { eye: [3, 2, 4], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45 },
  },
});

const recipe = studio.exportRecipe();
```

For a headless controller, use `createStudioController` with an [`agent scene`](#agent-workflows). It drives picking, gizmo drags, surface snapping, look edits and camera bookmarks without rendering a DOM.
