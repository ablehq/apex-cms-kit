import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { computePageVersion } from '../page-version';
import { pageIdSchema } from './get-page';
import type { BffContext } from '../context';

/**
 * GET /api/admin/pages/[pageId]/version — the composite page-version read the stale
 * guard uses (plan §8, 3a). It re-reads the page from Apex and returns ONLY the
 * `{ version }` token, nothing else — `savePage()` calls this once, immediately
 * before it writes, and compares the token to the baseline captured at load. A
 * mismatch means someone else changed the page; the save refuses.
 *
 * It is a separate, minimal op (not a second call to get-page) so the guard's one
 * job — "is the tree still what I loaded?" — is a single cheap round-trip, and so
 * the browser never has to re-diff a whole page body just to answer it.
 */
export async function handleReadPageVersion(
	request: Request,
	ctx: BffContext,
	params: { pageId: string }
): Promise<Response> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;

	const idResult = pageIdSchema.safeParse(params.pageId);
	if (!idResult.success) return bffError(400, 'invalid page id');

	const apexResponse = await guard.apex.getPage(idResult.data);
	if (!apexResponse.ok) return bffError(502, 'upstream error');

	const body = apexResponse.body as { data?: unknown };
	const page =
		body && typeof body === 'object' && body.data && typeof body.data === 'object'
			? (body.data as Record<string, unknown>)
			: (apexResponse.body as Record<string, unknown>);
	if (!page || typeof page !== 'object') return bffError(502, 'unexpected upstream shape');

	const version = await computePageVersion(page);
	return noStoreJson({ version });
}
