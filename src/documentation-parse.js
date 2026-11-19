/** The topic and section a docs hash names. A malformed percent escape names nothing, so the page opens its first topic. */
export function parseDocumentHash(hash) {
  const [topic = '', section = ''] = hash.slice(1).split('/').map(decodeOrEmpty);
  return { topic, section };
}

function decodeOrEmpty(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return '';
  }
}

const FIGURE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/;

/** `![alt](source "caption")` as parts, or null when the paragraph is not a well formed figure. */
export function parseFigure(paragraph) {
  const match = paragraph.match(FIGURE);
  return match ? { alt: match[1], source: match[2], caption: match[3] } : null;
}
