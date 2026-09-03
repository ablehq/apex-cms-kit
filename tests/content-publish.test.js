// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publishContent } from '../src/server/content/publish.ts';
import { CONTENT_KEY, readContent, resetContentMemo } from '../src/server/content/read.ts';

const ACCOUNT = '11111111-2222-4333-8444-555555555555';

/** A Map-backed stand-in for the KV namespace, with the two methods the module uses. */
function memoryStore(seed = {}) {
	const map = new Map(Object.entries(seed));
	return {
		map,
		async get(key) {
			return map.has(key) ? map.get(key) : null;
		},
		async put(key, value) {
			map.set(key, value);
		}
	};
}

function page(id) {
	return {
		data: [{ id }],
		pagination: { total_count: 1, current_page: 1, total_pages: 1 }
	};
}

const CMS_CONFIG = {
	data: {
		posts: [
			{ archetype_schema: { slug: 'article', plural_name: 'articles', account_id: ACCOUNT } }
		],
		content_library: [
			{ archetype_schema: { slug: 'author', plural_name: 'authors', account_id: ACCOUNT } }
		],
		asset_library: [{ gallery: { id: 'gal-1', name: 'images' } }]
	}
};

/** An Apex client that answers every read from a table of path → body. */
function stubApex(overrides = {}) {
	const calls = [];
	const bodies = {
		'/api/platform/v1/cms/post_archetype_views/search_and_filter': {
			data: [
				{
					id: 'post-1',
					archetype_id: 'arch-1',
					archetype_schema_slug: 'article',
					document: { id: 'doc-1' }
				}
			],
			pagination: { total_count: 1, current_page: 1, total_pages: 1 }
		},
		'/api/platform/v1/specification/archetypes/search_and_filter': page('author-1'),
		'/api/platform/v1/cms/gallery_items/search_and_filter': page('img-1'),
		'/api/platform/v1/cms/documents/search_and_filter': page('doc-1'),
		'/api/platform/v1/tags/search_and_filter': page('tag-1'),
		'/api/platform/v1/cms/pages/search_and_filter': {
			data: [],
			pagination: { total_count: 0, current_page: 1, total_pages: 0 }
		},
		'/api/platform/v1/specification/archetype_schemas/article/archetypes/arch-1': {
			data: { id: 'arch-1' }
		},
		'/api/platform/v1/media/search_and_filter': {
			data: [],
			pagination: { total_count: 0, current_page: 1, total_pages: 0 }
		},
		...overrides
	};
	return {
		calls,
		async readCmsConfig() {
			return { status: 200, ok: true, body: CMS_CONFIG };
		},
		async get(path, query) {
			calls.push({ path, query });
			const body = bodies[path];
			if (!body) return { status: 404, ok: false, body: null };
			return { status: 200, ok: true, body };
		}
	};
}

describe('publishContent', () => {
	it('writes one snapshot value and a version hint, from cms_config-discovered collections', async () => {
		const apex = stubApex();
		const kv = memoryStore();
		const result = await publishContent({ apex, kv, accountId: ACCOUNT, publishedBy: 'editor@x' });
		assert.equal(result.ok, true);
		const stored = JSON.parse(kv.map.get(CONTENT_KEY));
		assert.ok(
			kv.map.get(CONTENT_KEY).startsWith(`{"version":"${stored.version}"`),
			'version is serialised first'
		);
		assert.equal(stored.accountId, ACCOUNT);
		assert.equal(stored.publishedBy, 'editor@x');
		// Discovered from cms_config: the post type, the library type, the gallery, plus
		// the fixed three and the per-post archetypes.
		assert.deepEqual(Object.keys(stored.collections).sort(), [
			'archetypes',
			'articles',
			'authors',
			'documents',
			'images',
			'pages',
			'tags'
		]);
		assert.equal(result.counts.authors, 1);
		assert.equal(result.previous, null);
		// The query is serialised the way search_and_filter expects.
		const posts = apex.calls.find((c) => c.path.endsWith('post_archetype_views/search_and_filter'));
		assert.equal(posts.query.q.status_eq, 'published');
		assert.equal(posts.query.page, 1);
	});

	it('refuses without an account pin, and refuses another account, writing nothing', async () => {
		const kv = memoryStore();
		const unpinned = await publishContent({
			apex: stubApex(),
			kv,
			accountId: undefined,
			publishedBy: 'e'
		});
		assert.deepEqual([unpinned.ok, unpinned.error], [false, 'account_unpinned']);
		const other = await publishContent({
			apex: stubApex(),
			kv,
			accountId: 'someone-else',
			publishedBy: 'e'
		});
		assert.deepEqual([other.ok, other.error], [false, 'account_mismatch']);
		assert.equal(kv.map.size, 0);
	});

	it('refuses a collection that was non-empty and comes back empty, unless allowEmpty', async () => {
		const kv = memoryStore();
		assert.equal(
			(await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'e' })).ok,
			true
		);
		const emptyAuthors = {
			'/api/platform/v1/specification/archetypes/search_and_filter': {
				data: [],
				pagination: { total_count: 0, current_page: 1, total_pages: 0 }
			}
		};
		const refused = await publishContent({
			apex: stubApex(emptyAuthors),
			kv,
			accountId: ACCOUNT,
			publishedBy: 'e'
		});
		assert.deepEqual([refused.ok, refused.error], [false, 'empty_collection']);
		assert.match(refused.detail, /authors came back empty/);
		const before = kv.map.get(CONTENT_KEY);
		assert.equal(kv.map.get(CONTENT_KEY), before, 'nothing was written');
		const allowed = await publishContent({
			apex: stubApex(emptyAuthors),
			kv,
			accountId: ACCOUNT,
			publishedBy: 'e',
			allowEmpty: true
		});
		assert.equal(allowed.ok, true);
		assert.equal(allowed.counts.authors, 0);
		assert.equal(allowed.previous.authors, 1);
	});

	it('throws on an Apex failure and writes nothing', async () => {
		const kv = memoryStore();
		const apex = stubApex({ '/api/platform/v1/tags/search_and_filter': undefined });
		await assert.rejects(
			publishContent({ apex, kv, accountId: ACCOUNT, publishedBy: 'e' }),
			/tags:tags: Apex 404/
		);
		assert.equal(kv.map.size, 0);
	});
});

describe('readContent', () => {
	it('parses once per version, re-checks KV at most once a minute, and de-duplicates in-flight reads', async () => {
		resetContentMemo();
		const kv = memoryStore();
		let reads = 0;
		const counting = {
			async get(key, options) {
				if (key === CONTENT_KEY) reads += 1;
				return kv.get(key, options);
			},
			put: kv.put.bind(kv)
		};
		await assert.rejects(readContent(counting), /nothing has been published/);
		await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'e' });
		const [first, concurrent] = await Promise.all([readContent(counting), readContent(counting)]);
		assert.equal(concurrent, first, 'concurrent misses share one read');
		assert.equal(reads, 2, 'one failed read, then one parse');
		assert.equal(await readContent(counting), first, 'served from the memo within the minute');
		assert.equal(reads, 2, 'no KV read inside the memo window');

		await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'e', now: 1 });
		assert.equal(await readContent(counting), first, 'still the memo until the minute is up');
		resetContentMemo(); // stands in for the minute passing
		const next = await readContent(counting);
		assert.notEqual(next.version, first.version);
		assert.equal(reads, 3);
		await assert.rejects(readContent(undefined), /CONTENT binding is not configured/);
	});
});
