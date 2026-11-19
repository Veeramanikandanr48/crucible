import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { siteNavLinks } from '../scripts/site-nav.mjs';

const read = relativePath => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const siteFolder = new URL('../site/', import.meta.url);
const pages = readdirSync(siteFolder).filter(file => file.endsWith('.html') && file !== 'file.html');

const expectedLinks = currentHref => siteNavLinks
  .map(link => `<a href="${link.href}"${link.href === currentHref ? ' aria-current="page"' : ''}>${link.label}</a>`)
  .join('');

function currentHref(fileName) {
  if (fileName === 'studio.html') return './studio.html';
  if (fileName === 'docs.html') return './docs.html';
  if (fileName === 'recipes.html' || fileName.startsWith('recipe-')) return './recipes.html';
  if (fileName === 'changelog.html') return './changelog.html';
  if (fileName === 'marketplace.html') return './marketplace.html';
  if (fileName === 'showcase.html') return './index.html#examples';
  return null;
}

test('every public site page has the same navigation and theme color', () => {
  for (const fileName of pages) {
    const html = read(`site/${fileName}`);
    const nav = html.match(/<nav[^>]*aria-label="Site"[^>]*>(.*?)<\/nav>/s);
    assert.ok(nav, `${fileName} has no shared navigation`);
    assert.equal(nav[1], expectedLinks(currentHref(fileName)), `${fileName} navigation differs`);
    assert.match(html, /<meta name="theme-color" content="#f8f7f1" \/>/, `${fileName} theme color differs`);
  }
});

test('the shared navigation has icons for Studio and Recipes', () => {
  const brand = read('src/brand.js');
  assert.match(brand, /Studio:'studio'/);
  assert.match(brand, /Recipes:'recipes'/);
  assert.match(brand, /studio:'M4 6h10/);
  assert.match(brand, /recipes:'M5 4h14/);
});

test('the shared navigation fits a phone without wrapping', () => {
  const css = read('src/site.css');
  assert.match(css, /\.site \.navigation nav \{ gap: clamp\(4px, 1\.5vw, 9px\); \}/);
  assert.match(css, /\.site \.navigation nav a \{ font-size: clamp\(8px, 2\.6vw, 11px\); \}/);
  assert.match(css, /\.site \.navigation nav a \.icon \{ display: none; \}/);
});
