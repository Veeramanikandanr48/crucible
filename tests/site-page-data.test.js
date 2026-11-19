import test from 'node:test';
import assert from 'node:assert/strict';

test('a malformed percent escape in the docs hash opens no topic instead of throwing', async () => {
  const { parseDocumentHash } = await import('../src/documentation-parse.js');
  assert.deepEqual(parseDocumentHash('#%E0%A4%A'), { topic: '', section: '' });
  assert.deepEqual(parseDocumentHash('#camera/%'), { topic: 'camera', section: '' });
});

test('a well formed docs hash keeps its topic and section, decoded', async () => {
  const { parseDocumentHash } = await import('../src/documentation-parse.js');
  assert.deepEqual(parseDocumentHash('#camera/lens%20setup'), { topic: 'camera', section: 'lens setup' });
  assert.deepEqual(parseDocumentHash(''), { topic: '', section: '' });
});

test('an image paragraph with a bare space in its target is not a figure', async () => {
  const { parseFigure } = await import('../src/documentation-parse.js');
  assert.equal(parseFigure('![sky](a b.png)'), null);
  assert.deepEqual(parseFigure('![sky](a.png "A sky")'), { alt: 'sky', source: 'a.png', caption: 'A sky' });
  assert.deepEqual(parseFigure('![sky](a.webm)'), { alt: 'sky', source: 'a.webm', caption: undefined });
});

test('one malformed npm search entry does not hide the other addons', async () => {
  const { addonEntries } = await import('../src/marketplace-npm.js');
  const objects = [
    null,
    {},
    { package: { name: '../evil', version: '1.0.0' } },
    { package: { name: 'crucible-hover', version: '1.2.0', description: 'hover' } },
    { package: { name: 'crucible-bare' } },
  ];
  assert.deepEqual(addonEntries(objects), [
    { name: 'crucible-hover', version: '1.2.0', description: 'hover', range: null },
    { name: 'crucible-bare', version: '', description: '', range: null },
  ]);
  assert.deepEqual(addonEntries(undefined), []);
});
