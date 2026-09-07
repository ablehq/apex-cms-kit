/**
 * The published site content, read from KV (plan §2.3).
 *
 * ONE value, `content`, holds the whole snapshot — every collection, projected —
 * so a publish is atomic: a reader gets the complete old snapshot or the complete
 * new one, never a mix, and there is no second key to fall out of step with. The
 * value is serialised with its `version` first, so a reader can tell whether this
 * isolate already holds it from the first bytes, without parsing megabytes again.
 */

export const CONTENT_KEY = 'content';

/** The subset of a KV namespace this module uses, so tests can pass a Map. */
export interface ContentStore {
	get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
}

export interface ContentManifest {
	version: string;
	publishedAt: string;
	publishedBy: string;
	accountId: string;
	counts: Record<string, number>;
	warnings: string[];
}

export interface ContentSnapshot extends ContentManifest {
	collections: Record<string, unknown[]>;
}

export class ContentUnavailableError extends Error {
	constructor(detail: string) {
		super(`site content unavailable: ${detail}`);
		this.name = 'ContentUnavailableError';
	}
}

/** Exactly one parsed snapshot per isolate, replaced — never accumulated. */
let memo: ContentSnapshot | null = null;
/** When the memo was last confirmed against KV; re-checked at most once a minute. */
let memoCheckedAt = 0;
let inflight: Promise<ContentSnapshot> | null = null;
/**
 * Bumped by every `resetContentMemo`. A read that started before an invalidation
 * must not install what it fetched: its bytes are older than the event that
 * invalidated the memo, and installing them would restore the stale snapshot for a
 * whole `MEMO_TTL_MS` — undoing the invalidation the publish just paid for.
 */
let generation = 0;
/**
 * THE PUBLISH-CLOCK FLOOR: the oldest `publishedAt` this isolate is still allowed
 * to MEMOISE, as epoch milliseconds. `0` means "no floor" — a cold isolate.
 *
 * The generation counter above orders events INSIDE this isolate. It cannot order
 * BYTES, and the bytes are where the remaining hazard is: `kv.get(…, {cacheTtl:
 * 60})` reads KV's own edge cache, which is eventually consistent and NOT monotonic
 * across tiers, so a read that starts after a publish can still be handed
 * pre-publish bytes. Their `startedAt` equals the current generation, so nothing
 * above stops them being installed — and once installed they are served for a whole
 * `MEMO_TTL_MS`.
 *
 * Two things raise the floor, and between them they close both directions:
 *
 *   1. every snapshot this isolate installs, so KV handing back bytes OLDER than the
 *      memo (the same eventual-consistency window, one TTL later) cannot replace it;
 *   2. `resetContentMemo(publishedAt)` — the publish path KNOWS the timestamp it
 *      just wrote, and passes it, so the very next read cannot install anything
 *      older than the publish that invalidated the memo.
 *
 * Older bytes are still SERVED to the caller that fetched them (refusing to answer
 * would be worse than answering with a snapshot that was current a second ago); they
 * are simply not installed, so the next read goes back to KV instead of waiting out
 * a minute on them.
 *
 * A snapshot whose `publishedAt` will not parse is treated as unknown and allowed
 * through: refusing to ever memoise it would trade a bounded staleness window for an
 * unbounded re-fetch on every request.
 */
let memoFloor = 0;
const MEMO_TTL_MS = 60_000;

/** `publishedAt` as epoch ms, or null when it is missing or unparseable. */
function publishedAtMs(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const stamp = Date.parse(value);
	return Number.isFinite(stamp) ? stamp : null;
}

const VERSION_PREFIX = /^\{"version":"([^"]+)"/u;

/**
 * The `version` of a stored snapshot, read from the first bytes without parsing.
 *
 * Exported because the PUBLISH compares it too: the version the store held when a
 * publish started, against the version it holds just before the write. One regex,
 * one place — a second copy that drifted would make the concurrency check pass on
 * snapshots it should refuse.
 */
export function versionOf(raw: string | null | undefined): string | null {
	if (!raw) return null;
	return VERSION_PREFIX.exec(raw)?.[1] ?? null;
}

export async function readContent(kv: ContentStore | undefined): Promise<ContentSnapshot> {
	if (!kv) throw new ContentUnavailableError('the CONTENT binding is not configured');
	if (memo && Date.now() - memoCheckedAt < MEMO_TTL_MS) return memo;
	if (!inflight) {
		/**
		 * WHAT GOES IN THE SLOT IS THE `finally`-CHAINED PROMISE, and that is the fix.
		 *
		 * The bug was `inflight = mine.finally(…)`: the callback then compared
		 * `inflight` against the INNER promise, `inflight === mine` was never true, the
		 * slot was never cleared, and every later read past the memo TTL was handed a
		 * long-resolved promise forever. Caught by a test that deadlocked. The `let`
		 * split below is only what lets the callback name the chained promise from
		 * inside its own initializer — `const mine: Promise<ContentSnapshot> = (…)()
		 * .finally(…)` would behave identically; the ORDER (`inflight = mine` after the
		 * chain, on line below) is the part that matters.
		 *
		 * CLEAR THE SLOT ONLY IF IT IS STILL OURS.
		 *
		 * An unconditional `inflight = null` clears whatever is there, INCLUDING A
		 * LATER READ'S PROMISE. That is how two reads end up running at once: a
		 * pre-reset read settles, frees the post-reset read's slot, and a third read
		 * starts against KV's 60-second edge cache — after which whichever lands last
		 * wins, and a slower one holding older bytes can install them over a newer memo
		 * for a full `MEMO_TTL_MS`.
		 *
		 * WHAT THE THREE DEFENCES DO AND DO NOT COVER. Slot ownership means at most one
		 * read is installing per generation. The generation check refuses a read that
		 * SPANS a reset. Neither can see the age of the BYTES, so KV's own edge cache —
		 * which can answer a post-publish read with pre-publish content — is closed by
		 * the third, `memoFloor`. What remains open is that such a caller is still
		 * SERVED the older snapshot; it is simply never installed, so the staleness
		 * lasts one request instead of one `MEMO_TTL_MS`.
		 */
		let mine: Promise<ContentSnapshot>;
		mine = (async () => {
			const startedAt = generation;
			const raw = await kv.get(CONTENT_KEY, { cacheTtl: 60 });
			if (!raw) throw new ContentUnavailableError('nothing has been published yet');
			const version = versionOf(raw);
			const snapshot =
				memo && version === memo.version ? memo : (JSON.parse(raw) as ContentSnapshot);
			const stamp = publishedAtMs(snapshot.publishedAt);
			// KV handed back bytes older than the publish clock this isolate has already
			// seen — its edge cache answering a post-publish read with pre-publish
			// content. They are never memoised, so the next read re-fetches instead of
			// waiting out a minute on them.
			const olderThanFloor = stamp !== null && memoFloor > 0 && stamp < memoFloor;
			if (olderThanFloor) {
				// KV handed back bytes older than the publish clock this isolate has
				// already seen. They are not installed — but if a NEWER snapshot is still
				// in hand, serving the OLDER one to this caller would be going backwards
				// for no reason: the memo is past the floor by construction (the floor is
				// raised to a snapshot's stamp as it is installed, and a reset clears the
				// memo with the floor it sets). Hand back the memo; the TTL has expired,
				// so the next read still goes to KV.
				return memo ?? snapshot;
			}
			if (generation === startedAt) {
				memo = snapshot;
				memoCheckedAt = Date.now();
				if (stamp !== null && stamp > memoFloor) memoFloor = stamp;
			}
			return snapshot;
		})().finally(() => {
			if (inflight === mine) inflight = null;
		});
		inflight = mine;
	}
	return inflight;
}

export function manifestOf(snapshot: ContentSnapshot): ContentManifest {
	const { collections: _collections, ...manifest } = snapshot;
	return manifest;
}

/**
 * Forget the isolate memo — called by `publishContent` after the write, and by
 * tests that want a cold reader.
 *
 * A publish invalidating its own isolate's memo is not a nicety: without it a
 * publish reaches the READER that made it no sooner than any other visitor, so the
 * admin rail and any SSR in that isolate keep serving the previous snapshot for up
 * to `MEMO_TTL_MS`. It removes the self-inflicted half of the delay. It does NOT
 * remove KV's own edge cache (`cacheTtl: 60` in `readContent`) and it does not
 * reach any other isolate — a visitor on a different one still waits.
 *
 * `publishedAt` is what a caller that just WROTE a snapshot passes: the timestamp of
 * the bytes it put. It becomes the memo floor, so the next read cannot install
 * anything older than the publish that invalidated the memo — the one hazard the
 * edge cache leaves open (see `memoFloor`). Omitting it means "go cold, and trust
 * whatever KV answers next", which is what a test wanting a clean reader wants and
 * what a publish must never ask for.
 */
export function resetContentMemo(publishedAt?: string) {
	memo = null;
	memoCheckedAt = 0;
	inflight = null;
	generation += 1;
	memoFloor = publishedAtMs(publishedAt) ?? 0;
}

/**
 * Adopt the snapshot this isolate JUST WROTE, instead of clearing the memo and
 * trusting KV to hand it back.
 *
 * WHAT WAS WRONG WITH CLEARING. `publishContent` used to call
 * `resetContentMemo(snapshot.publishedAt)`: memo empty, floor set to the stamp it
 * had written, next read goes to KV. The floor is a WALL CLOCK, and two publishing
 * isolates do not share one. Publish B, running on another isolate, can capture a
 * millisecond EQUAL TO or LOWER THAN A's — the clock is read before a fetch that
 * takes tens of seconds (`publish.ts`), and KV's concurrency check is explicitly
 * non-atomic — so B's reset installs a floor no higher than A's stamp, and the very
 * next read on that isolate can be handed A's older bytes by KV's edge cache and
 * MEMOISE them, because the floor test is `stamp < memoFloor` and equal is not
 * less. The isolate then serves, for a whole `MEMO_TTL_MS`, a snapshot older than
 * the one it just published.
 *
 * Installing what we wrote removes the read entirely: there is nothing for the edge
 * cache to answer wrongly, the publisher sees its own publish immediately (which is
 * what the invalidation was for), and the publish costs ZERO extra KV reads instead
 * of one. The floor moves only UPWARD here — a publish must never lower a bar this
 * isolate has already cleared.
 *
 * ⚠ ACCEPTED LIMITATION, and it is not fixable here. This orders what ONE isolate
 * serves. It does not order two isolates' WRITES: whichever `put` lands last wins
 * in KV regardless of its timestamp, and `publish.ts`'s read-compare-write narrows
 * that window without closing it. Strict cross-isolate ordering needs a SERIALIZED
 * REVISION — a Durable Object, or a store with compare-and-set — because wall
 * clocks on different machines cannot provide one, at any precision. The
 * `publishedAt` floor is a staleness bound, not a total order, and must not be read
 * as one.
 */
export function installContentMemo(snapshot: ContentSnapshot) {
	inflight = null;
	generation += 1;
	memo = snapshot;
	memoCheckedAt = Date.now();
	const stamp = publishedAtMs(snapshot.publishedAt);
	if (stamp !== null && stamp > memoFloor) memoFloor = stamp;
}
