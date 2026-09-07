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
const MEMO_TTL_MS = 60_000;

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
		inflight = (async () => {
			const startedAt = generation;
			const raw = await kv.get(CONTENT_KEY, { cacheTtl: 60 });
			if (!raw) throw new ContentUnavailableError('nothing has been published yet');
			const version = versionOf(raw);
			const snapshot =
				memo && version === memo.version ? memo : (JSON.parse(raw) as ContentSnapshot);
			// A publish landed while this read was in flight: hand THIS caller what KV
			// gave us, but do not memoise it — the next read re-fetches and sees the new
			// value rather than waiting out a minute on bytes fetched before the write.
			if (generation === startedAt) {
				memo = snapshot;
				memoCheckedAt = Date.now();
			}
			return snapshot;
		})().finally(() => {
			inflight = null;
		});
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
 * remove KV's own edge cache (`cacheTtl: 60` above) and it does not reach any other
 * isolate — a visitor on a different one still waits.
 */
export function resetContentMemo() {
	memo = null;
	memoCheckedAt = 0;
	inflight = null;
	generation += 1;
}
