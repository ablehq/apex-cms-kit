import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	collectArchetypeReferences,
	createArchetypesDataEntry
} from '../src/cms/archetype-data.js';

describe('CMS post archetype collection', () => {
	it('always creates the archetypes collection when there are no posts', () => {
		const references = collectArchetypeReferences([{ type: 'posts', data: [] }]);
		const collection = createArchetypesDataEntry([]);

		assert.deepEqual(references, []);
		assert.deepEqual(collection, {
			name: 'archetypes',
			type: 'archetypes',
			data: []
		});
	});

	it('deduplicates references shared by multiple posts', () => {
		const post = {
			archetype_id: 'article-data-id',
			archetype_schema_slug: 'article'
		};

		assert.deepEqual(collectArchetypeReferences([{ type: 'posts', data: [post, post] }]), [
			{ archetypeId: 'article-data-id', archetypeSlug: 'article' }
		]);
	});
});
