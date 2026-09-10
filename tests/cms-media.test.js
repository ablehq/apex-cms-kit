import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMediaIndex } from '../src/cms/media.js';

// The index is read the way PRODUCTION reads it — `media?.get(id)` at
// `cms/page-data.js:116`. There used to be a `resolveMedia(index, id)` accessor
// that only tests called; it is gone, so these assertions go through the Map.
/** @param {Map<string, object>} index @param {unknown} id */
const resolveMedia = (index, id) => (typeof id === 'string' && id ? (index.get(id) ?? null) : null);

test('gallery items are indexed by the id a media field would store', () => {
	const index = buildMediaIndex([
		[
			{
				id: 'attachment-1',
				record_type: 'Cms::GalleryItem',
				record_id: 'gallery-1',
				alt_text: 'The church logo',
				url: 'https://assets.example/logo.png',
				file: { content_type: 'image/png' }
			}
		]
	]);

	assert.deepEqual(resolveMedia(index, 'gallery-1'), {
		url: 'https://assets.example/logo.png',
		alt: 'The church logo',
		contentType: 'image/png'
	});
	// Indexed under both keys, because which one a field stores depends on which
	// endpoint wrote the collection.
	assert.equal(resolveMedia(index, 'attachment-1')?.url, 'https://assets.example/logo.png');
});

test('a record with no usable URL is not indexed', () => {
	const index = buildMediaIndex([
		[{ id: 'a', file: { key: 'only/a/key' } }, { id: 'b' }, null, 'x']
	]);
	assert.equal(index.size, 0);
	assert.equal(resolveMedia(index, 'a'), null);
});

test('the file URL is used when the record has no top-level one', () => {
	const index = buildMediaIndex([[{ id: 'a', file: { url: 'https://assets.example/a.jpg' } }]]);
	assert.equal(resolveMedia(index, 'a')?.url, 'https://assets.example/a.jpg');
});

test('collections merge, and the first writer of an id wins', () => {
	const index = buildMediaIndex([
		[{ id: 'shared', url: 'https://assets.example/first.png' }],
		[{ id: 'shared', url: 'https://assets.example/second.png' }],
		[{ id: 'other', url: 'https://assets.example/other.png' }]
	]);
	assert.equal(resolveMedia(index, 'shared')?.url, 'https://assets.example/first.png');
	assert.equal(index.size, 2);
});

test('an empty snapshot resolves nothing rather than throwing', () => {
	const index = buildMediaIndex([[], undefined, null]);
	assert.equal(index.size, 0);
	assert.equal(resolveMedia(index, 'anything'), null);
	assert.equal(resolveMedia(index, ''), null);
	assert.equal(resolveMedia(index, undefined), null);
});
