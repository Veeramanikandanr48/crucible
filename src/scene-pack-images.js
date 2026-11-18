// Gives the texture images of a packed scene back the form the renderer uploads. The pack holds an image as plain
// { width, height, data } (a baked lightmap is one byte per channel); a browser uploads ImageData, which the recipe build
// makes through createImage in src/material-texture-kit.js. This module imports nothing, so the runtime stays light.

function isPackedImage(value) {
  return value !== null && typeof value === 'object' && value.data instanceof Uint8ClampedArray
    && Number.isInteger(value.width) && Number.isInteger(value.height);
}

function imageDataOf(image) {
  return typeof ImageData === 'function' ? new ImageData(image.data, image.width, image.height) : image;
}

function materialWithImageData(material) {
  let changed = null;
  for (const [slot, texture] of Object.entries(material)) {
    if (texture === null || typeof texture !== 'object' || !isPackedImage(texture.image)) continue;
    changed ??= { ...material };
    changed[slot] = { ...texture, image: imageDataOf(texture.image) };
  }
  return changed ?? material;
}

/** The parts with every packed texture image turned into ImageData (a part without textures is returned as it is). */
export function partsWithImageData(parts) {
  return parts.map(part => {
    const material = part.material ? materialWithImageData(part.material) : part.material;
    return material === part.material ? part : { ...part, material };
  });
}
