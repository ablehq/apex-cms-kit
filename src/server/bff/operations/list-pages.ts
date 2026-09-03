import { z } from 'zod';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import type { BffContext } from '../context';

/**
 * GET /api/admin/pages — a read-only, typed BFF operation (plan §8, 3a: "each op a
 * small +server.ts handler with its own zod schema and one fixed Apex call"). It is
 * NOT a generic forwarder: the query is a closed, `.strict()` schema, and the one
 * Apex call is fixed to the pages `search_and_filter` endpoint on the fixed origin.
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

	const query: Record<string, string | number> = {
		page: parsed.data.page ?? 1,
		per_page: parsed.data.per_page ?? 50
	};
	if (parsed.data.status && parsed.data.status !== 'all') {
		query['q[status_eq]'] = parsed.data.status;
	}

	const apexResponse = await guard.apex.listPages(query);
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
