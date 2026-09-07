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

		// A PUBLISH INSTALLS WHAT IT WROTE (codex on the P3 fix pass, finding 3).
		// It used to CLEAR the memo and set a wall-clock floor, which left the next
		// read to KV's edge cache with `stamp < memoFloor` as its only protection —
		// and an EQUAL millisecond from a second publishing isolate is not less. The
		// bytes we just put are the bytes to serve; nothing has to be fetched to
		// learn that, so the invalidation now costs zero reads instead of one.
		const published = await readContent(counting);
		assert.equal(reads, 1, 'only the failed read: the publish installed its own snapshot');

		// Cold again, and the de-duplication and the memo window are what they were.
		resetContentMemo();
		const [first, concurrent] = await Promise.all([readContent(counting), readContent(counting)]);
		assert.equal(concurrent, first, 'concurrent misses share one read');
		assert.equal(reads, 2, 'the failed read, then one parse');
		assert.equal(first.version, published.version, 'and KV holds what the publish installed');
		assert.equal(await readContent(counting), first, 'served from the memo within the minute');
		assert.equal(reads, 2, 'no KV read inside the memo window');

		await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'e', now: 1 });
		const afterPublish = await readContent(counting);
		assert.notEqual(afterPublish.version, first.version, 'the publish is visible at once');
		assert.equal(reads, 2, 'and it cost no read at all — the snapshot came from the publish');
		// …and stays memoised, so the swap is not a disabled memo.
		assert.equal(await readContent(counting), afterPublish, 'memoised after the publish');
		assert.equal(reads, 2);
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
		// The publish INSTALLS its snapshot, so go cold: this test is about the slot,
		// and a warm memo would short-circuit every read below.
		resetContentMemo();

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

	/**
	 * ── THE STORE THAT GOES BACKWARDS ────────────────────────────────────────
	 *
	 * Every stub above is a `Map`: it always answers the newest bytes written to it,
	 * so it can never test the one hazard slot ownership and the generation counter
	 * cannot reach. Real KV is eventually consistent and NOT monotonic across tiers,
	 * and `readContent` asks it for `{cacheTtl: 60}` — its own edge cache — so a read
	 * that STARTS after a publish can be handed PRE-publish bytes. Their generation
	 * matches, so nothing else refuses them, and once installed they are served for a
	 * full `MEMO_TTL_MS`.
	 *
	 * `goingBackwards` is the double standing rule §6 asks for: a store that can be
	 * told to answer an OLDER value than the one it holds. Both tests below fail with
	 * the `memoFloor` comparison removed.
	 */
	function goingBackwards(kv) {
		const state = { serve: null, reads: 0 };
		return {
			state,
			async get(key, options) {
				state.reads += 1;
				if (state.serve !== null) return state.serve;
				return kv.get(key, options);
			},
			put: kv.put.bind(kv)
		};
	}

	it('does not memoise bytes older than the floor a cold reader was given', async () => {
		// O4 / codex 1: a caller that goes cold KNOWING a publish timestamp passes it
		// as the floor. Without it the very next read — which started AFTER the reset,
		// so the generation check waves it through — installs whatever the edge cache
		// happened to hold and serves it for a minute.
		//
		// The PUBLISH path no longer takes this route: it installs the snapshot it
		// wrote (see `installContentMemo`), which is strictly stronger, because a
		// wall-clock floor cannot refuse an EQUAL stamp from a second isolate. The
		// floor still governs every cold reader, so it is exercised here directly.
		resetContentMemo();
		const kv = memoryStore();
		await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'e', now: 1000 });
		const stale = kv.map.get(CONTENT_KEY);
		const staleVersion = JSON.parse(stale).version;
		await publishContent({
			apex: stubApex(),
			kv,
			accountId: ACCOUNT,
			publishedBy: 'e',
			now: 60_000
		});
		const fresh = JSON.parse(kv.map.get(CONTENT_KEY));
		const freshVersion = fresh.version;
		assert.notEqual(staleVersion, freshVersion);
		resetContentMemo(fresh.publishedAt); // cold, with the floor the publish would set

		const backwards = goingBackwards(kv);
		backwards.state.serve = stale; // KV's edge cache answers pre-publish bytes
		const served = await readContent(backwards);
		assert.equal(served.version, staleVersion, 'the caller is still answered, not refused');

		backwards.state.serve = null;
		const next = await readContent(backwards);
		assert.equal(
			next.version,
			freshVersion,
			'the stale bytes were NOT installed: the next read went back to KV'
		);
		assert.equal(backwards.state.reads, 2, 'and it really did read again');
	});

	it('a publish is not undone by a rival snapshot carrying the SAME millisecond', async () => {
		/**
		 * codex on the P3 fix pass, finding 3 — the case a wall-clock floor cannot
		 * decide. `publishedAt` is captured BEFORE a fetch that takes tens of seconds
		 * (`publish.ts`) and KV's compare-and-set is explicitly non-atomic, so a second
		 * publishing isolate can carry an EQUAL or lower millisecond. The floor test is
		 * `stamp < memoFloor`, and equal is not less: the isolate that had just
		 * published could be handed the rival's PRE-publish bytes by KV's edge cache,
		 * pass the floor, and memoise them for a full `MEMO_TTL_MS` — serving, as the
		 * publisher, something older than what it published.
		 *
		 * The fix is not a better comparison; there is no comparison that works, because
		 * two machines' clocks are not a total order at any precision. It is to stop
		 * asking: install the snapshot the `put` just wrote.
		 *
		 * MUTATION: `installContentMemo(snapshot)` → `resetContentMemo(snapshot.publishedAt)`
		 * in `publish.ts` fails this test on the version assertion below.
		 */
		resetContentMemo();
		const kv = memoryStore();
		// The rival's publish, which landed first and carries the same millisecond.
		await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'e', now: 5000 });
		const rival = kv.map.get(CONTENT_KEY);
		const rivalVersion = JSON.parse(rival).version;
		// Ours, written second — the one this isolate must serve.
		await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'e', now: 5000 });
		const ours = JSON.parse(kv.map.get(CONTENT_KEY));
		assert.notEqual(rivalVersion, ours.version, 'the two snapshots are distinguishable');
		assert.equal(JSON.parse(rival).publishedAt, ours.publishedAt, 'and share a millisecond');

		const backwards = goingBackwards(kv);
		backwards.state.serve = rival; // KV's edge cache answers the rival's bytes
		assert.equal(
			(await readContent(backwards)).version,
			ours.version,
			'the publisher serves what it published, not an equal-stamped rival'
		);
		assert.equal(
			backwards.state.reads,
			0,
			'and it never asked KV, so there was nothing to get wrong'
		);
	});

	it('does not let KV replace a NEWER memo with older bytes once the memo window lapses', async () => {
		/**
		 * The other direction, and the guard codex's review had removed as unreachable:
		 * it IS unreachable through the public API while the memo is fresh, because the
		 * memo short-circuits every read. Past `MEMO_TTL_MS` it is not — the same
		 * eventual-consistency window can answer the re-check with bytes older than
		 * what this isolate is already serving.
		 *
		 * The clock is moved rather than waited on; `Date.now` is restored in `finally`
		 * so a failure here cannot poison the rest of the file.
		 */
		resetContentMemo();
		const kv = memoryStore();
		await publishContent({ apex: stubApex(), kv, accountId: ACCOUNT, publishedBy: 'e', now: 1000 });
		const stale = kv.map.get(CONTENT_KEY);
		const staleVersion = JSON.parse(stale).version;
		await publishContent({
			apex: stubApex(),
			kv,
			accountId: ACCOUNT,
			publishedBy: 'e',
			now: 60_000
		});
		const freshVersion = JSON.parse(kv.map.get(CONTENT_KEY)).version;

		const backwards = goingBackwards(kv);
		assert.equal(
			(await readContent(backwards)).version,
			freshVersion,
			'the memo holds the new one'
		);

		const realNow = Date.now;
		try {
			const later = realNow() + 120_000;
			Date.now = () => later;
			backwards.state.serve = stale;
			const readsBefore = backwards.state.reads;
			// The memo IS re-checked past the TTL and KV DOES go backwards — but the
			// newer snapshot is still in hand, so that is what the caller gets. Serving
			// the older bytes would be this isolate going backwards for a request, which
			// the floor exists to prevent; not installing them was only half of it.
			assert.equal(
				(await readContent(backwards)).version,
				freshVersion,
				'the older bytes are neither served nor installed while a newer memo is held'
			);
			assert.equal(backwards.state.reads, readsBefore + 1, 'and it really did re-read KV');
			assert.notEqual(staleVersion, freshVersion, 'the two snapshots are distinguishable');
			backwards.state.serve = null;
			assert.equal(
				(await readContent(backwards)).version,
				freshVersion,
				'the older snapshot never took the memo — a third read gets the newer one'
			);
			assert.equal(backwards.state.reads, readsBefore + 2, 'the memo was not refreshed either');
		} finally {
			Date.now = realNow;
		}
	});

	it('a bare resetContentMemo drops the floor, so a cold reader trusts KV again', async () => {
		// The floor is a defence against going BACKWARDS, not a permanent high-water
		// mark: a caller that asks for a cold reader (every test harness does) must not
		// inherit a floor from a snapshot this isolate has forgotten.
		resetContentMemo();
		const kv = memoryStore();
		await publishContent({
			apex: stubApex(),
			kv,
			accountId: ACCOUNT,
			publishedBy: 'e',
			now: 60_000
		});
		assert.ok((await readContent(kv)).version);

		const old = memoryStore();
		await publishContent({
			apex: stubApex(),
			kv: old,
			accountId: ACCOUNT,
			publishedBy: 'e',
			now: 1000
		});
		resetContentMemo();
		const readBack = await readContent(old);
		assert.equal(readBack.version, JSON.parse(old.map.get(CONTENT_KEY)).version);
		assert.equal(await readContent(old), readBack, 'and it memoised, rather than refusing');
	});
});
