import assert from 'node:assert/strict';
import test from 'node:test';
import { stripGlslComments } from '../scripts/strip-glsl-comments.mjs';

function shader(...lines) {
  return ['const source = `#version 300 es', ...lines, '`;'].join('\n');
}

test('line comments inside a shader template are removed', () => {
  const stripped = stripGlslComments(shader('// whole line', 'float a = 1.0; // trailing', '#define SCALE 2.0 // note', 'float b = 2.0;'));
  assert.equal(stripped, shader('float a = 1.0;', '#define SCALE 2.0', 'float b = 2.0;'));
});

test('a // inside a block comment on one line does not cut the block open', () => {
  const source = shader('float a = 1.0; /* old // note */', 'float b = 2.0;');
  assert.equal(stripGlslComments(source), source);
});

test('a // at the end of a line inside a multi-line block comment keeps the closing */', () => {
  const source = shader('/* first line', '   second line // text */', 'float b = 2.0; // gone');
  assert.equal(stripGlslComments(source), shader('/* first line', '   second line // text */', 'float b = 2.0;'));
});

test('a line comment after a closed block comment is still removed', () => {
  assert.equal(stripGlslComments(shader('float a = 1.0; /* keep */ // drop')), shader('float a = 1.0; /* keep */'));
});

test('an open block comment does not leak past the end of its template', () => {
  const source = ['const first = `#version 300 es', '/* never closed', '`;', 'const second = `', 'float a = 1.0; // drop', '`;'].join('\n');
  assert.equal(stripGlslComments(source), ['const first = `#version 300 es', '/* never closed', '`;', 'const second = `', 'float a = 1.0;', '`;'].join('\n'));
});
