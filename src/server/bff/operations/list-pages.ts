import { z } from 'zod';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { listAllPages } from '../paginate';
import type { BffContext } from '../context';

/**
 * GET /api/admin/pages — a read-only, typed BFF operation (plan §8, 3a: "each op a
 * small +server.ts handler with its own zod schema and one fixed Apex call"). It is
 * NOT a generic forwarder: the query is a closed, `.strict()` schema, and the Apex
 * call is fixed to the pages `search_and_filter` endpoint on the fixed origin.
 *
 * Without a `page`, the answer is EVERY page: both sites call
 * `listPages({ status: 'all' })` once and show the result whole, and a single page
 * of 50 (what this op answered before, dropping the pagination) made page 51+
 * invisible in the Pages screen. The walk reads 100 at a time, follows
 * `pagination.total_pages`, is capped at 20 pages and fails closed (502) on a
 * malformed envelope. An explicit `page` keeps the single-page answer.
 */
export const listPagesQuerySchema = z
	.object({
		status: z.enum(['draft', 'published', 'all']).optional(),
		page: z.coerce.number().int().min(1).max(1000).optional(),
		per_page: z.coerce.number().int().min(1).max(100).optional()
	})
	.strict();

export async function handleListPages(request: Request, ctx: BffContext): Promise<Response> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;

	const raw = Object.fromEntries(new URL(request.url).searchParams.entries());
	const parsed = listPagesQuerySchema.safeParse(raw);
	// Fail closed on any unknown or malformed query parameter.
	if (!parsed.success) return bffError(400, 'invalid query');

	const filter: Record<string, string | number> = {};
	if (parsed.data.status && parsed.data.status !== 'all') {
		filter['q[status_eq]'] = parsed.data.status;
	}

	if (parsed.data.page === undefined) {
		const rows = await listAllPages((page) =>
			guard.apex.listPages({ ...filter, page, per_page: parsed.data.per_page ?? 100 })
		);
		if (!rows) return bffError(502, 'upstream error');
		return noStoreJson({ pages: rows });
	}

	const apexResponse = await guard.apex.listPages({
		...filter,
		page: parsed.data.page,
		per_page: parsed.data.per_page ?? 50
	});
	if (!apexResponse.ok) return bffError(502, 'upstream error');

	// Unwrap Apex's `{ data: [...], pagination }` envelope to a plain array — the
	// browser gets exactly the pages, not the upstream response shape.
	const body = apexResponse.body;
	let pages: unknown[] = [];
	if (Array.isArray(body)) {
		pages = body;
	} else if (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)) {
		pages = (body as { data: unknown[] }).data;
	}

	return noStoreJson({ pages });
}
