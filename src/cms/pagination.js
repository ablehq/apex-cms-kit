/**
 * @typedef {{
 *   total_count: number,
 *   current_page: number,
 *   total_pages: number,
 *   window?: number,
 *   breakdown?: unknown[]
 * }} Pagination
 */

/**
 * Fetch a stable snapshot of every page in an Apex search response. Duplicate
 * ids can occur where page boundaries move, but a duplicate must not hide a
 * missing record: the final unique count must still equal total_count.
 *
 * @template {{ id: string }} T
 * @param {(filters: Record<string, unknown>) => Promise<{ data: T[], pagination: Pagination } | null>} fetchPage
 * @param {Record<string, unknown>} filters
 * @param {{ label?: string, perPage?: number, maxPages?: number, rejectDuplicateIds?: boolean }} [options]
 */
export async function fetchAllPages(fetchPage, filters, options = {}) {
	const label = options.label ?? 'CMS collection';
	const configuredPerPage = Number(options.perPage ?? filters.per_page ?? 100);
	if (!Number.isInteger(configuredPerPage) || configuredPerPage < 1 || configuredPerPage > 500) {
		throw new Error(`${label} has an invalid per-page size: ${configuredPerPage}.`);
	}
	const maxPages = options.maxPages ?? 10_000;
	/** @type {Map<string, T>} */
	const items = new Map();
	/** @type {Pagination | null} */
	let firstPagination = null;
	let page = 1;

	while (page <= maxPages) {
		const response = await fetchPage({
			...filters,
			per_page: configuredPerPage,
			page
		});
		if (!response || !Array.isArray(response.data) || !response.pagination) {
			throw new Error(`${label} page ${page} returned an invalid paginated response.`);
		}
		const pagination = response.pagination;
		for (const [name, value] of Object.entries({
			current_page: pagination.current_page,
			total_pages: pagination.total_pages,
			total_count: pagination.total_count
		})) {
			if (!Number.isInteger(value) || value < 0) {
				throw new Error(`${label} page ${page} has invalid pagination.${name}.`);
			}
		}
		if (pagination.current_page !== page) {
			throw new Error(
				`${label} requested page ${page} but Apex returned page ${pagination.current_page}.`
			);
		}
		if (!firstPagination) {
			firstPagination = { ...pagination };
		} else if (
			pagination.total_pages !== firstPagination.total_pages ||
			pagination.total_count !== firstPagination.total_count
		) {
			throw new Error(`${label} changed while it was being paginated; retry the build.`);
		}

		for (const item of response.data) {
			if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) {
				throw new Error(`${label} page ${page} contains an item without a stable id.`);
			}
			if (options.rejectDuplicateIds && items.has(item.id)) {
				throw new Error(`${label} contains duplicate id ${item.id}.`);
			}
			items.set(item.id, item);
		}

		const totalPages = Math.max(1, pagination.total_pages);
		if (page >= totalPages) break;
		page += 1;
	}

	if (!firstPagination) throw new Error(`${label} returned no pagination metadata.`);
	if (page > maxPages) throw new Error(`${label} exceeded the ${maxPages}-page safety limit.`);
	if (items.size !== firstPagination.total_count) {
		throw new Error(
			`${label} fetch is incomplete: expected ${firstPagination.total_count} unique records, received ${items.size}.`
		);
	}

	return {
		data: [...items.values()],
		pagination: {
			...firstPagination,
			current_page: Math.max(1, firstPagination.total_pages)
		}
	};
}
