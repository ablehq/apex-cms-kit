/**
 * The SvelteKit-facing reader: a loader's one call. Kept apart from `read.ts` so
 * the publish path (and a site's ingest) never imports SvelteKit.
 */
import { error } from '@sveltejs/kit';
import { ContentUnavailableError, readContent } from './read';
import type { ContentStore } from './read';

/** For loaders: the collections, keyed by snapshot file name (`pages`, `sermons`, …). */
export async function siteContent(
	platform: { env?: { CONTENT?: ContentStore } } | undefined
): Promise<Record<string, unknown[]>> {
	try {
		return (await readContent(platform?.env?.CONTENT)).collections;
	} catch (cause) {
		// A site with nothing published is a 503 with a sentence, not a stack trace —
		// and a public one: the binding's name stays in the thrown error for the logs.
		if (cause instanceof ContentUnavailableError)
			error(503, 'This site has not been published yet.');
		throw cause;
	}
}
