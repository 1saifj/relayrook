import { strict as assert } from 'node:assert';
import { paginate, pageCount } from './pager.mjs';

const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

// 1-based paging contract
assert.deepEqual(paginate(items, 1, 3), ['a', 'b', 'c']);
assert.deepEqual(paginate(items, 2, 3), ['d', 'e', 'f']);
assert.deepEqual(paginate(items, 3, 3), ['g']);
assert.deepEqual(paginate(items, 4, 3), []);
assert.deepEqual(paginate([], 1, 5), []);
assert.equal(pageCount(items, 3), 3);
assert.equal(pageCount([], 3), 0);
assert.throws(() => paginate(items, 1, 0), RangeError);

console.log('check: pass');
