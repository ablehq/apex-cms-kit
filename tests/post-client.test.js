// @ts-nocheck — node:test suite over the client's URL shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApexAdminClient } from '../src/server/bff/apex-admin-client.ts';

/**
 * `allowedPostSlugs` — the post methods are unreachable until a site names its
 * post schemas, and the content-library methods stay unable to reach them.
 */

const UUID = '11111111-c70c-47e4-8f6b-ad122832367b';

function recording() {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({
			url: `${url}`,
			method: init.method,
			body: init.body ? JSON.parse(init.body) : null
		});
		return new Response(JSON.stringify({ data: { id: UUID } }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	};
	return { calls, fetchImpl };
}

describe('the post methods behind allowedPostSlugs', () => {
	it('refuse every post method when no post slug is enabled', async () => {
		const { calls, fetchImpl } = recording();
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 't',
			fetchImpl,
			allowedSchemaSlugs: ['focus_area']
		});
		await assert.rejects(() => client.listPosts('story'), /not an allowed post archetype schema/u);
		await assert.rejects(() => client.listPostArchetypes('story'), /not an allowed/u);
		await assert.rejects(() => client.getPostArchetype('story', UUID), /not an allowed/u);
		await assert.rejects(
			() => client.createPost('story', { title: 'x', slug: 'x' }),
			/not an allowed/u
		);
		await assert.rejects(() => client.updatePostArchetype('story', UUID, {}), /not an allowed/u);
		await assert.rejects(() => client.deletePost('story', UUID), /not an allowed/u);
		await assert.rejects(() => client.updatePostFields(UUID, { title: 'x' }), /not enabled/u);
		assert.deepEqual(calls, [], 'nothing reached Apex');
	});

	it('refuse a post slug outside the list, and a content-library slug on the post surface', async () => {
		const { calls, fetchImpl } = recording();
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 't',
			fetchImpl,
			allowedSchemaSlugs: ['focus_area'],
			allowedPostSlugs: ['update']
		});
		await assert.rejects(() => client.listPosts('story'), /not an allowed post/u);
		await assert.rejects(() => client.listPosts('focus_area'), /not an allowed post/u);
		// And the OTHER direction still holds: the post slug is not a content-library slug.
		await assert.rejects(() => client.listContentLibrary('update'), /not a content-library/u);
		await assert.rejects(
			() => client.updateContentLibraryRecord('update', UUID, {}),
			/not a content-library/u
		);
		assert.deepEqual(calls, []);
	});

	it('address the two id spaces on the surfaces the plan names, and the schema filter wins', async () => {
		const { calls, fetchImpl } = recording();
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 't',
			fetchImpl,
			allowedPostSlugs: ['update', 'story']
		});
		await client.listPosts('story', { 'q[archetype_schema_slug_eq]': 'update', 'q[id_eq]': UUID });
		assert.match(calls[0].url, /\/cms\/post_archetype_views\/search_and_filter\?/u);
		// The FIXED filter wins over the caller's, and there is exactly one of it.
		const params = new URL(calls[0].url).searchParams;
		assert.deepEqual(params.getAll('q[archetype_schema_slug_eq]'), ['story']);
		assert.equal(params.get('q[id_eq]'), UUID);

		await client.listPostArchetypes('story');
		assert.match(
			calls[1].url,
			/\/specification\/archetypes\/search_and_filter\?.*slug_eq%5D=story$/u
		);

		await client.getPostArchetype('story', UUID);
		assert.equal(
			calls[2].url,
			`https://apex.internal/api/platform/v1/specification/archetype_schemas/story/archetypes/${UUID}`
		);

		await client.createPost(
			'story',
			{ title: 'T', slug: 't' },
			{ kind: 'video' },
			{ focus_area: [{ focus_area: UUID }] }
		);
		assert.equal(
			calls[3].url,
			'https://apex.internal/api/platform/v1/specification/archetype_schemas/story/archetype_models'
		);
		assert.deepEqual(calls[3].body, {
			target_model_attributes: { title: 'T', slug: 't' },
			kind: 'video',
			focus_area: [{ focus_area: UUID }]
		});

		await client.updatePostArchetype('story', UUID, { kind: 'interview' }, { author: null });
		assert.equal(calls[4].method, 'PATCH');
		assert.match(calls[4].url, /archetype_schemas\/story\/archetype_models\/.*$/u);
		assert.deepEqual(calls[4].body, { kind: 'interview', author: null });

		await client.updatePostFields(UUID, { title: 'T2' });
		assert.equal(calls[5].url, `https://apex.internal/api/platform/v1/cms/posts/${UUID}`);
		assert.equal(calls[5].method, 'PATCH');

		await client.deletePost('update', UUID);
		assert.equal(calls[6].method, 'DELETE');
		assert.match(calls[6].url, /archetype_schemas\/update\/archetype_models\//u);
	});
});
