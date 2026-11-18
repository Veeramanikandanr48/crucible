import test from 'node:test';
import assert from 'node:assert/strict';
import { clipDisplayName, fallbackClipName, resolveClipIndex } from '../src/clip-name.js';

const animations = [{ name: 'Survey' }, { name: 'Walk' }, {}, { name: '' }];

test('an unnamed clip gets one fallback name', () => {
  assert.equal(fallbackClipName(0), 'animation_0');
  assert.equal(clipDisplayName({}, 2), 'animation_2');
  assert.equal(clipDisplayName({ name: '' }, 3), 'animation_3');
  assert.equal(clipDisplayName({ name: 'Run' }, 1), 'Run');
});

test('a clip is found by index or by name, and an index keeps working', () => {
  assert.equal(resolveClipIndex(animations, 1), 1);
  assert.equal(resolveClipIndex(animations, 'Walk'), 1);
  assert.equal(resolveClipIndex(animations, 'animation_2'), 2);
});

test('an unknown name or index lists the valid names', () => {
  assert.throws(() => resolveClipIndex(animations, 'Fly'), /clip "Fly" does not exist\. Pass an index or a name: 0 "Survey", 1 "Walk", 2 "animation_2", 3 "animation_3"\./);
  assert.throws(() => resolveClipIndex(animations, 9), /clip 9 does not exist\. Pass an index or a name: 0 "Survey"/);
  assert.throws(() => resolveClipIndex([], 'Walk'), /The asset has no clips\./);
});

test('a name shared by several clips asks for an index', () => {
  assert.throws(() => resolveClipIndex([{ name: 'A' }, { name: 'A' }], 'A'), /names 2 clips\. Pass one of their indexes: 0, 1\./);
});
