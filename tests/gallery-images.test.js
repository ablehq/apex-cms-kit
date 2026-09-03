// @ts-nocheck — node:test suite over dynamic Apex shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarizeGalleryImage } from '../src/server/bff/operations/list-gallery-images.ts';

describe('summarizeGalleryImage — the thumbnail a picker browses', () => {
	const withBytes = {
		id: 'img-1',
		gallery_id: 'gal-1',
		caption: 'A caption',
		alt: 'Alt text',
		position: 2,
		created_at: '2026-01-01T00:00:00Z',
		medium: { file: { key: 'uploads/abc.jpg' } }
	};

	it('composes the URL the public pages compose, from the site prefix', () => {
		const image = summarizeGalleryImage(withBytes, 'https://assets.example');
		assert.equal(image.url, 'https://assets.example/cdn-cgi/image/f=auto,w=auto/uploads/abc.jpg');
		assert.equal(image.caption, 'A caption');
		assert.equal(image.position, 2);
	});

	it('is null with no prefix — the picker then shows the id, as it did before', () => {
		assert.equal(summarizeGalleryImage(withBytes).url, null);
		assert.equal(summarizeGalleryImage(withBytes, '').url, null);
	});

	it('is null when no bytes are attached: `medium` is absent until an upload lands', () => {
		const noBytes = { ...withBytes, medium: undefined };
		assert.equal(summarizeGalleryImage(noBytes, 'https://assets.example').url, null);
		// And a half-shaped medium does not throw.
		assert.equal(summarizeGalleryImage({ ...withBytes, medium: {} }, 'https://x').url, null);
		assert.equal(
			summarizeGalleryImage({ ...withBytes, medium: { file: {} } }, 'https://x').url,
			null
		);
	});
});
