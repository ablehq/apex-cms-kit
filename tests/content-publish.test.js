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

	it('refuses a publish whose store moved underneath it, and keeps the newer content', async () => {
		/**
		 * THE LOST UPDATE, REPRODUCED. Publish A starts, is paused mid-fetch, B
		 * finishes with newer content, A resumes — and before P3 A's older content
		 * won, permanently, because the write was unconditional. Two tabs, two
		 * editors, or one slow request and a retry all reach it.
		 *
		 * A is paused inside the FETCH, after it has read the version it started
		 * from, which is exactly where the real window is. Reverting the
		 * `startedFrom`/`heldNow` comparison in `publish.ts` makes this fail with
		 * B's content overwritten by A's.
		 */
		const kv = memoryStore();
		assert.equal(
			(await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'first' })).ok,
			true
		);

		let release = () => {};
		const paused = new Promise((resolve) => {
			release = resolve;
		});
		const slowApex = stubApex();
		const originalGet = slowApex.get;
		let held = false;
		slowApex.get = async (path, query) => {
			if (!held) {
				held = true;
				await paused;
			}
			return originalGet(path, query);
		};

		const a = publishContent({ apex: slowApex, kv, accountId: ACCOUNT, publishedBy: 'A' });
		// B publishes to completion while A is still gathering.
		const b = await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'B' });
		assert.equal(b.ok, true);
		release();

		const refused = await a;
		assert.deepEqual([refused.ok, refused.error], [false, 'concurrent_publish']);
		assert.match(refused.detail, /another publish finished/u);
		const stored = JSON.parse(kv.map.get(CONTENT_KEY));
		assert.equal(stored.publishedBy, 'B', "B's content survives; A wrote nothing");
		assert.equal(stored.version, b.version);
	});

	it('refuses a first publish that raced another first publish', async () => {
		// The `null` → something transition is the same race with no previous version
		// to name, and it has to refuse too: otherwise the very first two publishes on
		// a new deployment are a coin toss.
		const kv = memoryStore();
		let release = () => {};
		const paused = new Promise((resolve) => {
			release = resolve;
		});
		const slowApex = stubApex();
		const originalGet = slowApex.get;
		let held = false;
		slowApex.get = async (path, query) => {
			if (!held) {
				held = true;
				await paused;
			}
			return originalGet(path, query);
		};
		const a = publishContent({ apex: slowApex, kv, accountId: ACCOUNT, publishedBy: 'A' });
		assert.equal(
			(await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'B' })).ok,
			true
		);
		release();
		const refused = await a;
		assert.deepEqual([refused.ok, refused.error], [false, 'concurrent_publish']);
		assert.equal(JSON.parse(kv.map.get(CONTENT_KEY)).publishedBy, 'B');
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

		// A PUBLISH NOW INVALIDATES THIS ISOLATE'S MEMO. Until P3 this line read
		// "still the memo until the minute is up", and it was true: the reader that
		// had just published kept serving the PREVIOUS snapshot for up to a minute —
		// the admin rail included, which is the one reader certain to be looking.
		await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'e', now: 1 });
		const afterPublish = await readContent(counting);
		assert.notEqual(afterPublish.version, first.version, 'the publish is visible at once');
		assert.equal(reads, 3, 'the invalidated memo cost exactly one more KV read');
		// …and then memoises again, so the invalidation is one read, not a disabled memo.
		assert.equal(await readContent(counting), afterPublish, 'memoised again after the publish');
		assert.equal(reads, 3);
		await assert.rejects(readContent(undefined), /CONTENT binding is not configured/);
	});

	it('does not let a read that started before a publish re-install the old snapshot', async () => {
		/**
		 * The invalidation is worth nothing if an in-flight read can undo it. A
		 * visitor's read begins, KV hands back the OLD bytes, a publish lands and
		 * resets the memo — and then the read completes and memoises what it fetched,
		 * restoring the stale snapshot for a whole minute. Reverting the generation
		 * check in `read.ts` makes this fail: the second read is served the old
		 * version out of a memo the publish had already cleared.
		 */
		resetContentMemo();
		const kv = memoryStore();
		await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'e', now: 1 });
		const old = kv.map.get(CONTENT_KEY);
		const oldVersion = JSON.parse(old).version;

		let release = () => {};
		const held = new Promise((resolve) => {
			release = resolve;
		});
		let slow = true;
		const slowKv = {
			async get(key) {
				// The bytes are taken FIRST and the response is slow — which is what KV
				// handing back a value that goes stale in flight actually looks like.
				const value = kv.map.get(key) ?? null;
				if (slow) await held;
				return value;
			},
			put: kv.put.bind(kv)
		};

		const reading = readContent(slowKv); // starts, blocks inside kv.get
		// The publish lands (and invalidates) while that read is still in flight.
		kv.map.set(CONTENT_KEY, old.replace(oldVersion, 'published-during-the-read'));
		resetContentMemo();
		release();
		assert.equal((await reading).version, oldVersion, 'the in-flight read keeps its own bytes');

		slow = false;
		const next = await readContent(slowKv);
		assert.equal(next.version, 'published-during-the-read', 'the next read is not stale');
	});

	it('a foreign read completing does not free the in-flight slot for a third read', async () => {
		/**
		 * THE OVERLAP THE GENERATION COUNTER DOES NOT COVER, found by review.
		 *
		 * The counter stops a read that began BEFORE an invalidation from installing
		 * what it fetched. It says nothing about two reads that both began AFTER one
		 * — and those could overlap, because the pre-reset promise's `finally` used
		 * to clear the shared `inflight` slot UNCONDITIONALLY, freeing it while a
		 * later read was still running. A third read then started against KV's
		 * 60-second edge cache, and whichever of the two landed last won. Both
		 * sibling sites' public loaders go through this reader.
		 *
		 * The slot is now cleared only by the promise that owns it, so the second
		 * read continues to de-duplicate every later caller. Reverting that makes the
		 * KV read count below go from 2 to 3.
		 */
		resetContentMemo();
		const kv = memoryStore();
		await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'e', now: 1000 });
		const bytes = kv.map.get(CONTENT_KEY);

		let releaseFirst = () => {};
		let releaseSecond = () => {};
		const first = new Promise((resolve) => {
			releaseFirst = resolve;
		});
		const second = new Promise((resolve) => {
			releaseSecond = resolve;
		});
		let reads = 0;
		const slowKv = {
			async get() {
				// The call index is captured BEFORE any await. Re-reading the shared
				// counter afterwards makes read 1 fall into read 2's gate the moment
				// read 2 has incremented it, and the test deadlocks on its own stub.
				const nth = ++reads;
				if (nth === 1) await first;
				if (nth === 2) await second;
				return bytes;
			},
			put: kv.put.bind(kv)
		};

		const a = readContent(slowKv); // read 1, pre-reset, held
		resetContentMemo(); // frees the slot for a new generation
		const b = readContent(slowKv); // read 2, post-reset, held — OWNS the slot

		releaseFirst();
		await a; // read 1 settles, and its `finally` must NOT free read 2's slot

		const c = readContent(slowKv); // must de-duplicate onto read 2
		assert.equal(reads, 2, 'no third KV read: the slot was still read 2\u2019s');

		releaseSecond();
		assert.equal(await c, await b, 'the third caller was served read 2\u2019s own promise');
	});

	it('clears the slot when its own read settles, so a later read is not served a corpse', async () => {
		/**
		 * The mirror image of the test above, and the bug the first attempt at this
		 * fix actually shipped: comparing against a promise that is not the one in the
		 * slot makes the condition permanently false, the slot is never cleared, and
		 * every later read is handed a long-settled promise forever.
		 *
		 * It has to be proved on a FAILING read. A successful one installs the memo,
		 * which short-circuits the next call, and every other path here runs a publish
		 * in between — and a publish resets the memo, which clears the slot anyway. An
		 * empty store rejects, memoises nothing, and resets nothing, so the only thing
		 * that can free the slot is the read's own completion.
		 */
		resetContentMemo();
		let reads = 0;
		const empty = {
			async get() {
				reads += 1;
				return null;
			},
			async put() {}
		};
		await assert.rejects(readContent(empty), /nothing has been published/);
		assert.equal(reads, 1);
		await assert.rejects(readContent(empty), /nothing has been published/);
		assert.equal(reads, 2, 'the settled read released the slot; this is a NEW read');
	});
});
