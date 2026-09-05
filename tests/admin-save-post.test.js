// @ts-nocheck — node:test suite over the admin browser modules.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	createPostDraft,
	hasPostArchetypeChanges,
	hasPostFieldChanges,
	isPostDirty,
	postArchetypePatch,
	postFieldsPatch,
	reconcilePost,
	setPostArchetypeField,
	setPostBlocks,
	setPostCover,
	setPostField,
	setPostReference,
	setPostTags
} from '../src/admin/post-draft.js';
import { savePost, STALE_MESSAGE } from '../src/admin/save-post.js';

/**
 * The post draft and the ordered save, without a DOM and without a network. What
 * is pinned is the part that is invisible when it is wrong: the write ORDER
 * (fields → body → archetype → tags → status), that a failure stops everything
 * after it, that the status event is never dispatched after a failure, and that
 * no code path in the draft can produce the `null` that destroys a field upstream.
 */

const ID = '11111111-2222-3333-4444-555555555555';
const FA1 = '11111111-1111-2222-3333-444444444444';
const FA2 = '22222222-1111-2222-3333-444444444444';
const AUTHOR = '33333333-1111-2222-3333-444444444444';
const IMG = '44444444-1111-2222-3333-444444444444';
const TAG = '55555555-1111-2222-3333-444444444444';

const contract = {
	schema: (slug) => (slug === 'story' ? { slug } : null),
	primitiveFieldDefs: () => [{ field_name: 'kind' }],
	referenceItems: () => [
		{ name: 'author', relationship_kind: 'has_one' },
		{ name: 'focus_area', relationship_kind: 'has_many' }
	]
};

const post = {
	id: ID,
	title: 'T',
	slug: 't',
	summary: 'S',
	publishedDate: '2026-07-01',
	status: 'draft',
	fields: { kind: 'video' },
	references: { author: [], focus_area: [{ itemId: 'j1', targetId: FA1 }] },
	tags: [{ id: 'tg1', tagId: TAG, tagName: 'Water' }],
	coverId: null,
	meta: { title: 'M', description: 'D', keywords: 'K' },
	blocks: [{ id: 'b1', kind: 'rich_text', html: '<p>one</p>' }]
};

/** A recording BFF double. `fail` forces one method to answer not-ok. */
function makeClient({ fail = null, status = 500, version = 'v1' } = {}) {
	const calls = [];
	const ok =
		(name) =>
		async (...args) => {
			calls.push({ name, args });
			if (fail === name) return { ok: false, status };
			return { ok: true, status: 200 };
		};
	return {
		calls,
		readPostVersion: async (slug, id) => {
			calls.push({ name: 'readPostVersion', args: [slug, id] });
			return { version };
		},
		updatePost: ok('updatePost'),
		savePostBody: ok('savePostBody'),
		updatePostArchetype: ok('updatePostArchetype'),
		setPostTags: ok('setPostTags'),
		changePostStatus: ok('changePostStatus'),
		getPost: async (slug, id) => {
			calls.push({ name: 'getPost', args: [slug, id] });
			return { post: { ...post, title: 'T2' }, version: 'v2' };
		}
	};
}

const names = (client) => client.calls.map((call) => call.name);

function dirtyEverything(draft) {
	setPostField(draft, 'title', 'T2');
	setPostField(draft, 'metaKeywords', 'K2');
	setPostCover(draft, IMG);
	setPostBlocks(draft, [{ id: null, kind: 'quote', quote: 'q', quotedBy: 'a' }]);
	setPostArchetypeField(draft, 'kind', 'interview');
	setPostReference(draft, 'author', AUTHOR);
	setPostReference(draft, 'focus_area', [FA1, FA2]);
	setPostTags(draft, []);
}

describe('post-draft — six stages, tracked independently', () => {
	it('starts clean, and every setter returns to clean when set back', () => {
		const draft = createPostDraft('story', post, 'v1', contract);
		assert.equal(isPostDirty(draft), false);
		assert.deepEqual(draft.references, { author: null, focus_area: [FA1] });
		assert.deepEqual(draft.tagIds, [TAG]);

		setPostField(draft, 'title', 'x');
		setPostField(draft, 'title', 'T');
		setPostCover(draft, IMG);
		setPostCover(draft, null);
		setPostArchetypeField(draft, 'kind', 'article');
		setPostArchetypeField(draft, 'kind', 'video');
		setPostReference(draft, 'focus_area', [FA2]);
		setPostReference(draft, 'focus_area', [FA1]);
		setPostTags(draft, []);
		setPostTags(draft, [TAG]);
		setPostBlocks(draft, []);
		setPostBlocks(draft, post.blocks);
		assert.equal(isPostDirty(draft), false, 'Save goes back to disabled');
	});

	it('splits the SEO triple and the cover out of the fields patch, only when moved', () => {
		const draft = createPostDraft('story', post, 'v1', contract);
		setPostField(draft, 'slug', 't2');
		assert.deepEqual(postFieldsPatch(draft), { slug: 't2' });
		setPostField(draft, 'metaTitle', 'M2');
		setPostCover(draft, IMG);
		assert.deepEqual(postFieldsPatch(draft), { slug: 't2', meta: { title: 'M2' }, coverId: IMG });
		setPostCover(draft, null);
		assert.equal('coverId' in postFieldsPatch(draft), false, 'back to the baseline cover');
	});

	it('clearing the cover to null is a real edit — the one legitimate null on this route', () => {
		const draft = createPostDraft('story', { ...post, coverId: IMG }, 'v1', contract);
		setPostCover(draft, null);
		assert.equal(draft.coverDirty, true);
		assert.deepEqual(postFieldsPatch(draft), { coverId: null });
	});

	it('the archetype patch carries dirty primitives and changed reference sets, in the record shape', () => {
		const draft = createPostDraft('story', post, 'v1', contract);
		assert.equal(hasPostArchetypeChanges(draft), false);
		setPostArchetypeField(draft, 'kind', null);
		assert.equal(draft.archetypeFields.kind, '', 'null becomes the safe clear');
		setPostReference(draft, 'author', null);
		assert.equal(
			draft.dirtyReferences.has('author'),
			false,
			'null on an already-empty has_one is not a change'
		);
		setPostReference(draft, 'author', AUTHOR);
		setPostReference(draft, 'focus_area', [FA2, FA1]);
		assert.deepEqual(postArchetypePatch(draft), {
			fields: { kind: '' },
			references: { author: AUTHOR, focus_area: [FA2, FA1] }
		});
		assert.equal(JSON.stringify(postArchetypePatch(draft).fields).includes('null'), false);
	});

	it('refuses a field name the contract does not have', () => {
		const draft = createPostDraft('story', post, 'v1', contract);
		assert.equal(setPostField(draft, 'status', 'published'), false);
		assert.equal(setPostArchetypeField(draft, 'transcript_reviewed', true), false);
		assert.equal(setPostReference(draft, 'partner', []), false);
		assert.equal(isPostDirty(draft), false);
	});

	it('reconcile adopts the server record and clears every stage', () => {
		const draft = createPostDraft('story', post, 'v1', contract);
		dirtyEverything(draft);
		assert.equal(isPostDirty(draft), true);
		reconcilePost(draft, { ...post, status: 'published', coverId: IMG }, 'v2');
		assert.equal(isPostDirty(draft), false);
		assert.equal(draft.baselineVersion, 'v2');
		assert.equal(draft.coverId, IMG);
		assert.equal(draft.post.status, 'published');
	});
});

describe('savePost — the write order, and what never runs after a failure', () => {
	it('writes fields, then body, then archetype, then tags, then status — in that order', async () => {
		const client = makeClient();
		const draft = createPostDraft('story', post, 'v1', contract);
		dirtyEverything(draft);

		const result = await savePost(draft, client, { statusEvent: 'publish' });
		assert.equal(result.ok, true);
		assert.deepEqual(names(client), [
			'readPostVersion',
			'updatePost',
			'savePostBody',
			'updatePostArchetype',
			'setPostTags',
			'changePostStatus',
			'getPost'
		]);
		assert.deepEqual(client.calls[1].args, [
			'story',
			ID,
			{ title: 'T2', meta: { keywords: 'K2' }, coverId: IMG }
		]);
		assert.deepEqual(client.calls[3].args[2], {
			fields: { kind: 'interview' },
			references: { author: AUTHOR, focus_area: [FA1, FA2] }
		});
		assert.deepEqual(client.calls[4].args, ['story', ID, []]);
		assert.deepEqual(client.calls[5].args, ['story', ID, 'publish']);
		assert.equal(draft.baselineVersion, 'v2');
		assert.equal(draft.fields.title, 'T2', 're-baselined from the server');
		assert.equal(isPostDirty(draft), false);
	});

	it('the stale guard runs once, before anything, and refuses', async () => {
		const client = makeClient({ version: 'v9' });
		const draft = createPostDraft('story', post, 'v1', contract);
		dirtyEverything(draft);
		const result = await savePost(draft, client, { statusEvent: 'publish' });
		assert.equal(result.stale, true);
		assert.equal(result.message, STALE_MESSAGE);
		assert.deepEqual(names(client), ['readPostVersion']);
		assert.equal(isPostDirty(draft), true, 'the draft keeps the edits for a retry');
	});

	for (const [failing, stage, before] of [
		['updatePost', 'fields', ['readPostVersion', 'updatePost']],
		['savePostBody', 'body', ['readPostVersion', 'updatePost', 'savePostBody']],
		[
			'updatePostArchetype',
			'archetype',
			['readPostVersion', 'updatePost', 'savePostBody', 'updatePostArchetype']
		],
		[
			'setPostTags',
			'tags',
			['readPostVersion', 'updatePost', 'savePostBody', 'updatePostArchetype', 'setPostTags']
		]
	]) {
		it(`a failed ${stage} write stops the save — PUBLISH is never dispatched after it`, async () => {
			const client = makeClient({ fail: failing, status: failing === 'updatePost' ? 409 : 500 });
			const draft = createPostDraft('story', post, 'v1', contract);
			dirtyEverything(draft);
			const result = await savePost(draft, client, { statusEvent: 'publish' });
			assert.equal(result.ok, false);
			assert.equal(result.stage, stage);
			assert.deepEqual(names(client), before);
			assert.ok(
				!names(client).includes('changePostStatus'),
				'publishing a half-saved post is the outcome designed against'
			);
			assert.ok(!names(client).includes('getPost'), 'no re-baseline after a failure');
		});
	}

	it('a slug collision on the fields stage says so', async () => {
		const client = makeClient({ fail: 'updatePost', status: 409 });
		const draft = createPostDraft('story', post, 'v1', contract);
		setPostField(draft, 'slug', 'taken');
		const result = await savePost(draft, client);
		assert.equal(result.status, 409);
		assert.match(result.message, /already uses that address/u);
	});

	it('skips every stage that has nothing to write', async () => {
		const client = makeClient();
		const draft = createPostDraft('story', post, 'v1', contract);
		setPostTags(draft, [TAG, FA1]);
		assert.equal((await savePost(draft, client)).ok, true);
		assert.deepEqual(names(client), ['readPostVersion', 'setPostTags', 'getPost']);
	});

	it('publish with nothing dirty is still a publish', async () => {
		const client = makeClient();
		const draft = createPostDraft('story', post, 'v1', contract);
		assert.equal((await savePost(draft, client, { statusEvent: 'publish' })).ok, true);
		assert.deepEqual(names(client), ['readPostVersion', 'changePostStatus', 'getPost']);
	});

	it('an empty tag set is still a write — clearing every tag has to reach the server', async () => {
		const client = makeClient();
		const draft = createPostDraft('story', post, 'v1', contract);
		setPostTags(draft, []);
		await savePost(draft, client);
		assert.deepEqual(client.calls.find((call) => call.name === 'setPostTags').args, [
			'story',
			ID,
			[]
		]);
	});

	it('a failed refresh reports success — the writes DID land', async () => {
		const client = makeClient();
		client.getPost = async () => {
			throw new Error('network');
		};
		const draft = createPostDraft('story', post, 'v1', contract);
		setPostField(draft, 'title', 'T2');
		assert.deepEqual(await savePost(draft, client), { ok: true, refreshed: false });
		assert.equal(hasPostFieldChanges(draft), true, 'still dirty, so the next save resends it');
	});
});
