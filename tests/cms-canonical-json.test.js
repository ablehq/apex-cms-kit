import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalize, stringifyCanonical } from '../src/cms/canonical-json.js';

test('object keys sort, array order is left alone', () => {
	const value = { b: 1, a: { d: 4, c: 3 }, list: [{ z: 26, y: 25 }] };
	assert.deepEqual(Object.keys(/** @type {object} */ (canonicalize(value))), ['a', 'b', 'list']);
	assert.deepEqual(Object.keys(/** @type {any} */ (canonicalize(value)).a), ['c', 'd']);
	// The array keeps its order; only the objects inside it get sorted keys.
	assert.deepEqual(Object.keys(/** @type {any} */ (canonicalize(value)).list[0]), ['y', 'z']);
});

test('semantic array order survives — sections and rows are not sorted', () => {
	const doc = { sections: [{ id: 's02' }, { id: 's01' }] };
	assert.deepEqual(
		/** @type {any} */ (canonicalize(doc)).sections.map((/** @type {any} */ s) => s.id),
		['s02', 's01']
	);
});

test('serialization is deterministic regardless of input key order', () => {
	const a = stringifyCanonical({ two: 2, one: 1, nested: { b: 2, a: 1 } });
	const b = stringifyCanonical({ nested: { a: 1, b: 2 }, one: 1, two: 2 });
	assert.equal(a, b);
});

test('the on-disk form is tab-indented with a trailing newline', () => {
	const out = stringifyCanonical([{ a: 1 }]);
	assert.ok(out.endsWith('\n'));
	assert.match(out, /\n\t\t"a": 1/);
});

test('primitives and null pass through', () => {
	assert.equal(canonicalize(null), null);
	assert.equal(canonicalize(3), 3);
	assert.equal(canonicalize('x'), 'x');
	assert.deepEqual(canonicalize([]), []);
});
