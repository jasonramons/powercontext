import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate, pageCount } from '../src/pagination.mjs';

const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));

test('P-1 page 1 returns the first page', () => {
  assert.deepEqual(paginate(rows, 1, 3).map((r) => r.id), [1, 2, 3]);
});

test('P-1 page 2 returns the second page', () => {
  assert.deepEqual(paginate(rows, 2, 3).map((r) => r.id), [4, 5, 6]);
});

test('P-1 last partial page keeps the remainder', () => {
  assert.deepEqual(paginate(rows, 4, 3).map((r) => r.id), [10]);
});

test('P-2 pageSize above 100 is rejected', () => {
  assert.throws(() => paginate(rows, 1, 101), RangeError);
});

test('P-2 pageSize 0 is rejected', () => {
  assert.throws(() => paginate(rows, 1, 0), RangeError);
});

test('P-3 page below 1 is rejected', () => {
  assert.throws(() => paginate(rows, 0, 3), RangeError);
});

test('P-4 out of range page returns an empty array', () => {
  assert.deepEqual(paginate(rows, 99, 3), []);
});

test('P-5 source array is not mutated', () => {
  const input = [{ id: 1 }, { id: 2 }];
  const snapshot = JSON.stringify(input);
  paginate(input, 1, 1);
  assert.equal(JSON.stringify(input), snapshot);
});

test('P-6 pageCount keeps ceiling semantics', () => {
  assert.equal(pageCount(10, 3), 4);
  assert.equal(pageCount(9, 3), 3);
});

test('P-6 pageCount rejects non-positive pageSize', () => {
  assert.throws(() => pageCount(10, 0), RangeError);
});
