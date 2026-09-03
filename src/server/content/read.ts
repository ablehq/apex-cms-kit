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
const MEMO_TTL_MS = 60_000;

const VERSION_PREFIX = /^\{"version":"([^"]+)"/u;

export async function readContent(kv: ContentStore | undefined): Promise<ContentSnapshot> {
	if (!kv) throw new ContentUnavailableError('the CONTENT binding is not configured');
	if (memo && Date.now() - memoCheckedAt < MEMO_TTL_MS) return memo;
	if (!inflight) {
		inflight = (async () => {
			const raw = await kv.get(CONTENT_KEY, { cacheTtl: 60 });
			if (!raw) throw new ContentUnavailableError('nothing has been published yet');
			const version = VERSION_PREFIX.exec(raw)?.[1];
			if (!memo || version !== memo.version) memo = JSON.parse(raw) as ContentSnapshot;
			memoCheckedAt = Date.now();
			return memo;
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

/** Tests only: forget the isolate memo. */
export function resetContentMemo() {
	memo = null;
	memoCheckedAt = 0;
	inflight = null;
}
