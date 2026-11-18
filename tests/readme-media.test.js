import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const webpUrlPattern = /https:\/\/[^\s"')<>]+\.webp/g;
const previewFilePattern = /^\/previews\/([\w.-]+\.webp)$/;

// Parse each URL and compare the host exactly, so only renders served from the Crucible site count.
function previewFilesIn(text) {
  const files = [];
  for (const [address] of text.matchAll(webpUrlPattern)) {
    const url = new URL(address);
    const match = url.pathname.match(previewFilePattern);
    if (url.hostname === 'crucible.codepawl.com' && match) files.push(match[1]);
  }
  return files;
}

function previewPath(fileName) {
  return new URL(`../public/previews/${fileName}`, import.meta.url);
}

function isAnimatedWebp(fileName) {
  return readFileSync(previewPath(fileName)).includes('ANMF');
}

test('the README shows a moving render before its first section', () => {
  const aboveTheFold = readme.slice(0, readme.indexOf('\n## '));
  const files = previewFilesIn(aboveTheFold);
  assert.ok(files.length > 0, 'Put a Crucible render from public/previews above the first "##" heading of README.md.');
  const moving = files.filter((fileName) => existsSync(previewPath(fileName)) && isAnimatedWebp(fileName));
  assert.ok(moving.length > 0, 'Add an animated webp (for example feature-clockwork.webp) above the first "##" heading of README.md.');
});

test('the README gallery lists renders that exist in public/previews', () => {
  const galleryStart = readme.indexOf('\n## Gallery');
  assert.ok(galleryStart > 0, 'Add a "## Gallery" section with current renders to README.md.');
  const galleryEnd = readme.indexOf('\n## ', galleryStart + 1);
  const files = previewFilesIn(readme.slice(galleryStart, galleryEnd));
  assert.ok(files.length >= 3, `The README gallery shows ${files.length} renders; show at least 3.`);
  for (const fileName of files) {
    assert.ok(existsSync(previewPath(fileName)), `README.md links ${fileName} but public/previews/${fileName} is missing.`);
  }
});
