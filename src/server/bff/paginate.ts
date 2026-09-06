import { unwrapArchetypeCollection } from './archetype-record';

/**
 * Every page of a paginated Apex read, or null. ONE walker for every list the
 * admin shows whole (the post list's two surfaces, the pages list): a read that
 * answered a single page silently lost row 51+ / 101+ and mis-joined the halves.
 *
 * Fails CLOSED: a page that will not read, a page without integer
 * `pagination.total_pages`, or more pages than `maxPages` all answer null — the
 * rows already read are no answer, not a partial one. The caller turns null into
 * a 502. `maxPages` bounds the walk (default 20 pages) so a runaway upstream
 * cannot keep an admin request open forever.
 */
export async function listAllPages(
	fetchPage: (page: number) => Promise<{ ok: boolean; body: unknown }>,
	options: { maxPages?: number } = {}
): Promise<Record<string, unknown>[] | null> {
	const maxPages = options.maxPages ?? 20;
	const rows: Record<string, unknown>[] = [];
	let page = 1;
	for (;;) {
		const response = await fetchPage(page);
		if (!response.ok) return null;
		rows.push(...unwrapArchetypeCollection(response.body));
		const totalPages = (response.body as { pagination?: { total_pages?: unknown } } | null)
			?.pagination?.total_pages;
		if (!Number.isInteger(totalPages)) return null;
		if (page >= Math.max(1, totalPages as number)) return rows;
		if (page >= maxPages) return null;
		page += 1;
	}
}
