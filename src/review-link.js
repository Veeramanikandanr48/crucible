// The review file of issue #924: a person who is not at the agent's keyboard opens a review page exported by scene_export_web,
// pins the view and saves the marks as a small JSON file. This module is the shared contract: the file shape, its size bound and
// the reader scene_ask_user uses to turn it back into the same marks the local annotate page sends.
import { randomBytes } from 'node:crypto';
import { ANNOTATE_LIMITS, validateMarks } from './agent-annotate.js';

export const REVIEW_FILE_FORMAT = 'crucible.review';
export const REVIEW_LINK_LIMITS = Object.freeze({
  // Sixteen notes of 280 characters, escaped, plus the frame around them, with room to spare.
  maxFileBytes: 16 * 1024,
  // Exports the server remembers the view of; the oldest is forgotten first.
  maxRememberedReviews: 8,
});

const REVIEW_ID_PATTERN = /^[a-f0-9]{32}$/;
const FILE_KEYS = ['format', 'version', 'reviewId', 'marks'];

function invalidReviewFile(detail) {
  return new TypeError(`The review file is invalid: ${detail}`);
}

/** A fresh identifier that ties a saved review file to the export it came from. */
export function newReviewId() {
  return randomBytes(16).toString('hex');
}

/** The file text a review page saves: the same shape parseReviewFile reads. */
export function reviewFileText(reviewId, marks) {
  return JSON.stringify({ format: REVIEW_FILE_FORMAT, version: 1, reviewId, marks: marks.map(({ x, y, note }) => ({ x, y, note })) });
}

/**
 * Reads the text of a saved review file. Returns { reviewId, marks } with the marks still unchecked against a view:
 * validateReviewMarks does that once the export is known. Throws a TypeError that says what to pass instead.
 */
export function parseReviewFile(text) {
  if (typeof text !== 'string') throw invalidReviewFile('pass the text of the file the review page saved.');
  if (Buffer.byteLength(text) > REVIEW_LINK_LIMITS.maxFileBytes) {
    throw invalidReviewFile(`the file is over ${REVIEW_LINK_LIMITS.maxFileBytes} bytes. Pass the file the review page saved, which is smaller.`);
  }
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw invalidReviewFile('it is not JSON. Pass the text of the file the review page saved.');
  }
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw invalidReviewFile('it must be a JSON object.');
  const unknownKey = Object.keys(file).find(key => !FILE_KEYS.includes(key));
  if (unknownKey) throw invalidReviewFile(`unknown field "${unknownKey}". Keep the fields ${FILE_KEYS.join(', ')}.`);
  if (file.format !== REVIEW_FILE_FORMAT || file.version !== 1) {
    throw invalidReviewFile(`format must be "${REVIEW_FILE_FORMAT}" version 1.`);
  }
  if (typeof file.reviewId !== 'string' || !REVIEW_ID_PATTERN.test(file.reviewId)) {
    throw invalidReviewFile('reviewId must be the 32 hexadecimal characters the export wrote into the page.');
  }
  return { reviewId: file.reviewId, marks: file.marks };
}

/** Checks the marks of a review file against the exported view and requires at least one, as the local page does. */
export function validateReviewMarks(marks, { width, height, maxMarks = ANNOTATE_LIMITS.maxMarks }) {
  // The review page lets a person pin at most ANNOTATE_LIMITS.maxMarks, so a larger maxMarks from a caller cannot raise it.
  const clean = validateMarks(marks, { width, height, maxMarks: Math.min(maxMarks, ANNOTATE_LIMITS.maxMarks) });
  if (!clean.length) throw invalidReviewFile('it holds no marks. Ask the reviewer to pin the view and save again.');
  return clean;
}
