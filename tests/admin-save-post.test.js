// @ts-nocheck — node:test suite over the admin browser modules.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	carryPendingStages,
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
function makeClient({
	fail = null,
	status = 500,
	version = 'v1',
	bodyVersion = 'bv1',
	errors = undefined,
	code = undefined,
	getPostThrows = false
} = {}) {
	const calls = [];
	const ok =
		(name) =>
		async (...args) => {
			calls.push({ name, args });
			if (fail === name) {
				return { ok: false, status, ...(errors ? { errors } : {}), ...(code ? { code } : {}) };
			}
			return { ok: true, status: 200, ...(name === 'savePostBody' ? { bodyVersion: 'bv2' } : {}) };
		};
	return {
		calls,
		readPostVersion: async (slug, id) => {
			calls.push({ name: 'readPostVersion', args: [slug, id] });
			return { version, bodyVersion };
		},
		updatePost: ok('updatePost'),
		savePostBody: ok('savePostBody'),
		updatePostArchetype: ok('updatePostArchetype'),
		setPostTags: ok('setPostTags'),
		changePostStatus: ok('changePostStatus'),
		getPost: async (slug, id) => {
			calls.push({ name: 'getPost', args: [slug, id] });
			if (getPostThrows) throw new TypeError('network');
			return { post: { ...post, title: 'T2' }, version: 'v2', bodyVersion: 'bv2' };
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

	it('a 422 on the fields stage names the rejected field, and does NOT blame the address', async () => {
		const client = makeClient({
			fail: 'updatePost',
			status: 422,
			// Apex's real shape: the messages are full sentences.
			errors: [
				{ attribute: 'published_date', messages: ['Published date is invalid'] },
				{ attribute: 'summary', messages: [] }
			]
		});
		const draft = createPostDraft('story', post, 'v1', contract);
		setPostField(draft, 'publishedDate', 'not-a-date');
		const result = await savePost(draft, client);
		assert.equal(result.status, 422);
		assert.match(
			result.message,
			/A field was rejected: Published date is invalid; summary\./u,
			'the sentence as Apex wrote it, never "published_date Published date …"; the bare attribute only when there is no message'
		);
		assert.doesNotMatch(result.message, /published_date/u);
		assert.doesNotMatch(result.message, /address/u);
		assert.match(result.message, /Nothing after it was saved/u);
	});

	it('a 422 that names no field says so, in the shared wording', async () => {
		const client = makeClient({ fail: 'updatePost', status: 422, errors: [] });
		const draft = createPostDraft('story', post, 'v1', contract);
		setPostField(draft, 'title', 'Renamed');
		const result = await savePost(draft, client);
		assert.equal(result.status, 422);
		assert.equal(
			result.message,
			'A field was rejected, but Apex did not say which. Nothing after it was saved; fix it and Save again.'
		);
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

describe('the four block kinds on the draft, and the body version it carries', () => {
	const fourKinds = [
		{ id: 'b1', kind: 'rich_text', html: '<p>one</p>' },
		{ id: 'b2', kind: 'quote', quote: 'q', quotedBy: 'a' },
		{ id: 'b3', kind: 'divider', dividerKind: 'large' },
		{ id: 'b4', kind: 'image', galleryItemId: IMG }
	];

	it('holds all four verbatim, and `setPostBlocks` is kind-agnostic', () => {
		const draft = createPostDraft('story', { ...post, blocks: fourKinds }, 'v1', contract, 'bv1');
		assert.deepEqual(draft.blocks, fourKinds);
		assert.equal(isPostDirty(draft), false);
		setPostBlocks(draft, [...fourKinds].reverse());
		assert.equal(draft.bodyDirty, true);
		setPostBlocks(draft, fourKinds);
		assert.equal(draft.bodyDirty, false, 'and back to clean, by value');
		// A divider resized and an image repointed are edits, not no-ops.
		setPostBlocks(draft, [{ ...fourKinds[2], dividerKind: 'small' }]);
		assert.equal(draft.bodyDirty, true);
	});

	it('sends the body version with the body, and adopts the one the save answers', async () => {
		const draft = createPostDraft('story', post, 'v1', contract, 'bv1');
		setPostBlocks(draft, fourKinds);
		const client = makeClient({});
		const result = await savePost(draft, client);
		assert.equal(result.ok, true);
		const body = client.calls.find((call) => call.name === 'savePostBody');
		assert.deepEqual(body.args[2], fourKinds, 'the blocks, verbatim');
		assert.equal(body.args[3], 'bv1', 'and the version this editor loaded');
		assert.equal(draft.bodyVersion, 'bv2', 're-baselined from the fresh load');
	});

	it('a body save that answers a new version updates the draft even when a LATER stage fails', async () => {
		// Otherwise the next save is refused as stale by the write this one just made.
		const draft = createPostDraft('story', post, 'v1', contract, 'bv1');
		setPostBlocks(draft, fourKinds);
		setPostTags(draft, []);
		const result = await savePost(draft, makeClient({ fail: 'setPostTags' }));
		assert.equal(result.ok, false);
		assert.equal(result.stage, 'tags');
		assert.equal(draft.bodyVersion, 'bv2');
	});
});

describe('a body write that may have landed says Reload, never Retry', () => {
	it('`body-written-unread` is stale:true, names what was not saved, and stops the save', async () => {
		const draft = createPostDraft('story', post, 'v1', contract, 'bv1');
		dirtyEverything(draft);
		const client = makeClient({ fail: 'savePostBody', status: 502, code: 'body-written-unread' });
		const result = await savePost(draft, client, { statusEvent: 'publish' });
		assert.equal(result.ok, false);
		assert.equal(result.stage, 'body');
		assert.equal(result.code, 'body-written-unread');
		assert.equal(result.stale, true, 'so the screen offers Reload, not Retry');
		assert.match(result.message, /may have been saved but could not be read back/u);
		assert.match(result.message, /references and tags/u);
		// Nothing after the body ran — least of all the status event.
		assert.deepEqual(names(client), ['readPostVersion', 'updatePost', 'savePostBody']);
	});

	it('a `409` on the body is stale too — the interleaved-save refusal', async () => {
		const draft = createPostDraft('story', post, 'v1', contract, 'bv1');
		setPostBlocks(draft, []);
		const result = await savePost(draft, makeClient({ fail: 'savePostBody', status: 409 }));
		assert.equal(result.stale, true);
		assert.equal(result.message, STALE_MESSAGE);
	});

	it('an ordinary body failure is NOT stale — Retry is the right offer there', async () => {
		const draft = createPostDraft('story', post, 'v1', contract, 'bv1');
		setPostBlocks(draft, []);
		const result = await savePost(draft, makeClient({ fail: 'savePostBody', status: 502 }));
		assert.equal(result.stale, false);
		assert.match(result.message, /Save again to retry/u);
	});

	it('a refused image names the picker, not "try again"', async () => {
		const draft = createPostDraft('story', post, 'v1', contract, 'bv1');
		setPostBlocks(draft, [{ id: null, kind: 'image', galleryItemId: IMG }]);
		const result = await savePost(
			draft,
			makeClient({ fail: 'savePostBody', status: 400, code: 'unknown-image' })
		);
		assert.match(result.message, /image library/u);
		assert.equal(result.stale, false);
	});

	it('a failed re-baseline is `refreshed:false` — every write landed, the draft is behind', async () => {
		const draft = createPostDraft('story', post, 'v1', contract, 'bv1');
		setPostField(draft, 'title', 'T2');
		const result = await savePost(draft, makeClient({ getPostThrows: true }));
		assert.deepEqual(result, { ok: true, refreshed: false });
	});
});

describe('carryPendingStages — a Reload that does not throw away unwritten work', () => {
	it('re-applies references, primitives, tags and the cover onto a fresh draft, and names them', () => {
		const old = createPostDraft('story', post, 'v1', contract, 'bv1');
		setPostReference(old, 'focus_area', [FA1, FA2]);
		setPostReference(old, 'author', AUTHOR);
		setPostArchetypeField(old, 'kind', 'interview');
		setPostTags(old, []);
		setPostCover(old, IMG);
		setPostBlocks(old, [{ id: null, kind: 'divider', dividerKind: 'small' }]);

		// The reload: the server's post, as it stands after the uncertain body write.
		const fresh = createPostDraft('story', post, 'v2', contract, 'bv2');
		const carried = carryPendingStages(fresh, old);

		assert.deepEqual(carried.sort(), ['cover', 'fields', 'references', 'tags']);
		assert.deepEqual(fresh.references, { author: AUTHOR, focus_area: [FA1, FA2] });
		assert.deepEqual([...fresh.dirtyReferences].sort(), ['author', 'focus_area']);
		assert.equal(fresh.archetypeFields.kind, 'interview');
		assert.deepEqual(fresh.tagIds, []);
		assert.equal(fresh.tagsDirty, true);
		assert.equal(fresh.coverId, IMG);
		assert.equal(fresh.coverDirty, true);
		// THE BODY IS NOT CARRIED. It is the stage whose fate is unknown, and
		// re-applying it is the append this whole path exists to prevent.
		assert.deepEqual(fresh.blocks, post.blocks);
		assert.equal(fresh.bodyDirty, false);
		// …and the fresh baselines are the server's, so a second save writes the carried
		// stages and nothing else.
		assert.equal(fresh.baselineVersion, 'v2');
		assert.equal(fresh.bodyVersion, 'bv2');
		assert.equal(hasPostArchetypeChanges(fresh), true);
		assert.equal(hasPostFieldChanges(fresh), true, 'the cover rides the fields patch');
	});

	it('carries NOTHING when the old draft had nothing pending, and never invents dirt', () => {
		const old = createPostDraft('story', post, 'v1', contract, 'bv1');
		const fresh = createPostDraft('story', post, 'v2', contract, 'bv2');
		assert.deepEqual(carryPendingStages(fresh, old), []);
		assert.equal(isPostDirty(fresh), false);
	});

	it('a carried value that the server ALREADY has is not re-dirtied', () => {
		// The uncertain write is the body's; the references may nevertheless have been
		// written by an earlier attempt. Carrying through the setters is what makes a
		// value equal to the fresh baseline read as clean.
		const old = createPostDraft('story', post, 'v1', contract, 'bv1');
		setPostReference(old, 'focus_area', [FA1, FA2]);
		const fresh = createPostDraft(
			'story',
			{
				...post,
				references: {
					author: [],
					focus_area: [
						{ itemId: 'j1', targetId: FA1 },
						{ itemId: 'j2', targetId: FA2 }
					]
				}
			},
			'v2',
			contract,
			'bv2'
		);
		assert.deepEqual(carryPendingStages(fresh, old), []);
		assert.equal(isPostDirty(fresh), false);
	});
});
