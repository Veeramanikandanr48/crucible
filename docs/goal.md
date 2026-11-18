# Goal

Crucible aims to be as capable as Blender, as light as three.js, and as AI friendly as possible. No public claim of parity or speed is allowed until the evidence below exists.

## Stance

Crucible makes 3D easy to understand and easy to do. Designers and AI agents work together on one scene to build lightweight realtime 3D for the web. The agent carries the heavy technical steps: setup, geometry, modifiers, rigging, checks and renders. The person shapes composition, form, lighting and materials directly in a streamlined web Studio (#2177) or through previews. Both work on the same deterministic scene recipe.

Every surface follows from this:

- **Show, then tell.** The README, docs, changelog and release notes lead with renders and clips made by Crucible. A reader sees what a feature makes before reading how it works. A change that people can see ships with a picture or a short clip.
- **Plain words.** Copy says what the person can make and what the agent does for them. Code comes after that.
- **The person stays in the loop.** Designers adjust framing, transforms, lights and materials directly in the web Studio. Agent tools also return previews, review grids and `scene_ask_user` choices.

## Definitions

**As capable as Blender.** Every in-scope row of the parity ledger (`docs/parity.md`) has evidence. The reference scenes also reach an agreed score against Cycles and EEVEE. Evidence is a golden fixture or a reference render. A demo does not count.

**As light as three.js.** The same scene costs less than three.js, in bytes and at runtime, on every scene in the matrix. Each entry has a size budget that a pull request cannot pass (`bench/size/README.md`). Exported web builds ship only the runtime player (#2178). Live embeds pause at zero GPU load when idle or offscreen, and use compact render targets (#2179).

**As AI friendly as possible.** A cold agent is compared on the same tasks with the official Blender MCP server and with three.js code. It must succeed more often and use fewer tool calls and tokens, on more than one model, and it never executes generated code (`bench/agent-modeling`).

## Not in scope

- Blender full desktop workspace and multi-editor windowing. Crucible provides a streamlined web Studio on the shared scene recipe (#2177), not a clone of every Blender editor.
- Dedicated game-server hosting, matchmaking and competitive physics rollback. Multiplayer stays an optional room and audience sync addon (`crucible/addons/netcode`) with zero bytes in core.
- The Video Editing sequencer, and Motion Tracking and Masking.
- Grease Pencil.
- Reading `.blend` files, and compatibility with the Blender Python API. GLB is the exchange format.
- Execution of agent-written code inside the engine. Tools stay bounded and schema-checked.

Each of these has a row in `docs/parity.md` with this reason. A change of direction can reopen it.

## Where the work is

GitHub milestones group open issues into `0 Measure`, `1 Lighter`, `2 Modeling`, `3 Look`, `4 Motion and simulation`, `5 Agent surface` and `6 Games`. `6 Games` covers interactive web scenes, single-player and co-op browser games, and live audience presence through optional `crucible/addons/netcode` (WebRTC peer-to-peer or a thin stateless relay). Game logic comes from bounded systems and recipes, never from agent-written code run in the engine. Each issue has a `goal:capable`, `goal:light` or `goal:ai` label. There is no tracking issue.
