import test from 'node:test';
import assert from 'node:assert/strict';
import { firstPartyPackages, npmManifestPath } from '../src/marketplace-npm.js';

test('a plain or scoped npm name becomes its registry manifest path', () => {
  assert.equal(npmManifestPath('hover-controller'), 'hover-controller/latest');
  assert.equal(npmManifestPath('@studio/crucible-hover'), '@studio%2Fcrucible-hover/latest');
});

test('a name that npm would not publish is refused instead of reaching the request', () => {
  for (const name of ['../../-/user', '@a/b/c', 'a/b', 'UPPER', 'a?x=1', 'a#b', '', ' a', 'a'.repeat(215), null, 42]) {
    assert.equal(npmManifestPath(name), null, `refuses ${String(name).slice(0, 20)}`);
  }
});

test('only published @codepawlhq/crucible- companion packages are listed, sorted, without addons or the engine', () => {
  const objects = [
    { package: { name: '@codepawlhq/crucible-three-bridge', version: '0.1.0', description: 'three.js bridge', keywords: ['three'] } },
    { package: { name: '@codepawlhq/crucible', version: '0.21.0', description: 'the engine' } },
    { package: { name: '@codepawlhq/crucible-denoise-oidn', version: '0.2.0' } },
    { package: { name: '@codepawlhq/crucible-hover', version: '1.0.0', keywords: ['crucible-addon'] } },
    { package: { name: '@someone/crucible-denoise', version: '1.0.0' } },
    { package: { name: '@codepawlhq/crucible-../x', version: '1.0.0' } },
    { package: null },
    {},
  ];
  assert.deepEqual(firstPartyPackages(objects), [
    { name: '@codepawlhq/crucible-denoise-oidn', version: '0.2.0', description: '' },
    { name: '@codepawlhq/crucible-three-bridge', version: '0.1.0', description: 'three.js bridge' },
  ]);
});

test('a search result that is not a list gives no packages', () => {
  for (const value of [undefined, null, {}, 'x']) assert.deepEqual(firstPartyPackages(value), []);
});
