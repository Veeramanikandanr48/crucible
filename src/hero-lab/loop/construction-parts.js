// The parts a renderer is constructed on only decide which shader features the program has. The constructor uploads their textures in one
// block, and a world's representative parts carry several large ones. Constructing on stand-in textures of one pixel moves those uploads to
// uploadTexturesInSlices, which makes them a few milliseconds at a time. The stand-ins keep every field that decides a shader feature
// (which maps exist, color space, filtering), so the program is the same one.

const MAP_FIELDS = ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];

const createOnePixelImage = () => new ImageData(1, 1);

// A part keeps its real textures when something other than the constructor's batch decides its lifetime (pinned parts stay in the
// renderer through replaceParts) or when its textures are not one of the five material maps.
const keepsRealTextures = (part, isPinned) => isPinned(part) || Boolean(part.material?.layers || part.material?.splat || part.material?.lightMap);

/**
 * Returns `parts` with each unpinned part's material maps replaced by one-pixel stand-ins. A part without maps, and every pinned part, is
 * returned as it is. The stand-in parts are new objects, so a later replaceParts of the real parts never keeps a batch that holds a stand-in.
 */
export function withStandInTextures(parts, isPinned, createImage = createOnePixelImage) {
  const standIns = new Map();
  const standInOf = descriptor => {
    if (!standIns.has(descriptor)) standIns.set(descriptor, { ...descriptor, image: createImage() });
    return standIns.get(descriptor);
  };
  return parts.map(part => {
    if (keepsRealTextures(part, isPinned) || !MAP_FIELDS.some(field => part.material?.[field])) return part;
    const material = { ...part.material };
    for (const field of MAP_FIELDS) if (material[field]) material[field] = standInOf(material[field]);
    return { ...part, material };
  });
}
