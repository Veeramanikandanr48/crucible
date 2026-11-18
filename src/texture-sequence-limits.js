// Colour map as an image sequence: frames are catalog images, the frame follows the scene's motion time. Kept outside
// agent-scene-capabilities.js so the scene entry does not carry text only an agent reads; the MCP runtime adds it to
// scene_capabilities.

export const TEXTURE_SEQUENCE_LIMITS = Object.freeze({
  // maxFrames bounds the list in a recipe. A sequence of at most wholeSequenceFrames frames is decoded whole; a longer one streams,
  // and only the frame of the current time and the one before it stay decoded. maxDecodedBytes bounds the decoded bytes a scene
  // keeps at once, and one frame is at most maxSide x maxSide x 4 = 16 MiB.
  maxFrames: 4096, wholeSequenceFrames: 64, maxFps: 60, maxSide: 2048, maxDecodedBytes: 64 * 1024 * 1024,
});

export const TEXTURE_SEQUENCE_CAPABILITIES = Object.freeze({
  field: 'material.map = { sequence: { frames: [catalog image asset IDs], fps, loop } }',
  covers: 'color map (map) of surface-tag materials; needs UVs (grid, box and similar); not combined with pattern',
  frame: 'floor(motionTime * fps), wrapped when loop is true (default) and held on the last frame when false; frame 0 before any motion time',
  clock: 'motionTime, also in render jobs (settings.motion.start + elapsed)',
  streaming: 'a sequence of more than wholeSequenceFrames frames loads on demand: the host reads and decodes the frame of each requested time and keeps the one before it, so a video job decodes each frame once, in frame order, and the limits are per frame (maxSide) and for the decoded frames kept at once (maxDecodedBytes), not for the whole list. Streaming covers scene_look with a time and the raster still and video jobs; scene_review (all shots in one call) and path traced or native jobs (settings.renderer, which refuses a streamed sequence) need a sequence of at most wholeSequenceFrames frames. Shorter sequences load whole.',
  images: 'PNG, JPEG or WebP files in the --assets folder, listed by scene_asset_catalog with kind image; opaque pixels, one size for all frames',
  catalog: 'a folder of more than 256 consecutively numbered images is listed by scene_asset_catalog under sequences, not per frame; write map.sequence = { catalog: the sequence name such as "frame_####.png", fps, loop } instead of frames. The server swaps in the frame IDs (hashed on first use, not at startup)',
  ...TEXTURE_SEQUENCE_LIMITS,
});
