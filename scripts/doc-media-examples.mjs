// Reads the live examples of a learn page that ask for a picture or a loop. No browser code lives here so tests can load it.

const POSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Return the examples of one page: `{ poster, loopSeconds }`, with loopSeconds 0 when the page shows no WebM for it. */
export function parseDocMediaExamples(page, text) {
  const examples = [];
  for (const match of text.matchAll(/^```js live([^\n]*)$/gm)) {
    const options = Object.fromEntries(match[1].trim().split(/\s+/).filter(Boolean).map(flag => flag.split('=')));
    if (!options.poster) continue;
    if (!POSTER_NAME.test(options.poster)) throw new Error(`${page}: poster "${options.poster}" must be a plain file name of letters, digits, - and _; pass e.g. poster=hero-scene.`);
    const wantsLoop = text.includes(`/docs-media/${options.poster}.webm`);
    const loopSeconds = wantsLoop ? Number(options.loop) : 0;
    if (wantsLoop && !(loopSeconds > 0 && loopSeconds <= 60)) throw new Error(`${page}/${options.poster}: the page shows a WebM, so the example needs loop=<seconds> from 0 to 60; pass e.g. loop=4.`);
    examples.push({ poster: options.poster, loopSeconds });
  }
  return examples;
}

/** Return the page ids to render: all of them, or the requested ones. */
export function selectDocMediaPages(available, requested) {
  if (!requested.length) return available;
  const unknown = requested.filter(page => !available.includes(page));
  if (unknown.length) throw new Error(`No learn page named ${unknown.join(', ')}; pass one of: ${available.join(', ')}.`);
  return available.filter(page => requested.includes(page));
}
