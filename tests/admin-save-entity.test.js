// @ts-nocheck — node:test suite over the legacy-mode admin browser modules.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	articleFieldsPatch,
	createArticleDraft,
	createEntityDraft,
	entityFieldNames,
	entityPatch,
	hasArticleFieldChanges,
	isArticleDirty,
	isEntityDirty,
	reconcileArticle,
	reconcileEntity,
	setArticleAuthorId,
	setArticleBlocks,
	setArticleField,
	setEntityField
} from '../src/admin/entity-draft.js';
import { saveArticle, saveEntity, STALE_MESSAGE } from '../src/admin/save-entity.js';

/**
 * The phase-3d draft and save model, without a DOM and without a network — the same
 * way `admin-save-page.test.js` covers pages. What is being pinned is the part that
 * is invisible when it is wrong: the write ORDER, that a failure stops everything
 * after it, that the status event is never dispatched after a failure, and that no
 * code path in the draft can produce the `null` that destroys a field upstream.
 */

const ID = '11111111-2222-3333-4444-555555555555';

/** A recording BFF double. `fail` forces one method to answer not-ok. */
function makeClient({ fail = null, status = 500, version = 'v1', record = {} } = {}) {
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
		readAuthorVersion: async () => {
			calls.push({ name: 'readAuthorVersion' });
			return { version };
		},
		readResourceVersion: async () => {
			calls.push({ name: 'readResourceVersion' });
			return { version };
		},
		readArticleVersion: async () => {
			calls.push({ name: 'readArticleVersion' });
			return { version };
		},
		updateAuthor: ok('updateAuthor'),
		updateResource: ok('updateResource'),
		setResourceTags: ok('setResourceTags'),
		updateArticle: ok('updateArticle'),
		setArticleAuthor: ok('setArticleAuthor'),
		saveArticleBody: ok('saveArticleBody'),
		changeArticleStatus: ok('changeArticleStatus'),
		getAuthor: async () => {
			calls.push({ name: 'getAuthor' });
			return { author: { id: ID, ...record }, version: 'v2' };
		},
		getResource: async () => {
			calls.push({ name: 'getResource' });
			return { resource: { id: ID, ...record }, version: 'v2' };
		},
		getArticle: async () => {
			calls.push({ name: 'getArticle' });
			return { article: { id: ID, ...record }, version: 'v2' };
		}
	};
}

const names = (client) => client.calls.map((call) => call.name);

describe('entity-draft — authors and resources', () => {
	it('knows each schema field for field, and nothing else', () => {
		assert.deepEqual(entityFieldNames('author'), ['name', 'designation']);
		assert.deepEqual(entityFieldNames('resource'), ['type', 'title', 'description', 'url']);
		assert.deepEqual(entityFieldNames('article'), [], 'an article is not a content-library record');
	});

	it('coerces a missing or null value to an empty string on the way IN', () => {
		const draft = createEntityDraft('author', { id: ID, name: 'Dion', designation: null }, 'v1');
		assert.deepEqual(draft.fields, { name: 'Dion', designation: '' });
		assert.equal(isEntityDirty(draft), false, 'reading a null is not an edit');
	});

	it('refuses a field the schema does not have', () => {
		const draft = createEntityDraft('author', { id: ID, name: 'Dion' }, 'v1');
		assert.equal(setEntityField(draft, 'transcript_reviewed', true), false);
		assert.equal(setEntityField(draft, 'status', 'published'), false);
		assert.equal('transcript_reviewed' in draft.fields, false);
		assert.equal(isEntityDirty(draft), false);
	});

	it('cannot produce null on the way OUT — a cleared field is an empty string', () => {
		const draft = createEntityDraft(
			'author',
			{ id: ID, name: 'Dion', designation: 'Pastor' },
			'v1'
		);
		setEntityField(draft, 'designation', null);
		assert.equal(draft.fields.designation, '');
		assert.deepEqual(entityPatch(draft), { designation: '' });
		assert.equal(
			JSON.stringify(entityPatch(draft)).includes('null'),
			false,
			'null in this body destroys the row upstream and strands the old value'
		);
	});

	it('an edit and an edit back leave nothing to save', () => {
		const draft = createEntityDraft(
			'author',
			{ id: ID, name: 'Dion', designation: 'Pastor' },
			'v1'
		);
		setEntityField(draft, 'name', 'Dionysius');
		assert.equal(isEntityDirty(draft), true);
		assert.deepEqual(entityPatch(draft), { name: 'Dionysius' });
		setEntityField(draft, 'name', 'Dion');
		assert.equal(isEntityDirty(draft), false, 'Save goes back to disabled');
		assert.deepEqual(entityPatch(draft), {});
	});

	it('the patch carries only what changed, in schema order', () => {
		const draft = createEntityDraft(
			'resource',
			{ id: ID, type: 'book', title: 'T', description: 'D', url: 'U' },
			'v1'
		);
		setEntityField(draft, 'url', 'U2');
		setEntityField(draft, 'type', 'video');
		assert.deepEqual(Object.keys(entityPatch(draft)), ['type', 'url']);
	});

	it('reconcile adopts the server record and clears the dirty set', () => {
		const draft = createEntityDraft('author', { id: ID, name: 'Dion', designation: 'P' }, 'v1');
		setEntityField(draft, 'name', 'typed');
		reconcileEntity(draft, { id: ID, name: 'Dion', designation: 'Elder' }, 'v2');
		assert.equal(draft.fields.name, 'Dion');
		assert.equal(draft.fields.designation, 'Elder');
		assert.equal(draft.baselineVersion, 'v2');
		assert.equal(isEntityDirty(draft), false);
	});
});

describe('saveEntity — one PATCH, one guard, stop on failure', () => {
	it('refuses when the record moved since it was opened, before any write', async () => {
		const client = makeClient({ version: 'v9' });
		const draft = createEntityDraft('author', { id: ID, name: 'Dion' }, 'v1');
		setEntityField(draft, 'name', 'Dionysius');

		const result = await saveEntity(draft, client);
		assert.equal(result.ok, false);
		assert.equal(result.stale, true);
		assert.equal(result.message, STALE_MESSAGE);
		assert.deepEqual(names(client), ['readAuthorVersion'], 'nothing was written');
	});

	it('writes the fields, then re-baselines', async () => {
		const client = makeClient({ record: { name: 'Dionysius', designation: '' } });
		const draft = createEntityDraft('author', { id: ID, name: 'Dion', designation: 'P' }, 'v1');
		setEntityField(draft, 'name', 'Dionysius');
		setEntityField(draft, 'designation', '');

		const result = await saveEntity(draft, client);
		assert.equal(result.ok, true);
		assert.deepEqual(names(client), ['readAuthorVersion', 'updateAuthor', 'getAuthor']);
		assert.deepEqual(client.calls[1].args[1], { name: 'Dionysius', designation: '' });
		assert.equal(draft.baselineVersion, 'v2');
		assert.equal(isEntityDirty(draft), false);
	});

	it('a clean draft still guards, and skips the PATCH it has nothing for', async () => {
		const client = makeClient();
		const draft = createEntityDraft('author', { id: ID, name: 'Dion' }, 'v1');
		assert.equal((await saveEntity(draft, client)).ok, true);
		assert.deepEqual(names(client), ['readAuthorVersion', 'getAuthor']);
	});

	it('tags are reconciled AFTER the fields, and only when the caller manages them', async () => {
		const client = makeClient();
		const draft = createEntityDraft('resource', { id: ID, title: 'T' }, 'v1');
		setEntityField(draft, 'title', 'T2');

		assert.equal((await saveEntity(draft, client, { tagIds: ['t1', 't2'] })).ok, true);
		assert.deepEqual(names(client), [
			'readResourceVersion',
			'updateResource',
			'setResourceTags',
			'getResource'
		]);
		assert.deepEqual(client.calls[2].args, [ID, ['t1', 't2']]);

		const untouched = makeClient();
		const other = createEntityDraft('resource', { id: ID, title: 'T' }, 'v1');
		await saveEntity(other, untouched);
		assert.equal(names(untouched).includes('setResourceTags'), false);
	});

	it('an empty tag set is still a write — clearing every tag has to reach the server', async () => {
		const client = makeClient();
		const draft = createEntityDraft('resource', { id: ID, title: 'T' }, 'v1');
		await saveEntity(draft, client, { tagIds: [] });
		assert.deepEqual(client.calls.find((call) => call.name === 'setResourceTags').args, [ID, []]);
	});

	it('a rejected field stops the save — the tags are never moved after it', async () => {
		const client = makeClient({ fail: 'updateResource', status: 422 });
		const draft = createEntityDraft('resource', { id: ID, title: 'T' }, 'v1');
		setEntityField(draft, 'title', 'T2');

		const result = await saveEntity(draft, client, { tagIds: ['t1'] });
		assert.equal(result.ok, false);
		assert.equal(result.stage, 'fields');
		assert.equal(result.status, 422);
		assert.deepEqual(names(client), ['readResourceVersion', 'updateResource']);
		assert.equal(isEntityDirty(draft), true, 'the draft keeps the edit so it can be retried');
	});
});

describe('entity-draft — articles', () => {
	const article = {
		id: ID,
		archetypeId: 'arch',
		documentId: 'doc',
		title: 'T',
		slug: 't',
		summary: 'S',
		publishedDate: '2026-07-01',
		status: 'draft',
		authorId: 'author-1',
		blocks: [{ id: 'b1', kind: 'rich_text', html: '<p>one</p>' }],
		meta: { title: 'M', description: 'D', keywords: 'K' }
	};

	it('flattens the SEO triple into the same field map and splits it back out', () => {
		const draft = createArticleDraft(article, 'v1');
		assert.equal(draft.fields.metaDescription, 'D');
		setArticleField(draft, 'title', 'T2');
		setArticleField(draft, 'metaKeywords', 'K2');
		assert.deepEqual(articleFieldsPatch(draft), { title: 'T2', meta: { keywords: 'K2' } });
	});

	it('omits `meta` entirely when no SEO field moved', () => {
		const draft = createArticleDraft(article, 'v1');
		setArticleField(draft, 'slug', 't2');
		assert.deepEqual(articleFieldsPatch(draft), { slug: 't2' });
		assert.equal('meta' in articleFieldsPatch(draft), false);
	});

	it('tracks the three stages independently', () => {
		const draft = createArticleDraft(article, 'v1');
		assert.equal(isArticleDirty(draft), false);

		setArticleAuthorId(draft, 'author-2');
		assert.equal(draft.authorDirty, true);
		assert.equal(hasArticleFieldChanges(draft), false, 'the author is not a post field');

		setArticleAuthorId(draft, 'author-1');
		assert.equal(draft.authorDirty, false, 'set back to what it was');

		setArticleBlocks(draft, [{ id: 'b1', kind: 'rich_text', html: '<p>two</p>' }]);
		assert.equal(draft.bodyDirty, true);
		setArticleBlocks(draft, [{ id: 'b1', kind: 'rich_text', html: '<p>one</p>' }]);
		assert.equal(draft.bodyDirty, false);
		assert.equal(isArticleDirty(draft), false);
	});

	it('clearing the author to null is a real edit, not a no-op', () => {
		const draft = createArticleDraft(article, 'v1');
		setArticleAuthorId(draft, null);
		assert.equal(draft.authorId, null);
		assert.equal(draft.authorDirty, true, 'an article with no author is a thing you can save');
	});

	it('reconcile clears all three stages at once', () => {
		const draft = createArticleDraft(article, 'v1');
		setArticleField(draft, 'title', 'x');
		setArticleAuthorId(draft, null);
		setArticleBlocks(draft, []);
		reconcileArticle(draft, { ...article, status: 'published' }, 'v2');
		assert.equal(isArticleDirty(draft), false);
		assert.equal(draft.article.status, 'published');
		assert.equal(draft.baselineVersion, 'v2');
	});
});

describe('saveArticle — the write order, and what never runs after a failure', () => {
	const article = {
		id: ID,
		title: 'T',
		slug: 't',
		summary: 'S',
		publishedDate: '2026-07-01',
		authorId: 'author-1',
		blocks: [],
		meta: { title: '', description: '', keywords: '' }
	};

	function dirtyEverything(draft) {
		setArticleField(draft, 'title', 'T2');
		setArticleAuthorId(draft, 'author-2');
		setArticleBlocks(draft, [{ id: null, kind: 'quote', quote: 'q', quotedBy: 'a' }]);
	}

	it('writes fields, then author, then body, then status — in that order', async () => {
		const client = makeClient({ record: article });
		const draft = createArticleDraft(article, 'v1');
		dirtyEverything(draft);

		const result = await saveArticle(draft, client, { statusEvent: 'publish' });
		assert.equal(result.ok, true);
		assert.deepEqual(names(client), [
			'readArticleVersion',
			'updateArticle',
			'setArticleAuthor',
			'saveArticleBody',
			'changeArticleStatus',
			'getArticle'
		]);
		assert.deepEqual(client.calls[2].args, [ID, 'author-2']);
		assert.deepEqual(client.calls[4].args, [ID, 'publish']);
	});

	it('the stale guard runs once, before anything, and refuses', async () => {
		const client = makeClient({ version: 'v9' });
		const draft = createArticleDraft(article, 'v1');
		dirtyEverything(draft);
		const result = await saveArticle(draft, client, { statusEvent: 'publish' });
		assert.equal(result.stale, true);
		assert.deepEqual(names(client), ['readArticleVersion']);
	});

	it('PUBLISH is never dispatched after a failed field write', async () => {
		const client = makeClient({ fail: 'updateArticle', status: 422 });
		const draft = createArticleDraft(article, 'v1');
		dirtyEverything(draft);

		const result = await saveArticle(draft, client, { statusEvent: 'publish' });
		assert.equal(result.ok, false);
		assert.equal(result.stage, 'fields');
		assert.deepEqual(names(client), ['readArticleVersion', 'updateArticle']);
		assert.equal(
			names(client).includes('changeArticleStatus'),
			false,
			'publishing a half-saved article is the one outcome worth designing against'
		);
	});

	it('PUBLISH is never dispatched after a failed body write either', async () => {
		const client = makeClient({ fail: 'saveArticleBody', status: 500 });
		const draft = createArticleDraft(article, 'v1');
		dirtyEverything(draft);

		const result = await saveArticle(draft, client, { statusEvent: 'publish' });
		assert.equal(result.stage, 'body');
		assert.equal(names(client).includes('changeArticleStatus'), false);
	});

	it('skips every stage that has nothing to write', async () => {
		const client = makeClient({ record: article });
		const draft = createArticleDraft(article, 'v1');
		setArticleBlocks(draft, [{ id: null, kind: 'rich_text', html: '<p>x</p>' }]);

		assert.equal((await saveArticle(draft, client)).ok, true);
		assert.deepEqual(names(client), ['readArticleVersion', 'saveArticleBody', 'getArticle']);
	});

	it('publish with nothing dirty is still a publish', async () => {
		const client = makeClient({ record: article });
		const draft = createArticleDraft(article, 'v1');
		assert.equal((await saveArticle(draft, client, { statusEvent: 'publish' })).ok, true);
		assert.deepEqual(names(client), ['readArticleVersion', 'changeArticleStatus', 'getArticle']);
	});

	it('a failed refresh reports success — the writes DID land', async () => {
		const client = makeClient();
		client.getArticle = async () => {
			throw new Error('network');
		};
		const draft = createArticleDraft(article, 'v1');
		setArticleField(draft, 'title', 'T2');
		assert.deepEqual(await saveArticle(draft, client), { ok: true, refreshed: false });
	});
});
