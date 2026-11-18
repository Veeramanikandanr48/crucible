// A folder of numbered images (frame_0001.png, frame_0002.png, ...) is one catalog entry once it holds more than 256 frames. The
// entry has no per-frame hash at startup: the frames are hashed when a recipe names the sequence.

const NUMBERED_IMAGE = /^(.*?)(\d{1,9})(\.(?:png|jpe?g|webp))$/i;
const MAXIMUM_PATTERN_LENGTH = 200;

/**
 * The shortest run that collapses. A shorter folder stays one entry per frame (256 entries list in about 40 KB), so a recipe can still
 * pass the frame IDs it reads from the catalog; a longer one lists in a few hundred bytes.
 */
export const MINIMUM_SEQUENCE_RUN = 257;

/**
 * Finds the runs of consecutive numbered images among file names. A run shares one prefix, extension and digit width
 * and has no gap in its numbers; `pattern` writes the digits as `#`, such as "frame_####.png". Names are sorted by frame number.
 */
export function findSequenceRuns(fileNames) {
  const groups = new Map();
  for (const name of fileNames) {
    const match = NUMBERED_IMAGE.exec(name);
    if (!match || name.length > MAXIMUM_PATTERN_LENGTH) continue;
    const [, prefix, digits, extension] = match;
    const key = `${prefix}\0${digits.length}\0${extension}`;
    if (!groups.has(key)) groups.set(key, { prefix, width: digits.length, extension, frames: [] });
    groups.get(key).frames.push({ number: Number(digits), name });
  }
  const runs = [];
  for (const group of groups.values()) {
    group.frames.sort((left, right) => left.number - right.number);
    const first = group.frames[0].number;
    const last = group.frames.at(-1).number;
    const isConsecutive = last - first + 1 === group.frames.length;
    if (group.frames.length < MINIMUM_SEQUENCE_RUN || !isConsecutive) continue;
    runs.push({
      pattern: `${group.prefix}${'#'.repeat(group.width)}${group.extension}`,
      first,
      last,
      names: group.frames.map(frame => frame.name),
    });
  }
  return runs;
}
